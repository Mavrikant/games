import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';
import type { ScoreDescriptor } from '@shared/leaderboard';
import { joinChannel, channelEnabled } from '@shared/realtime-channel';
import type { ChannelHandle } from '@shared/realtime-channel';

import {
  FRAME_DT_CLAMP,
  HUNT_S,
  INPUT_MS,
  MAX_HUMANS,
  MAX_SUBSTEPS,
  MIN_PLAYERS,
  SIM_DT,
  SNAP_MS,
  seekerCountFor,
} from './kamuflaj/constants';
import { freshInput, freshWorld, makePlayer, seatPlayers, setupMatch, step } from './kamuflaj/world';
import {
  decodeHello,
  decodeInput,
  decodeSnapshot,
  decodeStart,
  encodeInput,
  encodeSnapshot,
  encodeStart,
} from './kamuflaj/net';
import {
  buildArena,
  initScene,
  isWebglOk,
  render as renderScene,
  resetCamera,
  resize as resizeScene,
  toWorld,
} from './kamuflaj/scene';
import { createLocalInput } from './kamuflaj/input';
import type { LocalInput } from './kamuflaj/input';
import type { Player, Role, Snapshot, Status, World } from './kamuflaj/types';

// 3D multiplayer chameleon hide-and-seek. Hiders paint their skin to the colour
// of nearby props and freeze to vanish; seekers hunt them with a sticky tongue.
// Online-only: host-authoritative rooms over @shared/realtime-channel, real
// players gathered in a lobby (no AI). Needs the realtime backend configured.

const STORAGE_BEST = 'kamuflaj.best';
const STORAGE_NAME = 'kamuflaj.name';
const STORAGE_ROLE = 'kamuflaj.role';
const SCORE_DESC: ScoreDescriptor = {
  gameId: 'kamuflaj',
  storageKey: STORAGE_BEST,
  direction: 'higher',
};

// Distinct identity hues per slot (slot 0 = the room host).
const PALETTE = [120, 22, 200, 285, 52, 330];

type Mode = 'idle' | 'online-host' | 'online-guest';
interface Seat {
  id: string;
  name: string;
  role: Role;
  hue: number;
}

const gen = createGenToken();
let world: World = freshWorld();
let mode: Mode = 'idle';
let room: ChannelHandle | null = null;
let roomCode = '';
let started = false; // host: has a match begun?
let myId = 'me';
let myName = 'Sen';
let chosenRole: Role = 'hider';
let best = 0;
let halted = false;
let lobbyCount = 1;

const guestNames = new Map<string, string>();
let gotStart = false; // guest: ignore snapshots until the host's 'start'
let lastSnapAt = 0;
let lastInputAt = 0;
let simAcc = 0;
let lastShownStatus: Status | null = null;
let reportedOver = false;
let feedKey = '';
let bannerKey = '';

let input!: LocalInput;
const guestInput = freshInput();
const discardInput = freshInput();

// DOM refs (filled in init()).
let kmRoot!: HTMLElement;
let canvas!: HTMLCanvasElement;
let roleEl!: HTMLElement;
let phaseEl!: HTMLElement;
let timeEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let statusEl!: HTMLElement;
let feedEl!: HTMLElement;
let blendWrap!: HTMLElement;
let blendBar!: HTMLElement;
let banner!: HTMLElement;
let bannerTitle!: HTMLElement;
let bannerSub!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let nameInput!: HTMLInputElement;
let roleToggle!: HTMLElement;
let roleHideBtn!: HTMLButtonElement;
let roleSeekBtn!: HTMLButtonElement;
let menuActions!: HTMLElement;
let createBtn!: HTMLButtonElement;
let shareBox!: HTMLElement;
let shareRowWrap!: HTMLElement;
let shareLinkInput!: HTMLInputElement;
let copyBtn!: HTMLButtonElement;
let lobbyCountEl!: HTMLElement;
let lobbyNote!: HTMLElement;
let lobbyStartBtn!: HTMLButtonElement;
let overPanel!: HTMLElement;
let boardList!: HTMLOListElement;
let rematchBtn!: HTMLButtonElement;
let toMenuBtn!: HTMLButtonElement;
let fsBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

