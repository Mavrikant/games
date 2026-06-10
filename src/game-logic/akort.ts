import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_BEST = 'akort.best';

const STRING_COUNT = 6;
const STRING_NOTES = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] as const;
const TARGET_FREQS = [82, 110, 147, 196, 247, 330] as const;

const WINDOW_CENTS = 25;
const RANGE_CENTS = 200;
const HOLD_MS = 1000;
const HOLD_DECAY_MULT = 1.6;

const FINE_HZ = 0.4;
const COARSE_HZ = 1.6;

const VIBRATO_AMP_HZ = 0.35;
const VIBRATO_PERIOD_MS = 1300;

const gen = createGenToken();
let state: State = 'ready';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let progressEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let activeIndex = 0;
let tunedFlags: boolean[] = [];
let baseFreqs: number[] = [];
let currentFreq = 0;
let holdMs = 0;
let elapsed = 0;
let startTime = 0;
let best = 0;
let animHandle: number | null = null;
let lastFrame = 0;

function centsToHzOffset(cents: number, base: number): number {
  return base * (Math.pow(2, cents / 1200) - 1);
}

function freqToCents(actual: number, target: number): number {
  if (actual <= 0 || target <= 0) return 0;
  return 1200 * Math.log2(actual / target);
}

function clampToRange(freq: number, target: number): number {
  const minHz = target * Math.pow(2, -RANGE_CENTS / 1200);
  const maxHz = target * Math.pow(2, RANGE_CENTS / 1200);
  return Math.max(minHz, Math.min(maxHz, freq));
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function commitBest(): void {
  if (best === 0 || elapsed < best) {
    best = elapsed;
    safeWrite(STORAGE_BEST, best);
  }
}

function updateHUD(): void {
  timeEl.textContent = elapsed.toFixed(1) + 's';
  bestEl.textContent = best > 0 ? best.toFixed(1) + 's' : '—';
  const tunedCount = tunedFlags.filter(Boolean).length;
  progressEl.textContent = `${tunedCount} / ${STRING_COUNT}`;
}

function findNextUnTuned(from: number): number {
  for (let i = 1; i <= STRING_COUNT; i++) {
    const candidate = (from + i) % STRING_COUNT;
    if (!tunedFlags[candidate]) return candidate;
  }
  return -1;
}

function findFirstUnTuned(): number {
  for (let i = 0; i < STRING_COUNT; i++) {
    if (!tunedFlags[i]) return i;
  }
  return -1;
}

function reset(): void {
  gen.bump();
  state = 'ready';
  activeIndex = 0;
  tunedFlags = new Array(STRING_COUNT).fill(false);
  baseFreqs = TARGET_FREQS.map((t) => {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const offsetCents = sign * (90 + Math.random() * 60);
    return t * Math.pow(2, offsetCents / 1200);
  });
  currentFreq = baseFreqs[0]!;
  holdMs = 0;
  elapsed = 0;
  startTime = 0;
  stopLoop();
  updateHUD();
  draw();
  showOverlay(
    'Akort',
    'Sol/sağ ok ile vidayı çevir, telin frekansını yeşil hedef bölgesine getir. Başlamak için bir tuşa bas ya da bu yazıya tıkla.',
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  startTime = performance.now();
  elapsed = 0;
  hideOverlay();
  startLoop();
}

function startLoop(): void {
  if (animHandle !== null) return;
  lastFrame = performance.now();
  const myGen = gen.current();
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) {
      animHandle = null;
      return;
    }
    const dt = Math.min(50, now - lastFrame);
    lastFrame = now;
    tick(dt);
    animHandle = requestAnimationFrame(loop);
  };
  animHandle = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (animHandle !== null) {
    cancelAnimationFrame(animHandle);
    animHandle = null;
  }
}

function tick(dt: number): void {
  if (state !== 'playing') return;
  const target = TARGET_FREQS[activeIndex]!;
  const base = baseFreqs[activeIndex]!;
  const vibrato = VIBRATO_AMP_HZ * Math.sin((2 * Math.PI * performance.now()) / VIBRATO_PERIOD_MS);
  currentFreq = base + vibrato;
  elapsed = (performance.now() - startTime) / 1000;

  const centsOff = Math.abs(freqToCents(currentFreq, target));
  if (centsOff < WINDOW_CENTS) {
    holdMs += dt;
    if (holdMs >= HOLD_MS) {
      tunedFlags[activeIndex] = true;
      holdMs = 0;
      const next = findFirstUnTuned();
      if (next === -1) {
        winGame();
        return;
      }
      activeIndex = next;
    }
  } else {
    holdMs = Math.max(0, holdMs - dt * HOLD_DECAY_MULT);
  }

  updateHUD();
  draw();
}

