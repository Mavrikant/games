import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_BEST = 'kar-tanesi.best';

const W = 480;
const H = 480;
const CX = 240;
const CY = 250;

const WEDGES = 6;
const SLOTS_PER_WEDGE = 2;
const SLOTS_PER_RING = WEDGES * SLOTS_PER_WEDGE;
const RINGS = 4;
const RING_RADII = [56, 96, 136, 176];
const CELL_RADIUS = 14;
const TWO_PI = Math.PI * 2;
const SLOT_ANGLE = TWO_PI / SLOTS_PER_RING;

const GAME_TIME = 90;
const SOLVED_FLASH_TIME = 0.55;

const PREVIEW_CX = 410;
const PREVIEW_CY = 70;
const PREVIEW_SCALE = 0.24;
const PREVIEW_CELL_R = 4;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeft = GAME_TIME;

let current: boolean[][] = [];
let target: boolean[][] = [];

let hoverRing = -1;
let hoverWedgeSlot = -1;

let solvedFlash = 0;

let lastFrame = 0;
let rafId: number | null = null;

function makeBoard(): boolean[][] {
  const b: boolean[][] = [];
  for (let r = 0; r < RINGS; r++) {
    b.push(new Array<boolean>(SLOTS_PER_RING).fill(false));
  }
  return b;
}

function boardsEqual(a: boolean[][], b: boolean[][]): boolean {
  for (let r = 0; r < RINGS; r++) {
    const rowA = a[r]!;
    const rowB = b[r]!;
    for (let s = 0; s < SLOTS_PER_RING; s++) {
      if (rowA[s] !== rowB[s]) return false;
    }
  }
  return true;
}

function isBoardEmpty(board: boolean[][]): boolean {
  for (let r = 0; r < RINGS; r++) {
    const row = board[r]!;
    for (let s = 0; s < SLOTS_PER_RING; s++) {
      if (row[s]) return false;
    }
  }
  return true;
}

function applyToggle(board: boolean[][], ring: number, wedgeSlot: number): void {
  const row = board[ring]!;
  for (let w = 0; w < WEDGES; w++) {
    const idx = (w * SLOTS_PER_WEDGE + wedgeSlot) % SLOTS_PER_RING;
    row[idx] = !row[idx];
  }
}

function randomTarget(): boolean[][] {
  const board = makeBoard();
  const totalGroups = RINGS * SLOTS_PER_WEDGE;
  const toggleCount = 3 + Math.floor(Math.random() * 4);
  const indices = new Set<number>();
  while (indices.size < toggleCount) {
    indices.add(Math.floor(Math.random() * totalGroups));
  }
  for (const idx of indices) {
    const ring = Math.floor(idx / SLOTS_PER_WEDGE);
    const wedgeSlot = idx % SLOTS_PER_WEDGE;
    applyToggle(board, ring, wedgeSlot);
  }
  return board;
}

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setTime(v: number): void {
  timeLeft = v;
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
}

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function clearOverlay(): void {
  hideOverlayEl(overlay);
}

function newPuzzle(): void {
  current = makeBoard();
  let next = randomTarget();
  let tries = 0;
  while ((boardsEqual(next, current) || isBoardEmpty(next)) && tries < 8) {
    next = randomTarget();
    tries++;
  }
  target = next;
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  setScore(0);
  setTime(GAME_TIME);
  solvedFlash = 0;
  hoverRing = -1;
  hoverWedgeSlot = -1;
  newPuzzle();
  draw();
  setOverlay(
    'Kar Tanesi',
    "Sağ üstteki hedefi eşle. Tek tıklama 6 yönde simetrik yansır.\n90 saniye içinde ne kadar çok kar tanesi çözebilirsin?\n\nBaşlamak için tıkla ya da Boşluk'a bas.",
  );
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  setScore(0);
  setTime(GAME_TIME);
  solvedFlash = 0;
  newPuzzle();
  clearOverlay();
  lastFrame = performance.now();
  startLoop();
  draw();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  if (score > best) {
    setBest(score);
    safeWrite(STORAGE_BEST, best);
  }
  setOverlay(
    'Süre bitti',
    `Çözüm: ${score} · Rekor: ${best}\nTekrar denemek için tıkla ya da Boşluk'a bas.`,
  );
  draw();
}

