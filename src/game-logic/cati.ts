import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen-token guards the RAF loop after reset (R-spam safe).
// - overlay-input-leak: explicit `state` enum; overlay swallows pointer; canvas
//   handler early-returns when state !== 'playing'.
// - module-level-dom-access: all DOM/storage access lives in init().
// - visual-vs-hitbox: HOLE_HIT_R drives both rendering of the leak circle and
//   pointer-down hit test. Same constant; no drift.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual collapse.
// - invisible-boot: first leak spawns 1500ms after start so the player sees
//   the playfield and rain effect well before the first drop forms.
// - hud-counter-synced-only-at-lifecycle-edges: timeEl and waterEl are written
//   from inside tick() each frame, not only at start/end.

const STORAGE_BEST = 'cati.best';

const CANVAS_W = 480;
const CANVAS_H = 600;

const COLS = 8;
const ROWS = 5;
const ROOF_TOP = 60;
const ROOF_HEIGHT = 230;
const TILE_W = CANVAS_W / COLS;
const TILE_H = ROOF_HEIGHT / ROWS;

const ROOM_TOP = ROOF_TOP + ROOF_HEIGHT + 16;
const ROOM_BOTTOM = CANVAS_H - 8;
const ROOM_HEIGHT = ROOM_BOTTOM - ROOM_TOP;

const HOLE_HIT_R = 16;             // visual + hitbox (shared)
const PATCH_DURATION_MS = 12_000;
const DRIP_INTERVAL_MS = 950;      // ms between drops from a single open hole
const FIRST_LEAK_DELAY_MS = 1500;
const SPAWN_INTERVAL_START = 3500; // ms between new hole spawns at t=0
const SPAWN_INTERVAL_MIN = 950;    // ms at peak storm
const SPAWN_RAMP_DURATION_MS = 60_000;
const WATER_PER_DROP = 2.4;        // % of tank
const WATER_MAX = 100;
const DROP_FALL_SPEED = 280;       // px/sec
const DROP_RADIUS = 5;
const MAX_HOLES = COLS * ROWS;

type State = 'ready' | 'playing' | 'gameover';

interface Hole {
  col: number;
  row: number;
  cx: number;
  cy: number;
  patched: boolean;
  patchUntilMs: number;
  nextDripAtMs: number;
}

interface Drop {
  x: number;
  y: number;
  vy: number;
}

interface RainStreak {
  x: number;
  y: number;
  len: number;
  vy: number;
}

const gen = createGenToken();
let state: State = 'ready';
let playMs = 0;        // ms since current game started (only ticks while playing)
let lastTickMs = 0;
let waterPct = 0;
let best = 0;
let nextSpawnAtMs = 0;
let holes: Hole[] = [];
let drops: Drop[] = [];
let rain: RainStreak[] = [];
let rafHandle: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let waterEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

function cellCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_W + TILE_W / 2,
    y: ROOF_TOP + row * TILE_H + TILE_H / 2,
  };
}

function spawnHole(): void {
  if (holes.length >= MAX_HOLES) return;
  const occupied = new Set<string>();
  for (const h of holes) occupied.add(`${h.col},${h.row}`);
  const free: { col: number; row: number }[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!occupied.has(`${c},${r}`)) free.push({ col: c, row: r });
    }
  }
  if (free.length === 0) return;
  const pick = free[Math.floor(Math.random() * free.length)]!;
  const center = cellCenter(pick.col, pick.row);
  holes.push({
    col: pick.col,
    row: pick.row,
    cx: center.x,
    cy: center.y,
    patched: false,
    patchUntilMs: 0,
    nextDripAtMs: playMs + 380 + Math.random() * 220,
  });
}

function spawnIntervalAt(t: number): number {
  const k = Math.min(1, t / SPAWN_RAMP_DURATION_MS);
  return SPAWN_INTERVAL_START + (SPAWN_INTERVAL_MIN - SPAWN_INTERVAL_START) * k;
}

function tryPatchAt(px: number, py: number): boolean {
  // Nearest open hole within hit radius wins.
  let target: Hole | null = null;
  let bestD2 = HOLE_HIT_R * HOLE_HIT_R;
  for (const h of holes) {
    if (h.patched) continue;
    const dx = h.cx - px;
    const dy = h.cy - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      target = h;
      bestD2 = d2;
    }
  }
  if (!target) return false;
  target.patched = true;
  target.patchUntilMs = playMs + PATCH_DURATION_MS;
  return true;
}