function winGame(): void {
  state = 'gameover';
  stopLoop();
  commitBest();
  updateHUD();
  draw();
  showOverlay('Akortlandı', `Süre: ${elapsed.toFixed(1)}s · R ile tekrar`);
}

function adjustFreq(deltaHz: number): void {
  if (state === 'gameover') return;
  if (state === 'ready') startPlaying();
  if (state !== 'playing') return;
  const t = TARGET_FREQS[activeIndex]!;
  const cur = baseFreqs[activeIndex]!;
  baseFreqs[activeIndex] = clampToRange(cur + deltaHz, t);
}

function skipString(): void {
  if (state === 'ready') {
    startPlaying();
    return;
  }
  if (state !== 'playing') return;
  if (findFirstUnTuned() === -1) return;
  const next = findNextUnTuned(activeIndex);
  if (next === -1) return;
  activeIndex = next;
  holdMs = 0;
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined && cached !== '') return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const out = val || fallback;
  cssCache.set(varName, out);
  return out;
}

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;

  ctx.fillStyle = getCss('--surface', '#11151c');
  ctx.fillRect(0, 0, W, H);

  drawStrings(20, 20, W - 40, 60);

  const target = TARGET_FREQS[activeIndex]!;
  const noteName = STRING_NOTES[activeIndex]!;

  ctx.textAlign = 'center';
  ctx.fillStyle = getCss('--text', '#e8ecf3');
  ctx.font = '700 56px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(noteName, W / 2, 158);

  ctx.font = '500 13px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = getCss('--text-dim', '#9aa0aa');
  ctx.fillText(`Hedef: ${target} Hz · Şu an: ${currentFreq.toFixed(1)} Hz`, W / 2, 184);

  drawDial(40, 210, W - 80, 80);

  const cents = freqToCents(currentFreq, target);
  const inWindow = Math.abs(cents) < WINDOW_CENTS;

  ctx.textAlign = 'center';
  ctx.font = '700 32px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = inWindow ? '#34d399' : '#fb7185';
  const sign = cents >= 0 ? '+' : '';
  const display = Math.abs(cents) > 199 ? (cents > 0 ? '+200+' : '-200+') : `${sign}${cents.toFixed(0)} ¢`;
  ctx.fillText(display, W / 2, 340);

  const barX = 40;
  const barY = 380;
  const barW = W - 80;
  const barH = 14;
  ctx.fillStyle = '#0d1218';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.strokeStyle = '#2a313d';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barW, barH);

  if (state === 'playing' && holdMs > 0) {
    const holdFrac = Math.min(1, holdMs / HOLD_MS);
    ctx.fillStyle = '#34d399';
    ctx.fillRect(barX + 1, barY + 1, (barW - 2) * holdFrac, barH - 2);
  }

  ctx.fillStyle = getCss('--text-dim', '#9aa0aa');
  ctx.font = '500 12px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  let hint = 'Sol/Sağ: ince · A/D: kaba · Space: pas';
  if (state === 'playing' && holdMs > 0) {
    hint = `Sabit kal — ${((HOLD_MS - holdMs) / 1000).toFixed(1)}s`;
  } else if (state === 'gameover') {
    hint = 'R ile yeniden başla';
  }
  ctx.fillText(hint, W / 2, barY + 36);
}

function drawStrings(x: number, y: number, w: number, h: number): void {
  const gap = 6;
  const cellW = (w - gap * (STRING_COUNT - 1)) / STRING_COUNT;

  for (let i = 0; i < STRING_COUNT; i++) {
    const cx = x + i * (cellW + gap);
    const tuned = tunedFlags[i]!;
    const active = i === activeIndex && state !== 'gameover';

    ctx.fillStyle = tuned ? '#0f3a22' : active ? '#1a2230' : '#10141c';
    ctx.fillRect(cx, y, cellW, h);

    ctx.strokeStyle = tuned ? '#34d399' : active ? '#6ee7b7' : '#2a313d';
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(cx + 0.5, y + 0.5, cellW - 1, h - 1);

    ctx.fillStyle = tuned ? '#34d399' : active ? '#e8ecf3' : '#9aa0aa';
    ctx.font = '700 18px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(STRING_NOTES[i]!, cx + cellW / 2, y + 26);

    ctx.font = '500 11px system-ui, -apple-system, sans-serif';
    if (tuned) {
      ctx.fillStyle = '#34d399';
      ctx.fillText('✓ akortlu', cx + cellW / 2, y + 46);
    } else if (active) {
      ctx.fillStyle = '#6ee7b7';
      ctx.fillText('aktif', cx + cellW / 2, y + 46);
    } else {
      ctx.fillStyle = '#9aa0aa';
      ctx.fillText('bekliyor', cx + cellW / 2, y + 46);
    }
  }
}

