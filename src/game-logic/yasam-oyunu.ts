// Conway's Game of Life. Classic cellular automaton on a finite (wrapped)
// grid. Rules: a live cell with 2-3 live neighbors survives; a dead cell
// with exactly 3 live neighbors becomes alive; everything else dies.
// Edges wrap toroidally so gliders can roam without dropping off.
//
// User interaction:
//   - Click / drag on the canvas to paint (toggle on first cell touched,
//     then keep drawing the same value while the pointer is held).
//   - Space: play / pause. N: single step (only when paused).
//     C: clear. R: random fill (~25%). P: cycle preset (also "Desen ekle" button).
// Simulation tick driven by RAF; speed slider sets ticks-per-second.

import { defineGame } from '@shared/game-module';

const COLS = 60;
const ROWS = 42;
const RANDOM_DENSITY = 0.25;

interface Pattern {
  name: string;
  cells: ReadonlyArray<readonly [number, number]>;
}

const PRESETS: readonly Pattern[] = [
  {
    name: 'Glider',
    cells: [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 1],
      [2, 2],
    ],
  },
  {
    name: 'Salınım (Blinker)',
    cells: [
      [0, 0],
      [0, 1],
      [0, 2],
    ],
  },
  {
    name: 'Beacon',
    cells: [
      [0, 0],
      [0, 1],
      [1, 0],
      [2, 3],
      [3, 2],
      [3, 3],
    ],
  },
  {
    name: 'Pulsar',
    cells: [
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 8],
      [0, 9],
      [0, 10],
      [2, 0],
      [3, 0],
      [4, 0],
      [2, 5],
      [3, 5],
      [4, 5],
      [2, 7],
      [3, 7],
      [4, 7],
      [2, 12],
      [3, 12],
      [4, 12],
      [5, 2],
      [5, 3],
      [5, 4],
      [5, 8],
      [5, 9],
      [5, 10],
      [7, 2],
      [7, 3],
      [7, 4],
      [7, 8],
      [7, 9],
      [7, 10],
      [8, 0],
      [9, 0],
      [10, 0],
      [8, 5],
      [9, 5],
      [10, 5],
      [8, 7],
      [9, 7],
      [10, 7],
      [8, 12],
      [9, 12],
      [10, 12],
      [12, 2],
      [12, 3],
      [12, 4],
      [12, 8],
      [12, 9],
      [12, 10],
    ],
  },
  {
    name: 'Hafif uzay gemisi',
    cells: [
      [0, 1],
      [0, 4],
      [1, 0],
      [2, 0],
      [2, 4],
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
    ],
  },
];

type State = 'paused' | 'running';

let grid: Uint8Array = new Uint8Array(COLS * ROWS);
let next: Uint8Array = new Uint8Array(COLS * ROWS);
let state: State = 'paused';
let generation = 0;
let population = 0;
let stepsPerSecond = 10;
let accumulator = 0;
let lastTime = 0;
let presetIndex = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let generationEl!: HTMLElement;
let populationEl!: HTMLElement;
let playBtn!: HTMLButtonElement;
let stepBtn!: HTMLButtonElement;
let speedInput!: HTMLInputElement;
let speedOut!: HTMLElement;
let presetBtn!: HTMLButtonElement;
let randomBtn!: HTMLButtonElement;
let clearBtn!: HTMLButtonElement;

let cellSize = 10;
let painting = false;
let paintValue: 0 | 1 = 1;
let lastPainted = -1;

function idx(r: number, c: number): number {
  return r * COLS + c;
}

function wrap(v: number, max: number): number {
  return (v + max) % max;
}

function countLive(): number {
  let n = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i]) n++;
  return n;
}

function step(): void {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (grid[idx(wrap(r + dr, ROWS), wrap(c + dc, COLS))]) n++;
        }
      }
      const alive = grid[idx(r, c)] === 1;
      next[idx(r, c)] = alive ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
    }
  }
  const tmp = grid;
  grid = next;
  next = tmp;
  generation++;
  population = countLive();
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0c0e14';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#1a1d27';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < COLS; c++) {
    ctx.moveTo(c * cellSize + 0.5, 0);
    ctx.lineTo(c * cellSize + 0.5, h);
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.moveTo(0, r * cellSize + 0.5);
    ctx.lineTo(w, r * cellSize + 0.5);
  }
  ctx.stroke();

  ctx.fillStyle = '#7cf2a8';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[idx(r, c)]) {
        ctx.fillRect(c * cellSize + 1, r * cellSize + 1, cellSize - 2, cellSize - 2);
      }
    }
  }
}

function renderHud(): void {
  generationEl.textContent = String(generation);
  populationEl.textContent = String(population);
  playBtn.textContent = state === 'running' ? 'Duraklat' : 'Oynat';
  stepBtn.disabled = state === 'running';
}

function loop(now: number): void {
  requestAnimationFrame(loop);
  if (state !== 'running') {
    lastTime = now;
    return;
  }
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  accumulator += dt;
  const stepDuration = 1 / stepsPerSecond;
  let stepped = false;
  // cap to avoid spiral-of-death after tab restore
  let safety = 30;
  while (accumulator >= stepDuration && safety-- > 0) {
    step();
    accumulator -= stepDuration;
    stepped = true;
  }
  if (stepped) {
    draw();
    renderHud();
  }
}

