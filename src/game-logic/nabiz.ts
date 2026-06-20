import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: best via safeRead/safeWrite.
// - stale-async-callback: requestAnimationFrame loop + reveal setTimeout are
//   gated by a generation token; reset()/restart bumps it so pending callbacks
//   no-op on a fresh round.
// - overlay-input-leak: explicit State enum; key/click handlers guard up-front.
// - invisible-boot: reset() draws the ready frame and shows the start overlay
//   synchronously so the page has visible content within one frame of init().
// - module-level-dom-access: all DOM + storage access lives in init().
// - hud-counter-synced-only-at-lifecycle-edges: renderHud() is invoked at every
//   score / round / guess mutation (not only in start/end).

const STORAGE_BEST = 'nabiz.best';
const ROUNDS = 5;
const MAX_PTS = 100;
const PT_PER_OFF = 15;
const REVEAL_MS = 1900;
const VISIBLE_MS = 4500;

interface RoundDef {
  bpm: number;
  durationMs: number;
  jitter: number;
}

const ROUND_DEFS: RoundDef[] = [
  { bpm: 60, durationMs: 10_000, jitter: 0 },
  { bpm: 80, durationMs: 12_000, jitter: 0 },
  { bpm: 100, durationMs: 14_000, jitter: 0 },
  { bpm: 120, durationMs: 16_000, jitter: 0.12 },
  { bpm: 150, durationMs: 18_000, jitter: 0.3 },
];

type State = 'ready' | 'counting' | 'answering' | 'reveal' | 'gameover';

const gen = createGenToken();
let state: State = 'ready';
let roundIdx = 0;
let beatsThisRound: number[] = [];
let actualCount = 0;
let guess = 0;
let lastErr = 0;
let lastPts = 0;
let totalScore = 0;
let best = 0;
let startTime = 0;
let beatIdxToFire = 0;
let heartPhase = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let roundEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let guessValEl!: HTMLElement;
let guessDownBtn!: HTMLButtonElement;
let guessUpBtn!: HTMLButtonElement;
let submitBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let feedbackEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const cssCache = new Map<string, string>();
function css(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function currentRound(): RoundDef {
  const def = ROUND_DEFS[Math.min(roundIdx, ROUND_DEFS.length - 1)];
  // noUncheckedIndexedAccess is on; def can't be undefined because
  // ROUNDS === ROUND_DEFS.length, but assert to satisfy the type checker.
  return def!;
}

function planRoundBeats(def: RoundDef): number[] {
  const interval = 60_000 / def.bpm;
  const beats: number[] = [];
  // Offset start so the player doesn't always get "beat at t=0".
  let t = interval * (0.35 + Math.random() * 0.4);
  while (t < def.durationMs - 80) {
    beats.push(t);
    const j = (Math.random() - 0.5) * 2 * def.jitter;
    t += interval * (1 + j);
  }
  return beats;
}

function ecgSampleAt(t: number): number {
  let dy = 0;
  for (const beatT of beatsThisRound) {
    const dt = t - beatT;
    if (dt < -60 || dt > 260) continue;
    if (dt < 0) {
      // P wave (small bump before the spike)
      dy += -4 * Math.exp(-Math.pow(dt + 28, 2) / 120);
    } else if (dt < 40) {
      // QRS complex
      if (dt < 8) {
        dy += 6 * Math.exp(-Math.pow(dt - 4, 2) / 6); // Q dip
      } else if (dt < 26) {
        dy += -58 * Math.exp(-Math.pow(dt - 17, 2) / 10); // R spike up
      } else {
        dy += 10 * Math.exp(-Math.pow(dt - 32, 2) / 12); // S dip
      }
    } else {
      dy += -8 * Math.exp(-Math.pow(dt - 130, 2) / 900); // T wave
    }
  }
  // baseline wobble
  dy += Math.sin(t * 0.013) * 0.7;
  return dy;
}

function drawGrid(w: number, h: number): void {
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
}

function drawHeart(x: number, y: number, r: number): void {
  // Heart silhouette via two arcs + triangle tip. Composes at radius r.
  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.2);
  ctx.bezierCurveTo(x - r, y - r, x - r * 1.1, y + r * 0.2, x, y + r);
  ctx.bezierCurveTo(x + r * 1.1, y + r * 0.2, x + r, y - r, x, y - r * 0.2);
  ctx.closePath();
  ctx.fill();
}