// ---- helpers ----------------------------------------------------------------

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function myPlayer(): Player | null {
  for (const p of world.players) if (p.id === myId) return p;
  return null;
}

function roleLabel(role: Role): string {
  return role === 'seeker' ? 'Avcı 👁' : 'Saklanan 🦎';
}

function fmtTime(s: number): string {
  const total = Math.max(0, Math.ceil(s));
  const m = Math.floor(total / 60);
  const r = total % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function saveName(): void {
  const n = nameInput.value.trim().slice(0, 14);
  if (n) {
    myName = n;
    safeWrite(STORAGE_NAME, n);
  }
}

/** Assign roles among the real players present, exactly seekerCountFor(n)
 *  seekers (honouring each player's preference first), the rest hiders. */
function assignRoster(humans: { id: string; name: string; prefer: Role }[]): Seat[] {
  const n = humans.length;
  const need = seekerCountFor(n);
  const roles: (Role | null)[] = humans.map(() => null);
  let s = 0;
  for (let i = 0; i < n && s < need; i++) {
    if (humans[i]!.prefer === 'seeker') {
      roles[i] = 'seeker';
      s++;
    }
  }
  for (let i = 0; i < n && s < need; i++) {
    if (roles[i] === null) {
      roles[i] = 'seeker';
      s++;
    }
  }
  return humans.map((h, i) => ({
    id: h.id,
    name: h.name,
    role: roles[i] ?? 'hider',
    hue: PALETTE[i % PALETTE.length]!,
  }));
}

/** Host: build a roster from everyone currently in the room (self first). */
function rosterFromMembers(): Seat[] {
  if (!room) return assignRoster([{ id: myId, name: myName, prefer: chosenRole }]);
  const ids = room.members();
  const humans: { id: string; name: string; prefer: Role }[] = [
    { id: myId, name: myName, prefer: chosenRole },
  ];
  for (const id of ids) {
    if (id === myId) continue;
    humans.push({ id, name: guestNames.get(id) ?? 'Misafir', prefer: 'hider' });
  }
  return assignRoster(humans.slice(0, MAX_HUMANS));
}

// ---- match flow -------------------------------------------------------------

/** Menu backdrop: an empty, softly-lit room (no AI players) slowly orbited by
 *  the camera so the page shows the arena immediately (pitfall: invisible-boot). */
function startAttract(): void {
  world = freshWorld();
  world.mode = 'idle';
  setupMatch(world, []);
  world.players = [];
  world.status = 'menu';
  buildArena(world);
  resetCamera();
}

function beginMatch(roster: Seat[]): void {
  setupMatch(world, roster);
  world.mode = mode;
  reportedOver = false;
  lastShownStatus = null;
  buildArena(world);
  resetCamera();
  if (mode === 'online-host' && room) room.send('start', encodeStart(world));
}

function teardownRoom(): void {
  if (room) {
    room.leave();
    room = null;
  }
  guestNames.clear();
  started = false;
  lobbyCount = 1;
}

function getRoomFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('room') ?? '';
  } catch {
    return '';
  }
}

function randomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function addFeed(line: string): void {
  world.feed.unshift(line);
  if (world.feed.length > 3) world.feed.length = 3;
}

/** Drop back to the menu with an explanatory message (network-failure paths). */
function menuWithMessage(title: string, msg: string, status: string): void {
  teardownRoom();
  mode = 'idle';
  netTargets.clear();
  startAttract();
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  lastShownStatus = null;
  syncOverlay(true);
  setStatus(status);
}

// ---- host: room + lobby -----------------------------------------------------

/** Host: a guest left. In the lobby just drop the count; mid-match remove the
 *  player so the match can still resolve. */
function dropMember(id: string): void {
  guestNames.delete(id);
  if (started) {
    const i = world.players.findIndex((p) => p.id === id);
    if (i >= 0) {
      addFeed(`${world.players[i]!.name} ayrıldı`);
      world.players.splice(i, 1);
      buildArena(world);
    }
  }
}

