import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'origami.best';

type State = 'ready' | 'playing' | 'solved' | 'stuck';
type FoldDir = 'left' | 'right' | 'up' | 'down';

interface Star {
  x: number;
  y: number;
  count: number;
}

interface Level {
  startStars: Star[];
  bounds: { left: number; top: number; right: number; bottom: number };
}

const GRID = 8;
const CELL = 56;
const PAD = 16;
const BOARD_W = GRID * CELL + PAD * 2;
const BOARD_TOP = PAD;
const BOARD_LEFT = PAD;

let level = 1;
let best = 0;
let state: State = 'ready';
let foldsUsed = 0;

let stars: Star[] = [];
let bounds = { left: 0, top: 0, right: GRID, bottom: GRID };
let currentLevel: Level | null = null;
let animT = 0;
let animFold: { dir: FoldDir; midline: number; preBounds: typeof bounds } | null = null;
let solvedTimer = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let foldsEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const cssCache = new Map<string, string>();
function css(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v || '#fff');
  return cssCache.get(name)!;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  showOverlayEl(overlayEl);
}
function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyFoldToStars(
  list: Star[],
  dir: FoldDir,
  curBounds: typeof bounds,
): { next: Star[]; nextBounds: typeof bounds } | null {
  const w = curBounds.right - curBounds.left;
  const h = curBounds.bottom - curBounds.top;
  if (dir === 'left' || dir === 'right') {
    if (w <= 1) return null;
  } else {
    if (h <= 1) return null;
  }
  const mid =
    dir === 'left' || dir === 'right'
      ? (curBounds.left + curBounds.right) / 2
      : (curBounds.top + curBounds.bottom) / 2;
  const nextBounds = { ...curBounds };
  const moved: Star[] = [];
  for (const s of list) {
    let nx = s.x;
    let ny = s.y;
    if (dir === 'left') {
      // fold right half onto left half; stars with x >= mid mirror
      if (s.x >= mid) nx = 2 * mid - 1 - s.x;
    } else if (dir === 'right') {
      if (s.x < mid) nx = 2 * mid - 1 - s.x;
    } else if (dir === 'up') {
      if (s.y >= mid) ny = 2 * mid - 1 - s.y;
    } else {
      if (s.y < mid) ny = 2 * mid - 1 - s.y;
    }
    moved.push({ x: nx, y: ny, count: s.count });
  }
  if (dir === 'left') nextBounds.right = mid;
  else if (dir === 'right') nextBounds.left = mid;
  else if (dir === 'up') nextBounds.bottom = mid;
  else nextBounds.top = mid;
  // Merge stars at same cell
  const merged: Star[] = [];
  for (const s of moved) {
    const existing = merged.find((m) => m.x === s.x && m.y === s.y);
    if (existing) existing.count += s.count;
    else merged.push({ ...s });
  }
  return { next: merged, nextBounds };
}

function inverseFold(
  list: Star[],
  dir: FoldDir,
  curBounds: typeof bounds,
  rand: () => number,
): { next: Star[]; nextBounds: typeof bounds } | null {
  // Inverse fold: expand bounds in chosen direction (doubles that dimension),
  // then peel exactly one star instance to the mirrored side. This guarantees
  // every scatter step actually scatters.
  const nextBounds = { ...curBounds };
  const w = curBounds.right - curBounds.left;
  const h = curBounds.bottom - curBounds.top;
  let mirrorMid: number;
  if (dir === 'left') {
    if (curBounds.right + w > GRID) return null;
    nextBounds.right = curBounds.right + w;
    mirrorMid = curBounds.right;
  } else if (dir === 'right') {
    if (curBounds.left - w < 0) return null;
    nextBounds.left = curBounds.left - w;
    mirrorMid = curBounds.left;
  } else if (dir === 'up') {
    if (curBounds.bottom + h > GRID) return null;
    nextBounds.bottom = curBounds.bottom + h;
    mirrorMid = curBounds.bottom;
  } else {
    if (curBounds.top - h < 0) return null;
    nextBounds.top = curBounds.top - h;
    mirrorMid = curBounds.top;
  }
  const totalStars = list.reduce((sum, s) => sum + s.count, 0);
  if (totalStars === 0) return null;
  // Pick a random star instance to peel (weight by count).
  let pickIdx = Math.floor(rand() * totalStars);
  let target: Star | null = null;
  for (const s of list) {
    if (pickIdx < s.count) {
      target = s;
      break;
    }
    pickIdx -= s.count;
  }
  if (!target) return null;
  const out = list.map((s) =>
    s === target ? { ...s, count: s.count - 1 } : { ...s },
  ).filter((s) => s.count > 0);
  let mx = target.x;
  let my = target.y;
  if (dir === 'left' || dir === 'right') mx = 2 * mirrorMid - 1 - target.x;
  else my = 2 * mirrorMid - 1 - target.y;
  const existing = out.find((s) => s.x === mx && s.y === my);
  if (existing) existing.count += 1;
  else out.push({ x: mx, y: my, count: 1 });
  return { next: out, nextBounds };
}

