import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'sek-tahmin.best';

// Logical play-field in canvas pixels. The canvas attribute is 540x420, so
// we render in a 500x380 inner box with a 20-px frame around it for the
// HUD ticks. Keeping these as constants and reading them in both draw() and
// the bouncing simulation prevents PITFALLS#visual-vs-hitbox.
const FRAME = 20;
const BOX_W = 500;
const BOX_H = 380;
const BALL_R = 6;
const ENTRY_R = 7;
const ARROW_LEN = 56;
const ROUNDS_PER_MATCH = 10;
const ANIM_MS = 1600;

type Phase = 'ready' | 'await-guess' | 'animating' | 'reveal' | 'match-over';

type Wall = 'top' | 'bottom' | 'left' | 'right';

type Vec = { x: number; y: number };

type Round = {
  entry: Vec;
  entryWall: Wall;
  // Unit direction at entry (points into the box).
  dir: Vec;
  bounces: number;
  // Pre-computed path: array of segment endpoints in box coords. First point
  // is the entry, last point is the exit on the perimeter, intermediates are
  // the wall-hit points.
  path: Vec[];
  exit: Vec;
};

let phase: Phase = 'ready';
let round = 0;
let score = 0;
let best = 0;
let current: Round | null = null;
let guess: Vec | null = null;
let actualExit: Vec | null = null;
let lastGain = 0;
let lastDist = 0;
let animProgress = 0; // 0..1 across full path
let animRafId = 0;

// DOM
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let roundEl!: HTMLElement;
let bouncesEl!: HTMLElement;
let bestEl!: HTMLElement;
let dirEl!: HTMLElement;
let entryEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayBody!: HTMLElement;

const gen = createGenToken();

function box(): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: FRAME, y0: FRAME, x1: FRAME + BOX_W, y1: FRAME + BOX_H };
}