async function createRoom(): Promise<void> {
  saveName();
  if (!channelEnabled()) {
    menuWithMessage(
      'Sunucu gerekli',
      'Kamuflaj yalnızca çok oyunculudur ve çevrimiçi bir sunucu gerektirir. Bu sürümde sunucu yapılandırılmamış.',
      '⚠️ Çok oyunculu sunucu yapılandırılmamış',
    );
    return;
  }
  teardownRoom();
  mode = 'online-host';
  roomCode = randomCode();
  shareLinkInput.value = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  world.status = 'waiting';
  lobbyCount = 1;
  syncOverlay(true);
  setStatus('🟡 Odaya bağlanılıyor…');
  const myGen = gen.current();
  const handle = await joinChannel(
    `kamuflaj:${roomCode}`,
    { role: 'host', name: myName },
    {
      onEvent: (event, data, from) => {
        if (mode !== 'online-host') return;
        if (event === 'hello') {
          const n = decodeHello(data);
          if (n) {
            guestNames.set(from, n);
            const c = world.players.find((cr) => cr.id === from);
            if (c) c.name = n;
            if (world.status === 'waiting') syncLobby();
          }
        } else if (event === 'input' && started) {
          const msg = decodeInput(data);
          const c = world.players.find((cr) => cr.id === from);
          if (msg && c) {
            c.input.mx = msg.mx;
            c.input.mz = msg.mz;
            c.input.aimX = msg.ax;
            c.input.aimZ = msg.az;
            if (msg.fire) c.input.fire = true;
          }
        }
      },
      onPresence: (ids) => {
        if (mode !== 'online-host' || !room) return;
        lobbyCount = Math.min(MAX_HUMANS, ids.length);
        if (world.status === 'waiting') syncLobby();
      },
      onLeave: (id) => {
        if (mode === 'online-host') dropMember(id);
      },
    },
  );
  if (!gen.isCurrent(myGen)) {
    handle?.leave();
    return;
  }
  if (!handle) {
    menuWithMessage(
      'Bağlanılamadı',
      'Çevrimiçi sunucuya ulaşılamadı. Lütfen daha sonra tekrar dene.',
      '⚠️ Bağlanılamadı',
    );
    return;
  }
  room = handle;
  myId = handle.id;
  lobbyCount = Math.max(1, room.members().length);
  setStatus('🟢 Oda hazır · arkadaşlarını çağır');
  syncLobby();
}

function hostStart(): void {
  if (mode !== 'online-host' || !room) return;
  if (lobbyCount < MIN_PLAYERS) return;
  started = true;
  beginMatch(rosterFromMembers());
}

// ---- guest networking -------------------------------------------------------

const netTargets = new Map<string, { x: number; z: number; yaw: number }>();

function applyStart(data: unknown): void {
  const start = decodeStart(data);
  if (!start) return;
  world = freshWorld();
  world.mode = 'online-guest';
  world.props = start.props;
  world.players = start.roster.map((r) => makePlayer(r.id, r.name, r.role, r.hue));
  seatPlayers(world);
  world.status = 'countdown';
  gotStart = true;
  netTargets.clear();
  buildArena(world);
  resetCamera();
  reportedOver = false;
  lastShownStatus = null;
}

function applySnapshot(snap: Snapshot): void {
  world.status = snap.st;
  world.phaseLeft = snap.pl;
  world.feed = snap.fd.slice(0, 3);
  world.winner = snap.wn;
  const ids = new Set(snap.pr.map((p) => p.id));
  let structural = false;
  // Prune players who left the host's world.
  for (let i = world.players.length - 1; i >= 0; i--) {
    if (!ids.has(world.players[i]!.id)) {
      netTargets.delete(world.players[i]!.id);
      world.players.splice(i, 1);
      structural = true;
    }
  }
  for (const np of snap.pr) {
    let c = world.players.find((p) => p.id === np.id);
    if (!c) {
      c = makePlayer(np.id, np.nm, np.ro === 1 ? 'seeker' : 'hider', np.bh);
      world.players.push(c);
      structural = true;
    }
    c.name = np.nm;
    c.role = np.ro === 1 ? 'seeker' : 'hider';
    c.bodyHue = np.bh;
    c.caught = np.ca === 1;
    c.visible = np.vi;
    c.score = np.sc;
    netTargets.set(np.id, { x: np.x, z: np.z, yaw: np.yw });
    if (typeof np.tx === 'number' && typeof np.tz === 'number' && typeof np.tl === 'number') {
      c.tongue = { dx: np.tx, dz: np.tz, len: np.tl, max: np.tl, retract: false, hitId: np.tv ?? null };
    } else {
      c.tongue = null;
    }
  }
  if (structural) buildArena(world);
}