function generateLevel(lvl: number): Level {
  // Deterministic seed so a level number is reproducible (better streak feel).
  const seed = (lvl * 2654435761 + 0x9e3779b9) >>> 0;
  const rand = mulberry32(seed);
  // Number of folds needed grows slowly so puzzles stay tractable.
  const scatterSteps = Math.min(2 + Math.floor(lvl / 2), 6);
  const starCount = Math.min(scatterSteps + 1, 7);

  for (let attempt = 0; attempt < 16; attempt++) {
    // Start with all stars stacked in a random 1x1 cell, then scatter.
    const sx = 2 + Math.floor(rand() * 4);
    const sy = 2 + Math.floor(rand() * 4);
    let curBounds = { left: sx, top: sy, right: sx + 1, bottom: sy + 1 };
    let cur: Star[] = [{ x: sx, y: sy, count: starCount }];

    let steps = 0;
    let failed = 0;
    const dirs: FoldDir[] = ['left', 'right', 'up', 'down'];
    while (steps < scatterSteps && failed < 12) {
      // Prefer directions that still have room; otherwise try any.
      const order = [...dirs].sort(() => rand() - 0.5);
      let applied = false;
      for (const dir of order) {
        const result = inverseFold(cur, dir, curBounds, rand);
        if (result) {
          cur = result.next;
          curBounds = result.nextBounds;
          applied = true;
          steps++;
          break;
        }
      }
      if (!applied) failed++;
    }
    if (cur.length >= 2) {
      return {
        startStars: cur.map((s) => ({ ...s })),
        bounds: { ...curBounds },
      };
    }
  }
  // Fallback: simple two-star puzzle
  return {
    startStars: [
      { x: 1, y: 3, count: 1 },
      { x: 6, y: 3, count: 1 },
    ],
    bounds: { left: 0, top: 0, right: GRID, bottom: GRID },
  };
}

function isSolved(list: Star[]): boolean {
  if (list.length !== 1) return false;
  // Total stars in single cell — count must equal sum from start
  return true;
}

function totalStars(list: Star[]): number {
  let n = 0;
  for (const s of list) n += s.count;
  return n;
}

function canFoldAny(curBounds: typeof bounds): boolean {
  return curBounds.right - curBounds.left > 1 || curBounds.bottom - curBounds.top > 1;
}

function loadLevel(lvl: number): void {
  currentLevel = generateLevel(lvl);
  stars = currentLevel.startStars.map((s) => ({ ...s }));
  bounds = { ...currentLevel.bounds };
  foldsUsed = 0;
  foldsEl.textContent = '0';
  animT = 0;
  animFold = null;
  solvedTimer = 0;
}

function tryFold(dir: FoldDir): void {
  if (state !== 'playing') return;
  if (animFold) return;
  const result = applyFoldToStars(stars, dir, bounds);
  if (!result) return;
  const preBounds = { ...bounds };
  const midline =
    dir === 'left' || dir === 'right'
      ? (preBounds.left + preBounds.right) / 2
      : (preBounds.top + preBounds.bottom) / 2;
  animFold = { dir, midline, preBounds };
  animT = 0;
  // Pre-commit the result so animation just visually transitions
  stars = result.next;
  bounds = result.nextBounds;
  foldsUsed++;
  foldsEl.textContent = String(foldsUsed);
  draw();
}

function finishFoldAnimation(): void {
  animFold = null;
  draw();
  if (isSolved(stars)) {
    state = 'solved';
    solvedTimer = 0;
    if (level > best) {
      best = level;
      bestEl.textContent = String(best);
      safeWrite(STORAGE_BEST, best);
    }
    showOverlay(
      'Tek hücreye toplandı',
      `Bölüm ${level} çözüldü.<br/>Boşluk ile bölüm ${level + 1} açılır.`,
    );
  } else if (!canFoldAny(bounds)) {
    state = 'stuck';
    showOverlay(
      'Yıldızlar dağıldı',
      `Kağıt küçüldü ama yıldızlar tek hücrede değil.<br/>R ile bölümü baştan dene.`,
    );
  }
}

function startPlaying(): void {
  if (state !== 'ready' && state !== 'solved' && state !== 'stuck') return;
  if (state === 'solved') level++;
  if (state === 'stuck') {
    // restart this level — counts toward best only on solve
  }
  state = 'playing';
  scoreEl.textContent = String(level);
  loadLevel(level);
  hideOverlay();
  draw();
}

