import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'boya-karistir.best';
const ROUND_MS = 60_000;

type ColorKey = 'r' | 'y' | 'b';
type State = 'ready' | 'playing' | 'gameover';

type RGB = readonly [number, number, number];

// Base paint colors. Tuned so the three primaries mix into roughly recognisable
// secondaries (R+Y → orange, R+B → purple, Y+B → green) and into a muddy grey
// when all three are blended in equal parts.
const BASE: Record<ColorKey, RGB> = {
  r: [222, 56, 52],
  y: [240, 208, 76],
  b: [60, 92, 196],
};

// Max distance in RGB space: sqrt(3 * 255^2) ≈ 441.673
const MAX_DIST = Math.sqrt(3 * 255 * 255);

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let round = 0;
let timeLeftMs = ROUND_MS;
let lastTs = 0;
let rafHandle = 0;

let target: RGB = [255, 255, 255];
let drops: Record<ColorKey, number> = { r: 0, y: 0, b: 0 };
let lastRoundScore = 0;
let showingFeedback = false;
let feedbackUntil = 0;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let targetCircle!: HTMLElement;
let mixCircle!: HTMLElement;
let mixEmpty!: HTMLElement;
let countR!: HTMLElement;
let countY!: HTMLElement;
let countB!: HTMLElement;
let clearBtn!: HTMLButtonElement;
let submitBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let potButtons!: NodeListOf<HTMLButtonElement>;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  showOverlayEl(overlayEl);
}
function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function rgbToCss(rgb: RGB): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function currentMix(): RGB {
  const total = drops.r + drops.y + drops.b;
  if (total === 0) return [255, 255, 255];
  const r = (drops.r * BASE.r[0] + drops.y * BASE.y[0] + drops.b * BASE.b[0]) / total;
  const g = (drops.r * BASE.r[1] + drops.y * BASE.y[1] + drops.b * BASE.b[1]) / total;
  const bl = (drops.r * BASE.r[2] + drops.y * BASE.y[2] + drops.b * BASE.b[2]) / total;
  return [Math.round(r), Math.round(g), Math.round(bl)];
}

function distance(a: RGB, b: RGB): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Generate a target by picking a random valid mix of base colors. This
// guarantees the target is reachable in principle — the player just has to
// find the right ratio. As `round` grows, totalDrops grows so the ratio
// becomes more granular (a 5-drop target distinguishes 2:3 from 3:2, etc.).
function generateTarget(): RGB {
  const totalDrops = Math.min(2 + Math.floor(round / 2), 6);
  // Always use at least 2 distinct primaries — single-pot targets are too
  // trivial. Pick a random non-zero distribution over r/y/b summing to total.
  let r = 0;
  let y = 0;
  let b = 0;
  while (r + y + b === 0 || (r === 0 && y === 0) || (r === 0 && b === 0) || (y === 0 && b === 0)) {
    r = Math.floor(Math.random() * (totalDrops + 1));
    y = Math.floor(Math.random() * (totalDrops + 1 - r));
    b = totalDrops - r - y;
  }
  const tr = (r * BASE.r[0] + y * BASE.y[0] + b * BASE.b[0]) / totalDrops;
  const tg = (r * BASE.r[1] + y * BASE.y[1] + b * BASE.b[1]) / totalDrops;
  const tb = (r * BASE.r[2] + y * BASE.y[2] + b * BASE.b[2]) / totalDrops;
  return [Math.round(tr), Math.round(tg), Math.round(tb)];
}

function renderCounts(): void {
  countR.textContent = String(drops.r);
  countY.textContent = String(drops.y);
  countB.textContent = String(drops.b);
}

function renderMix(): void {
  const total = drops.r + drops.y + drops.b;
  if (total === 0) {
    mixCircle.style.background = 'transparent';
    mixCircle.classList.add('swatch__circle--empty');
    mixEmpty.style.display = 'block';
  } else {
    mixCircle.style.background = rgbToCss(currentMix());
    mixCircle.classList.remove('swatch__circle--empty');
    mixEmpty.style.display = 'none';
  }
  renderCounts();
}

function renderTarget(): void {
  targetCircle.style.background = rgbToCss(target);
}

function renderHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeftMs / 1000)));
}

function startRound(): void {
  round += 1;
  target = generateTarget();
  drops = { r: 0, y: 0, b: 0 };
  renderTarget();
  renderMix();
}

function addDrop(color: ColorKey): void {
  if (state !== 'playing') return;
  // Cap drops at 12 per round to keep ratios meaningful and prevent UI bloat.
  if (drops.r + drops.y + drops.b >= 12) return;
  drops[color] += 1;
  renderMix();
  // Tiny pulse on the pot — feedback that the click registered.
  const btn = document.querySelector<HTMLElement>(`.pot--${color}`);
  if (btn) {
    btn.classList.remove('pot--pulse');
    // Force reflow so animation can restart.
    void btn.offsetWidth;
    btn.classList.add('pot--pulse');
  }
}

function clearMix(): void {
  if (state !== 'playing') return;
  drops = { r: 0, y: 0, b: 0 };
  renderMix();
}

