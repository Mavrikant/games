import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { joinRoom, realtimeEnabled } from '@shared/realtime-room';
import type { PeerState, RoomHandle } from '@shared/realtime-room';

// PITFALLS guarded here (see docs/PITFALLS.md before editing):
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - module-level-dom-access: every querySelector lives in init().
// - stale-async-callback: gen.bump() in reset() cancels the RAF loop.
// - overlay-input-leak: the `state` enum gates steering + start handling.
// - missing-overlay-css: erime-arena.css defines .overlay--hidden.
// - hud-counter-synced-only-at-lifecycle-edges: HUD is rewritten every frame.

// ---- world / tuning -------------------------------------------------------
const WORLD = 1600;
const START_MASS = 100;
const MAX_MASS = 6000;
const FOOD_MASS = 7;
const NUM_FOOD = 160;
const NUM_BOTS = 6; // local "wildlife" — keeps the arena alive solo or online
const EAT_RATIO = 1.18; // must be this much larger to swallow another blob
const GAIN = 0.85; // share of the victim's mass absorbed
const BASE_SPEED = 240; // world units/sec at spawn size
// Players spawn within this radius of the arena center so people in the same
// room meet quickly instead of scattering across the whole world.
const SPAWN_SPREAD = 220;
// Brief invulnerability after (re)spawning, so a fresh mass-100 cell isn't
// instantly swallowed by a nearby bigger blob before it can move.
const SPAWN_PROTECT_MS = 2500;
const ROOM = 'lobby';
const PEER_STALE_MS = 5000;
const EAT_COOLDOWN_MS = 1200;
const STORAGE_BEST = 'erime-arena.best';
const STORAGE_NAME = 'erime-arena.name';

type State = 'ready' | 'playing' | 'dead';

interface Blob {
  x: number;
  y: number;
  mass: number;
  hue: number;
  name: string;
}

interface Bot extends Blob {
  tx: number;
  ty: number;
  retarget: number;
}

interface Pellet {
  x: number;
  y: number;
  hue: number;
}

// ---- module state ---------------------------------------------------------
const gen = createGenToken();
let state: State = 'ready';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let massEl!: HTMLElement;
let bestEl!: HTMLElement;
let statusEl!: HTMLElement;
let leadersEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let nameInput!: HTMLInputElement;
let startBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let fsBtn!: HTMLButtonElement;
let eaRoot!: HTMLElement;

const view = { w: 360, h: 360 };
let zoom = 1;
const cam = { x: WORLD / 2, y: WORLD / 2 };

const self: Blob = { x: WORLD / 2, y: WORLD / 2, mass: START_MASS, hue: 210, name: 'Sen' };
let peakMass = START_MASS;
let best = START_MASS;
let protectUntil = 0; // performance.now() until which self can't be eaten

const food: Pellet[] = [];
const bots: Bot[] = [];

const peers = new Map<string, PeerState>();
const eatCooldown = new Map<string, number>();
let room: RoomHandle | null = null;
let online = false;

// input
const pointer = { x: 0, y: 0, active: false };
const keys = new Set<string>();

let lastTime = 0;
let leaderTimer = 0;

// ---- helpers --------------------------------------------------------------
function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function radiusOf(mass: number): number {
  return Math.sqrt(mass) * 1.8;
}

function speedOf(mass: number): number {
  const f = Math.min(1.3, Math.max(0.4, Math.pow(START_MASS / mass, 0.4)));
  return BASE_SPEED * f;
}

function clampWorld(b: Blob): void {
  const r = radiusOf(b.mass);
  b.x = Math.min(WORLD - r, Math.max(r, b.x));
  b.y = Math.min(WORLD - r, Math.max(r, b.y));
}

function spawnPellet(): Pellet {
  return { x: rnd(20, WORLD - 20), y: rnd(20, WORLD - 20), hue: Math.floor(rnd(0, 360)) };
}

