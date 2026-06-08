import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// Kum Saati — clockless time estimation.
//
// Flow per round:
//   showing-target → ready → timing → result → (next round)
//
// PITFALLS#stale-async-callback: every setTimeout is gen-token guarded so
// a mid-round restart cannot inject phantom transitions into the next round.
// PITFALLS#overlay-input-leak: explicit `state` enum; handlers early-return
// when state doesn't allow input.
// PITFALLS#invisible-boot: reset() goes straight to round 1's "showing-target"
// phase so the first visible frame already shows a target.

const STORAGE_BEST = 'kum-saati.best';

type Phase = 'idle' | 'showing-target' | 'ready' | 'timing' | 'result';

interface Round {
  targetMs: number;
  showFakes: boolean;
}

const SHOW_TARGET_MS = 2000;
const RESULT_PAUSE_MS = 1500;

const SCORE_PERFECT = 300;
const SCORE_GREAT = 180;
const SCORE_GOOD = 90;
const SCORE_CONSOLATION = 30;

const TOL_PERFECT_MS = 100;
const TOL_GREAT_MS = 300;
const TOL_GOOD_MS = 700;

const gen = createGenToken();
let phase: Phase = 'idle';
let score = 0;
let best = 0;
let roundNum = 0;
let currentRound: Round | null = null;
let comboPerfect = 0;
let timingStart = 0;
let fakeRaf = 0;
let fakeFrozen = false;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let phaseEl!: HTMLElement;
let targetEl!: HTMLElement;
let bigBtn!: HTMLButtonElement;
let hintEl!: HTMLElement;
let comboEl!: HTMLElement;
let fakesEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let boardEl!: HTMLElement;

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return `${s.toFixed(1)} sn`;
}

