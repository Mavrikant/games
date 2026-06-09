import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const COLS = 10;
const ROWS = 10;
const CELL = 36;
const STORAGE_BEST = 'sonar-labirent.best';

const PING_SPEED = 320;
const PING_FADE = 70;
const WALL_DECAY = 0.93;
const MOVE_COOLDOWN_MS = 110;
const MAX_PINGS = 4;

type Cell = { n: boolean; e: boolean; s: boolean; w: boolean; visited: boolean };
type Wall = { x1: number; y1: number; x2: number; y2: number; lit: number };
type Ping = { x: number; y: number; radius: number };
type State = 'ready' | 'playing' | 'won';
type Dir = 'up' | 'down' | 'left' | 'right';

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let boardWrap!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let cells: Cell[][] = [];
let walls: Wall[] = [];
let pings: Ping[] = [];
let playerCol = 0;
let playerRow = 0;
let pingCount = 0;
let best = 0;
let state: State = 'ready';
let lastMoveTime = 0;
let lastFrame = 0;
let rafHandle: number | null = null;
let myGen = 0;

function setBestDisplay(): void {
  bestEl.textContent = best > 0 ? String(best) : '—';
}

function generateMaze(): void {
  cells = [];
  for (let r = 0; r < ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < COLS; c++) {
      row.push({ n: true, e: true, s: true, w: true, visited: false });
    }
    cells.push(row);
  }

  const stack: { c: number; r: number }[] = [];
  cells[0]![0]!.visited = true;
  stack.push({ c: 0, r: 0 });

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const c = top.c;
    const r = top.r;
    const opts: { dir: Dir; c: number; r: number }[] = [];
    if (r > 0 && !cells[r - 1]![c]!.visited) opts.push({ dir: 'up', c, r: r - 1 });
    if (c < COLS - 1 && !cells[r]![c + 1]!.visited) opts.push({ dir: 'right', c: c + 1, r });
    if (r < ROWS - 1 && !cells[r + 1]![c]!.visited) opts.push({ dir: 'down', c, r: r + 1 });
    if (c > 0 && !cells[r]![c - 1]!.visited) opts.push({ dir: 'left', c: c - 1, r });

    if (opts.length === 0) {
      stack.pop();
      continue;
    }

    const pick = opts[Math.floor(Math.random() * opts.length)]!;
    const here = cells[r]![c]!;
    const there = cells[pick.r]![pick.c]!;

    if (pick.dir === 'up') {
      here.n = false;
      there.s = false;
    } else if (pick.dir === 'right') {
      here.e = false;
      there.w = false;
    } else if (pick.dir === 'down') {
      here.s = false;
      there.n = false;
    } else {
      here.w = false;
      there.e = false;
    }

    there.visited = true;
    stack.push({ c: pick.c, r: pick.r });
  }

  walls = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = cells[r]![c]!;
      if (cell.n) {
        walls.push({ x1: c * CELL, y1: r * CELL, x2: (c + 1) * CELL, y2: r * CELL, lit: 0 });
      }
      if (cell.w) {
        walls.push({ x1: c * CELL, y1: r * CELL, x2: c * CELL, y2: (r + 1) * CELL, lit: 0 });
      }
    }
  }
  for (let c = 0; c < COLS; c++) {
    walls.push({
      x1: c * CELL,
      y1: ROWS * CELL,
      x2: (c + 1) * CELL,
      y2: ROWS * CELL,
      lit: 0,
    });
  }
  for (let r = 0; r < ROWS; r++) {
    walls.push({
      x1: COLS * CELL,
      y1: r * CELL,
      x2: COLS * CELL,
      y2: (r + 1) * CELL,
      lit: 0,
    });
  }
}

function distPointToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function update(dt: number): void {
  const maxR = Math.hypot(COLS * CELL, ROWS * CELL);
  for (const ping of pings) {
    ping.radius += PING_SPEED * dt;
  }
  pings = pings.filter((p) => p.radius < maxR + PING_FADE);

  for (const wall of walls) {
    wall.lit *= WALL_DECAY;
    if (wall.lit < 0.005) wall.lit = 0;
    for (const ping of pings) {
      const d = distPointToSegment(ping.x, ping.y, wall.x1, wall.y1, wall.x2, wall.y2);
      const delta = ping.radius - d;
      if (delta >= 0 && delta < PING_FADE) {
        const lit = 1 - delta / PING_FADE;
        if (lit > wall.lit) wall.lit = lit;
      }
    }
  }
}

