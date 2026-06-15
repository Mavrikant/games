import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';
type Btn = 'h-' | 'h+' | 'm-' | 'm+' | 's-' | 's+';

const STORAGE_BEST = 'saatci.best';
const ROUND_MS = 60_000;
const W = 360;
const H = 360;
const CX = W / 2;
const CY = H / 2;
const R = 150;
const SOLVE_FLASH_MS = 520;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let targetEl!: HTMLElement;
let currentEl!: HTMLElement;
let movesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayStartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let movesThisLevel = 0;
let timeLeftMs = ROUND_MS;
let lastTick = 0;
let timerId: ReturnType<typeof setInterval> | null = null;
let solveFlashMs = 0;

let curH = 0;
let curM = 0;
let curS = 0;
let tgtH = 2;
let tgtM = 10;
let tgtS = 0;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached || fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v || fallback;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function format(h: number, m: number, s: number): string {
  const hh = h === 0 ? 12 : h;
  return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function setScore(v: number): void {
  score = v;
  scoreEl.textContent = String(score);
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setTime(ms: number): void {
  timeLeftMs = ms;
  const sec = Math.max(0, Math.ceil(ms / 1000));
  timeEl.textContent = String(sec);
}

function pickTarget(firstLevel: boolean): void {
  if (firstLevel) {
    // Tutorial-friendly opener: two +1H presses solve it (couples M to 10).
    tgtH = 2;
    tgtM = 10;
    tgtS = 0;
  } else {
    let attempts = 0;
    do {
      tgtH = Math.floor(Math.random() * 12);
      tgtM = Math.floor(Math.random() * 60);
      tgtS = Math.floor(Math.random() * 60);
      attempts++;
    } while (
      attempts < 8 &&
      tgtH === curH &&
      tgtM === curM &&
      tgtS === curS
    );
  }
  movesThisLevel = 0;
  syncDisplay();
}

function syncDisplay(): void {
  targetEl.textContent = format(tgtH, tgtM, tgtS);
  currentEl.textContent = format(curH, curM, curS);
  movesEl.textContent = String(movesThisLevel);
  draw();
}

function isSolved(): boolean {
  return curH === tgtH && curM === tgtM && curS === tgtS;
}

function press(b: Btn): void {
  if (state !== 'playing') return;
  movesThisLevel++;
  switch (b) {
    case 'h-':
      curH = mod(curH - 1, 12);
      break;
    case 'h+':
      curH = mod(curH + 1, 12);
      curM = mod(curM + 5, 60);
      break;
    case 'm-':
      curM = mod(curM - 1, 60);
      break;
    case 'm+':
      curM = mod(curM + 1, 60);
      curS = mod(curS + 12, 60);
      break;
    case 's-':
      curS = mod(curS - 1, 60);
      break;
    case 's+':
      curS = mod(curS + 1, 60);
      break;
  }
  syncDisplay();
  if (isSolved()) {
    setScore(score + 1);
    solveFlashMs = SOLVE_FLASH_MS;
    pickTarget(false);
  }
}

function drawHand(frac: number, len: number, width: number, color: string): void {
  const angle = frac * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(CX, CY);
  ctx.lineTo(CX + Math.cos(angle) * len, CY + Math.sin(angle) * len);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function draw(): void {
  const accent = getCss('--sa-accent', '#5eead4');
  const ghost = getCss('--sa-ghost', 'rgba(248,113,113,0.55)');
  const dim = 'rgba(148, 163, 184, 0.55)';

  ctx.fillStyle = getCss('--sa-face', '#0c1626');
  ctx.fillRect(0, 0, W, H);

  // outer disc
  const grad = ctx.createRadialGradient(CX, CY - 40, 20, CX, CY, R + 8);
  grad.addColorStop(0, '#15273b');
  grad.addColorStop(1, '#091221');
  ctx.beginPath();
  ctx.arc(CX, CY, R + 6, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // rim
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.strokeStyle = getCss('--border', '#1e293b');
  ctx.lineWidth = 3;
  ctx.stroke();

  // solve flash
  if (solveFlashMs > 0) {
    const a = solveFlashMs / SOLVE_FLASH_MS;
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(110, 231, 183, ${0.7 * a})`;
    ctx.lineWidth = 8;
    ctx.stroke();
  }

  // hour markers
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const major = i % 5 === 0;
    const inset = major ? 14 : 6;
    const x1 = CX + Math.cos(a) * (R - inset);
    const y1 = CY + Math.sin(a) * (R - inset);
    const x2 = CX + Math.cos(a) * (R - 3);
    const y2 = CY + Math.sin(a) * (R - 3);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = major ? dim : 'rgba(148,163,184,0.25)';
    ctx.lineWidth = major ? 2 : 1;
    ctx.stroke();
  }

  // hour numerals 12/3/6/9
  ctx.fillStyle = getCss('--text-dim', '#94a3b8');
  ctx.font = '600 15px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('12', CX, CY - R + 28);
  ctx.fillText('3', CX + R - 28, CY);
  ctx.fillText('6', CX, CY + R - 28);
  ctx.fillText('9', CX - R + 28, CY);

  // target ghost hands first (under current)
  drawHand((tgtH + tgtM / 60) / 12, R * 0.5, 8, 'rgba(248, 113, 113, 0.25)');
  drawHand((tgtM + tgtS / 60) / 60, R * 0.78, 5, 'rgba(248, 113, 113, 0.25)');
  drawHand(tgtS / 60, R * 0.88, 3, ghost);

  // current hands
  drawHand((curH + curM / 60) / 12, R * 0.5, 7, accent);
  drawHand((curM + curS / 60) / 60, R * 0.78, 4, accent);
  drawHand(curS / 60, R * 0.88, 2, '#f59e0b');

  // center cap
  ctx.beginPath();
  ctx.arc(CX, CY, 6, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.strokeStyle = '#08111e';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function showOverlay(title: string, msg: string, btnText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayStartBtn.textContent = btnText;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  state = 'ready';
  setScore(0);
  setTime(ROUND_MS);
  curH = 0;
  curM = 0;
  curS = 0;
  solveFlashMs = 0;
  pickTarget(true);
  showOverlay(
    'Saatçi',
    'Üç çark hedef saate kilitlenmeli. +1H aynı zamanda dakikayı 5 ilerletir, +1M ise saniyeyi 12 ilerletir. − çarkları temiz çalışır. 60 saniyede en çok kaç hedef kilitleyebilirsin?',
    'Başla',
  );
}

function startPlaying(): void {
  if (state === 'gameover') {
    reset();
  }
  state = 'playing';
  hideOverlay();
  lastTick = performance.now();
  if (timerId !== null) clearInterval(timerId);
  timerId = setInterval(tick, 100);
}

function tick(): void {
  if (state !== 'playing') return;
  const now = performance.now();
  const dt = now - lastTick;
  lastTick = now;
  setTime(timeLeftMs - dt);
  if (timeLeftMs <= 0) endRound();
}

function endRound(): void {
  state = 'gameover';
  setTime(0);
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  if (score > best) {
    setBest(score);
    safeWrite(STORAGE_BEST, score);
  }
  showOverlay(
    'Süre doldu',
    `${score} hedef kilitledin. Rekor: ${best}. Tekrar oynamak için Boşluk veya R.`,
    'Tekrar oyna',
  );
}

function loop(): void {
  if (solveFlashMs > 0) {
    solveFlashMs = Math.max(0, solveFlashMs - 32);
    draw();
  }
  requestAnimationFrame(loop);
}

function handleStartIntent(): void {
  if (state === 'ready') {
    startPlaying();
  } else if (state === 'gameover') {
    reset();
    startPlaying();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  currentEl = document.querySelector<HTMLElement>('#current')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayStartBtn = document.querySelector<HTMLButtonElement>('#overlay-start')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  setBest(best);

  const wire = (id: string, b: Btn): void => {
    document.querySelector<HTMLButtonElement>(id)!.addEventListener('click', (e) => {
      e.preventDefault();
      press(b);
    });
  };
  wire('#btn-h-minus', 'h-');
  wire('#btn-h-plus', 'h+');
  wire('#btn-m-minus', 'm-');
  wire('#btn-m-plus', 'm+');
  wire('#btn-s-minus', 's-');
  wire('#btn-s-plus', 's+');

  const keyMap: Record<string, Btn> = {
    q: 'h-',
    w: 'h+',
    a: 'm-',
    s: 'm+',
    z: 's-',
    x: 's+',
  };

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === ' ' || k === 'Enter') {
      if (state !== 'playing') {
        handleStartIntent();
        e.preventDefault();
      }
      return;
    }
    if (k === 'r' || k === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (state !== 'playing') return;
    const action = keyMap[k.toLowerCase()];
    if (action !== undefined) {
      press(action);
      e.preventDefault();
    }
  });

  overlayStartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleStartIntent();
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