function makeBot(): Bot {
  const x = rnd(40, WORLD - 40);
  const y = rnd(40, WORLD - 40);
  return {
    x,
    y,
    mass: rnd(60, 360),
    hue: Math.floor(rnd(0, 360)),
    name: 'Bot',
    tx: x,
    ty: y,
    retarget: 0,
  };
}

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v;
}

// ---- lifecycle ------------------------------------------------------------
function setStatus(): void {
  if (online && room) {
    statusEl.textContent = `🟢 Çevrimiçi · ${room.peerCount()} oyuncu`;
  } else if (realtimeEnabled()) {
    statusEl.textContent = '🟡 Bağlanılamadı · botlarla oyna';
  } else {
    statusEl.textContent = '⚪ Çevrimdışı · botlarla oyna';
  }
}

function startPlay(): void {
  const nm = nameInput.value.trim().slice(0, 14);
  if (nm) {
    self.name = nm;
    safeWrite(STORAGE_NAME, nm);
  } else {
    self.name = 'Sen';
  }
  self.x = WORLD / 2 + rnd(-SPAWN_SPREAD, SPAWN_SPREAD);
  self.y = WORLD / 2 + rnd(-SPAWN_SPREAD, SPAWN_SPREAD);
  self.mass = START_MASS;
  peakMass = START_MASS;
  state = 'playing';
  protectUntil = performance.now() + SPAWN_PROTECT_MS;
  hideOverlayEl(overlay);
  // Drop focus from the name field so movement keys steer instead of typing
  // into the (now hidden) input.
  nameInput.blur();
}

function die(): void {
  state = 'dead';
  if (peakMass > best) {
    best = Math.round(peakMass);
    safeWrite(STORAGE_BEST, best);
  }
  overlayTitle.textContent = 'Yutuldun!';
  overlayMsg.textContent = `Zirve kütlen: ${Math.round(peakMass)} · Tekrar doğmak için Başla`;
  startBtn.textContent = 'Tekrar doğ';
  showOverlayEl(overlay);
}

function seedWorld(): void {
  food.length = 0;
  for (let i = 0; i < NUM_FOOD; i++) food.push(spawnPellet());
  bots.length = 0;
  for (let i = 0; i < NUM_BOTS; i++) bots.push(makeBot());
}

function reset(): void {
  gen.bump();
  seedWorld();
  self.x = WORLD / 2;
  self.y = WORLD / 2;
  self.mass = START_MASS;
  peakMass = START_MASS;
  state = 'ready';
  overlayTitle.textContent = 'Hücre Savaşı';
  overlayMsg.textContent =
    'Yemleri ve daha küçük hücreleri yut, büyü; büyüklerden kaç.';
  startBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  startLoop();
}

// ---- simulation -----------------------------------------------------------
function steerSelf(dt: number): void {
  let dx = 0;
  let dy = 0;
  let active = false;
  if (keys.size > 0) {
    // Keyboard yields a unit-ish vector — move whenever any key is held.
    if (keys.has('up')) dy -= 1;
    if (keys.has('down')) dy += 1;
    if (keys.has('left')) dx -= 1;
    if (keys.has('right')) dx += 1;
    active = dx !== 0 || dy !== 0;
  } else if (pointer.active) {
    // Pointer yields a pixel offset from the center — apply a small deadzone
    // so a cursor parked at the center doesn't jitter the blob.
    dx = pointer.x - view.w / 2;
    dy = pointer.y - view.h / 2;
    active = Math.hypot(dx, dy) > 4;
  }
  if (active) {
    const len = Math.hypot(dx, dy) || 1;
    const s = speedOf(self.mass) * dt;
    self.x += (dx / len) * s;
    self.y += (dy / len) * s;
    clampWorld(self);
  }
}

