// Tane — falling-sand fill puzzle.
// Pour grains into a closed vessel (vase/bowl/bottle). Sand obeys grid
// gravity (down, then diagonal). Goal: fill the interior to TARGET_RATIO
// without exhausting the AMMO budget. Score = grains used (lower = better).
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM/storage access lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() cancels the RAF loop on reset/restart.
// - overlay-input-leak: pointer + key handlers gate on `state !== 'playing'`.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual.
// - hud-counter-synced-only-at-lifecycle-edges: HUD refreshed every frame.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const W = 36;
const H = 50;
const CELL = 10;

const STORAGE_BEST = 'tane.best';
const TARGET_RATIO = 0.85;
const AMMO_INITIAL = 700;
const SPAWN_PER_FRAME = 4;
const SPAWN_RADIUS = 1;
const REST_FRAMES_TO_FINISH = 30;

const EMPTY = 0;
const SAND = 1;
const WALL = 2;

type GameState = 'ready' | 'playing' | 'won' | 'lost';

interface Shape {
  key: 'vase' | 'bowl' | 'bottle';
  label: string;
  yTop: number;
  yBottom: number;
  fn: (y: number) => [number, number] | null;
}

const SHAPES: Shape[] = [
  {
    key: 'vase',
    label: 'Vazo',
    yTop: 5,
    yBottom: 45,
    fn: (y) => {
      if (y < 5 || y > 45) return null;
      const cx = 18;
      let half: number;
      if (y < 9) half = 5;
      else if (y < 14) half = 5 + (y - 9) * 1.1;
      else if (y < 34) half = 10.5;
      else if (y < 43) half = 10.5 - (y - 34) * 0.45;
      else half = 7;
      const xl = Math.round(cx - half);
      const xr = Math.round(cx + half);
      return [xl, xr];
    },
  },
  {
    key: 'bowl',
    label: 'Kase',
    yTop: 20,
    yBottom: 44,
    fn: (y) => {
      if (y < 20 || y > 44) return null;
      const cx = 18;
      const t = (y - 20) / (44 - 20);
      const half = 14 - Math.pow(t, 1.4) * 8;
      const xl = Math.round(cx - half);
      const xr = Math.round(cx + half);
      return [xl, xr];
    },
  },
  {
    key: 'bottle',
    label: 'Şişe',
    yTop: 5,
    yBottom: 45,
    fn: (y) => {
      if (y < 5 || y > 45) return null;
      const cx = 18;
      let half: number;
      if (y < 13) half = 3;
      else if (y < 18) half = 3 + (y - 13) * 1.4;
      else if (y < 42) half = 10;
      else half = 10 - (y - 42) * 0.6;
      const xl = Math.round(cx - half);
      const xr = Math.round(cx + half);
      return [xl, xr];
    },
  },
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let filledEl!: HTMLElement;
let spilledEl!: HTMLElement;
let ammoEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();
const grid = new Uint8Array(W * H);
const interior = new Uint8Array(W * H);

let interiorTotal = 0;
let state: GameState = 'ready';
let ammo = AMMO_INITIAL;
let usedGrains = 0;
let best: number | null = null;
let restingFrames = 0;
let isPouring = false;
let pourX = -1;
let pourY = -1;
let currentShape: Shape = SHAPES[0]!;

const colorCache = new Map<string, string>();
function css(name: string, fallback: string): string {
  const cached = colorCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const val = v || fallback;
  colorCache.set(name, val);
  return val;
}

function loadBest(): number | null {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function saveBest(): void {
  if (best !== null) safeWrite(STORAGE_BEST, best);
}

function pickShape(prev: Shape | null): Shape {
  if (SHAPES.length === 1) return SHAPES[0]!;
  let s: Shape;
  do {
    s = SHAPES[Math.floor(Math.random() * SHAPES.length)]!;
  } while (prev && s.key === prev.key);
  return s;
}

function buildShape(shape: Shape): void {
  grid.fill(EMPTY);
  interior.fill(0);
  interiorTotal = 0;
  for (let y = shape.yTop; y <= shape.yBottom; y++) {
    const range = shape.fn(y);
    if (!range) continue;
    const [xl, xr] = range;
    for (let x = xl; x < xr; x++) {
      if (x < 0 || x >= W) continue;
      const idx = y * W + x;
      interior[idx] = 1;
      interiorTotal++;
    }
  }
  // Walls = any cell that's a non-top neighbour of an interior cell but
  // itself non-interior. Skipping the top neighbour leaves the rim open
  // so sand can fall into the vessel.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (interior[y * W + x] !== 1) continue;
      if (x > 0 && interior[y * W + (x - 1)] !== 1) grid[y * W + (x - 1)] = WALL;
      if (x < W - 1 && interior[y * W + (x + 1)] !== 1) grid[y * W + (x + 1)] = WALL;
      if (y < H - 1 && interior[(y + 1) * W + x] !== 1) grid[(y + 1) * W + x] = WALL;
    }
  }
}