function draw(): void {
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Exit pulse — always faintly visible so player has a directional anchor.
  const exitCx = (COLS - 0.5) * CELL;
  const exitCy = (ROWS - 0.5) * CELL;
  const t = performance.now() / 700;
  const pulse = 0.55 + 0.45 * Math.sin(t);
  const exitGrad = ctx.createRadialGradient(exitCx, exitCy, 0, exitCx, exitCy, CELL * 0.55);
  exitGrad.addColorStop(0, `rgba(52, 211, 153, ${0.55 * pulse})`);
  exitGrad.addColorStop(1, 'rgba(52, 211, 153, 0)');
  ctx.fillStyle = exitGrad;
  ctx.beginPath();
  ctx.arc(exitCx, exitCy, CELL * 0.55, 0, Math.PI * 2);
  ctx.fill();

  // Sonar wave rings.
  const maxR = Math.hypot(COLS * CELL, ROWS * CELL);
  for (const ping of pings) {
    const fade = Math.max(0, 1 - ping.radius / maxR);
    ctx.strokeStyle = `rgba(125, 211, 252, ${0.22 * fade})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ping.x, ping.y, ping.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Walls — only drawn where sonar has lit them.
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.5;
  for (const wall of walls) {
    if (wall.lit < 0.02) continue;
    const a = wall.lit;
    ctx.strokeStyle = `rgba(125, 211, 252, ${a})`;
    ctx.shadowColor = `rgba(56, 189, 248, ${a * 0.7})`;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(wall.x1, wall.y1);
    ctx.lineTo(wall.x2, wall.y2);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Player — always visible so navigation is anchored.
  const px = (playerCol + 0.5) * CELL;
  const py = (playerRow + 0.5) * CELL;
  const playerGrad = ctx.createRadialGradient(px, py, 0, px, py, 12);
  playerGrad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  playerGrad.addColorStop(0.4, 'rgba(255, 255, 255, 0.35)');
  playerGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = playerGrad;
  ctx.beginPath();
  ctx.arc(px, py, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(px, py, 2.6, 0, Math.PI * 2);
  ctx.fill();
}

function frame(now: number): void {
  if (myGen !== gen.current()) return;
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  update(dt);
  draw();
  rafHandle = requestAnimationFrame(frame);
}

function tryMove(dc: number, dr: number): void {
  if (state === 'won') return;
  const now = performance.now();
  if (now - lastMoveTime < MOVE_COOLDOWN_MS) return;

  const cell = cells[playerRow]?.[playerCol];
  if (!cell) return;

  if (dr === -1 && cell.n) return;
  if (dr === 1 && cell.s) return;
  if (dc === -1 && cell.w) return;
  if (dc === 1 && cell.e) return;

  playerCol += dc;
  playerRow += dr;
  lastMoveTime = now;

  if (state === 'ready') {
    state = 'playing';
    hideOverlayEl(overlay);
  }

  if (playerCol === COLS - 1 && playerRow === ROWS - 1) {
    winGame();
  }
}

function sendPing(): void {
  if (state === 'won') return;
  if (state === 'ready') {
    state = 'playing';
    hideOverlayEl(overlay);
  }
  const px = (playerCol + 0.5) * CELL;
  const py = (playerRow + 0.5) * CELL;
  pings.push({ x: px, y: py, radius: 0 });
  if (pings.length > MAX_PINGS) pings.shift();
  pingCount++;
  scoreEl.textContent = String(pingCount);
}

function winGame(): void {
  state = 'won';
  if (best === 0 || pingCount < best) {
    best = pingCount;
    safeWrite(STORAGE_BEST, best);
    setBestDisplay();
  }
  overlayTitle.textContent = 'Çıkışa ulaştın!';
  const recordMsg = best === pingCount ? ' Yeni rekor!' : '';
  overlayMsg.textContent =
    `Darbe: ${pingCount} · Rekor: ${best}.${recordMsg} R veya Yeni labirent ile tekrar dene.`;
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  myGen = gen.current();
  pings = [];
  pingCount = 0;
  playerCol = 0;
  playerRow = 0;
  state = 'ready';
  lastMoveTime = 0;
  scoreEl.textContent = '0';
  generateMaze();
  overlayTitle.textContent = 'Sonar Labirent';
  overlayMsg.textContent =
    'Boşluk veya tıkla → sonar darbesi. Ok tuşları → hareket. Yeşil pulse → çıkış. Az darbeyle ulaş.';
  showOverlayEl(overlay);

  lastFrame = performance.now();
  if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  rafHandle = requestAnimationFrame(frame);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') {
    tryMove(0, -1);
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    tryMove(0, 1);
    e.preventDefault();
  } else if (k === 'arrowleft' || k === 'a') {
    tryMove(-1, 0);
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    tryMove(1, 0);
    e.preventDefault();
  } else if (k === ' ') {
    sendPing();
    e.preventDefault();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function onCanvasPointer(e: Event): void {
  e.preventDefault();
  sendPing();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  boardWrap = canvas.parentElement!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  const stored = safeRead<number>(STORAGE_BEST, 0);
  best = Number.isFinite(stored) && stored > 0 ? stored : 0;
  setBestDisplay();

  window.addEventListener('keydown', onKey);
  boardWrap.addEventListener('pointerdown', onCanvasPointer);
  restartBtn.addEventListener('click', reset);

  document
    .querySelectorAll<HTMLButtonElement>('.sn-touch__btn')
    .forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const act = btn.dataset.act;
        const dir = btn.dataset.dir as Dir | undefined;
        if (act === 'ping') sendPing();
        else if (dir === 'up') tryMove(0, -1);
        else if (dir === 'down') tryMove(0, 1);
        else if (dir === 'left') tryMove(-1, 0);
        else if (dir === 'right') tryMove(1, 0);
      });
    });

  reset();
}

export const game = defineGame({ init, reset });