// Eat nearby pellets for a blob; returns mass gained.
function eatFood(b: Blob): void {
  const r = radiusOf(b.mass);
  const r2 = r * r;
  for (let i = 0; i < food.length; i++) {
    const p = food[i];
    if (!p) continue;
    const ddx = p.x - b.x;
    const ddy = p.y - b.y;
    if (ddx * ddx + ddy * ddy < r2) {
      b.mass = Math.min(MAX_MASS, b.mass + FOOD_MASS);
      food[i] = spawnPellet();
    }
  }
}

function overlaps(a: Blob, b: Blob): boolean {
  const big = Math.max(radiusOf(a.mass), radiusOf(b.mass));
  const ddx = a.x - b.x;
  const ddy = a.y - b.y;
  return ddx * ddx + ddy * ddy < big * big * 0.85 * 0.85;
}

function updateBots(dt: number): void {
  for (const bot of bots) {
    bot.retarget -= dt;
    // Pick a target: flee bigger blobs, chase smaller ones, else seek food.
    let threat: Blob | null = null;
    let prey: Blob | null = null;
    const candidates: Blob[] = [self, ...bots];
    for (const o of candidates) {
      if (o === bot) continue;
      const d = Math.hypot(o.x - bot.x, o.y - bot.y);
      if (d > 360) continue;
      if (o.mass > bot.mass * EAT_RATIO && (!threat || d < Math.hypot(threat.x - bot.x, threat.y - bot.y))) {
        threat = o;
      } else if (bot.mass > o.mass * EAT_RATIO && (!prey || d < Math.hypot(prey.x - bot.x, prey.y - bot.y))) {
        prey = o;
      }
    }
    if (threat) {
      bot.tx = bot.x + (bot.x - threat.x);
      bot.ty = bot.y + (bot.y - threat.y);
    } else if (prey) {
      bot.tx = prey.x;
      bot.ty = prey.y;
    } else if (bot.retarget <= 0) {
      let bestP: Pellet | null = null;
      let bestD = Infinity;
      for (const p of food) {
        const d = (p.x - bot.x) ** 2 + (p.y - bot.y) ** 2;
        if (d < bestD) {
          bestD = d;
          bestP = p;
        }
      }
      if (bestP) {
        bot.tx = bestP.x;
        bot.ty = bestP.y;
      } else {
        bot.tx = rnd(40, WORLD - 40);
        bot.ty = rnd(40, WORLD - 40);
      }
      bot.retarget = rnd(0.4, 1.2);
    }
    const dx = bot.tx - bot.x;
    const dy = bot.ty - bot.y;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      const s = speedOf(bot.mass) * dt * 0.92;
      bot.x += (dx / len) * s;
      bot.y += (dy / len) * s;
      clampWorld(bot);
    }
    eatFood(bot);
  }
}

// Bots eating each other / self; self eating bots; self dying to bigger bots.
function resolveLocalEating(now: number): void {
  // bot vs bot
  for (const a of bots) {
    for (const b of bots) {
      if (a === b) continue;
      if (a.mass > b.mass * EAT_RATIO && overlaps(a, b)) {
        a.mass = Math.min(MAX_MASS, a.mass + b.mass * GAIN);
        b.x = rnd(40, WORLD - 40);
        b.y = rnd(40, WORLD - 40);
        b.mass = rnd(60, 150);
      }
    }
  }
  if (state !== 'playing') return;
  for (const b of bots) {
    if (!overlaps(self, b)) continue;
    if (self.mass > b.mass * EAT_RATIO) {
      self.mass = Math.min(MAX_MASS, self.mass + b.mass * GAIN);
      b.x = rnd(40, WORLD - 40);
      b.y = rnd(40, WORLD - 40);
      b.mass = rnd(60, 150);
    } else if (b.mass > self.mass * EAT_RATIO) {
      if (now < protectUntil) continue; // spawn protection
      die();
      return;
    }
  }
}