function submitMix(): void {
  if (state !== 'playing') return;
  const total = drops.r + drops.y + drops.b;
  if (total === 0) return; // empty mix: ignore
  const mix = currentMix();
  const dist = distance(mix, target);
  const pct = Math.max(0, 1 - dist / MAX_DIST);
  // Sharpen scoring: pure-linear distance is too forgiving. Apply a power
  // curve so getting within ~30 of the target lands you in the 80s, and
  // getting it spot-on rewards 100. (Same shape as Nüans but slightly tuned.)
  const sharpened = Math.pow(pct, 2.2);
  const points = Math.round(sharpened * 100);
  score += points;
  lastRoundScore = points;
  renderHud();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    renderHud();
  }
  flashFeedback(points);
  startRound();
}

function flashFeedback(points: number): void {
  showingFeedback = true;
  feedbackUntil = performance.now() + 700;
  mixCircle.classList.add('swatch__circle--flash');
  // Color the ring by quality.
  mixCircle.style.boxShadow =
    points >= 85
      ? '0 0 0 4px #4ade80, 0 0 22px 4px rgba(74, 222, 128, 0.55)'
      : points >= 60
        ? '0 0 0 4px #facc15, 0 0 22px 4px rgba(250, 204, 21, 0.45)'
        : '0 0 0 4px #ef4444, 0 0 22px 4px rgba(239, 68, 68, 0.45)';
}

function tickFeedback(now: number): void {
  if (!showingFeedback) return;
  if (now >= feedbackUntil) {
    showingFeedback = false;
    mixCircle.classList.remove('swatch__circle--flash');
    mixCircle.style.boxShadow = '';
  }
}

function loop(ts: number): void {
  if (state !== 'playing') return;
  const dtRaw = ts - lastTs;
  lastTs = ts;
  // Cap dt: backgrounded tab shouldn't drain 5 seconds at once.
  const dt = Math.min(dtRaw, 100);

  timeLeftMs -= dt;
  tickFeedback(ts);

  if (timeLeftMs <= 0) {
    timeLeftMs = 0;
    renderHud();
    endRound();
    return;
  }
  renderHud();
  rafHandle = requestAnimationFrame(loop);
}

function endRound(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    renderHud();
  }
  showOverlay(
    'Süre doldu',
    `Toplam skor: ${score}<br/>Son tur: ${lastRoundScore}<br/>R veya tıklama ile yeniden başla.`,
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay();
  lastTs = performance.now();
  rafHandle = requestAnimationFrame(loop);
}

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafHandle);
  state = 'ready';
  score = 0;
  round = 0;
  lastRoundScore = 0;
  timeLeftMs = ROUND_MS;
  showingFeedback = false;
  mixCircle.classList.remove('swatch__circle--flash');
  mixCircle.style.boxShadow = '';
  startRound();
  renderHud();
  showOverlay(
    'Boya Karıştır',
    'Hedef renge ulaşmak için kırmızı, sarı ve mavi damlaları doğru oranda karıştır. Karışım hedefe ne kadar yakınsa tur puanı o kadar yüksek olur.<br/>Başlamak için tıkla veya Boşluk\'a bas.',
  );
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  targetCircle = document.querySelector<HTMLElement>('#target-circle')!;
  mixCircle = document.querySelector<HTMLElement>('#mix-circle')!;
  mixEmpty = document.querySelector<HTMLElement>('#mix-empty')!;
  countR = document.querySelector<HTMLElement>('#count-r')!;
  countY = document.querySelector<HTMLElement>('#count-y')!;
  countB = document.querySelector<HTMLElement>('#count-b')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear-btn')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#submit-btn')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  potButtons = document.querySelectorAll<HTMLButtonElement>('.pot');

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  clearBtn.addEventListener('click', () => {
    clearMix();
  });

  submitBtn.addEventListener('click', () => {
    if (state === 'ready') {
      startPlaying();
      return;
    }
    submitMix();
  });

  potButtons.forEach((btn) => {
    const color = btn.dataset.color as ColorKey | undefined;
    if (!color) return;
    btn.addEventListener('click', () => {
      if (state === 'ready') startPlaying();
      addDrop(color);
    });
  });

  overlayEl.addEventListener('click', () => {
    if (state === 'ready') startPlaying();
    else if (state === 'gameover') reset();
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === '1') {
      if (state === 'ready') startPlaying();
      addDrop('r');
      e.preventDefault();
    } else if (k === '2') {
      if (state === 'ready') startPlaying();
      addDrop('y');
      e.preventDefault();
    } else if (k === '3') {
      if (state === 'ready') startPlaying();
      addDrop('b');
      e.preventDefault();
    } else if (k === 'enter') {
      if (state === 'ready') startPlaying();
      else if (state === 'playing') submitMix();
      else if (state === 'gameover') reset();
      e.preventDefault();
    } else if (k === ' ' || k === 'spacebar') {
      if (state === 'ready') startPlaying();
      else if (state === 'gameover') reset();
      e.preventDefault();
    } else if (k === 'c') {
      if (state === 'playing') clearMix();
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