function startLoop(): void {
  if (rafId !== null) return;
  const myGen = gen.current();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen) || state !== 'playing') {
      rafId = null;
      return;
    }
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    update(dt);
    draw();
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function update(dt: number): void {
  setTime(timeLeft - dt);
  if (solvedFlash > 0) solvedFlash = Math.max(0, solvedFlash - dt);
  if (timeLeft <= 0) {
    setTime(0);
    endGame();
  }
}

function cellCenter(ring: number, slot: number): { x: number; y: number } {
  const radius = RING_RADII[ring]!;
  const angle = slot * SLOT_ANGLE - Math.PI / 2;
  return { x: CX + Math.cos(angle) * radius, y: CY + Math.sin(angle) * radius };
}

function findHit(px: number, py: number): { ring: number; wedgeSlot: number } | null {
  let bestDist = Number.POSITIVE_INFINITY;
  let bestRing = -1;
  let bestSlot = -1;
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SLOTS_PER_RING; s++) {
      const c = cellCenter(r, s);
      const dx = px - c.x;
      const dy = py - c.y;
      const d2 = dx * dx + dy * dy;
      const reach = CELL_RADIUS + 4;
      if (d2 <= reach * reach && d2 < bestDist) {
        bestDist = d2;
        bestRing = r;
        bestSlot = s;
      }
    }
  }
  if (bestRing === -1) return null;
  return { ring: bestRing, wedgeSlot: bestSlot % SLOTS_PER_WEDGE };
}

function handlePlay(px: number, py: number): void {
  const hit = findHit(px, py);
  if (!hit) return;
  applyToggle(current, hit.ring, hit.wedgeSlot);
  if (boardsEqual(current, target)) {
    setScore(score + 1);
    solvedFlash = SOLVED_FLASH_TIME;
    newPuzzle();
  }
}

function canvasCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startGame();
    return;
  }
  if (state === 'playing') {
    const p = canvasCoords(e);
    handlePlay(p.x, p.y);
    draw();
  }
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') {
    if (hoverRing !== -1) {
      hoverRing = -1;
      hoverWedgeSlot = -1;
      draw();
    }
    return;
  }
  const p = canvasCoords(e);
  const hit = findHit(p.x, p.y);
  const newRing = hit ? hit.ring : -1;
  const newSlot = hit ? hit.wedgeSlot : -1;
  if (newRing !== hoverRing || newSlot !== hoverWedgeSlot) {
    hoverRing = newRing;
    hoverWedgeSlot = newSlot;
    draw();
  }
}

function onPointerLeave(): void {
  if (hoverRing !== -1 || hoverWedgeSlot !== -1) {
    hoverRing = -1;
    hoverWedgeSlot = -1;
    if (state === 'playing') draw();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state === 'ready' || state === 'gameover') {
      startGame();
      e.preventDefault();
    }
  }
}