// Self vs remote peers — deterministic from shared broadcast state, with a
// per-peer cooldown so a stale overlap isn't double-counted before the peer
// rebroadcasts its respawned state.
function resolvePeerEating(now: number): void {
  if (state !== 'playing') return;
  for (const peer of peers.values()) {
    if (!peer.alive) continue;
    const until = eatCooldown.get(peer.id) ?? 0;
    if (now < until) continue;
    if (!overlaps(self, peer)) continue;
    if (self.mass > peer.mass * EAT_RATIO) {
      self.mass = Math.min(MAX_MASS, self.mass + peer.mass * GAIN);
      eatCooldown.set(peer.id, now + EAT_COOLDOWN_MS);
    } else if (peer.mass > self.mass * EAT_RATIO) {
      if (now < protectUntil) continue; // spawn protection
      eatCooldown.set(peer.id, now + EAT_COOLDOWN_MS);
      die();
      return;
    }
  }
}

function prunePeers(now: number): void {
  for (const [id, p] of peers) {
    if (now - p.t > PEER_STALE_MS) peers.delete(id);
  }
}

function update(dt: number, now: number): void {
  if (state === 'playing') {
    steerSelf(dt);
    eatFood(self);
    if (self.mass > peakMass) peakMass = self.mass;
  }
  updateBots(dt);
  resolveLocalEating(now);
  if (online) {
    prunePeers(now);
    resolvePeerEating(now);
    if (room) {
      room.send({
        name: self.name,
        hue: self.hue,
        x: self.x,
        y: self.y,
        mass: self.mass,
        alive: state === 'playing',
      });
    }
  }
}

// ---- rendering ------------------------------------------------------------
function sx(wx: number): number {
  return (wx - cam.x) * zoom + view.w / 2;
}
function sy(wy: number): number {
  return (wy - cam.y) * zoom + view.h / 2;
}

function drawBlob(b: Blob, isSelf: boolean): void {
  const r = radiusOf(b.mass) * zoom;
  const x = sx(b.x);
  const y = sy(b.y);
  if (x + r < 0 || x - r > view.w || y + r < 0 || y - r > view.h) return;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${b.hue} 68% ${isSelf ? 56 : 50}%)`;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.08);
  ctx.strokeStyle = `hsl(${b.hue} 70% ${isSelf ? 72 : 32}%)`;
  ctx.stroke();
  if (isSelf && performance.now() < protectUntil) {
    ctx.beginPath();
    ctx.arc(x, y, r + 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (r > 14) {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `${Math.max(10, Math.min(20, r * 0.5))}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.name, x, y);
  }
}