function clampPerimeter(p: Vec): Vec {
  const b = box();
  // Snap to the nearest wall, then clamp along it.
  const dLeft = Math.abs(p.x - b.x0);
  const dRight = Math.abs(p.x - b.x1);
  const dTop = Math.abs(p.y - b.y0);
  const dBottom = Math.abs(p.y - b.y1);
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return { x: b.x0, y: clamp(p.y, b.y0, b.y1) };
  if (min === dRight) return { x: b.x1, y: clamp(p.y, b.y0, b.y1) };
  if (min === dTop) return { x: clamp(p.x, b.x0, b.x1), y: b.y0 };
  return { x: clamp(p.x, b.x0, b.x1), y: b.y1 };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function chooseEntry(rng: () => number): { entry: Vec; wall: Wall; dir: Vec } {
  const b = box();
  const wallIdx = Math.floor(rng() * 4);
  const wall: Wall = (['top', 'bottom', 'left', 'right'] as const)[wallIdx]!;
  // Avoid corners: keep entry within 12% from each end.
  const t = 0.12 + rng() * 0.76;
  let entry: Vec;
  let inward: Vec;
  if (wall === 'top') {
    entry = { x: b.x0 + t * BOX_W, y: b.y0 };
    inward = { x: 0, y: 1 };
  } else if (wall === 'bottom') {
    entry = { x: b.x0 + t * BOX_W, y: b.y1 };
    inward = { x: 0, y: -1 };
  } else if (wall === 'left') {
    entry = { x: b.x0, y: b.y0 + t * BOX_H };
    inward = { x: 1, y: 0 };
  } else {
    entry = { x: b.x1, y: b.y0 + t * BOX_H };
    inward = { x: -1, y: 0 };
  }
  // Pick a slope. We avoid grazing angles (<15°) and dead-on perpendiculars.
  // Slope = tangential / normal, so for top/bottom that's dx/dy, for sides dy/dx.
  // Allowed range: tan(15°) ≈ 0.27 up to tan(72°) ≈ 3.08.
  const slope = (0.3 + rng() * 2.4) * (rng() < 0.5 ? -1 : 1);
  let dx: number;
  let dy: number;
  if (wall === 'top' || wall === 'bottom') {
    dx = slope;
    dy = inward.y;
  } else {
    dy = slope;
    dx = inward.x;
  }
  const m = Math.hypot(dx, dy);
  return { entry, wall, dir: { x: dx / m, y: dy / m } };
}

// Simulate bouncing inside the box. Stops after `targetBounces` wall hits;
// the final segment continues until the ball exits the box at one more wall
// (so total wall events = targetBounces + 1; the last one is the exit).
function simulate(entry: Vec, dir: Vec, targetBounces: number): Vec[] {
  const b = box();
  const pts: Vec[] = [{ ...entry }];
  let pos: Vec = { ...entry };
  let vx = dir.x;
  let vy = dir.y;
  // The entry itself sits exactly on a wall; nudge inward by a hair so the
  // first wall-hit check doesn't fire on t≈0.
  pos.x += vx * 0.001;
  pos.y += vy * 0.001;
  const eps = 1e-9;
  for (let i = 0; i <= targetBounces; i++) {
    // Time to hit each wall (only positive times).
    const tRight = vx > eps ? (b.x1 - pos.x) / vx : Infinity;
    const tLeft = vx < -eps ? (b.x0 - pos.x) / vx : Infinity;
    const tTop = vy < -eps ? (b.y0 - pos.y) / vy : Infinity;
    const tBottom = vy > eps ? (b.y1 - pos.y) / vy : Infinity;
    const t = Math.min(tRight, tLeft, tTop, tBottom);
    if (!isFinite(t)) break;
    const hit: Vec = { x: pos.x + vx * t, y: pos.y + vy * t };
    pts.push(hit);
    pos = hit;
    if (i < targetBounces) {
      // Reflect.
      if (t === tRight || t === tLeft) vx = -vx;
      if (t === tTop || t === tBottom) vy = -vy;
      // Nudge inward so the next loop's wall test doesn't re-fire on the
      // wall we just bounced off.
      pos.x += vx * 0.001;
      pos.y += vy * 0.001;
    }
  }
  return pts;
}

function pathLength(pts: Vec[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return s;
}

function bouncesForRound(r: number): number {
  // r is 1-indexed within a match.
  if (r <= 2) return 1;
  if (r <= 4) return 2;
  if (r <= 6) return 3;
  if (r <= 8) return 4;
  return 5;
}

function newRound(): Round {
  const rng = Math.random;
  const bounces = bouncesForRound(round);
  // Re-roll until we get a clean path (no degenerate corner-hit chain).
  for (let attempt = 0; attempt < 24; attempt++) {
    const { entry, wall, dir } = chooseEntry(rng);
    const pts = simulate(entry, dir, bounces);
    if (pts.length !== bounces + 2) continue; // simulation broke (corner glitch)
    const exit = pts[pts.length - 1]!;
    // Reject if exit is on the same wall and < 30 px from entry — boring.
    const sameWall =
      (wall === 'top' && exit.y === FRAME) ||
      (wall === 'bottom' && exit.y === FRAME + BOX_H) ||
      (wall === 'left' && exit.x === FRAME) ||
      (wall === 'right' && exit.x === FRAME + BOX_W);
    if (sameWall && Math.hypot(exit.x - entry.x, exit.y - entry.y) < 30)
      continue;
    return { entry, entryWall: wall, dir, bounces, path: pts, exit };
  }
  // Fallback: accept whatever last attempt was.
  const { entry, wall, dir } = chooseEntry(rng);
  const pts = simulate(entry, dir, bounces);
  return {
    entry,
    entryWall: wall,
    dir,
    bounces,
    path: pts,
    exit: pts[pts.length - 1]!,
  };
}

function scoreForDistance(d: number): number {
  if (d <= 12) return 20;
  if (d <= 30) return 10;
  if (d <= 60) return 4;
  return 0;
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  roundEl.textContent = `${Math.min(round, ROUNDS_PER_MATCH)}/${ROUNDS_PER_MATCH}`;
  bouncesEl.textContent = current ? String(current.bounces) : '—';
  bestEl.textContent = String(best);
  if (current) {
    const dx = current.dir.x;
    const dy = current.dir.y;
    dirEl.textContent = `dx ${dx.toFixed(2)} · dy ${dy.toFixed(2)}`;
    entryEl.textContent = current.entryWall;
  } else {
    dirEl.textContent = '—';
    entryEl.textContent = '—';
  }
}

function draw(): void {
  const b = box();
  // Clear.
  ctx.fillStyle = readVar('--bg', '#0a0b0e');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Box backdrop.
  ctx.fillStyle = readVar('--surface', '#16181d');
  ctx.fillRect(b.x0, b.y0, BOX_W, BOX_H);

  // Walls.
  ctx.strokeStyle = readVar('--border', '#2a2d33');
  ctx.lineWidth = 2;
  ctx.strokeRect(b.x0 + 1, b.y0 + 1, BOX_W - 2, BOX_H - 2);

  // Faint internal grid (visual aid for guessing).
  ctx.strokeStyle = 'rgba(170, 180, 200, 0.06)';
  ctx.lineWidth = 1;
  const step = 50;
  ctx.beginPath();
  for (let x = b.x0 + step; x < b.x1; x += step) {
    ctx.moveTo(x + 0.5, b.y0);
    ctx.lineTo(x + 0.5, b.y1);
  }
  for (let y = b.y0 + step; y < b.y1; y += step) {
    ctx.moveTo(b.x0, y + 0.5);
    ctx.lineTo(b.x1, y + 0.5);
  }
  ctx.stroke();

  if (!current) return;

  // Entry dot + direction arrow.
  const accent = readVar('--accent', '#7dd87a');
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(current.entry.x, current.entry.y, ENTRY_R, 0, Math.PI * 2);
  ctx.fill();
  drawArrow(
    current.entry.x,
    current.entry.y,
    current.entry.x + current.dir.x * ARROW_LEN,
    current.entry.y + current.dir.y * ARROW_LEN,
    accent,
  );

  // Animating path (so far) or full path on reveal.
  if (phase === 'animating' || phase === 'reveal') {
    drawPath(current.path, phase === 'reveal' ? 1 : animProgress);
  }

  // Guess marker.
  if (guess) {
    ctx.strokeStyle = '#e2b450';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(guess.x, guess.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    // Small tick on the wall it lives on.
    ctx.beginPath();
    ctx.moveTo(guess.x - 3, guess.y);
    ctx.lineTo(guess.x + 3, guess.y);
    ctx.moveTo(guess.x, guess.y - 3);
    ctx.lineTo(guess.x, guess.y + 3);
    ctx.stroke();
  }

  // Real exit (on reveal).
  if (phase === 'reveal' && actualExit) {
    ctx.strokeStyle = '#e16060';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(actualExit.x - 8, actualExit.y - 8);
    ctx.lineTo(actualExit.x + 8, actualExit.y + 8);
    ctx.moveTo(actualExit.x + 8, actualExit.y - 8);
    ctx.lineTo(actualExit.x - 8, actualExit.y + 8);
    ctx.stroke();
  }

  // Moving ball during animation.
  if (phase === 'animating') {
    const pos = pointAtProgress(current.path, animProgress);
    ctx.fillStyle = '#f4f4f6';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPath(pts: Vec[], progress: number): void {
  // Draw the polyline up to `progress` (0..1) of total length.
  const total = pathLength(pts);
  const target = total * progress;
  let walked = 0;
  ctx.strokeStyle = 'rgba(170, 200, 240, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    if (walked + seg <= target) {
      ctx.lineTo(pts[i]!.x, pts[i]!.y);
      walked += seg;
    } else {
      const remain = target - walked;
      const k = remain / seg;
      const x = pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * k;
      const y = pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * k;
      ctx.lineTo(x, y);
      break;
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function pointAtProgress(pts: Vec[], progress: number): Vec {
  const total = pathLength(pts);
  const target = total * progress;
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    if (walked + seg >= target) {
      const k = (target - walked) / seg;
      return {
        x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * k,
        y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * k,
      };
    }
    walked += seg;
  }
  return pts[pts.length - 1]!;
}

function drawArrow(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const h = 9;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - h * Math.cos(ang - Math.PI / 7),
    y1 - h * Math.sin(ang - Math.PI / 7),
  );
  ctx.lineTo(
    x1 - h * Math.cos(ang + Math.PI / 7),
    y1 - h * Math.sin(ang + Math.PI / 7),
  );
  ctx.closePath();
  ctx.fill();
}

const cssCache = new Map<string, string>();
function readVar(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const val = v || fallback;
  cssCache.set(name, val);
  return val;
}

function setOverlay(title: string, body: string): void {
  overlayTitle.textContent = title;
  overlayBody.innerHTML = body;
  showOverlay(overlay);
}

function hideOverlayUI(): void {
  hideOverlay(overlay);
}

function startMatch(): void {
  gen.bump();
  cancelAnimationFrame(animRafId);
  score = 0;
  round = 0;
  current = null;
  guess = null;
  actualExit = null;
  phase = 'ready';
  setOverlay(
    'Sek Tahmin',
    `<strong>${ROUNDS_PER_MATCH} tur</strong>. Yeşil noktadan giren topun, oka göre <strong>K kez</strong> sektikten sonra çıkacağı kenar noktasını tıkla.<br/>Enter/Boşluk: başla.`,
  );
  updateHud();
  draw();
}

function nextRound(): void {
  if (round >= ROUNDS_PER_MATCH) {
    endMatch();
    return;
  }
  round++;
  current = newRound();
  guess = null;
  actualExit = null;
  phase = 'await-guess';
  hideOverlayUI();
  updateHud();
  draw();
}

function submitGuess(p: Vec): void {
  if (phase !== 'await-guess' || !current) return;
  guess = clampPerimeter(p);
  actualExit = current.exit;
  lastDist = Math.hypot(guess.x - actualExit.x, guess.y - actualExit.y);
  lastGain = scoreForDistance(lastDist);
  phase = 'animating';
  animProgress = 0;
  draw();
  animateBall();
}

function animateBall(): void {
  const myGen = gen.current();
  const start = performance.now();
  const step = (now: number) => {
    if (!gen.isCurrent(myGen)) return;
    const dt = now - start;
    animProgress = Math.min(1, dt / ANIM_MS);
    draw();
    if (animProgress < 1) {
      animRafId = requestAnimationFrame(step);
    } else {
      finishReveal();
    }
  };
  animRafId = requestAnimationFrame(step);
}

function finishReveal(): void {
  if (phase !== 'animating') return;
  score += lastGain;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  phase = 'reveal';
  const label =
    lastGain === 20
      ? 'Tam isabet!'
      : lastGain === 10
        ? 'Çok yakın'
        : lastGain === 4
          ? 'Yakın'
          : 'Iskaladın';
  setOverlay(
    `+${lastGain}`,
    `${label} · sapma <strong>${Math.round(lastDist)} px</strong>.<br/>Enter/Boşluk: sonraki tur.`,
  );
  updateHud();
  draw();
}

function endMatch(): void {
  phase = 'match-over';
  setOverlay(
    'Parti bitti',
    `Toplam <strong>${score}</strong> puan · Rekor <strong>${best}</strong>.<br/>Enter/Boşluk veya Yeniden başla: yeni parti.`,
  );
  updateHud();
  draw();
}

function onCanvasClick(e: PointerEvent): void {
  if (phase !== 'await-guess') return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  submitGuess({ x: px, y: py });
  if (e.cancelable) e.preventDefault();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    startMatch();
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    if (phase === 'ready' || phase === 'reveal' || phase === 'match-over') {
      if (phase === 'match-over') startMatch();
      else nextRound();
      e.preventDefault();
    }
  }
}

function reset(): void {
  startMatch();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  bouncesEl = document.querySelector<HTMLElement>('#bounces')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  dirEl = document.querySelector<HTMLElement>('#dir')!;
  entryEl = document.querySelector<HTMLElement>('#entry')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayBody = document.querySelector<HTMLElement>('#overlay-body')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  canvas.addEventListener('pointerdown', onCanvasClick);
  overlay.addEventListener('pointerdown', (e) => {
    if (phase === 'ready' || phase === 'reveal' || phase === 'match-over') {
      if (phase === 'match-over') startMatch();
      else nextRound();
      e.preventDefault();
    }
  });
  window.addEventListener('keydown', onKey);

  startMatch();
}

export const game = defineGame({ init, reset });
