import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Asansör — beş katlı bir kuyuda asansör operatörü oyunu.
// Yolcular rastgele katlarda hedefleriyle birlikte belirir; sabırları
// tükenmeden onları asansöre alıp hedef katlarına bırakman gerek.
//
// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen token bound at rAF schedule, captured by value.
// - overlay-input-leak: explicit `state` enum guards every input handler.
// - visual-vs-hitbox: floorCenterY() is the single source of truth for both
//   the rendered floor band and the click hit-test that picks a target floor.
// - module-level-dom-access: all DOM/storage access lives in init().
// - invisible-boot: startGame() spawns the first passenger + draws immediately.
// - hud-counter-synced-only-at-lifecycle-edges: score/lives written through
//   setScore()/setLives() helpers so HUD updates the moment the value changes.

// --- Geometry: shared by render AND hit-test. ---
const W = 480;
const H = 520;
const FLOOR_COUNT = 5;
const FLOOR_H = 100;
const TOP_MARGIN = (H - FLOOR_COUNT * FLOOR_H) / 2; // 10px
const SHAFT_X = 320;
const SHAFT_W = 130;
const CAR_W = 110;
const CAR_PAD = (SHAFT_W - CAR_W) / 2;
const WAIT_X = 36;
const WAIT_GAP = 50; // px between waiting passengers
const PAX_R = 16; // passenger circle radius (visual + hit)
const CAR_SLOT_GAP = 30;

const ELEVATOR_SPEED = 320; // px / sec
const CAPACITY = 3;
const START_LIVES = 3;

// Spawn pacing: speeds up over time, but never below SPAWN_MIN.
const SPAWN_START = 3.2;
const SPAWN_MIN = 1.1;
const SPAWN_RAMP = 0.06; // sec subtracted per delivery
// Patience: how long a waiting passenger tolerates being ignored.
const PATIENCE_START = 14;
const PATIENCE_MIN = 7;
const PATIENCE_RAMP = 0.15;

// Per delivery score; bonus when 2+ delivered at the same stop (combo).
const SCORE_PER_DELIVERY = 10;