function render(): void {
  // camera + zoom follow self
  cam.x = self.x;
  cam.y = self.y;
  const r = radiusOf(self.mass);
  zoom = Math.min(1.1, Math.max(0.55, 1.1 - (r - radiusOf(START_MASS)) / 320));

  ctx.fillStyle = getCss('--surface') || '#14171c';
  ctx.fillRect(0, 0, view.w, view.h);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const step = 100;
  const startX = Math.floor((cam.x - view.w / 2 / zoom) / step) * step;
  const endX = cam.x + view.w / 2 / zoom;
  for (let gx = startX; gx <= endX; gx += step) {
    ctx.beginPath();
    ctx.moveTo(sx(gx), 0);
    ctx.lineTo(sx(gx), view.h);
    ctx.stroke();
  }
  const startY = Math.floor((cam.y - view.h / 2 / zoom) / step) * step;
  const endY = cam.y + view.h / 2 / zoom;
  for (let gy = startY; gy <= endY; gy += step) {
    ctx.beginPath();
    ctx.moveTo(0, sy(gy));
    ctx.lineTo(view.w, sy(gy));
    ctx.stroke();
  }

  // world border
  ctx.strokeStyle = 'rgba(129,140,248,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(sx(0), sy(0), WORLD * zoom, WORLD * zoom);

  // food
  for (const p of food) {
    const x = sx(p.x);
    const y = sy(p.y);
    if (x < -6 || x > view.w + 6 || y < -6 || y > view.h + 6) continue;
    ctx.beginPath();
    ctx.arc(x, y, 4 * zoom + 1, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${p.hue} 75% 60%)`;
    ctx.fill();
  }

  // all blobs, smaller first so bigger draw on top
  const drawList: Array<{ b: Blob; isSelf: boolean }> = [];
  for (const b of bots) drawList.push({ b, isSelf: false });
  for (const p of peers.values()) {
    if (p.alive) drawList.push({ b: p, isSelf: false });
  }
  if (state === 'playing') drawList.push({ b: self, isSelf: true });
  drawList.sort((a, b) => a.b.mass - b.b.mass);
  for (const d of drawList) drawBlob(d.b, d.isSelf);

  // Off-screen indicators for human peers, so other players stay findable
  // even when they spawn or roam outside the viewport.
  const cx = view.w / 2;
  const cy = view.h / 2;
  const m = 16;
  for (const p of peers.values()) {
    if (!p.alive) continue;
    const px = sx(p.x);
    const py = sy(p.y);
    if (px >= 0 && px <= view.w && py >= 0 && py <= view.h) continue; // on screen
    let dx = px - cx;
    let dy = py - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const tx = dx > 0 ? (view.w - m - cx) / dx : dx < 0 ? (m - cx) / dx : Infinity;
    const ty = dy > 0 ? (view.h - m - cy) / dy : dy < 0 ? (m - cy) / dy : Infinity;
    const t = Math.min(tx, ty);
    const ex = cx + dx * t;
    const ey = cy + dy * t;
    ctx.beginPath();
    ctx.arc(ex, ey, 7, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${p.hue} 68% 55%)`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.name, ex - dx * 16, ey - dy * 10);
  }
}

function updateHud(now: number): void {
  massEl.textContent = String(Math.round(state === 'playing' ? self.mass : peakMass));
  bestEl.textContent = String(best);
  leaderTimer -= 1;
  if (leaderTimer <= 0) {
    leaderTimer = 15; // ~ every 15 frames
    setStatus();
    renderLeaders();
  }
}

function renderLeaders(): void {
  const all: Array<{ name: string; mass: number; isSelf: boolean }> = [];
  if (state === 'playing') all.push({ name: self.name, mass: self.mass, isSelf: true });
  for (const b of bots) all.push({ name: b.name, mass: b.mass, isSelf: false });
  for (const p of peers.values()) if (p.alive) all.push({ name: p.name, mass: p.mass, isSelf: false });
  all.sort((a, b) => b.mass - a.mass);
  const top = all.slice(0, 5);
  leadersEl.replaceChildren();
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    if (!e) continue;
    const li = document.createElement('li');
    li.className = e.isSelf ? 'leaders__row leaders__row--self' : 'leaders__row';
    li.textContent = `${i + 1}. ${e.name} · ${Math.round(e.mass)}`;
    leadersEl.appendChild(li);
  }
}

// ---- loop -----------------------------------------------------------------
function startLoop(): void {
  const myGen = gen.current();
  lastTime = performance.now();
  const frame = (now: number): void => {
    if (!gen.isCurrent(myGen)) return; // canceled by reset()
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.05) dt = 0.05; // clamp tab-switch / jank
    update(dt, now);
    render();
    updateHud(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---- input + boot ---------------------------------------------------------
function sizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  view.w = rect.width > 2 ? Math.round(rect.width) : 360;
  view.h = rect.height > 2 ? Math.round(rect.height) : 360;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Fullscreen toggle on the whole game container (HUD + status + board stay
// visible). Best-effort: vendor-prefixed for Safari, errors swallowed (iOS
// doesn't allow element fullscreen, so it simply stays inline there).
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => unknown };
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => unknown;
};

function isFullscreen(): boolean {
  const d = document as FsDocument;
  return !!(document.fullscreenElement || d.webkitFullscreenElement);
}

function toggleFullscreen(): void {
  try {
    if (isFullscreen()) {
      const d = document as FsDocument;
      const exit = document.exitFullscreen || d.webkitExitFullscreen;
      const r = exit?.call(document);
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        (r as Promise<unknown>).catch(() => {});
      }
    } else {
      const e = eaRoot as FsElement;
      const req = e.requestFullscreen || e.webkitRequestFullscreen;
      const r = req?.call(e);
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        (r as Promise<unknown>).catch(() => {});
      }
    }
  } catch {
    /* fullscreen unsupported (e.g. iOS) — stay inline */
  }
}