function countInside(): number {
  let c = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === SAND && interior[i] === 1) c++;
  }
  return c;
}

function countSpilled(): number {
  let c = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === SAND && interior[i] !== 1) c++;
  }
  return c;
}

function updateHud(): void {
  const inside = countInside();
  const ratio = interiorTotal > 0 ? Math.round((inside / interiorTotal) * 100) : 0;
  filledEl.textContent = ratio + '%';
  spilledEl.textContent = String(countSpilled());
  ammoEl.textContent = String(ammo);
}

function updatePhysics(): boolean {
  let anyMoved = false;
  const leftFirst = Math.random() < 0.5;
  for (let y = H - 2; y >= 0; y--) {
    const xStart = leftFirst ? 0 : W - 1;
    const xEnd = leftFirst ? W : -1;
    const xStep = leftFirst ? 1 : -1;
    for (let x = xStart; x !== xEnd; x += xStep) {
      const idx = y * W + x;
      if (grid[idx] !== SAND) continue;
      const belowIdx = (y + 1) * W + x;
      if (grid[belowIdx] === EMPTY) {
        grid[belowIdx] = SAND;
        grid[idx] = EMPTY;
        anyMoved = true;
        continue;
      }
      const canDL = x > 0 && grid[(y + 1) * W + (x - 1)] === EMPTY;
      const canDR = x < W - 1 && grid[(y + 1) * W + (x + 1)] === EMPTY;
      if (canDL && canDR) {
        const goLeft = Math.random() < 0.5;
        const tIdx = goLeft ? (y + 1) * W + (x - 1) : (y + 1) * W + (x + 1);
        grid[tIdx] = SAND;
        grid[idx] = EMPTY;
        anyMoved = true;
      } else if (canDL) {
        grid[(y + 1) * W + (x - 1)] = SAND;
        grid[idx] = EMPTY;
        anyMoved = true;
      } else if (canDR) {
        grid[(y + 1) * W + (x + 1)] = SAND;
        grid[idx] = EMPTY;
        anyMoved = true;
      }
    }
  }
  return anyMoved;
}

function spawnGrains(): void {
  if (!isPouring || ammo <= 0) return;
  for (let i = 0; i < SPAWN_PER_FRAME; i++) {
    if (ammo <= 0) break;
    const dx = Math.floor(Math.random() * (SPAWN_RADIUS * 2 + 1)) - SPAWN_RADIUS;
    const sx = pourX + dx;
    const sy = pourY;
    if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
    const idx = sy * W + sx;
    if (grid[idx] === EMPTY) {
      grid[idx] = SAND;
      ammo--;
      usedGrains++;
    }
  }
}

