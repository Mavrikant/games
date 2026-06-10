// Çatlak — branching-crack precision arcade.
//
// A fracture sprouts from the rim of a ceramic plate and creeps inward as
// a chain of short segments. The leading "tip" drifts in small random
// angles; after a length threshold it forks into two new tips. Each tip
// shows a small ring the player can tap. Tapping the ring within a small
// radius seals that tip — frozen, no further growth from that branch.
// Tapping empty space (or the body) costs a life. If any active tip
// reaches the plate rim, the run ends. Score = sealed tips.
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM/storage access lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() cancels the RAF loop.
// - overlay-input-leak: pointer + key handlers gate on `state`.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual.
// - unreachable-start-state: overlay has both a Start button and Space/Enter.
// - hud-counter-synced-only-at-lifecycle-edges: setScore/setLives push
//   the new value to the DOM the same instant the model changes.
// - visual-vs-hitbox: TIP_HIT_RADIUS is shared by render + hitTest, and
//   TIP_FORGIVE adds the same forgiveness used to draw the outer ring.
// - stale-dom-from-prev-state: reset clears crack arrays before render.
// - designed-lose-condition-not-wired: edge-hit and miss both call loseLife.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'catlak.best';
const MAX_LIVES = 3;

const RIM_INSET = 26;             // distance from canvas edge to the plate rim
const SEG_LEN = 6;                // px per growth step (drawn segment)
const TIP_HIT_RADIUS = 16;        // visible ring radius; also collision radius
const TIP_FORGIVE = 8;            // extra slack so the tap feels fair
const FORK_LEN_START = 90;        // px of branch length before a tip forks
const FORK_LEN_FLOOR = 42;
const FORK_LEN_PER_POINT = 1.4;
const SPEED_START = 22;           // px / s
const SPEED_FLOOR_DELTA = 80;     // px / s added by score (capped below)
const SPEED_PER_POINT = 2.2;
const DRIFT_AMOUNT = 0.35;        // radians of jitter per step
const SEED_INTERVAL_START = 14;   // seconds before another rim seed sprouts
const SEED_INTERVAL_FLOOR = 4;
const SEED_PER_POINT = 0.35;
const MAX_ACTIVE_TIPS = 14;       // soft cap so the screen never overflows

type State = 'ready' | 'playing' | 'gameover';

interface Tip {
  x: number;
  y: number;
  angle: number;
  branchLen: number;       // px grown since last fork
  alive: boolean;
  sealed: boolean;
  age: number;             // seconds since spawn — used for pulse animation
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
}

interface Pop {
  x: number;
  y: number;
  born: number;
  text: string;
  color: string;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let lives = MAX_LIVES;

let tips: Tip[] = [];
let segments: Segment[] = [];
let pops: Pop[] = [];

let nowSec = 0;
let lastFrame = 0;
let nextSeed = 0;
let plateBounds = { left: 0, top: 0, right: 480, bottom: 540 };

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
  lives = Math.max(0, v);
  livesEl.textContent = String(lives);
}

function currentSpeed(): number {
  return SPEED_START + Math.min(SPEED_FLOOR_DELTA, score * SPEED_PER_POINT);
}

function currentForkLen(): number {
  return Math.max(FORK_LEN_FLOOR, FORK_LEN_START - score * FORK_LEN_PER_POINT);
}

