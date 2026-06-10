import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { joinChannel, channelEnabled } from '@shared/realtime-channel';
import type { ChannelHandle } from '@shared/realtime-channel';

// Two-player online snake duel.
//
// Networking model: HOST-AUTHORITATIVE. The player who creates the room (host,
// snake P1 / green) runs the entire simulation and broadcasts the full world
// state each tick. The player who joins via the shared link (guest, snake P2 /
// blue) only sends its desired direction and renders whatever the host sends.
// This makes the two screens impossible to diverge — there is one source of
// truth — at the cost of ~1 tick of input latency for the guest, which is fine
// for a grid snake.
//
// Offline / unconfigured: when Supabase isn't set up (channelEnabled() false)
// or the connection fails, the game is fully playable against a local AI
// opponent. This keeps it smoke-test-safe (the network is blocked there) and
// playtestable without a backend. See docs/PITFALLS.md:
//   - realtime-must-degrade-silently: joinChannel returns null → AI fallback.
//   - module-level-dom-access: every querySelector lives in init().
//   - unguarded-storage: safeRead/safeWrite wrap localStorage.
//   - stale-async-callback: gen.bump() cancels the RAF + tick loop on reset.
//   - overlay-input-leak: input is gated by `mode` + `net.status`.
//   - missing-overlay-css: yilan-duello.css defines .overlay--hidden.
//   - hud-counter-synced-only-at-lifecycle-edges: HUD redrawn every render.

// ---- grid / tuning --------------------------------------------------------
const COLS = 19;
const ROWS = 19;
const TICK_MS = 130;
const COUNTDOWN_START = 3;
const STORAGE_NAME = 'yilan-duello.name';
const STORAGE_WINS = 'yilan-duello.wins';

type Cell = { x: number; y: number };
type DirName = 'up' | 'down' | 'left' | 'right';

const DIRS: Record<DirName, Cell> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// Which peer am I and what is running the simulation?
//   'idle'        → in the menu, nothing connected
//   'online-host' → I created the room; I simulate + broadcast
//   'online-guest'→ I joined a room; I render host state + send input
//   'ai'          → offline, I simulate locally vs an AI snake
type Mode = 'idle' | 'online-host' | 'online-guest' | 'ai';

type Status = 'menu' | 'waiting' | 'connecting' | 'countdown' | 'playing' | 'over';
type Winner = 'p1' | 'p2' | 'draw' | null;

interface SnakeNet {
  body: Cell[]; // head at index 0
  dir: DirName;
  alive: boolean;
  score: number;
  name: string;
}

// Full world snapshot — what the host broadcasts and the guest renders.
interface NetState {
  status: Status;
  count: number; // countdown remaining (3..1) while status === 'countdown'
  food: Cell;
  snakes: [SnakeNet, SnakeNet];
  winner: Winner;
}

// ---- module state ---------------------------------------------------------
const gen = createGenToken();
let mode: Mode = 'idle';

// The authoritative world (host/AI own it; guest mirrors the received copy).
let world: NetState = freshWorld();
// Buffered next direction for each snake (host applies these on the next tick).
let pending: [DirName, DirName] = ['right', 'left'];
// Guest's most recently received input (host side), and AI uses its own.
let tickHandle: number | null = null;

let room: ChannelHandle | null = null;
let roomCode = '';
let started = false; // host: has the match begun for the current guest?

let myName = 'Sen';
let wins = 0;

// DOM refs (filled in init()).
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreP1El!: HTMLElement;
let scoreP2El!: HTMLElement;
let statusEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let nameInput!: HTMLInputElement;
let menuActions!: HTMLElement;
let createBtn!: HTMLButtonElement;
let aiBtn!: HTMLButtonElement;
let shareBox!: HTMLElement;
let shareLinkInput!: HTMLInputElement;
let copyBtn!: HTMLButtonElement;
let overActions!: HTMLElement;
let rematchBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let dpad!: HTMLElement;

let cell = 18; // px per grid cell, recomputed on resize

// ---- helpers --------------------------------------------------------------
function freshSnakes(): [SnakeNet, SnakeNet] {
  const midY = Math.floor(ROWS / 2);
  const p1: SnakeNet = {
    body: [
      { x: 3, y: midY },
      { x: 2, y: midY },
      { x: 1, y: midY },
    ],
    dir: 'right',
    alive: true,
    score: 0,
    name: 'Yeşil',
  };
  const p2: SnakeNet = {
    body: [
      { x: COLS - 4, y: midY },
      { x: COLS - 3, y: midY },
      { x: COLS - 2, y: midY },
    ],
    dir: 'left',
    alive: true,
    score: 0,
    name: 'Mavi',
  };
  return [p1, p2];
}