function formatError(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} sn`;
}

function pickTarget(round: number): Round {
  // Round 1-3: gentle medium durations (3-6s)
  // Round 4-5: stretched range (2-9s)
  // Round 6+: wider range (1-13s) + fake counters
  let minMs: number;
  let maxMs: number;
  if (round <= 3) {
    minMs = 3000;
    maxMs = 6000;
  } else if (round <= 5) {
    minMs = 2000;
    maxMs = 9000;
  } else {
    minMs = 1000;
    maxMs = 13000;
  }
  // Quantize to 100ms steps so targets read cleanly.
  const span = maxMs - minMs;
  const steps = Math.floor(span / 100);
  const targetMs = minMs + Math.floor(Math.random() * (steps + 1)) * 100;
  return {
    targetMs,
    showFakes: round >= 6,
  };
}

function setBigBtn(text: string, color: 'primary' | 'go' | 'stop' | 'idle'): void {
  bigBtn.textContent = text;
  bigBtn.dataset.style = color;
}

function setPhase(label: string): void {
  phaseEl.textContent = label;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  bestEl.textContent = String(best);
}

function awardScore(errorMs: number): number {
  let base: number;
  if (errorMs <= TOL_PERFECT_MS) base = SCORE_PERFECT;
  else if (errorMs <= TOL_GREAT_MS) base = SCORE_GREAT;
  else if (errorMs <= TOL_GOOD_MS) base = SCORE_GOOD;
  else base = SCORE_CONSOLATION;

  if (errorMs <= TOL_PERFECT_MS) {
    comboPerfect = Math.min(comboPerfect + 1, 5);
  } else {
    comboPerfect = 0;
  }
  // Combo multiplier: 1.0, 1.2, 1.4, 1.6, 1.8, 2.0
  const multiplier = 1 + comboPerfect * 0.2;
  return Math.round(base * multiplier);
}

function rateLabel(errorMs: number): { title: string; tone: 'perfect' | 'great' | 'good' | 'meh' } {
  if (errorMs <= TOL_PERFECT_MS) return { title: 'TAM ON İKİDEN!', tone: 'perfect' };
  if (errorMs <= TOL_GREAT_MS) return { title: 'Çok iyi', tone: 'great' };
  if (errorMs <= TOL_GOOD_MS) return { title: 'Yaklaştın', tone: 'good' };
  return { title: 'Uzak', tone: 'meh' };
}

function clearFakes(): void {
  if (fakeRaf !== 0) {
    cancelAnimationFrame(fakeRaf);
    fakeRaf = 0;
  }
  fakesEl.innerHTML = '';
  fakeFrozen = false;
}

function startFakeCounters(round: Round): void {
  clearFakes();
  if (!round.showFakes) return;

  // Two fake counters with mismatched rates / start values.
  // Their job is to *lie*: one runs ~1.7x speed, the other ~0.6x speed,
  // both showing a number labeled "Süre" (Time) to mislead the player.
  const a = document.createElement('div');
  a.className = 'fake fake--a';
  a.textContent = '0.0 sn';
  const b = document.createElement('div');
  b.className = 'fake fake--b';
  b.textContent = '0.0 sn';
  fakesEl.appendChild(a);
  fakesEl.appendChild(b);

  const startedAt = performance.now();
  const myGen = gen.current();
  const rateA = 1.7;
  const rateB = 0.6;
  // Freeze the displayed value at the moment the user "stops" so the
  // result screen doesn't show lies still scrolling.
  const tick = () => {
    if (!gen.isCurrent(myGen)) return;
    if (fakeFrozen) return;
    const elapsed = performance.now() - startedAt;
    a.textContent = `${((elapsed * rateA) / 1000).toFixed(1)} sn`;
    b.textContent = `${((elapsed * rateB) / 1000).toFixed(1)} sn`;
    fakeRaf = requestAnimationFrame(tick);
  };
  fakeRaf = requestAnimationFrame(tick);
}

function showOverlayMsg(title: string, msg: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnLabel;
  showOverlay(overlay);
}

function renderCombo(): void {
  if (comboPerfect >= 1) {
    const mult = 1 + comboPerfect * 0.2;
    comboEl.textContent = `Kombo ×${mult.toFixed(1)}`;
    comboEl.classList.add('combo--on');
  } else {
    comboEl.textContent = '';
    comboEl.classList.remove('combo--on');
  }
}

function startRound(): void {
  roundNum += 1;
  currentRound = pickTarget(roundNum);
  roundEl.textContent = String(roundNum);
  phase = 'showing-target';

  setPhase(`Tur ${roundNum} · Hedef`);
  targetEl.textContent = formatSeconds(currentRound.targetMs);
  targetEl.classList.remove('target--hidden');
  setBigBtn('Hazırlan…', 'idle');
  bigBtn.disabled = true;
  hintEl.textContent = currentRound.showFakes
    ? 'Dikkat: sahte sayaçlar yalan söyleyecek. Sezgine güven.'
    : 'Süreyi aklında tut. Hazır olduğunda başlat.';
  renderCombo();
  clearFakes();
  boardEl.dataset.tone = 'neutral';

  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (phase !== 'showing-target') return;
    enterReady();
  }, SHOW_TARGET_MS);
}

function enterReady(): void {
  phase = 'ready';
  targetEl.classList.add('target--hidden');
  targetEl.textContent = '? sn';
  setPhase('Hazır');
  setBigBtn('BAŞLAT', 'go');
  bigBtn.disabled = false;
  hintEl.textContent = 'Boşluk veya butona bas → süre başlasın.';
}

function startTiming(): void {
  if (phase !== 'ready' || !currentRound) return;
  phase = 'timing';
  timingStart = performance.now();
  setPhase('Say…');
  setBigBtn('DURDUR', 'stop');
  hintEl.textContent = 'Hedef süreye ulaştığını düşündüğünde dur.';
  startFakeCounters(currentRound);
}

function stopTiming(): void {
  if (phase !== 'timing' || !currentRound) return;
  const elapsed = performance.now() - timingStart;
  fakeFrozen = true;
  if (fakeRaf !== 0) {
    cancelAnimationFrame(fakeRaf);
    fakeRaf = 0;
  }
  const errorMs = Math.abs(elapsed - currentRound.targetMs);
  const gained = awardScore(errorMs);
  score += gained;
  scoreEl.textContent = String(score);
  commitBest();

  const rated = rateLabel(errorMs);
  phase = 'result';
  setPhase('Sonuç');
  targetEl.classList.remove('target--hidden');
  targetEl.textContent = `${formatSeconds(elapsed)} / hedef ${formatSeconds(currentRound.targetMs)}`;
  setBigBtn(`+${gained}`, rated.tone === 'perfect' ? 'go' : 'idle');
  bigBtn.disabled = true;
  hintEl.textContent = `${rated.title} — ${errorMs <= TOL_GOOD_MS ? '' : '~'}${formatError(errorMs)} ${elapsed > currentRound.targetMs ? 'geç' : 'erken'}`;
  boardEl.dataset.tone = rated.tone;
  renderCombo();

  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (phase !== 'result') return;
    startRound();
  }, RESULT_PAUSE_MS);
}

function bigBtnPressed(): void {
  if (phase === 'ready') {
    startTiming();
  } else if (phase === 'timing') {
    stopTiming();
  }
}

function reset(): void {
  gen.bump();
  clearFakes();
  hideOverlay(overlay);
  score = 0;
  roundNum = 0;
  comboPerfect = 0;
  currentRound = null;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  renderCombo();
  startRound();
}

function onKey(e: KeyboardEvent): void {
  if (e.repeat) return;
  if (e.key === ' ' || e.code === 'Space') {
    // Only act when an action makes sense; never let stray Space submit a
    // round during the "showing-target" or "result" pauses.
    if (phase === 'ready' || phase === 'timing') {
      e.preventDefault();
      bigBtnPressed();
    }
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
  }
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  phaseEl = document.querySelector<HTMLElement>('#phase')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  bigBtn = document.querySelector<HTMLButtonElement>('#bigbtn')!;
  hintEl = document.querySelector<HTMLElement>('#hint')!;
  comboEl = document.querySelector<HTMLElement>('#combo')!;
  fakesEl = document.querySelector<HTMLElement>('#fakes')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  boardEl = document.querySelector<HTMLElement>('#board')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', reset);
  bigBtn.addEventListener('click', bigBtnPressed);
  overlayBtn.addEventListener('click', () => {
    hideOverlay(overlay);
    reset();
  });
  window.addEventListener('keydown', onKey);

  // Show a brief title overlay; first round starts after the player confirms.
  showOverlayMsg(
    'Kum Saati',
    'Süre 2 saniye gösterilir, sonra kaybolur.\nSezginle aynı süreyi ölç.',
    'Başla',
  );
}

export const game = defineGame({ init, reset });