function drawIdle(message: string): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = css('--surface') || '#13151a';
  ctx.fillRect(0, 0, w, h);
  drawGrid(w, h);

  // Flat baseline
  ctx.strokeStyle = '#34d399';
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.55);
  ctx.lineTo(w, h * 0.55);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.fillStyle = css('--text-dim') || '#8b8e98';
  ctx.font = '500 16px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, w / 2, h / 2 - 30);
}

function drawFrame(elapsed: number, def: RoundDef): void {
  const w = canvas.width;
  const h = canvas.height;
  const baseY = h * 0.55;

  ctx.fillStyle = css('--surface') || '#13151a';
  ctx.fillRect(0, 0, w, h);
  drawGrid(w, h);

  // ECG trace — data flows right-to-left. Newest sample at the right edge.
  ctx.strokeStyle = '#34d399';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  const step = 2;
  for (let px = 0; px <= w; px += step) {
    const tAtPx = elapsed - VISIBLE_MS + (px / w) * VISIBLE_MS;
    if (tAtPx < 0) continue;
    const y = baseY + ecgSampleAt(tAtPx);
    if (!started) {
      ctx.moveTo(px, y);
      started = true;
    } else {
      ctx.lineTo(px, y);
    }
  }
  ctx.stroke();

  // Pulsing heart icon (synced visual cue)
  const heartX = w - 46;
  const heartY = 46;
  const baseR = 14;
  const r = baseR + heartPhase * 10;
  ctx.save();
  ctx.fillStyle = '#ef4444';
  ctx.globalAlpha = 0.45 + heartPhase * 0.55;
  drawHeart(heartX, heartY, r);
  ctx.restore();

  // Time-remaining bar at the top
  const remaining = Math.max(0, def.durationMs - elapsed);
  const remW = (remaining / def.durationMs) * w;
  ctx.fillStyle = 'rgba(52, 211, 153, 0.18)';
  ctx.fillRect(0, 0, remW, 6);

  // BPM badge bottom-left, jitter badge if irregular
  ctx.fillStyle = css('--text-dim') || '#8b8e98';
  ctx.font = '600 12px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${def.bpm} BPM`, 14, h - 14);
  if (def.jitter > 0) {
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'right';
    ctx.fillText('aritmi', w - 14, h - 14);
  }
}

function drawRevealOverlay(): void {
  // Continue showing the last frame snapshot with a translucent label of
  // actual vs guess across the canvas.
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = 'rgba(10, 11, 14, 0.55)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = css('--text') || '#e5e7eb';
  ctx.font = '700 36px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${actualCount} darbe`, w / 2, h / 2 - 14);
  ctx.fillStyle = css('--text-dim') || '#8b8e98';
  ctx.font = '500 14px system-ui, -apple-system, sans-serif';
  ctx.fillText(
    `Senin: ${guess} · Sapma: ${lastErr} · +${lastPts}`,
    w / 2,
    h / 2 + 18,
  );
}

function loop(): void {
  if (state !== 'counting') return;
  const myGen = gen.current();
  const def = currentRound();
  const elapsed = performance.now() - startTime;

  // Fire visual heart pulse for each beat we crossed since last frame.
  while (
    beatIdxToFire < beatsThisRound.length &&
    beatsThisRound[beatIdxToFire]! <= elapsed
  ) {
    heartPhase = 1;
    beatIdxToFire++;
  }

  drawFrame(elapsed, def);
  heartPhase *= 0.86;

  if (elapsed >= def.durationMs) {
    finishCounting();
    return;
  }

  requestAnimationFrame(() => {
    if (gen.isCurrent(myGen)) loop();
  });
}

function startGame(): void {
  gen.bump();
  state = 'counting';
  roundIdx = 0;
  totalScore = 0;
  hideOverlay(overlay);
  startRound();
}

function startRound(): void {
  state = 'counting';
  const def = currentRound();
  beatsThisRound = planRoundBeats(def);
  actualCount = beatsThisRound.length;
  // Seed guess at 0 — exposing the BPM×s expected value would let players
  // skip counting and submit blind for a near-perfect score in regular rounds.
  guess = 0;
  beatIdxToFire = 0;
  heartPhase = 0;
  startTime = performance.now();
  renderHud();
  renderControlState();
  setFeedback(
    `Tur ${roundIdx + 1}/${ROUNDS} · pencere ${(def.durationMs / 1000).toFixed(0)} sn — gözle say.`,
  );
  loop();
}