function freshWorld(): NetState {
  const snakes = freshSnakes();
  return {
    status: 'menu',
    count: 0,
    food: { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) },
    snakes,
    winner: null,
  };
}

function eq(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

function occupied(world: NetState): Cell[] {
  const cells: Cell[] = [];
  for (const s of world.snakes) if (s.alive) cells.push(...s.body);
  return cells;
}

function placeFood(world: NetState): void {
  const taken = occupied(world);
  // Try random spots, then fall back to a scan so we never loop forever.
  for (let i = 0; i < 200; i++) {
    const c = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
    if (!taken.some((t) => eq(t, c))) {
      world.food = c;
      return;
    }
  }
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = { x, y };
      if (!taken.some((t) => eq(t, c))) {
        world.food = c;
        return;
      }
    }
  }
}

// Reject 180° reversals: a snake of length > 1 can't turn back on itself.
function validTurn(current: DirName, next: DirName): boolean {
  const c = DIRS[current];
  const n = DIRS[next];
  return !(c.x === -n.x && c.y === -n.y);
}

// ---- simulation (host / AI only) ------------------------------------------
function chooseAiDir(): DirName {
  const ai = world.snakes[1];
  const head = ai.body[0]!;
  const food = world.food;
  // Cells we must not enter next: both snakes' bodies (minus tails that move).
  const blocked = new Set<string>();
  for (const s of world.snakes) {
    if (!s.alive) continue;
    for (let i = 0; i < s.body.length - 1; i++) {
      const b = s.body[i]!;
      blocked.add(`${b.x},${b.y}`);
    }
  }
  const options: DirName[] = ['up', 'down', 'left', 'right'];
  const scored = options
    .filter((d) => validTurn(ai.dir, d))
    .map((d) => {
      const nx = head.x + DIRS[d].x;
      const ny = head.y + DIRS[d].y;
      const offBoard = nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS;
      const hits = blocked.has(`${nx},${ny}`);
      const safe = !offBoard && !hits;
      const dist = Math.abs(nx - food.x) + Math.abs(ny - food.y);
      return { d, safe, dist };
    });
  // Prefer a safe move that reduces distance to food; otherwise any safe move;
  // otherwise keep going (it'll die — fair).
  const safe = scored.filter((s) => s.safe).sort((a, b) => a.dist - b.dist);
  if (safe.length > 0) return safe[0]!.d;
  return ai.dir;
}

function stepWorld(): void {
  if (world.status === 'countdown') {
    world.count -= 1;
    if (world.count <= 0) world.status = 'playing';
    return;
  }
  if (world.status !== 'playing') return;

  // AI fills in P2's intent when offline.
  if (mode === 'ai') pending[1] = chooseAiDir();

  // 1. Apply buffered turns.
  for (let i = 0; i < 2; i++) {
    const s = world.snakes[i]!;
    if (s.alive && validTurn(s.dir, pending[i])) s.dir = pending[i];
  }

  // 2. Compute the post-move body for each snake.
  const ate: [boolean, boolean] = [false, false];
  const newBodies: Cell[][] = [[], []];
  for (let i = 0; i < 2; i++) {
    const s = world.snakes[i]!;
    if (!s.alive) {
      newBodies[i] = s.body;
      continue;
    }
    const head = s.body[0]!;
    const nh = { x: head.x + DIRS[s.dir].x, y: head.y + DIRS[s.dir].y };
    ate[i] = eq(nh, world.food);
    const body = [nh, ...s.body];
    if (!ate[i]) body.pop();
    newBodies[i] = body;
  }

  // 3. Resolve collisions from the post-move bodies.
  const head0 = newBodies[0]![0]!;
  const head1 = newBodies[1]![0]!;
  const s0 = world.snakes[0]!;
  const s1 = world.snakes[1]!;

  function dead(head: Cell, selfBody: Cell[], otherBody: Cell[], otherAlive: boolean): boolean {
    if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) return true;
    // self: skip index 0 (the head itself)
    for (let i = 1; i < selfBody.length; i++) if (eq(head, selfBody[i]!)) return true;
    if (otherAlive) for (const c of otherBody) if (eq(head, c)) return true;
    return false;
  }

  let dead0 = s0.alive && dead(head0, newBodies[0]!, newBodies[1]!, s1.alive);
  let dead1 = s1.alive && dead(head1, newBodies[1]!, newBodies[0]!, s0.alive);
  // Head-to-head into the same cell is a mutual crash (draw).
  if (s0.alive && s1.alive && eq(head0, head1)) {
    dead0 = true;
    dead1 = true;
  }

  // 4. Commit movement for snakes that survived; apply growth/score.
  if (s0.alive && !dead0) {
    s0.body = newBodies[0]!;
    if (ate[0]) s0.score += 1;
  }
  if (s1.alive && !dead1) {
    s1.body = newBodies[1]!;
    if (ate[1]) s1.score += 1;
  }
  if (dead0) s0.alive = false;
  if (dead1) s1.alive = false;

  // 5. Respawn food if eaten (and not in a death frame that ended the game).
  if ((ate[0] && !dead0) || (ate[1] && !dead1)) placeFood(world);

  // 6. End condition: someone died.
  if (dead0 || dead1) {
    world.status = 'over';
    if (dead0 && dead1) world.winner = 'draw';
    else if (dead0) world.winner = 'p2';
    else world.winner = 'p1';
    onMatchEnd();
  }
}