function resetLevel(): void {
  if (state === 'playing' || state === 'stuck' || state === 'solved') {
    state = 'playing';
    loadLevel(level);
    hideOverlay();
    draw();
  }
}

function fullReset(): void {
  level = 1;
  state = 'ready';
  scoreEl.textContent = '1';
  loadLevel(level);
  showOverlay(
    'Origami',
    'Ok tuşları veya WASD ile katla. Tüm yıldızları tek hücrede topla.<br/>Boşluk ile başla.',
  );
  draw();
}

function cellRect(gx: number, gy: number): { x: number; y: number; w: number; h: number } {
  return {
    x: BOARD_LEFT + gx * CELL,
    y: BOARD_TOP + gy * CELL,
    w: CELL,
    h: CELL,
  };
}

function drawStarShape(cx: number, cy: number, r: number): void {
  const spikes = 5;
  const inner = r * 0.45;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (Math.PI * i) / spikes - Math.PI / 2;
    const rad = i % 2 === 0 ? r : inner;
    const px = cx + Math.cos(ang) * rad;
    const py = cy + Math.sin(ang) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function draw(): void {
  ctx.fillStyle = css('--surface');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Outer board outline (full original paper as faint outline)
  const outerX = BOARD_LEFT;
  const outerY = BOARD_TOP;
  const outerW = GRID * CELL;
  const outerH = GRID * CELL;
  ctx.strokeStyle = css('--origami-outline');
  ctx.lineWidth = 1;
  ctx.strokeRect(outerX + 0.5, outerY + 0.5, outerW, outerH);

  // Draw paper area (current bounds) with subtle grid
  const paperX = BOARD_LEFT + bounds.left * CELL;
  const paperY = BOARD_TOP + bounds.top * CELL;
  const paperW = (bounds.right - bounds.left) * CELL;
  const paperH = (bounds.bottom - bounds.top) * CELL;

  // Paper fill
  ctx.fillStyle = css('--origami-paper');
  ctx.fillRect(paperX, paperY, paperW, paperH);

  // Subtle inner crease grid
  ctx.strokeStyle = css('--origami-crease');
  ctx.lineWidth = 1;
  for (let i = bounds.left + 1; i < bounds.right; i++) {
    const x = BOARD_LEFT + i * CELL + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, paperY);
    ctx.lineTo(x, paperY + paperH);
    ctx.stroke();
  }
  for (let i = bounds.top + 1; i < bounds.bottom; i++) {
    const y = BOARD_TOP + i * CELL + 0.5;
    ctx.beginPath();
    ctx.moveTo(paperX, y);
    ctx.lineTo(paperX + paperW, y);
    ctx.stroke();
  }

  // Paper border
  ctx.strokeStyle = css('--origami-edge');
  ctx.lineWidth = 2;
  ctx.strokeRect(paperX + 0.5, paperY + 0.5, paperW - 1, paperH - 1);

  // Stars — handle the fold animation:
  // During animation, "static" stars are those that didn't move (already on stationary half),
  // "moving" stars are mirrored over the midline. We approximate by tween from pre-mirror
  // position to post-mirror position.
  if (animFold) {
    const t = animT;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    for (const s of stars) {
      // We need to know if this star "came from" the folded-away side.
      // Heuristic: if the star is on the stationary half post-fold, it might be
      // a moved star OR original. We just slide all stars from their MIRRORED
      // PRE position toward their final cell. For static stars this is a no-op.
      let preX = s.x;
      let preY = s.y;
      const pre = animFold.preBounds;
      const dir = animFold.dir;
      const mid = animFold.midline;
      // If the star post-fold lies on the stationary half, its potential pre-fold
      // position on the folded side would be the mirror of post position.
      let mirroredX = s.x;
      let mirroredY = s.y;
      if (dir === 'left' || dir === 'right') mirroredX = 2 * mid - 1 - s.x;
      else mirroredY = 2 * mid - 1 - s.y;
      // Only animate from mirrored position if the mirrored cell was inside the pre-bounds
      // on the folded-away half. Otherwise star is purely static.
      let wasOnFoldedSide = false;
      if (dir === 'left' && mirroredX >= mid && mirroredX < pre.right) wasOnFoldedSide = true;
      if (dir === 'right' && mirroredX < mid && mirroredX >= pre.left) wasOnFoldedSide = true;
      if (dir === 'up' && mirroredY >= mid && mirroredY < pre.bottom) wasOnFoldedSide = true;
      if (dir === 'down' && mirroredY < mid && mirroredY >= pre.top) wasOnFoldedSide = true;
      if (wasOnFoldedSide) {
        preX = mirroredX;
        preY = mirroredY;
      }
      const finalCellX = BOARD_LEFT + s.x * CELL + CELL / 2;
      const finalCellY = BOARD_TOP + s.y * CELL + CELL / 2;
      const preCellX = BOARD_LEFT + preX * CELL + CELL / 2;
      const preCellY = BOARD_TOP + preY * CELL + CELL / 2;
      const drawX = preCellX + (finalCellX - preCellX) * ease;
      const drawY = preCellY + (finalCellY - preCellY) * ease;
      ctx.fillStyle = css('--origami-star');
      ctx.shadowColor = css('--origami-star');
      ctx.shadowBlur = 6;
      drawStarShape(drawX, drawY, CELL * 0.28);
      ctx.shadowBlur = 0;
      if (s.count > 1) {
        ctx.fillStyle = css('--origami-badge');
        ctx.beginPath();
        ctx.arc(drawX + CELL * 0.22, drawY - CELL * 0.22, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = css('--origami-badge-text');
        ctx.font = '600 12px system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(s.count), drawX + CELL * 0.22, drawY - CELL * 0.22 + 0.5);
      }
    }
  } else {
    for (const s of stars) {
      const r = cellRect(s.x, s.y);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      ctx.fillStyle = css('--origami-star');
      ctx.shadowColor = css('--origami-star');
      ctx.shadowBlur = state === 'solved' ? 16 : 6;
      drawStarShape(cx, cy, r.w * 0.28);
      ctx.shadowBlur = 0;
      if (s.count > 1) {
        ctx.fillStyle = css('--origami-badge');
        ctx.beginPath();
        ctx.arc(cx + r.w * 0.22, cy - r.h * 0.22, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = css('--origami-badge-text');
        ctx.font = '600 12px system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(s.count), cx + r.w * 0.22, cy - r.h * 0.22 + 0.5);
      }
    }
  }

  // Footer hint strip: show level info & remaining stars total
  const footerY = BOARD_TOP + outerH + 14;
  ctx.fillStyle = css('--text-dim');
  ctx.font = '500 13px system-ui,sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const total = totalStars(stars);
  const dim = `${bounds.right - bounds.left} × ${bounds.bottom - bounds.top}`;
  ctx.fillText(`Kağıt ${dim}  ·  Yıldız ${total}`, BOARD_LEFT, footerY);
  ctx.textAlign = 'right';
  ctx.fillText(`← ↑ → ↓  ·  R sıfırla`, BOARD_LEFT + outerW, footerY);
}

let rafHandle = 0;
function loop(ts: number): void {
  rafHandle = requestAnimationFrame(loop);
  if (animFold) {
    animT += 1 / 16; // ~16 frames per fold
    if (animT >= 1) {
      animT = 1;
      finishFoldAnimation();
    } else {
      draw();
    }
  } else if (state === 'solved') {
    solvedTimer++;
    if (solvedTimer % 20 === 0) draw();
  }
  void ts;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  foldsEl = document.querySelector<HTMLElement>('#folds')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  // Resize canvas internally to match design.
  canvas.width = BOARD_W;
  canvas.height = GRID * CELL + PAD * 2 + 36;

  restartBtn.addEventListener('click', () => {
    fullReset();
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      tryFold('left');
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      tryFold('right');
      e.preventDefault();
    } else if (k === 'arrowup' || k === 'w') {
      tryFold('up');
      e.preventDefault();
    } else if (k === 'arrowdown' || k === 's') {
      tryFold('down');
      e.preventDefault();
    } else if (k === ' ' || k === 'spacebar' || k === 'enter') {
      if (state === 'ready' || state === 'solved' || state === 'stuck') startPlaying();
      e.preventDefault();
    } else if (k === 'r') {
      if (state === 'playing' || state === 'stuck') resetLevel();
      else if (state === 'ready') startPlaying();
      e.preventDefault();
    } else if (k === 'n') {
      if (state === 'solved') startPlaying();
      e.preventDefault();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const dir = btn.dataset.fold as FoldDir | undefined;
    if (dir) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (state === 'ready' || state === 'solved' || state === 'stuck') startPlaying();
        tryFold(dir);
      });
    } else if (btn.id === 'touch-reset') {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (state === 'playing' || state === 'stuck') resetLevel();
        else if (state === 'solved') startPlaying();
        else if (state === 'ready') startPlaying();
      });
    }
  });

  overlayEl.addEventListener('click', () => {
    if (state === 'ready' || state === 'solved' || state === 'stuck') startPlaying();
  });

  fullReset();
  loop(0);
}

function reset(): void {
  fullReset();
  if (rafHandle) cancelAnimationFrame(rafHandle);
  loop(0);
}

export const game = defineGame({ init, reset });