function tick(now: number, myGen: number): void {
  if (!gen.isCurrent(myGen)) {
    rafHandle = null;
    return;
  }
  if (state !== 'playing') {
    rafHandle = null;
    return;
  }
  const rawDt = now - lastTickMs;
  lastTickMs = now;
  const dt = Math.min(48, rawDt); // clamp big frame gaps (tab switch)

  playMs += dt;

  // Spawn new leaks (first leak waits FIRST_LEAK_DELAY_MS for a friendly boot)
  if (playMs >= nextSpawnAtMs && playMs >= FIRST_LEAK_DELAY_MS) {
    spawnHole();
    nextSpawnAtMs = playMs + spawnIntervalAt(playMs);
  }

  // Patches expire → hole leaks again
  for (const h of holes) {
    if (h.patched && playMs >= h.patchUntilMs) {
      h.patched = false;
      h.nextDripAtMs = playMs + 400; // small grace, no backlog dump
    }
  }

  // Drips
  for (const h of holes) {
    if (h.patched) continue;
    if (playMs >= h.nextDripAtMs) {
      drops.push({ x: h.cx, y: h.cy + 4, vy: DROP_FALL_SPEED });
      h.nextDripAtMs = playMs + DRIP_INTERVAL_MS;
    }
  }

  // Drops fall; on hitting the water surface, raise waterPct
  const waterSurfaceY = ROOM_BOTTOM - (waterPct / WATER_MAX) * ROOM_HEIGHT;
  const stillFalling: Drop[] = [];
  for (const d of drops) {
    d.y += (d.vy * dt) / 1000;
    if (d.y >= waterSurfaceY) {
      waterPct = Math.min(WATER_MAX, waterPct + WATER_PER_DROP);
    } else {
      stillFalling.push(d);
    }
  }
  drops = stillFalling;

  // Rain streaks (cosmetic) wrap around
  for (const s of rain) {
    s.y += (s.vy * dt) / 1000;
    if (s.y > ROOF_TOP - 4) {
      s.y = -s.len - Math.random() * 60;
      s.x = Math.random() * CANVAS_W;
    }
  }

  // HUD
  scoreEl.textContent = String(Math.floor(playMs / 1000));
  waterEl.textContent = `${Math.floor(waterPct)}%`;

  // Lose condition: tank full
  if (waterPct >= WATER_MAX) {
    endGame();
    draw();
    return;
  }

  draw();
  rafHandle = requestAnimationFrame((t) => tick(t, myGen));
}

function startLoop(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastTickMs = performance.now();
  rafHandle = requestAnimationFrame((t) => tick(t, myGen));
}

function stopLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function initRain(): void {
  rain = [];
  for (let i = 0; i < 36; i++) {
    rain.push({
      x: Math.random() * CANVAS_W,
      y: Math.random() * ROOF_TOP - 8,
      len: 8 + Math.random() * 14,
      vy: 320 + Math.random() * 180,
    });
  }
}

function startGame(): void {
  if (state === 'playing') return;
  gen.bump();
  state = 'playing';
  playMs = 0;
  waterPct = 0;
  holes = [];
  drops = [];
  nextSpawnAtMs = FIRST_LEAK_DELAY_MS;
  initRain();
  scoreEl.textContent = '0';
  waterEl.textContent = '0%';
  hideOverlayEl(overlay);
  startLoop();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  const seconds = Math.floor(playMs / 1000);
  if (seconds > best) {
    best = seconds;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
  overlayTitle.textContent = 'Su bastı!';
  overlayMsg.textContent = `Dayanma süresi: ${seconds} sn\nDokun veya R ile tekrar dene.`;
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  playMs = 0;
  waterPct = 0;
  holes = [];
  drops = [];
  initRain();
  scoreEl.textContent = '0';
  waterEl.textContent = '0%';
  bestEl.textContent = String(best);
  overlayTitle.textContent = 'Çatı';
  overlayMsg.textContent =
    'Çatı sızıyor. Yağmur damlatan delikleri yamala — oda su altında kalmadan dayan.\nBaşlamak için tıkla.';
  showOverlayEl(overlay);
  draw();
}

// ---------- Rendering ----------

function drawSky(): void {
  ctx.fillStyle = '#0c1828';
  ctx.fillRect(0, 0, CANVAS_W, ROOF_TOP);
  ctx.strokeStyle = 'rgba(140, 200, 255, 0.45)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const s of rain) {
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x - 2, s.y + s.len);
  }
  ctx.stroke();
}