// Host/AI tick: advance the world, broadcast it, render it.
function hostTick(): void {
  stepWorld();
  broadcastState();
  syncOverlayFromWorld();
  if (world.status === 'over' && tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function startHostLoop(): void {
  if (tickHandle !== null) clearInterval(tickHandle);
  tickHandle = window.setInterval(hostTick, TICK_MS);
}

function onMatchEnd(): void {
  // Track a local "wins" tally only for the human (P1) outcomes.
  if (mode === 'ai' || mode === 'online-host') {
    if (world.winner === 'p1') {
      wins += 1;
      safeWrite(STORAGE_WINS, wins);
    }
  }
}

// ---- begin / reset a match (host + AI) ------------------------------------
function beginMatch(): void {
  world = freshWorld();
  world.snakes[0]!.name = myName;
  world.snakes[1]!.name = mode === 'ai' ? 'serpAI' : guestName || 'Mavi';
  pending = ['right', 'left'];
  world.status = 'countdown';
  world.count = COUNTDOWN_START;
  started = true;
  hideOverlayEl(overlay);
  startHostLoop();
  broadcastState();
}

// ---- networking glue ------------------------------------------------------
let guestName = '';

function broadcastState(): void {
  if (mode === 'online-host' && room) room.send('state', world);
}

function teardownRoom(): void {
  if (room) {
    room.leave();
    room = null;
  }
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  started = false;
}

function getRoomFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('room') ?? '';
  } catch {
    return '';
  }
}

function shareUrlFor(code: string): string {
  const base = window.location.origin + window.location.pathname;
  return `${base}?room=${code}`;
}

function randomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// Host creates a room and waits for a guest to join via the shared link.
async function createRoom(): Promise<void> {
  saveName();
  if (!channelEnabled()) {
    startAi();
    return;
  }
  mode = 'online-host';
  roomCode = randomCode();
  showWaitingOverlay();
  setStatus('🟡 Odaya bağlanılıyor…');
  const myGen = gen.current();
  const handle = await joinChannel(
    `yilan-duello:${roomCode}`,
    { role: 'host', name: myName },
    {
      onEvent: (event, data) => {
        if (event === 'hello' && typeof data === 'object' && data !== null) {
          const n = (data as { name?: unknown }).name;
          if (typeof n === 'string' && n.trim()) guestName = n.trim().slice(0, 12);
        } else if (event === 'input' && typeof data === 'object' && data !== null) {
          const d = (data as { dir?: unknown }).dir;
          if (isDir(d)) pending[1] = d;
        }
      },
      onPresence: (ids) => {
        if (mode === 'online-host' && !started && ids.length >= 2) beginMatch();
      },
      onLeave: () => {
        // Guest dropped: stop the match and return to waiting.
        if (mode === 'online-host' && started && world.status !== 'over') {
          if (tickHandle !== null) {
            clearInterval(tickHandle);
            tickHandle = null;
          }
          started = false;
          guestName = '';
          showWaitingOverlay();
          setStatus('🟡 Rakip ayrıldı · yeni oyuncu bekleniyor');
        }
      },
    },
  );
  if (!gen.isCurrent(myGen)) {
    handle?.leave();
    return;
  }
  if (!handle) {
    // Couldn't connect — offer the offline AI game instead of failing.
    mode = 'idle';
    overlayMsg.textContent = 'Çevrimiçi bağlantı kurulamadı. Yapay zekâya karşı oynayabilirsin.';
    showMenuOverlay();
    setStatus('⚠️ Bağlanılamadı · çevrimdışı oyna');
    return;
  }
  room = handle;
  // A guest might already be present (rejoin) — start immediately if so.
  if (handle.peerCount() >= 1) beginMatch();
  else setStatus('🟢 Oda hazır · rakip bekleniyor');
}