const STORAGE_BEST = 'asansor.best';
const SCORE_DESC = {
  gameId: 'asansor',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

// Distinct colours per destination floor — keeps "where am I going" readable.
const DEST_COLORS = [
  '#f87171', // 1
  '#fbbf24', // 2
  '#34d399', // 3
  '#60a5fa', // 4
  '#c084fc', // 5
];

type State = 'ready' | 'playing' | 'paused' | 'gameover';

interface Passenger {
  id: number;
  from: number; // origin floor (1..5), -1 once boarded
  dest: number; // destination floor (1..5)
  patience: number; // 0..1 (1 = full)
  patienceMax: number; // current run's max patience in seconds
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let lives = START_LIVES;

let waiting: Passenger[] = [];
let onboard: Passenger[] = [];
let nextId = 1;

let elevatorY = 0; // pixel y of car center
let targetFloor = 1;

let spawnTimer = 0;
let spawnInterval = SPAWN_START;
let currentPatience = PATIENCE_START;
let elapsed = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

function floorCenterY(floor: number): number {
  // Floor 5 sits at top of the playfield, floor 1 at the bottom.
  return TOP_MARGIN + (FLOOR_COUNT - floor) * FLOOR_H + FLOOR_H / 2;
}

function pickFloorFromY(y: number): number | null {
  const local = y - TOP_MARGIN;
  if (local < 0 || local >= FLOOR_COUNT * FLOOR_H) return null;
  const idx = Math.floor(local / FLOOR_H);
  return FLOOR_COUNT - idx; // top row = floor 5
}

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function setLives(v: number): void {
  lives = v;
  livesEl.textContent = String(Math.max(0, lives));
}

function show(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hide(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  waiting = [];
  onboard = [];
  nextId = 1;
  setScore(0);
  setLives(START_LIVES);
  targetFloor = 1;
  elevatorY = floorCenterY(1);
  spawnTimer = 0;
  spawnInterval = SPAWN_START;
  currentPatience = PATIENCE_START;
  elapsed = 0;
  show(
    'Asansör',
    'Yolcuları sabırları tükenmeden doğru kata bırak. 1-5 tuşlarına bas veya bir kata tıkla.',
  );
  draw();
}

function startGame(): void {
  if (state === 'ready' || state === 'gameover') {
    reset(); // resets state to 'ready' first
  }
  state = 'playing';
  hide();
  // invisible-boot guard: spawn one passenger immediately so the first
  // frame the player sees has gameplay content, not an empty shaft.
  spawnPassenger();
  spawnTimer = spawnInterval * 0.5;
  startLoop();
  draw();
}

function spawnPassenger(): void {
  // Pick an origin floor that has room — keep waiting queues bounded so
  // sprite stacks never overflow into the shaft.
  const MAX_PER_FLOOR = 3;
  const counts: number[] = Array(FLOOR_COUNT + 1).fill(0);
  for (const p of waiting) counts[p.from]!++;
  const candidates: number[] = [];
  for (let f = 1; f <= FLOOR_COUNT; f++) {
    if (counts[f]! < MAX_PER_FLOOR) candidates.push(f);
  }
  if (candidates.length === 0) return; // all queues full; skip this tick
  const from = candidates[Math.floor(Math.random() * candidates.length)]!;
  // Destination must differ from origin.
  let dest = 1 + Math.floor(Math.random() * FLOOR_COUNT);
  if (dest === from) dest = ((dest % FLOOR_COUNT) + 1);
  waiting.push({
    id: nextId++,
    from,
    dest,
    patience: 1,
    patienceMax: currentPatience,
  });
}

function update(dt: number): void {
  if (state !== 'playing') return;
  elapsed += dt;

  // Elevator motion toward target floor.
  const targetY = floorCenterY(targetFloor);
  if (elevatorY !== targetY) {
    const delta = targetY - elevatorY;
    const step = ELEVATOR_SPEED * dt;
    if (Math.abs(delta) <= step) {
      elevatorY = targetY;
      onElevatorArrived();
    } else {
      elevatorY += Math.sign(delta) * step;
    }
  }

  // Patience drain for waiting passengers.
  for (const p of waiting) {
    p.patience -= dt / p.patienceMax;
  }
  // Remove patience-zeroed passengers; each costs a life.
  for (let i = waiting.length - 1; i >= 0; i--) {
    const p = waiting[i]!;
    if (p.patience <= 0) {
      waiting.splice(i, 1);
      loseLife();
      if (state !== 'playing') return;
    }
  }

  // Spawn ticker.
  spawnTimer += dt;
  if (spawnTimer >= spawnInterval) {
    spawnTimer = 0;
    spawnPassenger();
  }
}

function onElevatorArrived(): void {
  // First: deliver onboard passengers whose dest matches.
  let delivered = 0;
  for (let i = onboard.length - 1; i >= 0; i--) {
    if (onboard[i]!.dest === targetFloor) {
      onboard.splice(i, 1);
      delivered++;
    }
  }
  if (delivered > 0) {
    // Combo bonus: 2 in one stop = +5, 3 = +15.
    const combo = delivered >= 3 ? 15 : delivered >= 2 ? 5 : 0;
    setScore(score + delivered * SCORE_PER_DELIVERY + combo);
    // Ramp difficulty.
    spawnInterval = Math.max(SPAWN_MIN, spawnInterval - SPAWN_RAMP * delivered);
    currentPatience = Math.max(PATIENCE_MIN, currentPatience - PATIENCE_RAMP * delivered);
  }

  // Then: board waiting passengers at this floor while capacity allows.
  for (let i = 0; i < waiting.length && onboard.length < CAPACITY; ) {
    const p = waiting[i]!;
    if (p.from === targetFloor) {
      waiting.splice(i, 1);
      p.from = -1;
      onboard.push(p);
      // Don't advance i — next item shifted into this slot.
    } else {
      i++;
    }
  }
}

function loseLife(): void {
  setLives(lives - 1);
  if (lives <= 0) {
    gameOver();
  }
}

function gameOver(): void {
  state = 'gameover';
  reportGameOver(SCORE_DESC, score, { label: 'Skor' });
  show('Oyun bitti', `Skor: ${score} · R ile yeniden başla`);
}

function setTarget(floor: number): void {
  if (floor < 1 || floor > FLOOR_COUNT) return;
  if (state === 'ready') {
    targetFloor = floor;
    startGame();
    return;
  }
  if (state !== 'playing') return;
  targetFloor = floor;
}

// ---- Render ----

function draw(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, W, H);

  // Floor bands + numbers + call indicators.
  for (let f = FLOOR_COUNT; f >= 1; f--) {
    const top = TOP_MARGIN + (FLOOR_COUNT - f) * FLOOR_H;
    // alternating band tint for readability
    ctx.fillStyle = f % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, top, W, FLOOR_H);
    // floor separator line
    ctx.strokeStyle = getCss('--border');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(W, top);
    ctx.stroke();

    // floor number bezel
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, top, 26, FLOOR_H);
    ctx.fillStyle = getCss('--text-dim');
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(f), 13, top + FLOOR_H / 2);

    // call indicator (lit if any waiting passenger here)
    const hasCall = waiting.some((p) => p.from === f);
    ctx.beginPath();
    ctx.arc(40, top + 14, 5, 0, Math.PI * 2);
    ctx.fillStyle = hasCall ? '#fbbf24' : 'rgba(255,255,255,0.10)';
    ctx.fill();
  }
  // Bottom border of last floor.
  ctx.strokeStyle = getCss('--border');
  ctx.beginPath();
  ctx.moveTo(0, TOP_MARGIN + FLOOR_COUNT * FLOOR_H);
  ctx.lineTo(W, TOP_MARGIN + FLOOR_COUNT * FLOOR_H);
  ctx.stroke();

  // Shaft.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(SHAFT_X, TOP_MARGIN, SHAFT_W, FLOOR_COUNT * FLOOR_H);
  ctx.strokeStyle = getCss('--border');
  ctx.strokeRect(SHAFT_X, TOP_MARGIN, SHAFT_W, FLOOR_COUNT * FLOOR_H);
  // shaft cable
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.moveTo(SHAFT_X + SHAFT_W / 2, TOP_MARGIN);
  ctx.lineTo(SHAFT_X + SHAFT_W / 2, elevatorY);
  ctx.stroke();

  // Waiting passengers.
  for (const p of waiting) {
    const queueIdx = waiting.filter((q) => q.from === p.from).indexOf(p);
    const cx = WAIT_X + queueIdx * WAIT_GAP + PAX_R;
    const cy = floorCenterY(p.from);
    drawPassenger(cx, cy, p, /*onboard=*/ false);
  }

  // Elevator car.
  const carX = SHAFT_X + CAR_PAD;
  const carY = elevatorY - FLOOR_H / 2 + 8;
  const carH = FLOOR_H - 16;
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(carX, carY, CAR_W, carH);
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 2;
  ctx.strokeRect(carX, carY, CAR_W, carH);
  // door split
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(carX + CAR_W / 2, carY);
  ctx.lineTo(carX + CAR_W / 2, carY + carH);
  ctx.stroke();

  // Boarded passengers inside car (up to 3 slots).
  for (let i = 0; i < onboard.length; i++) {
    const p = onboard[i]!;
    const cx = carX + 22 + i * CAR_SLOT_GAP;
    const cy = elevatorY;
    drawPassenger(cx, cy, p, /*onboard=*/ true);
  }

  // Target floor indicator (next to shaft).
  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Hedef: ${targetFloor}`, SHAFT_X - 84, TOP_MARGIN + 14);

  // Capacity tag.
  ctx.fillStyle = getCss('--text-dim');
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(
    `Yolcu ${onboard.length}/${CAPACITY}`,
    SHAFT_X - 84,
    TOP_MARGIN + 32,
  );
}

function drawPassenger(cx: number, cy: number, p: Passenger, isOnboard: boolean): void {
  const color = DEST_COLORS[p.dest - 1]!;
  // patience ring (waiting only)
  if (!isOnboard) {
    ctx.beginPath();
    ctx.arc(cx, cy, PAX_R + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.patience);
    ctx.strokeStyle = p.patience > 0.4 ? '#9ca3af' : p.patience > 0.2 ? '#fbbf24' : '#ef4444';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  // body
  ctx.beginPath();
  ctx.arc(cx, cy, PAX_R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  // dest number
  ctx.fillStyle = '#0a0b0e';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(p.dest), cx, cy + 1);
}

// ---- rAF loop with generation token (PITFALLS#stale-async-callback) ----

function startLoop(): void {
  const token = gen.current();
  let lastTs = 0;
  const tick = (ts: number): void => {
    if (!gen.isCurrent(token)) return; // canceled by reset()
    if (state === 'gameover') return; // halt loop on game over
    if (lastTs === 0) lastTs = ts;
    const dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    if (state === 'playing') {
      update(dt);
      draw();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- CSS variable cache ----

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, v);
  return v;
}

// ---- Input ----

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k >= '1' && k <= '5') {
    setTarget(parseInt(k, 10));
    e.preventDefault();
    return;
  }
  if (k === 'ArrowUp' || k === 'w' || k === 'W') {
    setTarget(Math.min(FLOOR_COUNT, targetFloor + 1));
    e.preventDefault();
    return;
  }
  if (k === 'ArrowDown' || k === 's' || k === 'S') {
    setTarget(Math.max(1, targetFloor - 1));
    e.preventDefault();
    return;
  }
  if (k === ' ' && (state === 'playing' || state === 'paused')) {
    if (state === 'playing') {
      state = 'paused';
      show('Duraklatıldı', 'Devam için boşluk.');
    } else {
      state = 'playing';
      hide();
    }
    e.preventDefault();
    return;
  }
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
  }
}

function onCanvasClick(e: MouseEvent): void {
  const rect = canvas.getBoundingClientRect();
  const yPx = ((e.clientY - rect.top) / rect.height) * H;
  const f = pickFloorFromY(yPx);
  if (f !== null) setTarget(f);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKey);
  canvas.addEventListener('click', onCanvasClick);
  restartBtn.addEventListener('click', reset);

  document.querySelectorAll<HTMLButtonElement>('.floor-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = Number(btn.dataset.floor);
      if (Number.isFinite(f)) setTarget(f);
    });
  });

  reset();
}

export const game = defineGame({ init, reset });