function play(): void {
  if (population === 0) return;
  state = 'running';
  accumulator = 0;
  lastTime = performance.now();
  renderHud();
}

function pause(): void {
  state = 'paused';
  renderHud();
}

function togglePlay(): void {
  if (state === 'running') pause();
  else play();
}

function singleStep(): void {
  if (state === 'running') return;
  step();
  draw();
  renderHud();
}

function clearGrid(): void {
  pause();
  grid.fill(0);
  generation = 0;
  population = 0;
  draw();
  renderHud();
}

function randomize(): void {
  pause();
  for (let i = 0; i < grid.length; i++) {
    grid[i] = Math.random() < RANDOM_DENSITY ? 1 : 0;
  }
  generation = 0;
  population = countLive();
  draw();
  renderHud();
}

function placePreset(): void {
  pause();
  const p = PRESETS[presetIndex % PRESETS.length]!;
  presetIndex++;
  let maxR = 0;
  let maxC = 0;
  for (const [r, c] of p.cells) {
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  const offsetR = Math.floor((ROWS - maxR - 1) / 2);
  const offsetC = Math.floor((COLS - maxC - 1) / 2);
  grid.fill(0);
  for (const [r, c] of p.cells) {
    grid[idx(offsetR + r, offsetC + c)] = 1;
  }
  generation = 0;
  population = countLive();
  draw();
  renderHud();
  presetBtn.textContent = `Desen: ${p.name}`;
  window.setTimeout(() => {
    presetBtn.textContent = 'Desen ekle';
  }, 1400);
}

function pointerToCell(e: PointerEvent): { r: number; c: number } | null {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
  const c = Math.floor(x / cellSize);
  const r = Math.floor(y / cellSize);
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
  return { r, c };
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  const cell = pointerToCell(e);
  if (!cell) return;
  painting = true;
  const i = idx(cell.r, cell.c);
  paintValue = grid[i] === 1 ? 0 : 1;
  grid[i] = paintValue;
  lastPainted = i;
  population = countLive();
  draw();
  renderHud();
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!painting) return;
  const cell = pointerToCell(e);
  if (!cell) return;
  const i = idx(cell.r, cell.c);
  if (i === lastPainted) return;
  grid[i] = paintValue;
  lastPainted = i;
  population = countLive();
  draw();
  renderHud();
}

function onPointerUp(e: PointerEvent): void {
  if (!painting) return;
  painting = false;
  lastPainted = -1;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* noop */
  }
}

function resizeCanvas(): void {
  const wrap = canvas.parentElement!;
  const targetW = Math.min(wrap.clientWidth, 720);
  cellSize = Math.max(6, Math.floor(targetW / COLS));
  canvas.width = cellSize * COLS;
  canvas.height = cellSize * ROWS;
  draw();
}

function reset(): void {
  pause();
  grid.fill(0);
  generation = 0;
  population = 0;
  presetIndex = 0;
  // seed with a glider so first-time visitors see motion when they hit play
  const seed: ReadonlyArray<readonly [number, number]> = [
    [Math.floor(ROWS / 2) - 1, Math.floor(COLS / 2)],
    [Math.floor(ROWS / 2), Math.floor(COLS / 2) + 1],
    [Math.floor(ROWS / 2) + 1, Math.floor(COLS / 2) - 1],
    [Math.floor(ROWS / 2) + 1, Math.floor(COLS / 2)],
    [Math.floor(ROWS / 2) + 1, Math.floor(COLS / 2) + 1],
  ];
  for (const [r, c] of seed) grid[idx(r, c)] = 1;
  population = countLive();
  draw();
  renderHud();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  generationEl = document.querySelector<HTMLElement>('#generation')!;
  populationEl = document.querySelector<HTMLElement>('#population')!;
  playBtn = document.querySelector<HTMLButtonElement>('#play')!;
  stepBtn = document.querySelector<HTMLButtonElement>('#step')!;
  speedInput = document.querySelector<HTMLInputElement>('#speed')!;
  speedOut = document.querySelector<HTMLElement>('#speed-out')!;
  presetBtn = document.querySelector<HTMLButtonElement>('#preset')!;
  randomBtn = document.querySelector<HTMLButtonElement>('#randomize')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear')!;

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  playBtn.addEventListener('click', togglePlay);
  stepBtn.addEventListener('click', singleStep);
  randomBtn.addEventListener('click', randomize);
  clearBtn.addEventListener('click', clearGrid);
  presetBtn.addEventListener('click', placePreset);

  speedInput.addEventListener('input', () => {
    stepsPerSecond = Number(speedInput.value) || 10;
    speedOut.textContent = `${stepsPerSecond}/sn`;
  });
  stepsPerSecond = Number(speedInput.value) || 10;
  speedOut.textContent = `${stepsPerSecond}/sn`;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === ' ') {
      togglePlay();
      e.preventDefault();
    } else if (e.key === 'n' || e.key === 'N') {
      singleStep();
      e.preventDefault();
    } else if (e.key === 'c' || e.key === 'C') {
      clearGrid();
      e.preventDefault();
    } else if (e.key === 'r' || e.key === 'R') {
      randomize();
      e.preventDefault();
    } else if (e.key === 'p' || e.key === 'P') {
      placePreset();
      e.preventDefault();
    }
  });

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
