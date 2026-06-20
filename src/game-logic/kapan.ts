import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// PITFALLS guarded here:
// - module-level-dom-access / unguarded-storage: every DOM and storage call
//   lives inside init(); defineGame() queues init for after the DOM parses.
// - stale-async-callback: the only async work is the rabbit-move flash;
//   it carries a gen token and no-ops after reset() so spammed restarts
//   cannot leak a stale resolution.
// - overlay-input-leak: every click handler bails out unless state ===
//   'playing'. The overlay button is the only way to leave 'ready' /
//   'gameover'.
// - visual-vs-hitbox: drawing and pointer hit-testing share the same
//   cellPx and GRID constants — no duplicated geometry.
// - hud-counter-synced-only-at-lifecycle-edges: setScore() writes the
//   variable and the DOM in the same call.

const GRID = 11;
const BARRIER_LIFE = 6;
const RABBIT_FLASH_MS = 240;
const STORAGE_BEST = 'kapan.best';

type State = 'ready' | 'playing' | 'gameover';

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let rabbit = { x: 5, y: 5 };
let prevRabbit = { x: 5, y: 5 };
let moveAnim = 0;
// barriers[y][x] = remaining life (>=1) or 0 for empty.
let barriers: number[][] = [];
let cellPx = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function emptyGrid(): number[][] {
  const g: number[][] = [];
  for (let y = 0; y < GRID; y++) {
    const row: number[] = [];
    for (let x = 0; x < GRID; x++) row.push(0);
    g.push(row);
  }
  return g;
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < GRID && y < GRID;
}

function isEdge(x: number, y: number): boolean {
  return x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1;
}

// BFS from rabbit through empty (non-barrier) cells. Returns the first step
// on a shortest path to any edge cell, or null when no edge is reachable.
function planRabbitMove(): { x: number; y: number } | null {
  const sx = rabbit.x;
  const sy = rabbit.y;
  if (isEdge(sx, sy)) return null;
  const dist: number[][] = [];
  const prev: ({ x: number; y: number } | null)[][] = [];
  for (let y = 0; y < GRID; y++) {
    const row: number[] = [];
    const prow: ({ x: number; y: number } | null)[] = [];
    for (let x = 0; x < GRID; x++) {
      row.push(-1);
      prow.push(null);
    }
    dist.push(row);
    prev.push(prow);
  }
  dist[sy]![sx] = 0;
  const queue: { x: number; y: number }[] = [{ x: sx, y: sy }];
  let target: { x: number; y: number } | null = null;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (isEdge(cur.x, cur.y)) {
      target = cur;
      break;
    }
    const neigh = [
      { x: cur.x + 1, y: cur.y },
      { x: cur.x - 1, y: cur.y },
      { x: cur.x, y: cur.y + 1 },
      { x: cur.x, y: cur.y - 1 },
    ];
    for (const n of neigh) {
      if (!inBounds(n.x, n.y)) continue;
      if (barriers[n.y]![n.x]! > 0) continue;
      if (dist[n.y]![n.x]! !== -1) continue;
      dist[n.y]![n.x] = dist[cur.y]![cur.x]! + 1;
      prev[n.y]![n.x] = { x: cur.x, y: cur.y };
      queue.push(n);
    }
  }
  if (!target) return null;
  let cur = target;
  while (true) {
    const p = prev[cur.y]![cur.x];
    if (!p) return cur;
    if (p.x === sx && p.y === sy) return cur;
    cur = p;
  }
}

function setScore(n: number): void {
  score = n;
  scoreEl.textContent = String(score);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
}

function resetBoard(): void {
  barriers = emptyGrid();
  rabbit = { x: 5, y: 5 };
  prevRabbit = { x: 5, y: 5 };
  moveAnim = 0;
}

function showOverlayWith(title: string, msg: string, btnText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnText;
  showOverlay(overlayEl);
}

function reset(): void {
  gen.bump();
  resetBoard();
  setScore(0);
  state = 'ready';
  showOverlayWith(
    'Kapan',
    'Boş bir hücreye dokun: bariyer dik. Tavşan kenara ulaşmadan kuşat.',
    'Başla',
  );
  draw();
}

function startNewRound(): void {
  gen.bump();
  resetBoard();
  state = 'playing';
  hideOverlay(overlayEl);
  draw();
}

function gameOver(): void {
  state = 'gameover';
  commitBest();
  showOverlayWith(
    'Kaçtı!',
    `Tavşan kenara ulaştı. Bu seansta ${score} kapan. Yeniden dene.`,
    'Yeniden başla',
  );
  draw();
}

function roundCleared(): void {
  setScore(score + 1);
  commitBest();
  resetBoard();
  draw();
  state = 'gameover'; // input lock during the celebration; "Sıradaki" starts next.
  showOverlayWith(
    'Kapan kapandı!',
    `Tavşan #${score} köşeye sıkıştı. Sonraki tavşan için devam et.`,
    'Sıradaki',
  );
}