function keyDir(k: string): 'up' | 'down' | 'left' | 'right' | null {
  if (k === 'arrowup' || k === 'w') return 'up';
  if (k === 'arrowdown' || k === 's') return 'down';
  if (k === 'arrowleft' || k === 'a') return 'left';
  if (k === 'arrowright' || k === 'd') return 'right';
  return null;
}

async function connect(): Promise<void> {
  if (!realtimeEnabled()) {
    setStatus();
    return;
  }
  const myGen = gen.current();
  const handle = await joinRoom(ROOM, {
    onState: (peer) => {
      // Stamp with the local receive time (performance.now, same clock as the
      // loop) — the sender's epoch timestamp can't be compared across machines
      // (clock skew) and would mis-fire staleness pruning.
      peers.set(peer.id, { ...peer, t: performance.now() });
    },
    onLeave: (id) => {
      peers.delete(id);
      eatCooldown.delete(id);
    },
  });
  if (!gen.isCurrent(myGen)) {
    handle?.leave();
    return;
  }
  if (handle) {
    room = handle;
    online = true;
  }
  setStatus();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  massEl = document.querySelector<HTMLElement>('#mass')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  leadersEl = document.querySelector<HTMLElement>('#leaders')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  nameInput = document.querySelector<HTMLInputElement>('#name')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  fsBtn = document.querySelector<HTMLButtonElement>('#fs')!;
  eaRoot = document.querySelector<HTMLElement>('#ea-root')!;

  best = safeRead<number>(STORAGE_BEST, START_MASS);
  self.hue = Math.floor(rnd(160, 260));
  const savedName = safeRead<string>(STORAGE_NAME, '');
  if (savedName) nameInput.value = savedName;

  sizeCanvas();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => sizeCanvas()).observe(canvas);
  }
  window.addEventListener('resize', sizeCanvas);

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.active = true;
  });
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    pointer.active = true;
    if (state !== 'playing') startPlay();
  });

  window.addEventListener('keydown', (e) => {
    // Don't hijack typing: while the name field (or any input) is focused,
    // letters/space type normally and only Enter starts the run.
    const target = e.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable);
    const k = e.key.toLowerCase();
    if (typing) {
      if (k === 'enter' && state !== 'playing') {
        startPlay();
        e.preventDefault();
      }
      return;
    }
    const dir = keyDir(k);
    if (dir) {
      keys.add(dir);
      if (state !== 'playing') startPlay();
      e.preventDefault();
    } else if (k === ' ' || k === 'enter') {
      if (state !== 'playing') {
        startPlay();
        e.preventDefault();
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    const dir = keyDir(e.key.toLowerCase());
    if (dir) keys.delete(dir);
  });

  startBtn.addEventListener('click', startPlay);
  restartBtn.addEventListener('click', startPlay);
  fsBtn.addEventListener('click', toggleFullscreen);
  // The board element resizes when entering/leaving fullscreen; re-fit the
  // canvas backing store. (ResizeObserver usually covers this; this is a
  // belt-and-suspenders fallback across browsers.)
  document.addEventListener('fullscreenchange', sizeCanvas);

  seedWorld();
  showOverlayEl(overlay);
  setStatus();
  startLoop();
  void connect();
}

export const game = defineGame({ init, reset });