function drawRoof(): void {
  // Eaves shadow strip under roof
  ctx.fillStyle = '#1c2435';
  ctx.fillRect(0, ROOF_TOP + ROOF_HEIGHT, CANVAS_W, 16);

  // Tiles: alternating shading
  for (let r = 0; r < ROWS; r++) {
    const y = ROOF_TOP + r * TILE_H;
    for (let c = 0; c < COLS; c++) {
      const x = c * TILE_W;
      ctx.fillStyle = (r + c) % 2 === 0 ? '#6b3a23' : '#5a2f1c';
      ctx.fillRect(x, y, TILE_W, TILE_H);
    }
  }

  // Grout lines
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < COLS; c++) {
    ctx.moveTo(c * TILE_W, ROOF_TOP);
    ctx.lineTo(c * TILE_W, ROOF_TOP + ROOF_HEIGHT);
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.moveTo(0, ROOF_TOP + r * TILE_H);
    ctx.lineTo(CANVAS_W, ROOF_TOP + r * TILE_H);
  }
  ctx.stroke();

  // Highlight along the eave
  ctx.strokeStyle = 'rgba(255, 220, 180, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, ROOF_TOP + 0.5);
  ctx.lineTo(CANVAS_W, ROOF_TOP + 0.5);
  ctx.stroke();
}

function drawHoles(): void {
  for (const h of holes) {
    // Stain ring (purely cosmetic; HIT_R is the only hitbox)
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(h.cx, h.cy, HOLE_HIT_R + 4, 0, Math.PI * 2);
    ctx.fill();

    if (h.patched) {
      const remaining = Math.max(0, h.patchUntilMs - playMs) / PATCH_DURATION_MS;
      ctx.save();
      ctx.translate(h.cx, h.cy);
      ctx.rotate(((h.col * 17 + h.row * 31) % 9) * 0.04);
      const s = HOLE_HIT_R + 6;
      ctx.fillStyle = '#f5c451';
      ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.strokeStyle = '#b88410';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-s, -s, s * 2, s * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-s + 3, -s + 3);
      ctx.lineTo(s - 3, s - 3);
      ctx.moveTo(s - 3, -s + 3);
      ctx.lineTo(-s + 3, s - 3);
      ctx.stroke();
      ctx.restore();

      // Decay ring on top of patch (shrinks as patch wears off)
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(
        h.cx,
        h.cy,
        HOLE_HIT_R + 8,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * remaining,
      );
      ctx.stroke();
    } else {
      ctx.fillStyle = '#06080c';
      ctx.beginPath();
      ctx.arc(h.cx, h.cy, HOLE_HIT_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(120, 200, 230, 0.35)';
      ctx.beginPath();
      ctx.arc(h.cx - 4, h.cy - 4, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawRoom(): void {
  ctx.fillStyle = '#2a3140';
  ctx.fillRect(0, ROOM_TOP, CANVAS_W, ROOM_HEIGHT + 8);

  // Dashed ceiling/room boundary
  ctx.strokeStyle = 'rgba(200,210,230,0.25)';
  ctx.setLineDash([10, 6]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, ROOM_TOP + 1);
  ctx.lineTo(CANVAS_W, ROOM_TOP + 1);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawWater(): void {
  const surfaceY = ROOM_BOTTOM - (waterPct / WATER_MAX) * ROOM_HEIGHT;

  const grad = ctx.createLinearGradient(0, surfaceY, 0, ROOM_BOTTOM);
  grad.addColorStop(0, '#46c4d4');
  grad.addColorStop(1, '#1f7e8d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, surfaceY, CANVAS_W, ROOM_BOTTOM - surfaceY);

  // Wavy surface
  ctx.strokeStyle = '#6dd5e2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const phase = playMs * 0.004;
  for (let x = 0; x <= CANVAS_W; x += 8) {
    const y = surfaceY + Math.sin(x * 0.06 + phase) * 2.2;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Level marks on right side
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const m of [25, 50, 75]) {
    const my = ROOM_BOTTOM - (m / WATER_MAX) * ROOM_HEIGHT;
    ctx.fillRect(CANVAS_W - 14, my, 8, 1);
    ctx.fillText(`${m}`, CANVAS_W - 16, my);
  }
}

function drawDrops(): void {
  ctx.fillStyle = '#79c8e0';
  for (const d of drops) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, DROP_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(121, 200, 224, 0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(d.x, d.y - DROP_RADIUS - 2);
    ctx.lineTo(d.x, d.y - DROP_RADIUS - 10);
    ctx.stroke();
  }
}

function draw(): void {
  ctx.fillStyle = '#0c1828';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  drawSky();
  drawRoof();
  drawHoles();
  drawRoom();
  drawWater();
  drawDrops();
}

// ---------- Input ----------

function getCanvasPos(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * CANVAS_W,
    y: ((clientY - rect.top) / rect.height) * CANVAS_H,
  };
}

function onCanvasPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  const p = getCanvasPos(e.clientX, e.clientY);
  tryPatchAt(p.x, p.y);
}

function onOverlayPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startGame();
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    if (state === 'ready' || state === 'gameover') {
      e.preventDefault();
      startGame();
    }
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  const c = canvas.getContext('2d');
  if (!c) return;
  ctx = c;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  waterEl = document.querySelector<HTMLElement>('#water')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', () => reset());
  overlay.addEventListener('pointerdown', onOverlayPointerDown);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