function render(): void {
  const bg = css('--bg', '#0a0b0e');
  const wall = '#3a3530';
  const wallEdge = '#5a4f44';
  const sand = '#e8c873';
  const sandDeep = '#c79a3c';
  const interiorTint = 'rgba(129, 140, 248, 0.06)';
  const accent = css('--accent', '#818cf8');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Soft tint inside the vessel so the silhouette is readable when empty.
  ctx.fillStyle = interiorTint;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (interior[y * W + x] === 1 && grid[y * W + x] === EMPTY) {
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }

  // Walls and sand.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = grid[y * W + x];
      if (v === WALL) {
        ctx.fillStyle = wall;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        ctx.fillStyle = wallEdge;
        ctx.fillRect(x * CELL, y * CELL, CELL, 1);
      } else if (v === SAND) {
        const inSide = interior[y * W + x] === 1;
        ctx.fillStyle = inSide ? sand : sandDeep;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }
  }

  // Pour cursor preview.
  if (isPouring && state === 'playing' && ammo > 0) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(
      pourX * CELL + CELL / 2,
      pourY * CELL + CELL / 2,
      CELL * 1.6,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function frame(myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (state === 'playing') {
    spawnGrains();
    const moved = updatePhysics();
    if (!moved && !isPouring) restingFrames++;
    else restingFrames = 0;
    if (restingFrames >= REST_FRAMES_TO_FINISH) {
      const inside = countInside();
      const ratio = interiorTotal > 0 ? inside / interiorTotal : 0;
      if (ratio >= TARGET_RATIO) {
        showWin();
      } else if (ammo === 0) {
        showLose();
      }
    }
    updateHud();
  }
  render();
  window.requestAnimationFrame(() => frame(myGen));
}

function showStartOverlay(): void {
  overlayTitle.textContent = currentShape.label;
  overlayMsg.textContent =
    'Kabı doldurmak için bas ve sürükle.\nHedef: %' +
    Math.round(TARGET_RATIO * 100) +
    ' dolu.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function showWin(): void {
  state = 'won';
  isPouring = false;
  if (best === null || usedGrains < best) {
    best = usedGrains;
    saveBest();
  }
  overlayTitle.textContent = 'Doldu!';
  overlayMsg.textContent =
    `${usedGrains} taneyle bitirdin.\nEn iyi: ${best ?? '—'}`;
  overlayBtn.textContent = 'Yeni şekil';
  showOverlay(overlay);
}

function showLose(): void {
  state = 'lost';
  isPouring = false;
  const inside = countInside();
  const ratio = interiorTotal > 0 ? Math.round((inside / interiorTotal) * 100) : 0;
  overlayTitle.textContent = 'Yetmedi';
  overlayMsg.textContent =
    `Kum bitti, kap %${ratio} doldu.\nHedef %${Math.round(TARGET_RATIO * 100)}.`;
  overlayBtn.textContent = 'Yeniden';
  showOverlay(overlay);
}

function newRound(nextShape: boolean): void {
  gen.bump();
  if (nextShape) currentShape = pickShape(currentShape);
  state = 'ready';
  ammo = AMMO_INITIAL;
  usedGrains = 0;
  isPouring = false;
  restingFrames = 0;
  pourX = -1;
  pourY = -1;
  buildShape(currentShape);
  updateHud();
  showStartOverlay();
  const myGen = gen.current();
  window.requestAnimationFrame(() => frame(myGen));
}

function beginPlay(): void {
  if (state === 'won' || state === 'lost') {
    newRound(true);
    return;
  }
  state = 'playing';
  restingFrames = 0;
  hideOverlay(overlay);
}

function clientToCell(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (clientX - rect.left) * sx;
  const py = (clientY - rect.top) * sy;
  return {
    x: Math.floor(px / CELL),
    y: Math.floor(py / CELL),
  };
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'won' || state === 'lost' || state === 'ready') return;
  const c = clientToCell(e.clientX, e.clientY);
  pourX = c.x;
  pourY = c.y;
  isPouring = true;
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  if (!isPouring) return;
  const c = clientToCell(e.clientX, e.clientY);
  pourX = c.x;
  pourY = c.y;
}

function onPointerUp(e: PointerEvent): void {
  if (state !== 'playing') return;
  isPouring = false;
  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    newRound(false);
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    newRound(true);
  } else if ((e.key === 'Enter' || e.key === ' ') && state !== 'playing') {
    e.preventDefault();
    beginPlay();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  filledEl = document.querySelector<HTMLElement>('#filled')!;
  spilledEl = document.querySelector<HTMLElement>('#spilled')!;
  ammoEl = document.querySelector<HTMLElement>('#ammo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = loadBest();
  currentShape = pickShape(null);

  restartBtn.addEventListener('click', () => newRound(false));
  overlayBtn.addEventListener('click', beginPlay);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onKey);

  newRound(false);
}

export const game = defineGame({ init, reset: () => newRound(false) });