function finishCounting(): void {
  state = 'answering';
  // Snapshot the final frame so the player can see the freeze.
  drawFrame(currentRound().durationMs, currentRound());
  renderControlState();
  setFeedback('Pencere kapandı — kaç darbe saydın? ↑/↓ ile ayarla, Enter onayla.');
}

function submit(): void {
  if (state !== 'answering') return;
  lastErr = Math.abs(actualCount - guess);
  lastPts = Math.max(0, MAX_PTS - PT_PER_OFF * lastErr);
  totalScore += lastPts;
  state = 'reveal';
  renderHud();
  renderControlState();
  drawRevealOverlay();
  setFeedback(`Gerçek: ${actualCount} · Sapma: ${lastErr} · Puan: +${lastPts}`);

  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    roundIdx++;
    if (roundIdx >= ROUNDS) {
      endGame();
    } else {
      startRound();
    }
  }, REVEAL_MS);
}

function endGame(): void {
  state = 'gameover';
  if (totalScore > best) {
    best = totalScore;
    safeWrite(STORAGE_BEST, best);
  }
  renderHud();
  renderControlState();
  drawIdle('Sıralama tamamlandı');
  setFeedback('');
  const max = ROUNDS * MAX_PTS;
  overlayTitle.textContent = 'Oyun bitti';
  overlayMsg.textContent = `Toplam: ${totalScore} / ${max}\nRekor: ${best} / ${max}`;
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlay(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  roundIdx = 0;
  totalScore = 0;
  guess = 0;
  actualCount = 0;
  lastErr = 0;
  lastPts = 0;
  beatsThisRound = [];
  beatIdxToFire = 0;
  heartPhase = 0;
  renderHud();
  renderControlState();
  drawIdle("Başla'ya bas");
  setFeedback('');
  overlayTitle.textContent = 'Nabız';
  overlayMsg.textContent =
    'Hastanın nabız penceresini izle. Pencere kapanınca kaç kez attığını gir. 5 tur, hızlanan tempo.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function renderHud(): void {
  roundEl.textContent = `${Math.min(roundIdx + 1, ROUNDS)}/${ROUNDS}`;
  scoreEl.textContent = String(totalScore);
  bestEl.textContent = String(best);
  guessValEl.textContent = String(guess);
}

function renderControlState(): void {
  const answering = state === 'answering';
  submitBtn.disabled = !answering;
  guessDownBtn.disabled = !answering;
  guessUpBtn.disabled = !answering;
}

function setFeedback(msg: string): void {
  feedbackEl.textContent = msg;
}

function nudgeGuess(delta: number): void {
  if (state !== 'answering') return;
  guess = Math.max(0, Math.min(400, guess + delta));
  guessValEl.textContent = String(guess);
}

function onKey(e: KeyboardEvent): void {
  if (e.key.toLowerCase() === 'r') {
    e.preventDefault();
    reset();
    return;
  }

  if (state === 'ready' || state === 'gameover') {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      startGame();
    }
    return;
  }

  if (state === 'counting' || state === 'reveal') return;

  // answering
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
    return;
  }
  const step = e.shiftKey ? 5 : 1;
  if (
    e.key === 'ArrowLeft' ||
    e.key === 'ArrowDown' ||
    e.key === '-' ||
    e.key.toLowerCase() === 'a' ||
    e.key.toLowerCase() === 's'
  ) {
    e.preventDefault();
    nudgeGuess(-step);
  } else if (
    e.key === 'ArrowRight' ||
    e.key === 'ArrowUp' ||
    e.key === '+' ||
    e.key === '=' ||
    e.key.toLowerCase() === 'd' ||
    e.key.toLowerCase() === 'w'
  ) {
    e.preventDefault();
    nudgeGuess(step);
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  guessValEl = document.querySelector<HTMLElement>('#guess-val')!;
  guessDownBtn = document.querySelector<HTMLButtonElement>('#guess-down')!;
  guessUpBtn = document.querySelector<HTMLButtonElement>('#guess-up')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#submit-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  feedbackEl = document.querySelector<HTMLElement>('#feedback')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  guessDownBtn.addEventListener('click', () => nudgeGuess(-1));
  guessUpBtn.addEventListener('click', () => nudgeGuess(1));
  submitBtn.addEventListener('click', submit);
  overlayBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