// Guest joins an existing room from the ?room=CODE link.
async function joinRoom(code: string): Promise<void> {
  saveName();
  mode = 'online-guest';
  roomCode = code;
  showConnectingOverlay();
  setStatus('🟡 Odaya bağlanılıyor…');
  const myGen = gen.current();
  const handle = await joinChannel(
    `yilan-duello:${code}`,
    { role: 'guest', name: myName },
    {
      onEvent: (event, data) => {
        if (event === 'state') applyRemoteState(data);
      },
      onPresence: (ids) => {
        if (mode === 'online-guest' && ids.length < 2) {
          // Only us in the room → the host isn't here (yet / left).
          if (world.status === 'menu' || world.status === 'waiting') {
            setStatus('🟡 Kurucu bekleniyor…');
          }
        }
      },
      onLeave: () => {
        if (mode === 'online-guest') {
          setStatus('🔴 Kurucu ayrıldı');
          overlayTitle.textContent = 'Bağlantı koptu';
          overlayMsg.textContent = 'Oda kurucusu ayrıldı. Menüye dönüp yeni bir oda kurabilirsin.';
          showMenuOverlay();
          mode = 'idle';
        }
      },
    },
  );
  if (!gen.isCurrent(myGen)) {
    handle?.leave();
    return;
  }
  if (!handle) {
    mode = 'idle';
    overlayTitle.textContent = 'Bağlanılamadı';
    overlayMsg.textContent = 'Çevrimiçi sunucuya ulaşılamadı. Yapay zekâya karşı oynayabilirsin.';
    showMenuOverlay();
    setStatus('⚠️ Bağlanılamadı · çevrimdışı oyna');
    return;
  }
  room = handle;
  room.send('hello', { name: myName });
  setStatus('🟢 Bağlandı · oyun başlıyor');
}

function isDir(v: unknown): v is DirName {
  return v === 'up' || v === 'down' || v === 'left' || v === 'right';
}

// Guest: validate + adopt the host's broadcast, then render it.
function applyRemoteState(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const d = data as Partial<NetState>;
  if (!Array.isArray(d.snakes) || d.snakes.length !== 2) return;
  if (typeof d.food !== 'object' || d.food === null) return;
  world = data as NetState;
  syncOverlayFromWorld();
}

// ---- offline AI -----------------------------------------------------------
function startAi(): void {
  saveName();
  teardownRoom();
  mode = 'ai';
  guestName = 'serpAI';
  setStatus('⚪ Çevrimdışı · yapay zekâya karşı');
  beginMatch();
}

// ---- overlay / HUD --------------------------------------------------------
function show(el: HTMLElement): void {
  el.classList.remove('yd-share--hidden', 'yd-actions--hidden');
}
function hide(el: HTMLElement): void {
  if (el === shareBox) el.classList.add('yd-share--hidden');
  else el.classList.add('yd-actions--hidden');
}

function showMenuOverlay(): void {
  show(menuActions);
  hide(shareBox);
  hide(overActions);
  // The "create room" button only makes sense when a backend is configured.
  createBtn.style.display = channelEnabled() ? '' : 'none';
  nameInput.style.display = '';
  showOverlayEl(overlay);
}

function showWaitingOverlay(): void {
  overlayTitle.textContent = 'Oda kuruldu';
  overlayMsg.textContent = 'Bağlantıyı 2. oyuncuya gönder. O katılınca oyun otomatik başlar.';
  hide(menuActions);
  hide(overActions);
  nameInput.style.display = 'none';
  shareLinkInput.value = shareUrlFor(roomCode);
  show(shareBox);
  showOverlayEl(overlay);
}

function showConnectingOverlay(): void {
  overlayTitle.textContent = 'Bağlanılıyor…';
  overlayMsg.textContent = 'Oda kurucusuna bağlanılıyor, oyun birazdan başlayacak.';
  hide(menuActions);
  hide(shareBox);
  hide(overActions);
  nameInput.style.display = 'none';
  showOverlayEl(overlay);
}