function drawDial(x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = '#0d1218';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#2a313d';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const target = TARGET_FREQS[activeIndex]!;
  const winLeftFrac = (RANGE_CENTS - WINDOW_CENTS) / (2 * RANGE_CENTS);
  const winRightFrac = (RANGE_CENTS + WINDOW_CENTS) / (2 * RANGE_CENTS);
  const winLeftX = x + w * winLeftFrac;
  const winRightX = x + w * winRightFrac;

  ctx.fillStyle = 'rgba(52, 211, 153, 0.22)';
  ctx.fillRect(winLeftX, y, winRightX - winLeftX, h);
  ctx.strokeStyle = '#34d399';
  ctx.lineWidth = 2;
  ctx.strokeRect(winLeftX, y, winRightX - winLeftX, h);

  ctx.strokeStyle = '#2a313d';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const tx = x + (i / 10) * w;
    const tickH = i === 5 ? 14 : 8;
    ctx.beginPath();
    ctx.moveTo(tx, y);
    ctx.lineTo(tx, y + tickH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx, y + h - tickH);
    ctx.lineTo(tx, y + h);
    ctx.stroke();
  }

  const cents = freqToCents(currentFreq, target);
  const clamped = Math.max(-RANGE_CENTS, Math.min(RANGE_CENTS, cents));
  const ibreFrac = (clamped + RANGE_CENTS) / (2 * RANGE_CENTS);
  const ibreX = x + w * ibreFrac;

  const inWindow = Math.abs(cents) < WINDOW_CENTS;
  const ibreColor = inWindow ? '#34d399' : Math.abs(cents) > 200 ? '#fb7185' : '#6ee7b7';

  ctx.strokeStyle = ibreColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ibreX, y);
  ctx.lineTo(ibreX, y + h);
  ctx.stroke();

  ctx.fillStyle = ibreColor;
  ctx.beginPath();
  ctx.moveTo(ibreX - 8, y - 4);
  ctx.lineTo(ibreX + 8, y - 4);
  ctx.lineTo(ibreX, y + 6);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(ibreX - 8, y + h + 4);
  ctx.lineTo(ibreX + 8, y + h + 4);
  ctx.lineTo(ibreX, y + h - 6);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#9aa0aa';
  ctx.font = '500 11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('düşük', x + 4, y + h + 22);
  ctx.textAlign = 'right';
  ctx.fillText('yüksek', x + w - 4, y + h + 22);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#34d399';
  ctx.fillText('hedef', x + w / 2, y + h + 22);
}

function handleKeydown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'gameover') return;
  if (k === 'arrowleft') {
    adjustFreq(-FINE_HZ);
    e.preventDefault();
  } else if (k === 'arrowright') {
    adjustFreq(FINE_HZ);
    e.preventDefault();
  } else if (k === 'a') {
    adjustFreq(-COARSE_HZ);
    e.preventDefault();
  } else if (k === 'd') {
    adjustFreq(COARSE_HZ);
    e.preventDefault();
  } else if (k === ' ' || k === 'enter') {
    skipString();
    e.preventDefault();
  }
}

function handleTouchButton(act: string): void {
  if (state === 'ready') {
    startPlaying();
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state !== 'playing') return;
  if (act === 'fine-down') adjustFreq(-FINE_HZ);
  else if (act === 'fine-up') adjustFreq(FINE_HZ);
  else if (act === 'coarse-down') adjustFreq(-COARSE_HZ);
  else if (act === 'coarse-up') adjustFreq(COARSE_HZ);
  else if (act === 'skip') skipString();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  progressEl = document.querySelector<HTMLElement>('#progress')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', handleKeydown);

  restartBtn.addEventListener('click', reset);

  overlay.addEventListener('click', () => {
    if (state === 'ready') startPlaying();
    else if (state === 'gameover') reset();
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act) handleTouchButton(act);
    });
  });

  reset();
}

export const game = defineGame({ init, reset });