/** Guest render integration: ease each player onto its last snapshot pose. */
function easeGuestPlayers(dt: number): void {
  const k = Math.min(1, dt * 9);
  for (const c of world.players) {
    const t = netTargets.get(c.id);
    if (!t) continue;
    c.x += (t.x - c.x) * k;
    c.z += (t.z - c.z) * k;
    const dyaw = ((t.yaw - c.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    c.yaw += dyaw * Math.min(1, dt * 10);
  }
}

async function joinRoomAsGuest(code: string): Promise<void> {
  saveName();
  teardownRoom();
  mode = 'online-guest';
  gotStart = false;
  roomCode = code;
  world.status = 'connecting';
  syncOverlay(true);
  setStatus('🟡 Odaya bağlanılıyor…');
  const myGen = gen.current();
  const handle = await joinChannel(
    `kamuflaj:${code}`,
    { role: 'guest', name: myName },
    {
      onEvent: (event, data) => {
        if (mode !== 'online-guest') return;
        if (event === 'start') {
          applyStart(data);
        } else if (event === 'state') {
          if (!gotStart) return;
          const snap = decodeSnapshot(data);
          if (snap) applySnapshot(snap);
        }
      },
      onPresence: (ids) => {
        if (mode !== 'online-guest') return;
        lobbyCount = Math.min(MAX_HUMANS, ids.length);
        if (world.status === 'waiting' || world.status === 'connecting') syncLobby();
      },
      onLeave: () => {
        if (mode === 'online-guest' && room && room.peerCount() === 0) {
          menuWithMessage(
            'Bağlantı koptu',
            'Oda kurucusu ayrıldı. Yeni bir oda kurabilirsin.',
            '🔴 Kurucu ayrıldı',
          );
        }
      },
    },
  );
  if (!gen.isCurrent(myGen)) {
    handle?.leave();
    return;
  }
  if (!handle) {
    menuWithMessage(
      'Bağlanılamadı',
      'Çevrimiçi sunucuya ulaşılamadı. Lütfen daha sonra tekrar dene.',
      '⚠️ Bağlanılamadı',
    );
    return;
  }
  room = handle;
  myId = handle.id;
  lobbyCount = Math.max(1, room.members().length);
  room.send('hello', { name: myName });
  world.status = 'waiting';
  setStatus('🟢 Lobiye katıldın · kurucuyu bekle');
  syncOverlay(true);
}

// ---- overlay / lobby / banner ----------------------------------------------

function show(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
}
function hide(el: HTMLElement, cls: string): void {
  el.classList.add(cls);
}

function syncRoleToggle(): void {
  roleHideBtn.classList.toggle('km-role__opt--on', chosenRole === 'hider');
  roleSeekBtn.classList.toggle('km-role__opt--on', chosenRole === 'seeker');
}

function showMenuPanels(): void {
  hide(shareBox, 'km-share--hidden');
  hide(overPanel, 'km-over--hidden');
  if (channelEnabled()) {
    show(menuActions, 'km-actions--hidden');
    show(roleToggle, 'km-role--hidden');
    nameInput.style.display = '';
  } else {
    // No realtime backend → multiplayer can't run here.
    hide(menuActions, 'km-actions--hidden');
    hide(roleToggle, 'km-role--hidden');
    nameInput.style.display = 'none';
  }
  syncRoleToggle();
}

/** Refresh the live lobby panel (player count + host's start button). */
function syncLobby(): void {
  lobbyCountEl.textContent = `${lobbyCount}/${MAX_HUMANS}`;
  if (mode === 'online-host') {
    show(shareRowWrap, 'km-hidden');
    lobbyStartBtn.style.display = '';
    const ready = lobbyCount >= MIN_PLAYERS;
    lobbyStartBtn.disabled = !ready;
    lobbyStartBtn.textContent = ready ? `Başlat (${lobbyCount} oyuncu)` : 'En az 2 oyuncu gerekli';
    lobbyNote.textContent = ready
      ? 'Hazır olduğunda başlat. Sonradan katılanlar bir sonraki tura girer.'
      : 'Bağlantıyı paylaş; en az bir kişi daha katılınca başlatabilirsin.';
  } else {
    hide(shareRowWrap, 'km-hidden');
    lobbyStartBtn.style.display = 'none';
    lobbyNote.textContent = 'Kurucu maçı başlatınca otomatik gireceksin.';
  }
}

function syncOverlay(force = false): void {
  const st = world.status;
  if (!force && st === lastShownStatus) return;

  if (st === 'menu') {
    overlayTitle.textContent = overlayTitle.textContent || 'Kamuflaj';
    showMenuPanels();
    showOverlay(overlay);
  } else if (st === 'waiting') {
    overlayTitle.textContent = mode === 'online-host' ? 'Oda kuruldu' : 'Lobiye katıldın';
    overlayMsg.textContent =
      mode === 'online-host'
        ? 'Bağlantıyı arkadaşlarına gönder ve hazır olunca başlat.'
        : 'Oda kurucusunun maçı başlatması bekleniyor.';
    hide(menuActions, 'km-actions--hidden');
    hide(roleToggle, 'km-role--hidden');
    hide(overPanel, 'km-over--hidden');
    show(shareBox, 'km-share--hidden');
    nameInput.style.display = 'none';
    syncLobby();
    showOverlay(overlay);
  } else if (st === 'connecting') {
    overlayTitle.textContent = 'Bağlanılıyor…';
    overlayMsg.textContent = 'Odaya bağlanılıyor, birazdan lobiye gireceksin.';
    hide(menuActions, 'km-actions--hidden');
    hide(roleToggle, 'km-role--hidden');
    hide(shareBox, 'km-share--hidden');
    hide(overPanel, 'km-over--hidden');
    nameInput.style.display = 'none';
    showOverlay(overlay);
  } else if (st === 'over') {
    showOverPanel();
  } else {
    // countdown / prep / hunt → gameplay is visible.
    hideOverlay(overlay);
  }
  lastShownStatus = st;
}

function showOverPanel(): void {
  const me = myPlayer();
  const ranked = [...world.players].sort((a, b) => b.score - a.score);
  const won =
    !!me &&
    ((world.winner === 'hider' && me.role === 'hider') ||
      (world.winner === 'seeker' && me.role === 'seeker'));
  overlayTitle.textContent = won
    ? 'Takımın kazandı! 🏆'
    : world.winner === 'seeker'
      ? 'Avcılar kazandı'
      : 'Saklananlar kazandı';
  overlayMsg.textContent = me ? `Skorun: ${me.score}` : 'Maç bitti.';
  boardList.textContent = '';
  for (const c of ranked) {
    const li = document.createElement('li');
    const tag = c.role === 'seeker' ? '👁' : c.caught ? '💤' : '🦎';
    li.textContent = `${tag} ${c.name} — ${c.score}${
      c.role === 'seeker' ? ` · ${c.catches} yakalama` : ''
    }`;
    if (c.id === myId) li.className = 'km-board__me';
    boardList.appendChild(li);
  }
  hide(menuActions, 'km-actions--hidden');
  hide(roleToggle, 'km-role--hidden');
  hide(shareBox, 'km-share--hidden');
  show(overPanel, 'km-over--hidden');
  nameInput.style.display = 'none';
  rematchBtn.style.display = mode === 'online-host' ? '' : 'none';
  if (mode === 'online-guest') overlayMsg.textContent += ' · kurucunun yeniden başlatması bekleniyor';
  showOverlay(overlay);

  if (!reportedOver && me) {
    reportedOver = true;
    if (me.score > best) {
      best = me.score;
      bestEl.textContent = String(best);
    }
    reportGameOver(SCORE_DESC, me.score, { label: 'Skor' });
  }
}

function syncBanner(): void {
  const st = world.status;
  const me = myPlayer();
  let title = '';
  let sub = '';
  if (st === 'countdown') {
    title = `Rolün: ${roleLabel(me?.role ?? chosenRole)}`;
    sub =
      (me?.role ?? chosenRole) === 'seeker'
        ? 'Uyuyorsun… av birazdan saklanacak'
        : 'Bir saklanak bul ve boyanmaya hazırlan';
  } else if (st === 'prep') {
    if (me?.role === 'seeker') {
      title = 'Avcılar uyuyor';
      sub = `Av başlamasına ${Math.ceil(world.phaseLeft)} sn`;
    } else {
      title = 'Saklan & Boyan!';
      sub = `Damlalık: Boşluk / dokun · ${Math.ceil(world.phaseLeft)} sn`;
    }
  }
  const showBanner = st === 'countdown' || st === 'prep';
  const key = `${showBanner ? 1 : 0}|${title}|${sub}`;
  if (key === bannerKey) return;
  bannerKey = key;
  if (showBanner) {
    bannerTitle.textContent = title;
    bannerSub.textContent = sub;
    banner.classList.remove('km-banner--hidden');
  } else {
    banner.classList.add('km-banner--hidden');
  }
}

// ---- HUD --------------------------------------------------------------------

const PHASE_LABEL: Record<Status, string> = {
  menu: 'Menü',
  waiting: 'Lobi',
  connecting: 'Bağlanıyor',
  countdown: 'Başlıyor',
  prep: 'Hazırlık',
  hunt: 'Avlanma',
  over: 'Bitti',
};

function syncHud(): void {
  const me = myPlayer();
  roleEl.textContent = me ? roleLabel(me.role) : roleLabel(chosenRole);
  phaseEl.textContent = PHASE_LABEL[world.status] ?? '';
  if (world.status === 'prep' || world.status === 'hunt' || world.status === 'countdown') {
    timeEl.textContent = fmtTime(world.phaseLeft);
  } else if (world.status === 'menu' || world.status === 'waiting') {
    timeEl.textContent = fmtTime(HUNT_S);
  } else {
    timeEl.textContent = '—';
  }
  scoreEl.textContent = String(me ? Math.round(me.score) : 0);

  const isHider = !!me && me.role === 'hider' && !me.caught;
  const inMatch = world.status === 'prep' || world.status === 'hunt';
  if (isHider && inMatch) {
    blendWrap.style.display = '';
    const hidden = Math.max(0, Math.min(1, 1 - me!.visible));
    blendBar.style.width = `${Math.round(hidden * 100)}%`;
    blendBar.style.background = hidden > 0.66 ? '#4ade80' : hidden > 0.33 ? '#facc15' : '#f87171';
  } else {
    blendWrap.style.display = 'none';
  }

  const key = world.feed.join('|');
  if (key !== feedKey) {
    feedKey = key;
    feedEl.textContent = '';
    for (const line of world.feed) {
      const li = document.createElement('li');
      li.textContent = line;
      feedEl.appendChild(li);
    }
  }
}

// ---- fullscreen (erime-arena pattern) ---------------------------------------

const FS_MAX = 'km-root--max';

function fsActive(): boolean {
  return document.fullscreenElement === kmRoot || kmRoot.classList.contains(FS_MAX);
}

function syncFs(): void {
  const active = fsActive();
  fsBtn.textContent = active ? '🗗' : '⛶';
  fsBtn.setAttribute('aria-label', active ? 'Tam ekrandan çık' : 'Tam ekran');
  resizeScene();
}

function enterFullscreen(): void {
  if (fsActive()) return;
  const req = kmRoot.requestFullscreen?.();
  if (req && typeof req.then === 'function') {
    req.then(syncFs).catch(() => {
      kmRoot.classList.add(FS_MAX);
      syncFs();
    });
  } else {
    kmRoot.classList.add(FS_MAX);
    syncFs();
  }
}

function exitFullscreen(): void {
  if (document.fullscreenElement === kmRoot) {
    const r = document.exitFullscreen?.();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  }
  kmRoot.classList.remove(FS_MAX);
  syncFs();
}

// ---- main loop --------------------------------------------------------------

function tick(dt: number): void {
  const playing = world.status === 'prep' || world.status === 'hunt';

  if (mode === 'online-guest') {
    input.read(playing ? guestInput : discardInput);
    if (playing && room) {
      const now = performance.now();
      if (guestInput.fire || now - lastInputAt >= INPUT_MS) {
        lastInputAt = now;
        room.send('input', encodeInput(guestInput));
        guestInput.fire = false;
      }
    }
    easeGuestPlayers(dt);
  } else {
    // Host (or idle attract): run the authoritative simulation.
    const me = myPlayer();
    if (playing && me) {
      input.read(me.input);
      if (!input.hasAim()) {
        me.input.aimX = me.x + Math.sin(me.yaw) * 8;
        me.input.aimZ = me.z + Math.cos(me.yaw) * 8;
      }
    } else {
      input.read(discardInput);
      discardInput.fire = false;
    }
    simAcc += dt;
    let steps = 0;
    while (simAcc >= SIM_DT && steps < MAX_SUBSTEPS) {
      step(world, SIM_DT);
      simAcc -= SIM_DT;
      steps++;
    }
    if (simAcc > SIM_DT) simAcc = 0;

    if (mode === 'online-host' && room && started) {
      const now = performance.now();
      if (now - lastSnapAt >= SNAP_MS) {
        lastSnapAt = now;
        room.send('state', encodeSnapshot(world));
      }
    }
  }

  syncHud();
  syncBanner();
  syncOverlay();

  const me = myPlayer();
  const aim =
    playing && me
      ? mode === 'online-guest'
        ? { x: guestInput.aimX, z: guestInput.aimZ }
        : { x: me.input.aimX, z: me.input.aimZ }
      : null;
  renderScene(world, dt, myId, aim);
}

function startLoop(): void {
  const myGen = gen.current();
  let last = performance.now();
  const frame = (now: number): void => {
    if (!gen.isCurrent(myGen) || halted) return;
    let dt = (now - last) / 1000;
    last = now;
    if (dt > FRAME_DT_CLAMP) dt = FRAME_DT_CLAMP;
    try {
      tick(dt);
    } catch {
      halted = true;
      setStatus('⚠️ Bir hata oluştu · Menü ile yeniden başlat');
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---- lifecycle --------------------------------------------------------------

function backToMenu(): void {
  gen.bump();
  halted = false;
  teardownRoom();
  mode = 'idle';
  netTargets.clear();
  startAttract();
  overlayTitle.textContent = 'Kamuflaj';
  overlayMsg.textContent = channelEnabled()
    ? 'Vücudunu çevreye boya, kıpırdamadan dur ve avcının dilinden kaç. Bir oda kur ve arkadaşlarını çağır.'
    : 'Kamuflaj çok oyunculu bir saklambaçtır ve çevrimiçi bir sunucu gerektirir.';
  bannerKey = '';
  banner.classList.add('km-banner--hidden');
  lastShownStatus = null;
  syncOverlay(true);
  // This status rewrite is also the smoke test's boot signal (contains '·').
  if (!isWebglOk()) setStatus('⚠️ 3B desteklenmiyor · oyun yine de çalışır');
  else if (channelEnabled()) setStatus('⚪ Hazır · oda kur ve arkadaşlarını çağır');
  else setStatus('⚠️ Çok oyunculu · sunucu yapılandırılmamış');
  startLoop();
}

function reset(): void {
  backToMenu();
}

function setRole(role: Role): void {
  chosenRole = role;
  safeWrite(STORAGE_ROLE, role);
  syncRoleToggle();
}

function init(): void {
  kmRoot = document.querySelector<HTMLElement>('#km-root')!;
  canvas = document.querySelector<HTMLCanvasElement>('#gl')!;
  roleEl = document.querySelector<HTMLElement>('#role')!;
  phaseEl = document.querySelector<HTMLElement>('#phase')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  feedEl = document.querySelector<HTMLElement>('#feed')!;
  blendWrap = document.querySelector<HTMLElement>('#blend')!;
  blendBar = document.querySelector<HTMLElement>('#blend-bar')!;
  banner = document.querySelector<HTMLElement>('#banner')!;
  bannerTitle = document.querySelector<HTMLElement>('#banner-title')!;
  bannerSub = document.querySelector<HTMLElement>('#banner-sub')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  nameInput = document.querySelector<HTMLInputElement>('#name')!;
  roleToggle = document.querySelector<HTMLElement>('#role-toggle')!;
  roleHideBtn = document.querySelector<HTMLButtonElement>('#role-hide')!;
  roleSeekBtn = document.querySelector<HTMLButtonElement>('#role-seek')!;
  menuActions = document.querySelector<HTMLElement>('#menu-actions')!;
  createBtn = document.querySelector<HTMLButtonElement>('#create')!;
  shareBox = document.querySelector<HTMLElement>('#share')!;
  shareRowWrap = document.querySelector<HTMLElement>('#share-row-wrap')!;
  shareLinkInput = document.querySelector<HTMLInputElement>('#share-link')!;
  copyBtn = document.querySelector<HTMLButtonElement>('#copy')!;
  lobbyCountEl = document.querySelector<HTMLElement>('#lobby-count')!;
  lobbyNote = document.querySelector<HTMLElement>('#lobby-note')!;
  lobbyStartBtn = document.querySelector<HTMLButtonElement>('#lobby-start')!;
  overPanel = document.querySelector<HTMLElement>('#over-panel')!;
  boardList = document.querySelector<HTMLOListElement>('#board-list')!;
  rematchBtn = document.querySelector<HTMLButtonElement>('#rematch')!;
  toMenuBtn = document.querySelector<HTMLButtonElement>('#to-menu')!;
  fsBtn = document.querySelector<HTMLButtonElement>('#fs')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  myName = safeRead<string>(STORAGE_NAME, '') || 'Sen';
  if (myName !== 'Sen') nameInput.value = myName;
  chosenRole = safeRead<Role>(STORAGE_ROLE, 'hider') === 'seeker' ? 'seeker' : 'hider';
  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  input = createLocalInput({
    canvas,
    stick: document.querySelector<HTMLElement>('#stick')!,
    nub: document.querySelector<HTMLElement>('#stick-nub')!,
    actionBtn: document.querySelector<HTMLButtonElement>('#action')!,
    toWorld,
  });
  input.attach();

  initScene(canvas, input.isCoarse);
  if (!isWebglOk()) setStatus('⚠️ 3B görüntü desteklenmiyor · oyun yine de çalışır');

  roleHideBtn.addEventListener('click', () => setRole('hider'));
  roleSeekBtn.addEventListener('click', () => setRole('seeker'));
  createBtn.addEventListener('click', () => {
    void createRoom();
    if (input.isCoarse && !fsActive() && channelEnabled()) enterFullscreen();
  });
  lobbyStartBtn.addEventListener('click', hostStart);
  rematchBtn.addEventListener('click', () => {
    if (mode === 'online-host') beginMatch(rosterFromMembers());
  });
  toMenuBtn.addEventListener('click', backToMenu);
  restartBtn.addEventListener('click', backToMenu);
  copyBtn.addEventListener('click', () => {
    shareLinkInput.select();
    try {
      void navigator.clipboard?.writeText(shareLinkInput.value);
      copyBtn.textContent = 'Kopyalandı ✓';
      window.setTimeout(() => {
        copyBtn.textContent = 'Kopyala';
      }, 1500);
    } catch {
      // Clipboard unavailable (insecure context / iframe); link stays selected.
    }
  });
  fsBtn.addEventListener('click', () => {
    if (fsActive()) exitFullscreen();
    else enterFullscreen();
  });
  document.addEventListener('fullscreenchange', syncFs);

  // Keyboard fallback for the menu (pitfall: unreachable-start-state): Enter or
  // Space opens a room when the backend is available.
  window.addEventListener('keydown', (e) => {
    if (world.status !== 'menu' || !channelEnabled()) return;
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (e.key === 'Enter' || (!typing && e.key === ' ')) {
      e.preventDefault();
      void createRoom();
    }
  });

  window.addEventListener('resize', resizeScene);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => resizeScene()).observe(canvas);
  }

  startAttract();
  const code = getRoomFromUrl();
  if (code && channelEnabled()) {
    startLoop();
    void joinRoomAsGuest(code);
  } else if (code && !channelEnabled()) {
    backToMenu();
    overlayMsg.textContent =
      'Bu bağlantı çevrimiçi bir oda içindi ama sunucu yapılandırılmamış.';
  } else {
    backToMenu();
  }
}

export const game = defineGame({ init, reset });