function showOverOverlay(): void {
  const w = world.winner;
  let title = 'Berabere!';
  if (w === 'p1') title = `${world.snakes[0]!.name} kazandı! 🟢`;
  else if (w === 'p2') title = `${world.snakes[1]!.name} kazandı! 🔵`;
  overlayTitle.textContent = title;
  overlayMsg.textContent = `Skor — ${world.snakes[0]!.name}: ${world.snakes[0]!.score} · ${world.snakes[1]!.name}: ${world.snakes[1]!.score}`;
  hide(menuActions);
  hide(shareBox);
  nameInput.style.display = 'none';
  // Only the host/AI (the one simulating) can start a rematch.
  if (mode === 'online-host' || mode === 'ai') {
    rematchBtn.textContent = 'Yeniden Oyna';
    show(overActions);
  } else {
    overlayMsg.textContent += ' · Kurucunun yeniden başlatması bekleniyor.';
    hide(overActions);
  }
  showOverlayEl(overlay);
}

// Drive the overlay purely from world.status so host and guest stay in sync.
let lastShownStatus: Status | null = null;
function syncOverlayFromWorld(): void {
  const st = world.status;
  if (st === 'countdown') {
    overlayTitle.textContent = String(Math.max(1, world.count));
    overlayMsg.textContent = 'Hazır ol…';
    hide(menuActions);
    hide(shareBox);
    hide(overActions);
    nameInput.style.display = 'none';
    showOverlayEl(overlay);
  } else if (st === 'playing') {
    hideOverlayEl(overlay);
  } else if (st === 'over') {
    if (lastShownStatus !== 'over') showOverOverlay();
  }
  lastShownStatus = st;
}

// ---- rendering ------------------------------------------------------------
const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached || fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v || fallback;
}

function sizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  const size = Math.max(60, Math.min(rect.width, rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cell = size / COLS;
}

function drawCell(c: Cell, color: string, inset = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(c.x * cell + inset, c.y * cell + inset, cell - inset * 2, cell - inset * 2);
}

function render(): void {
  const size = COLS * cell;
  ctx.fillStyle = getCss('--surface', '#14171c');
  ctx.fillRect(0, 0, size, ROWS * cell);

  // subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, ROWS * cell);
    ctx.stroke();
  }
  for (let j = 0; j <= ROWS; j++) {
    ctx.beginPath();
    ctx.moveTo(0, j * cell);
    ctx.lineTo(COLS * cell, j * cell);
    ctx.stroke();
  }

  // food
  const food = world.food;
  ctx.fillStyle = '#f43f5e';
  ctx.beginPath();
  ctx.arc(food.x * cell + cell / 2, food.y * cell + cell / 2, cell * 0.32, 0, Math.PI * 2);
  ctx.fill();

  // snakes
  const palettes = [
    { body: '#22c55e', head: '#86efac' },
    { body: '#3b82f6', head: '#93c5fd' },
  ];
  for (let i = 0; i < 2; i++) {
    const s = world.snakes[i]!;
    if (!s.alive && world.status !== 'over') continue;
    const pal = palettes[i]!;
    for (let b = s.body.length - 1; b >= 0; b--) {
      const segColor = b === 0 ? pal.head : pal.body;
      const cellRef = s.body[b]!;
      ctx.globalAlpha = s.alive ? 1 : 0.35;
      drawCell(cellRef, segColor, b === 0 ? 0.5 : 1.5);
    }
    ctx.globalAlpha = 1;
  }
}

