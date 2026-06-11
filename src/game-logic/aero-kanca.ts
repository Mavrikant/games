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
  INPUT_MS,
  MATCH_S,
  MAX_HUMANS,
  MAX_SUBSTEPS,
  PALETTE,
  SIM_DT,
  SNAP_MS,
  TOTAL_CRAFTS,
  BOT_NAMES,
} from './aero-kanca/constants';
import { freshInput, freshWorld, makeCraft, setupMatch, step } from './aero-kanca/world';
import { driveBots, resetBotMinds } from './aero-kanca/bots';
import {
  decodeHello,
  decodeInput,
  decodeSnapshot,
  decodeStart,
  encodeInput,
  encodeSnapshot,
  encodeStart,
} from './aero-kanca/net';
import {
  buildArena,
  initScene,
  isWebglOk,
  render as renderScene,
  resetCamera,
  resize as resizeScene,
  toWorld,
} from './aero-kanca/scene';
import { createLocalInput } from './aero-kanca/input';
import type { LocalInput } from './aero-kanca/input';
import type { Craft, Mode, Snapshot, Status, World } from './aero-kanca/types';

// 3D hovercraft arena over floating sky islands. Host-authoritative online
// rooms (yilan-duello pattern) with AI bots filling every empty slot; fully
// playable offline. PITFALLS honored throughout — see the per-module headers.

const STORAGE_BEST = 'aero-kanca.best';
const STORAGE_NAME = 'aero-kanca.name';
const SCORE_DESC: ScoreDescriptor = {
  gameId: 'aero-kanca',
  storageKey: STORAGE_BEST,
  direction: 'higher',
};

const gen = createGenToken();
let world: World = freshWorld();
let mode: Mode = 'idle';
let room: ChannelHandle | null = null;
let roomCode = '';
let started = false; // host: has a match begun?
let myId = 'me';
let myName = 'Sen';
let best = 0;
let halted = false;

const guestNames = new Map<string, string>();
let gotStart = false; // guest: ignore snapshots until the host's 'start'
let lastSnapAt = 0;
let lastInputAt = 0;
let simAcc = 0;
let lastShownStatus: Status | null = null;
let reportedOver = false;
let feedKey = '';

let input!: LocalInput;
const guestInput = freshInput(); // guest's local input, mirrored to the host
const discardInput = freshInput(); // drains edges while not playing

// DOM refs (filled in init()).
let akRoot!: HTMLElement;
let canvas!: HTMLCanvasElement;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let statusEl!: HTMLElement;
let feedEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let nameInput!: HTMLInputElement;
let menuActions!: HTMLElement;
let botsBtn!: HTMLButtonElement;
let createBtn!: HTMLButtonElement;
let shareBox!: HTMLElement;
let shareLinkInput!: HTMLInputElement;
let copyBtn!: HTMLButtonElement;
let soloStartBtn!: HTMLButtonElement;
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

function myCraft(): Craft | null {
  for (const c of world.crafts) if (c.id === myId) return c;
  return null;
}