function handleCellClick(cx: number, cy: number): void {
  if (state !== 'playing') return;
  if (!inBounds(cx, cy)) return;
  if (rabbit.x === cx && rabbit.y === cy) return;
  if (barriers[cy]![cx]! > 0) return;

  // 1. Plant fresh barrier with full life.
  barriers[cy]![cx] = BARRIER_LIFE;
  // 2. Decay every OTHER barrier so the just-placed one shows full life.
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (x === cx && y === cy) continue;
      if (barriers[y]![x]! > 0) {
        barriers[y]![x] = barriers[y]![x]! - 1;
      }
    }
  }
  // 3. Plan rabbit move.
  const next = planRabbitMove();
  if (next === null) {
    draw();
    const myGen = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      roundCleared();
    }, 360);
    return;
  }
  // 4. Apply rabbit move with a short flash.
  prevRabbit = { x: rabbit.x, y: rabbit.y };
  rabbit = next;
  moveAnim = 1;
  const myGen = gen.current();
  const animStart = performance.now();
  const tick = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    const t = (now - animStart) / RABBIT_FLASH_MS;
    moveAnim = Math.max(0, 1 - t);
    draw();
    if (moveAnim > 0) {
      window.requestAnimationFrame(tick);
    } else if (isEdge(rabbit.x, rabbit.y)) {
      gameOver();
    }
  };
  window.requestAnimationFrame(tick);
}

function draw(): void {
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = getCss('--kapan-bg', '#0c1018');
  ctx.fillRect(0, 0, w, h);

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const px = x * cellPx;
      const py = y * cellPx;
      const edge = isEdge(x, y);
      ctx.fillStyle = edge
        ? getCss('--kapan-edge', '#1c2533')
        : getCss('--kapan-cell', '#141a23');
      ctx.fillRect(px + 1, py + 1, cellPx - 2, cellPx - 2);
    }
  }

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const life = barriers[y]![x]!;
      if (life <= 0) continue;
      const t = life / BARRIER_LIFE;
      const px = x * cellPx;
      const py = y * cellPx;
      const pad = cellPx * (0.12 + (1 - t) * 0.18);
      const r = Math.round(214 * t + 110 * (1 - t));
      const g = Math.round(140 * t + 80 * (1 - t));
      const b = Math.round(60 * t + 50 * (1 - t));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const radius = Math.max(3, cellPx * 0.16);
      roundRect(
        ctx,
        px + pad,
        py + pad,
        cellPx - pad * 2,
        cellPx - pad * 2,
        radius,
      );
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.4 * t})`;
      const dotR = Math.max(1.2, cellPx * 0.045);
      for (let i = 0; i < life; i++) {
        const dx = px + cellPx - pad - dotR - i * (dotR * 2.4);
        const dy = py + pad + dotR + 1;
        if (dx < px + pad) break;
        ctx.beginPath();
        ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const rabbitT = 1 - moveAnim;
  const rx = (prevRabbit.x + (rabbit.x - prevRabbit.x) * rabbitT) * cellPx;
  const ry = (prevRabbit.y + (rabbit.y - prevRabbit.y) * rabbitT) * cellPx;
  drawRabbit(rx + cellPx / 2, ry + cellPx / 2, cellPx * 0.38, moveAnim);
}

function drawRabbit(cx: number, cy: number, r: number, flash: number): void {
  ctx.fillStyle = getCss('--kapan-rabbit', '#f1f5f9');
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.1, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.4, cy - r * 0.8, r * 0.18, r * 0.55, -0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.4, cy - r * 0.8, r * 0.18, r * 0.55, 0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#101418';
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.3, cy, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f472b6';
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.3, r * 0.11, 0, Math.PI * 2);
  ctx.fill();
  if (flash > 0) {
    ctx.strokeStyle = `rgba(244, 114, 182, ${0.55 * flash})`;
    ctx.lineWidth = Math.max(2, r * 0.18 * flash);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1.2 + (1 - flash) * 0.6), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.quadraticCurveTo(x + w, y, x + w, y + rr);
  c.lineTo(x + w, y + h - rr);
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  c.lineTo(x + rr, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - rr);
  c.lineTo(x, y + rr);
  c.quadraticCurveTo(x, y, x + rr, y);
  c.closePath();
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  const val = v || fallback;
  cssCache.set(varName, val);
  return val;
}

function pointerCell(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = Math.floor((px * scaleX) / cellPx);
  const cy = Math.floor((py * scaleY) / cellPx);
  return { x: cx, y: cy };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  cellPx = canvas.width / GRID;
  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);
  setScore(0);
  resetBoard();

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    const c = pointerCell(e);
    handleCellClick(c.x, c.y);
  });

  overlayBtn.addEventListener('click', () => {
    if (state === 'playing') return;
    startNewRound();
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if ((k === ' ' || k === 'enter') && state !== 'playing') {
      startNewRound();
      e.preventDefault();
    }
  });

  showOverlayWith(
    'Kapan',
    'Boş bir hücreye dokun: bariyer dik. Tavşan kenara ulaşmadan kuşat.',
    'Başla',
  );
  draw();
}

export const game = defineGame({ init, reset });