function drawBackdrop(): void {
  ctx.fillStyle = '#050810';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#0e1730';
  ctx.lineWidth = 1;
  for (let s = 0; s < SLOTS_PER_RING; s++) {
    const angle = s * SLOT_ANGLE - Math.PI / 2;
    const inner = 18;
    const outer = RING_RADII[RINGS - 1]! + 28;
    ctx.beginPath();
    ctx.moveTo(CX + Math.cos(angle) * inner, CY + Math.sin(angle) * inner);
    ctx.lineTo(CX + Math.cos(angle) * outer, CY + Math.sin(angle) * outer);
    ctx.stroke();
  }
  ctx.strokeStyle = '#15203b';
  ctx.lineWidth = 1.4;
  for (let w = 0; w < WEDGES; w++) {
    const angle = w * (TWO_PI / WEDGES) - Math.PI / 2;
    const inner = 14;
    const outer = RING_RADII[RINGS - 1]! + 34;
    ctx.beginPath();
    ctx.moveTo(CX + Math.cos(angle) * inner, CY + Math.sin(angle) * inner);
    ctx.lineTo(CX + Math.cos(angle) * outer, CY + Math.sin(angle) * outer);
    ctx.stroke();
  }

  ctx.strokeStyle = '#101a30';
  ctx.lineWidth = 1;
  for (let r = 0; r < RINGS; r++) {
    ctx.beginPath();
    ctx.arc(CX, CY, RING_RADII[r]!, 0, TWO_PI);
    ctx.stroke();
  }

  ctx.fillStyle = '#1e2a44';
  ctx.beginPath();
  ctx.arc(CX, CY, 6, 0, TWO_PI);
  ctx.fill();
  if (solvedFlash > 0) {
    const a = solvedFlash / SOLVED_FLASH_TIME;
    ctx.strokeStyle = `rgba(147, 197, 253, ${(a * 0.7).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(CX, CY, 8 + (1 - a) * 16, 0, TWO_PI);
    ctx.stroke();
  }
}

function drawBoard(
  board: boolean[][],
  cx: number,
  cy: number,
  scale: number,
  cellR: number,
  withHover: boolean,
): void {
  const hoverSet = new Set<number>();
  if (withHover && hoverRing !== -1 && hoverWedgeSlot !== -1) {
    for (let w = 0; w < WEDGES; w++) {
      hoverSet.add((w * SLOTS_PER_WEDGE + hoverWedgeSlot) % SLOTS_PER_RING);
    }
  }

  for (let r = 0; r < RINGS; r++) {
    const radius = RING_RADII[r]! * scale;
    for (let s = 0; s < SLOTS_PER_RING; s++) {
      const angle = s * SLOT_ANGLE - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      const on = board[r]![s]!;
      const hovered = withHover && hoverRing === r && hoverSet.has(s);

      if (on) {
        ctx.fillStyle = hovered ? '#dbeafe' : '#93c5fd';
        if (withHover) {
          ctx.shadowBlur = 10;
          ctx.shadowColor = '#60a5fa';
        }
        ctx.beginPath();
        ctx.arc(x, y, cellR, 0, TWO_PI);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.32)';
        ctx.beginPath();
        ctx.arc(x - cellR * 0.3, y - cellR * 0.3, cellR * 0.35, 0, TWO_PI);
        ctx.fill();
      } else {
        ctx.strokeStyle = hovered ? '#60a5fa' : '#1e2a44';
        ctx.lineWidth = hovered ? 2 : 1.5;
        ctx.beginPath();
        ctx.arc(x, y, cellR, 0, TWO_PI);
        ctx.stroke();
        if (hovered) {
          ctx.fillStyle = 'rgba(96, 165, 250, 0.16)';
          ctx.beginPath();
          ctx.arc(x, y, cellR - 1, 0, TWO_PI);
          ctx.fill();
        }
      }
    }
  }
}

function drawPreview(): void {
  const pr = RING_RADII[RINGS - 1]! * PREVIEW_SCALE + 14;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(PREVIEW_CX, PREVIEW_CY, pr, 0, TWO_PI);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#7ea6e8';
  ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('HEDEF', PREVIEW_CX, PREVIEW_CY - pr - 4);
  ctx.textAlign = 'left';

  ctx.fillStyle = '#1e293b';
  ctx.beginPath();
  ctx.arc(PREVIEW_CX, PREVIEW_CY, 1.6, 0, TWO_PI);
  ctx.fill();

  drawBoard(target, PREVIEW_CX, PREVIEW_CY, PREVIEW_SCALE, PREVIEW_CELL_R, false);
}

function draw(): void {
  drawBackdrop();
  drawBoard(current, CX, CY, 1, CELL_RADIUS, true);
  drawPreview();

  if (solvedFlash > 0) {
    const a = solvedFlash / SOLVED_FLASH_TIME;
    ctx.fillStyle = `rgba(147, 197, 253, ${(a * 0.08).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  setBest(safeRead<number>(STORAGE_BEST, 0));

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') startGame();
  });
  restartBtn.addEventListener('click', () => {
    reset();
  });
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