function fmtTime(s: number): string {
  const total = Math.ceil(s);
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

function botRoster(fromSlot: number): { id: string; name: string; hue: number; bot: boolean }[] {
  const list: { id: string; name: string; hue: number; bot: boolean }[] = [];
  for (let i = fromSlot; i < TOTAL_CRAFTS; i++) {
    list.push({
      id: `bot${i}`,
      name: BOT_NAMES[(i - 1 + BOT_NAMES.length) % BOT_NAMES.length]!,
      hue: PALETTE[i % PALETTE.length]!,
      bot: true,
    });
  }
  return list;
}

// ---- match flow ----------------------------------------------------------------

/** Menu backdrop: an all-bot skirmish renders behind the overlay so the page
 *  shows live gameplay immediately (pitfall: invisible-boot). */
function startAttract(): void {
  world = freshWorld();
  world.mode = 'idle';
  resetBotMinds();
  setupMatch(
    world,
    Array.from({ length: TOTAL_CRAFTS }, (_, i) => ({
      id: `bot${i}`,
      name: BOT_NAMES[i % BOT_NAMES.length]!,
      hue: PALETTE[i % PALETTE.length]!,
      bot: true,
    })),
  );
  world.status = 'menu';
  buildArena(world);
  resetCamera();
}

function beginMatch(roster: { id: string; name: string; hue: number; bot: boolean }[]): void {
  resetBotMinds();
  setupMatch(world, roster);
  world.mode = mode;
  reportedOver = false;
  lastShownStatus = null;
  buildArena(world);
  resetCamera();
  if (mode === 'online-host' && room) {
    room.send('start', encodeStart(world));
  }
}

function startBots(): void {
  saveName();
  teardownRoom();
  mode = 'bots';
  myId = 'me';
  setStatus('⚪ Botlara karşı · 2 dakikada en yüksek skor');
  beginMatch([{ id: myId, name: myName, hue: PALETTE[0]!, bot: false }, ...botRoster(1)]);
}

function teardownRoom(): void {
  if (room) {
    room.leave();
    room = null;
  }
  guestNames.clear();
  started = false;
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

// ---- host networking -------------------------------------------------------------

function humanCount(): number {
  let n = 0;
  for (const c of world.crafts) if (!c.bot) n++;
  return n;
}

/** Host: hand the longest-lived bot slot to a newly arrived guest. */
function adoptGuest(id: string): void {
  if (world.crafts.some((c) => c.id === id)) return;
  if (humanCount() >= MAX_HUMANS) {
    room?.send('full', { id });
    return;
  }
  for (const c of world.crafts) {
    if (c.bot) {
      c.bot = false;
      c.id = id;
      c.name = guestNames.get(id) ?? 'Misafir';
      c.input = freshInput();
      addJoinFeed(`${c.name} katıldı`);
      buildArena(world); // craft meshes are keyed by id
      if (room) room.send('start', encodeStart(world));
      return;
    }
  }
  room?.send('full', { id });
}

/** Host: a guest left — its craft reverts to a bot. */
function dropGuest(id: string): void {
  for (let i = 0; i < world.crafts.length; i++) {
    const c = world.crafts[i]!;
    if (c.id === id && !c.bot) {
      addJoinFeed(`${c.name} ayrıldı`);
      c.bot = true;
      c.id = `bot${i}`;
      c.name = BOT_NAMES[i % BOT_NAMES.length]!;
      c.input = freshInput();
      buildArena(world); // craft meshes are keyed by id
      if (room) room.send('start', encodeStart(world));
      return;
    }
  }
}

function addJoinFeed(line: string): void {
  world.feed.unshift(line);
  if (world.feed.length > 3) world.feed.length = 3;
}

/** Drop back to the menu (fresh attract world) with an explanatory message.
 *  Used by every network failure path — unlike backToMenu() it neither bumps
 *  the gen token (the rAF loop keeps running; these fire from net callbacks)
 *  nor overwrites the custom title/message. */
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

async function createRoom(): Promise<void> {
  saveName();
  if (!channelEnabled()) {
    startBots();
    return;
  }
  teardownRoom();
  mode = 'online-host';
  roomCode = randomCode();
  shareLinkInput.value = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  world.status = 'waiting';
  syncOverlay(true);
  setStatus('🟡 Odaya bağlanılıyor…');
  const myGen = gen.current();
  const handle = await joinChannel(
    `aero-kanca:${roomCode}`,
    { role: 'host', name: myName },
    {
      onEvent: (event, data, from) => {
        if (mode !== 'online-host') return;
        if (event === 'hello') {
          const n = decodeHello(data);
          if (n) {
            guestNames.set(from, n);
            const c = world.crafts.find((cr) => cr.id === from);
            if (c) c.name = n;
          }
        } else if (event === 'input' && started) {
          const msg = decodeInput(data);
          const c = world.crafts.find((cr) => cr.id === from);
          if (msg && c && !c.bot) {
            c.input.mx = msg.mx;
            c.input.mz = msg.mz;
            c.input.aimX = msg.ax;
            c.input.aimZ = msg.az;
            c.input.held = msg.held;
            if (msg.fire) c.input.fire = true;
            if (msg.release) c.input.release = true;
          }
        }
      },
      onPresence: (ids) => {
        if (mode !== 'online-host' || !room) return;
        const guests = ids.filter((id) => id !== room!.id);
        if (!started && guests.length > 0) {
          started = true;
          myId = room!.id;
          beginMatch([
            { id: myId, name: myName, hue: PALETTE[0]!, bot: false },
            ...botRoster(1),
          ]);
          for (const g of guests) adoptGuest(g);
        } else if (started) {
          for (const g of guests) adoptGuest(g);
        }
      },
      onLeave: (id) => {
        if (mode === 'online-host' && started) dropGuest(id);
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
      'Çevrimiçi sunucuya ulaşılamadı. Botlara karşı oynayabilirsin.',
      '⚠️ Bağlanılamadı · botlarla oyna',
    );
    return;
  }
  room = handle;
  myId = handle.id;
  setStatus('🟢 Oda hazır · arkadaşlarını bekle');
  // Guests may already be present (rejoin while we re-subscribed).
  if (handle.peerCount() > 0) {
    started = true;
    beginMatch([{ id: myId, name: myName, hue: PALETTE[0]!, bot: false }, ...botRoster(1)]);
    for (const id of handle.members()) if (id !== handle.id) adoptGuest(id);
  }
}

// ---- guest networking --------------------------------------------------------------

function applyStart(data: unknown): void {
  const start = decodeStart(data);
  if (!start) return;
  world = freshWorld();
  world.mode = 'online-guest';
  world.islands = start.islands;
  world.crafts = start.roster.map((r) => makeCraft(r.id, r.name, r.hue, r.bot));
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
  world.count = snap.ct;
  world.left = snap.lf;
  world.feed = snap.fd.slice(0, 3);
  world.winner = snap.wn;
  // The collapse schedule keys off world.t; the guest reconstructs it from
  // the match clock so liveOf() gives both peers the same island geometry.
  world.t = snap.st === 'playing' || snap.st === 'over' ? Math.max(0, MATCH_S - snap.lf) : 0;
  for (const nc of snap.cr) {
    let c = world.crafts.find((cr) => cr.id === nc.id);
    if (!c) {
      c = makeCraft(nc.id, nc.nm, nc.hu, false);
      world.crafts.push(c);
      buildArena(world);
    }
    c.name = nc.nm;
    c.alive = nc.al === 1;
    c.protectIn = nc.pr === 1 ? 1 : 0;
    c.pts = nc.pt;
    c.kos = nc.ko;
    // Dead-reckoning targets: store server pos in tx/tz via closure-free maps
    netTargets.set(nc.id, {
      x: nc.x,
      y: nc.y,
      z: nc.z,
      vx: nc.vx,
      vy: nc.vy,
      vz: nc.vz,
      yaw: nc.yw,
    });
    if (typeof nc.hx === 'number' && typeof nc.hy === 'number' && typeof nc.hz === 'number') {
      c.hook = {
        kind: nc.ht ? 'craft' : 'rock',
        x: nc.hx,
        y: nc.hy,
        z: nc.hz,
        victimId: nc.ht ?? null,
        len: 0,
        age: 0,
      };
    } else {
      c.hook = null;
    }
  }
  for (let i = 0; i < snap.ob.length && i < world.orbs.length; i++) {
    const o = snap.ob[i]!;
    world.orbs[i]!.x = o.x;
    world.orbs[i]!.y = o.y;
    world.orbs[i]!.z = o.z;
  }
  while (world.orbs.length < snap.ob.length) {
    const o = snap.ob[world.orbs.length]!;
    world.orbs.push({ x: o.x, y: o.y, z: o.z, island: 0 });
  }
}

const netTargets = new Map<
  string,
  { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number }
>();

/** Guest render integration: dead-reckon from the last snapshot velocities. */
function easeGuestCrafts(dt: number): void {
  const k = Math.min(1, dt * 6);
  for (const c of world.crafts) {
    const t = netTargets.get(c.id);
    if (!t) continue;
    // Advance the target by its own velocity, then ease the craft onto it.
    t.x += t.vx * dt;
    t.y += t.vy * dt;
    t.z += t.vz * dt;
    c.x += (t.x - c.x) * k + t.vx * dt * (1 - k);
    c.y += (t.y - c.y) * Math.min(1, dt * 10);
    c.z += (t.z - c.z) * k + t.vz * dt * (1 - k);
    c.vx = t.vx;
    c.vy = t.vy;
    c.vz = t.vz;
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
    `aero-kanca:${code}`,
    { role: 'guest', name: myName },
    {
      onEvent: (event, data) => {
        if (mode !== 'online-guest') return;
        if (event === 'start') {
          applyStart(data);
        } else if (event === 'state') {
          if (!gotStart) return; // arena geometry arrives with 'start'
          const snap = decodeSnapshot(data);
          if (snap) applySnapshot(snap);
        } else if (event === 'full') {
          const d = data as { id?: unknown } | null;
          if (d && typeof d === 'object' && d.id === room?.id) {
            menuWithMessage(
              'Oda dolu',
              'Bu odada boş yer kalmamış. Botlara karşı oynayabilirsin.',
              '⚠️ Oda dolu · botlarla oyna',
            );
          }
        }
      },
      onPresence: () => {},
      onLeave: () => {
        // Everyone else (host included) left → the match can't continue.
        if (mode === 'online-guest' && room && room.peerCount() === 0) {
          menuWithMessage(
            'Bağlantı koptu',
            'Oda kurucusu ayrıldı. Yeni bir oda kurabilir veya botlarla oynayabilirsin.',
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
      'Çevrimiçi sunucuya ulaşılamadı. Botlara karşı oynayabilirsin.',
      '⚠️ Bağlanılamadı · botlarla oyna',
    );
    return;
  }
  room = handle;
  myId = handle.id;
  room.send('hello', { name: myName });
  setStatus('🟢 Bağlandı · maç başlıyor');
}

// ---- overlay ---------------------------------------------------------------------

function show(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
}
function hide(el: HTMLElement, cls: string): void {
  el.classList.add(cls);
}

function showMenuPanels(): void {
  show(menuActions, 'ak-actions--hidden');
  hide(shareBox, 'ak-share--hidden');
  hide(overPanel, 'ak-over--hidden');
  nameInput.style.display = '';
  createBtn.style.display = channelEnabled() ? '' : 'none';
}

function syncOverlay(force = false): void {
  const st = world.status;
  if (!force && st === lastShownStatus) {
    if (st === 'countdown') overlayTitle.textContent = String(Math.max(1, Math.ceil(world.count)));
    return;
  }
  if (st === 'menu') {
    if (lastShownStatus !== 'menu' || force) {
      overlayTitle.textContent = overlayTitle.textContent || 'AeroKanca';
      showMenuPanels();
      showOverlay(overlay);
    }
  } else if (st === 'waiting') {
    overlayTitle.textContent = 'Oda kuruldu';
    overlayMsg.textContent =
      'Bağlantıyı arkadaşlarına gönder; ilk oyuncu katılınca maç başlar. Boş yerleri botlar doldurur.';
    hide(menuActions, 'ak-actions--hidden');
    hide(overPanel, 'ak-over--hidden');
    show(shareBox, 'ak-share--hidden');
    nameInput.style.display = 'none';
    showOverlay(overlay);
  } else if (st === 'connecting') {
    overlayTitle.textContent = 'Bağlanılıyor…';
    overlayMsg.textContent = 'Oda kurucusuna bağlanılıyor, maç birazdan başlayacak.';
    hide(menuActions, 'ak-actions--hidden');
    hide(shareBox, 'ak-share--hidden');
    hide(overPanel, 'ak-over--hidden');
    nameInput.style.display = 'none';
    showOverlay(overlay);
  } else if (st === 'countdown') {
    overlayTitle.textContent = String(Math.max(1, Math.ceil(world.count)));
    overlayMsg.textContent = 'Kancanı hazırla…';
    hide(menuActions, 'ak-actions--hidden');
    hide(shareBox, 'ak-share--hidden');
    hide(overPanel, 'ak-over--hidden');
    nameInput.style.display = 'none';
    showOverlay(overlay);
  } else if (st === 'playing') {
    hideOverlay(overlay);
  } else if (st === 'over') {
    showOverPanel();
  }
  lastShownStatus = st;
}

function showOverPanel(): void {
  const me = myCraft();
  const ranked = [...world.crafts].sort((a, b) => b.pts - a.pts);
  overlayTitle.textContent =
    world.winner === '' ? 'Berabere!' : world.winner === (me?.name ?? '') ? 'Kazandın! 🏆' : `${world.winner ?? '—'} kazandı`;
  overlayMsg.textContent = 'Maç bitti.';
  boardList.textContent = '';
  for (const c of ranked) {
    const li = document.createElement('li');
    li.textContent = `${c.name} — ${c.pts} puan · ${c.kos} düşürme`;
    if (c.id === myId) li.className = 'ak-board__me';
    boardList.appendChild(li);
  }
  hide(menuActions, 'ak-actions--hidden');
  hide(shareBox, 'ak-share--hidden');
  show(overPanel, 'ak-over--hidden');
  nameInput.style.display = 'none';
  rematchBtn.style.display = mode === 'online-guest' ? 'none' : '';
  if (mode === 'online-guest') overlayMsg.textContent = 'Maç bitti · kurucunun yeniden başlatması bekleniyor.';
  showOverlay(overlay);

  if (!reportedOver && me) {
    reportedOver = true;
    if (me.pts > best) {
      best = me.pts;
      bestEl.textContent = String(best);
    }
    reportGameOver(SCORE_DESC, me.pts, { label: 'Skor' });
  }
}

// ---- HUD / feed --------------------------------------------------------------------

function syncHud(): void {
  const me = myCraft();
  scoreEl.textContent = String(me ? me.pts : 0);
  timeEl.textContent = world.status === 'menu' ? '2:00' : fmtTime(world.left);
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

// ---- fullscreen (erime-arena pattern: native API + CSS fallback for iOS) -------------

const FS_MAX = 'ak-root--max';

function fsActive(): boolean {
  return document.fullscreenElement === akRoot || akRoot.classList.contains(FS_MAX);
}

function syncFs(): void {
  const active = fsActive();
  fsBtn.textContent = active ? '🗗' : '⛶';
  fsBtn.setAttribute('aria-label', active ? 'Tam ekrandan çık' : 'Tam ekran');
  resizeScene();
}

function enterFullscreen(): void {
  if (fsActive()) return;
  const req = akRoot.requestFullscreen?.();
  if (req && typeof req.then === 'function') {
    req.then(syncFs).catch(() => {
      akRoot.classList.add(FS_MAX);
      syncFs();
    });
  } else {
    akRoot.classList.add(FS_MAX);
    syncFs();
  }
}

function exitFullscreen(): void {
  if (document.fullscreenElement === akRoot) {
    const r = document.exitFullscreen?.();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  }
  akRoot.classList.remove(FS_MAX);
  syncFs();
}

// ---- main loop -----------------------------------------------------------------------

function tick(dt: number): void {
  const playing = world.status === 'playing';

  if (mode === 'online-guest') {
    // Read local input; mirror it to the host (throttled; edges immediately).
    input.read(playing ? guestInput : discardInput);
    if (playing && room) {
      const now = performance.now();
      if (guestInput.fire || guestInput.release || now - lastInputAt >= INPUT_MS) {
        lastInputAt = now;
        room.send('input', encodeInput(guestInput));
        guestInput.fire = false;
        guestInput.release = false;
      }
    }
    easeGuestCrafts(dt);
  } else {
    // Local simulation (host / bots / attract).
    const me = myCraft();
    if (playing && me && !me.bot) {
      input.read(me.input);
      if (!input.hasAim()) {
        // No pointer yet (or WebGL off): aim straight ahead of the craft.
        me.input.aimX = me.x + Math.sin(me.yaw) * 12;
        me.input.aimZ = me.z + Math.cos(me.yaw) * 12;
      }
    } else {
      input.read(discardInput);
      discardInput.fire = false;
      discardInput.release = false;
    }
    driveBots(world);
    simAcc += dt;
    let steps = 0;
    while (simAcc >= SIM_DT && steps < MAX_SUBSTEPS) {
      step(world, SIM_DT);
      simAcc -= SIM_DT;
      steps++;
    }
    if (simAcc > SIM_DT) simAcc = 0; // tab was hidden: drop the backlog

    if (mode === 'online-host' && room && started) {
      const now = performance.now();
      if (now - lastSnapAt >= SNAP_MS) {
        lastSnapAt = now;
        room.send('state', encodeSnapshot(world));
      }
    }
  }

  syncHud();
  syncOverlay();

  const me = myCraft();
  const aim =
    playing && me && input.hasAim()
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
      // Never let an exception reach the console (smoke gate). Freeze the
      // loop and surface a recoverable message instead.
      halted = true;
      setStatus('⚠️ Bir hata oluştu · Menü ile yeniden başlat');
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---- lifecycle -------------------------------------------------------------------------

function backToMenu(): void {
  gen.bump();
  halted = false;
  teardownRoom();
  mode = 'idle';
  netTargets.clear();
  startAttract();
  overlayTitle.textContent = 'AeroKanca';
  overlayMsg.textContent = channelEnabled()
    ? 'Kancanı kayalara saplayıp savrul, rakipleri boşluğa fırlat. Bir oda kur ya da botlarla oyna.'
    : 'Kancanı kayalara saplayıp savrul, rakipleri boşluğa fırlat. Botlara karşı oyna.';
  lastShownStatus = null;
  syncOverlay(true);
  // This rewrite is also the smoke test's boot signal (always contains '·').
  if (!isWebglOk()) setStatus('⚠️ 3B desteklenmiyor · oyun yine de oynanır');
  else if (channelEnabled()) setStatus('⚪ Hazır · oda kur veya botlarla oyna');
  else setStatus('⚪ Çevrimdışı · botlarla oyna');
  startLoop();
}

function reset(): void {
  backToMenu();
}

function init(): void {
  akRoot = document.querySelector<HTMLElement>('#ak-root')!;
  canvas = document.querySelector<HTMLCanvasElement>('#gl')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  feedEl = document.querySelector<HTMLElement>('#feed')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  nameInput = document.querySelector<HTMLInputElement>('#name')!;
  menuActions = document.querySelector<HTMLElement>('#menu-actions')!;
  botsBtn = document.querySelector<HTMLButtonElement>('#bots')!;
  createBtn = document.querySelector<HTMLButtonElement>('#create')!;
  shareBox = document.querySelector<HTMLElement>('#share')!;
  shareLinkInput = document.querySelector<HTMLInputElement>('#share-link')!;
  copyBtn = document.querySelector<HTMLButtonElement>('#copy')!;
  soloStartBtn = document.querySelector<HTMLButtonElement>('#solo-start')!;
  overPanel = document.querySelector<HTMLElement>('#over-panel')!;
  boardList = document.querySelector<HTMLOListElement>('#board-list')!;
  rematchBtn = document.querySelector<HTMLButtonElement>('#rematch')!;
  toMenuBtn = document.querySelector<HTMLButtonElement>('#to-menu')!;
  fsBtn = document.querySelector<HTMLButtonElement>('#fs')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  myName = safeRead<string>(STORAGE_NAME, '') || 'Sen';
  if (myName !== 'Sen') nameInput.value = myName;
  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  input = createLocalInput({
    canvas,
    stick: document.querySelector<HTMLElement>('#stick')!,
    nub: document.querySelector<HTMLElement>('#stick-nub')!,
    hookBtn: document.querySelector<HTMLButtonElement>('#hook')!,
    toWorld,
  });
  input.attach();

  initScene(canvas, input.isCoarse);
  if (!isWebglOk()) {
    setStatus('⚠️ 3B görüntü desteklenmiyor · oyun yine de çalışır');
  }

  // Buttons.
  botsBtn.addEventListener('click', () => {
    startBots();
    if (input.isCoarse && !fsActive()) enterFullscreen();
  });
  createBtn.addEventListener('click', () => void createRoom());
  soloStartBtn.addEventListener('click', () => {
    if (mode === 'online-host' && !started && room) {
      started = true;
      beginMatch([{ id: myId, name: myName, hue: PALETTE[0]!, bot: false }, ...botRoster(1)]);
    }
  });
  rematchBtn.addEventListener('click', () => {
    if (mode === 'bots') startBots();
    else if (mode === 'online-host') {
      const roster = world.crafts.map((c) => ({ id: c.id, name: c.name, hue: c.hue, bot: c.bot }));
      beginMatch(roster);
    }
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
      // Clipboard can be unavailable (insecure context / iframe); the link
      // stays selected for manual copy.
    }
  });
  fsBtn.addEventListener('click', () => {
    if (fsActive()) exitFullscreen();
    else enterFullscreen();
  });
  document.addEventListener('fullscreenchange', syncFs);

  // Keyboard fallback for the menu (pitfall: unreachable-start-state).
  window.addEventListener('keydown', (e) => {
    if (world.status !== 'menu') return;
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (e.key === 'Enter' || (!typing && e.key === ' ')) {
      e.preventDefault();
      startBots();
    }
  });

  window.addEventListener('resize', resizeScene);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => resizeScene()).observe(canvas);
  }

  // Boot: auto-join via share link, else menu + attract mode. The status
  // rewrite (backToMenu/menuWithMessage) doubles as the smoke test's boot
  // signal — it always contains "·".
  startAttract();
  const code = getRoomFromUrl();
  if (code && channelEnabled()) {
    startLoop();
    void joinRoomAsGuest(code);
  } else if (code && !channelEnabled()) {
    backToMenu();
    overlayMsg.textContent =
      'Bu bağlantı çevrimiçi bir oda içindi ama sunucu yapılandırılmamış. Botlara karşı oynayabilirsin.';
  } else {
    backToMenu();
  }
}

export const game = defineGame({ init, reset });