function renderLoop(): void {
  const myGen = gen.current();
  const frame = (): void => {
    if (!gen.isCurrent(myGen)) return;
    render();
    scoreP1El.textContent = String(world.snakes[0]!.score);
    scoreP2El.textContent = String(world.snakes[1]!.score);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---- input ----------------------------------------------------------------
// My own snake index: host/AI control P1 (0); guest controls P2 (1).
function mySnakeIndex(): number {
  return mode === 'online-guest' ? 1 : 0;
}

function steer(dir: DirName): void {
  if (world.status !== 'playing' && world.status !== 'countdown') return;
  const idx = mySnakeIndex();
  if (mode === 'online-guest') {
    // Optimism off: just tell the host. The host validates the turn.
    if (room) room.send('input', { dir });
    return;
  }
  // Host / AI apply locally to the buffered turn for P1.
  const cur = world.snakes[idx]!.dir;
  if (validTurn(cur, dir)) pending[idx] = dir;
}

function keyDir(k: string): DirName | null {
  if (k === 'arrowup' || k === 'w') return 'up';
  if (k === 'arrowdown' || k === 's') return 'down';
  if (k === 'arrowleft' || k === 'a') return 'left';
  if (k === 'arrowright' || k === 'd') return 'right';
  return null;
}

// ---- lifecycle ------------------------------------------------------------
function saveName(): void {
  const n = nameInput.value.trim().slice(0, 12);
  if (n) {
    myName = n;
    safeWrite(STORAGE_NAME, n);
  }
}

function backToMenu(): void {
  gen.bump();
  teardownRoom();
  mode = 'idle';
  world = freshWorld();
  lastShownStatus = null;
  overlayTitle.textContent = 'Yılan Düellosu';
  overlayMsg.textContent = channelEnabled()
    ? 'İki kişilik çevrimiçi yılan. Bir oda kur, bağlantıyı arkadaşına yolla.'
    : 'Çevrimiçi sunucu yapılandırılmamış. Yapay zekâya karşı oynayabilirsin.';
  showMenuOverlay();
  setStatus(channelEnabled() ? '⚪ Hazır' : '⚪ Çevrimdışı · yapay zekâ modu');
  renderLoop();
}

function reset(): void {
  backToMenu();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreP1El = document.querySelector<HTMLElement>('#score-p1')!;
  scoreP2El = document.querySelector<HTMLElement>('#score-p2')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  nameInput = document.querySelector<HTMLInputElement>('#name')!;
  menuActions = document.querySelector<HTMLElement>('#menu-actions')!;
  createBtn = document.querySelector<HTMLButtonElement>('#create')!;
  aiBtn = document.querySelector<HTMLButtonElement>('#ai')!;
  shareBox = document.querySelector<HTMLElement>('#share')!;
  shareLinkInput = document.querySelector<HTMLInputElement>('#share-link')!;
  copyBtn = document.querySelector<HTMLButtonElement>('#copy')!;
  overActions = document.querySelector<HTMLElement>('#over-actions')!;
  rematchBtn = document.querySelector<HTMLButtonElement>('#rematch')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  dpad = document.querySelector<HTMLElement>('#dpad')!;

  myName = safeRead<string>(STORAGE_NAME, '') || 'Sen';
  if (myName !== 'Sen') nameInput.value = myName;
  wins = safeRead<number>(STORAGE_WINS, 0);

  sizeCanvas();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => sizeCanvas()).observe(canvas);
  }
  window.addEventListener('resize', sizeCanvas);

  // Buttons.
  createBtn.addEventListener('click', () => void createRoom());
  aiBtn.addEventListener('click', startAi);
  rematchBtn.addEventListener('click', () => {
    if (mode === 'online-host' || mode === 'ai') beginMatch();
  });
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
      // Clipboard API can be unavailable (insecure context / iframe). The
      // link is already selected so the user can copy it manually.
    }
  });

  // Keyboard steering.
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (typing) return;
    const dir = keyDir(e.key.toLowerCase());
    if (dir) {
      steer(dir);
      e.preventDefault();
    }
  });

  // Touch d-pad.
  for (const btn of Array.from(dpad.querySelectorAll<HTMLButtonElement>('.yd-dpad__btn'))) {
    const handler = (e: Event): void => {
      e.preventDefault();
      const d = btn.dataset.dir;
      if (isDir(d)) steer(d);
    };
    btn.addEventListener('click', handler);
    btn.addEventListener('touchstart', handler, { passive: false });
  }

  // Swipe steering on the board.
  let touchStart: { x: number; y: number } | null = null;
  canvas.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (t) touchStart = { x: t.clientX, y: t.clientY };
    },
    { passive: true },
  );
  canvas.addEventListener(
    'touchmove',
    (e) => {
      if (!touchStart) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      if (Math.hypot(dx, dy) < 24) return;
      if (Math.abs(dx) > Math.abs(dy)) steer(dx > 0 ? 'right' : 'left');
      else steer(dy > 0 ? 'down' : 'up');
      touchStart = null;
    },
    { passive: true },
  );

  // Auto-join when arriving via a ?room=CODE link; otherwise show the menu.
  const code = getRoomFromUrl();
  if (code && channelEnabled()) {
    renderLoop();
    void joinRoom(code);
  } else {
    if (code && !channelEnabled()) {
      overlayMsg.textContent =
        'Bu bağlantı çevrimiçi bir oda içindi ama sunucu yapılandırılmamış. Yapay zekâya karşı oynayabilirsin.';
    }
    backToMenu();
  }
}

export const game = defineGame({ init, reset });