function currentSeedInterval(): number {
  return Math.max(
    SEED_INTERVAL_FLOOR,
    SEED_INTERVAL_START - score * SEED_PER_POINT,
  );
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function activeTipCount(): number {
  let n = 0;
  for (const t of tips) if (t.alive && !t.sealed) n++;
  return n;
}

function spawnSeedFromRim(): void {
  if (activeTipCount() >= MAX_ACTIVE_TIPS) return;
  // Pick a random side and point along it, then point inward.
  const side = Math.floor(rand(0, 4)); // 0=top, 1=right, 2=bottom, 3=left
  let x = 0;
  let y = 0;
  let angle = 0;
  const inset = RIM_INSET + 2;
  if (side === 0) {
    x = rand(plateBounds.left + 40, plateBounds.right - 40);
    y = plateBounds.top + 2;
    angle = Math.PI / 2 + rand(-0.35, 0.35);
  } else if (side === 1) {
    x = plateBounds.right - 2;
    y = rand(plateBounds.top + 40, plateBounds.bottom - 40);
    angle = Math.PI + rand(-0.35, 0.35);
  } else if (side === 2) {
    x = rand(plateBounds.left + 40, plateBounds.right - 40);
    y = plateBounds.bottom - 2;
    angle = -Math.PI / 2 + rand(-0.35, 0.35);
  } else {
    x = plateBounds.left + 2;
    y = rand(plateBounds.top + 40, plateBounds.bottom - 40);
    angle = 0 + rand(-0.35, 0.35);
  }
  // Push the spawn point a generous distance inside the rim so the first
  // tip ring spawns in safe territory and the player has time to react.
  const inwardPush = inset * 1.8;
  x += Math.cos(angle) * inwardPush;
  y += Math.sin(angle) * inwardPush;
  tips.push({ x, y, angle, branchLen: 0, alive: true, sealed: false, age: 0 });
}

function distToRim(x: number, y: number): number {
  const dx = Math.min(x - plateBounds.left, plateBounds.right - x);
  const dy = Math.min(y - plateBounds.top, plateBounds.bottom - y);
  return Math.min(dx, dy);
}

function growTips(dt: number): void {
  const speed = currentSpeed();
  const forkLen = currentForkLen();
  const newTips: Tip[] = [];
  for (const tip of tips) {
    tip.age += dt;
    if (!tip.alive || tip.sealed) continue;
    const stepDist = speed * dt;
    let remaining = stepDist;
    while (remaining > 0 && tip.alive && !tip.sealed) {
      const step = Math.min(SEG_LEN, remaining);
      const nx = tip.x + Math.cos(tip.angle) * step;
      const ny = tip.y + Math.sin(tip.angle) * step;
      segments.push({
        x1: tip.x,
        y1: tip.y,
        x2: nx,
        y2: ny,
        thickness: 2 + Math.min(2, score * 0.02),
      });
      tip.x = nx;
      tip.y = ny;
      tip.branchLen += step;
      tip.angle += rand(-DRIFT_AMOUNT, DRIFT_AMOUNT);
      // Check rim breach.
      if (distToRim(tip.x, tip.y) <= 2) {
        tip.alive = false;
        edgeHit();
        return;
      }
      // Fork?
      if (tip.branchLen >= forkLen) {
        tip.alive = false;
        const spread = rand(0.5, 0.9);
        if (
          tips.length + newTips.length <
          MAX_ACTIVE_TIPS + 4
        ) {
          newTips.push({
            x: tip.x,
            y: tip.y,
            angle: tip.angle + spread,
            branchLen: 0,
            alive: true,
            sealed: false,
            age: 0,
          });
          newTips.push({
            x: tip.x,
            y: tip.y,
            angle: tip.angle - spread,
            branchLen: 0,
            alive: true,
            sealed: false,
            age: 0,
          });
        }
        break;
      }
      remaining -= step;
    }
  }
  for (const t of newTips) tips.push(t);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Tabak çatladı';
  overlayMsg.textContent =
    `Skor: ${score}  ·  Rekor: ${best}\n` +
    'Bir tuşa, butona ya da tabağa dokun: yeni bir tabak çıkarılır.';
  overlayBtn.textContent = 'Yeniden başla';
  showOverlay(overlay);
}

function edgeHit(): void {
  if (state !== 'playing') return;
  state = 'gameover';
  spawnPop(
    plateBounds.left + (plateBounds.right - plateBounds.left) / 2,
    plateBounds.top + 22,
    'kenara ulaştı',
    '#d94a4a',
  );
  showGameOverOverlay();
}

function loseLife(): void {
  setLives(lives - 1);
  if (lives <= 0) {
    state = 'gameover';
    showGameOverOverlay();
  }
}

function spawnPop(x: number, y: number, text: string, color: string): void {
  pops.push({ x, y, text, color, born: nowSec });
  if (pops.length > 20) pops.shift();
}

function tryTap(cx: number, cy: number): void {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < tips.length; i++) {
    const t = tips[i]!;
    if (!t.alive || t.sealed) continue;
    const dx = t.x - cx;
    const dy = t.y - cy;
    const d2 = dx * dx + dy * dy;
    const r = TIP_HIT_RADIUS + TIP_FORGIVE;
    if (d2 <= r * r && d2 < bestDist) {
      bestDist = d2;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) {
    spawnPop(cx, cy, 'kaçırma', '#d94a4a');
    loseLife();
    return;
  }
  const t = tips[bestIdx]!;
  t.sealed = true;
  setScore(score + 1);
  spawnPop(t.x, t.y, '+1', '#3da16b');
}

function drawPlate(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const rx = (plateBounds.right - plateBounds.left) / 2;
  const ry = (plateBounds.bottom - plateBounds.top) / 2;
  ctx.save();
  ctx.strokeStyle = '#a8946a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(168, 148, 106, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx - 10, ry - 10, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawSegments(): void {
  ctx.save();
  ctx.strokeStyle = '#2b2620';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of segments) {
    ctx.lineWidth = s.thickness;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTips(): void {
  for (const t of tips) {
    if (!t.alive && !t.sealed) continue;
    ctx.save();
    if (t.sealed) {
      ctx.fillStyle = 'rgba(60, 130, 90, 0.55)';
      ctx.beginPath();
      ctx.arc(t.x, t.y, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (t.alive) {
      const pulse = 0.6 + 0.4 * Math.sin(nowSec * 8 + t.age * 2);
      const rimNear = Math.max(0, 1 - distToRim(t.x, t.y) / 50);
      const baseAlpha = 0.55 + 0.4 * pulse;
      ctx.strokeStyle =
        rimNear > 0.3
          ? `rgba(220, 70, 70, ${baseAlpha})`
          : `rgba(34, 34, 34, ${baseAlpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, TIP_HIT_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle =
        rimNear > 0.3 ? 'rgba(220, 70, 70, 0.9)' : 'rgba(34, 34, 34, 0.9)';
      ctx.beginPath();
      ctx.arc(t.x, t.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawPops(): void {
  for (const p of pops) {
    const age = nowSec - p.born;
    const t = age / 0.85;
    const y = p.y - 28 * t;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.fillStyle = p.color;
    ctx.font = '700 14px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.text, p.x, y);
    ctx.restore();
  }
}

function draw(): void {
  drawPlate();
  drawSegments();
  drawTips();
  drawPops();
}

function update(dt: number): void {
  if (state !== 'playing') return;
  nowSec += dt;
  growTips(dt);
  if (state !== 'playing') return;
  if (nowSec >= nextSeed) {
    spawnSeedFromRim();
    nextSeed = nowSec + currentSeedInterval();
  }
  pops = pops.filter((p) => nowSec - p.born < 0.85);
}

function loop(timestamp: number): void {
  const myGen = gen.current();
  if (!gen.isCurrent(myGen)) return;
  const t = timestamp / 1000;
  const raw = lastFrame === 0 ? 0 : t - lastFrame;
  const dt = Math.min(raw, 1 / 15);
  lastFrame = t;
  // Animate `nowSec` for the pulse even in ready/gameover so the plate
  // feels alive; growth itself is gated by state inside update().
  if (state !== 'playing') nowSec += dt;
  update(dt);
  draw();
  if (gen.isCurrent(myGen)) {
    requestAnimationFrame((ts) => {
      if (gen.isCurrent(myGen)) loop(ts);
    });
  }
}

function startGame(): void {
  state = 'playing';
  score = 0;
  setScore(0);
  setLives(MAX_LIVES);
  tips = [];
  segments = [];
  pops = [];
  nowSec = 0;
  lastFrame = 0;
  nextSeed = currentSeedInterval();
  spawnSeedFromRim();
  hideOverlay(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  tips = [];
  segments = [];
  pops = [];
  nowSec = 0;
  lastFrame = 0;
  setScore(0);
  setLives(MAX_LIVES);
  overlayTitle.textContent = 'Çatlak';
  overlayMsg.textContent =
    'Tabağın kenarından bir çatlak doğar ve içeri ilerler.\n' +
    'Aktif uçtaki halkaya dokun — uç mühürlenir, büyümez.\n' +
    'Çatallanır, hızlanır; bir uç kenara değerse tabak çatlar.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
  draw();
  requestAnimationFrame(loop);
}

function computePlateBounds(): void {
  plateBounds = {
    left: RIM_INSET,
    top: RIM_INSET,
    right: canvas.width - RIM_INSET,
    bottom: canvas.height - RIM_INSET,
  };
}

function onPointer(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const cx = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const cy = ((e.clientY - rect.top) / rect.height) * canvas.height;
  if (state === 'ready') {
    startGame();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state !== 'playing') return;
  tryTap(cx, cy);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready') {
    if (k === ' ' || k === 'enter') {
      startGame();
      e.preventDefault();
    }
    return;
  }
  if (state === 'gameover') {
    if (k === ' ' || k === 'enter') {
      reset();
      e.preventDefault();
    }
    return;
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  computePlateBounds();

  canvas.addEventListener('pointerdown', onPointer);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => {
    if (state === 'ready') startGame();
    else if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
