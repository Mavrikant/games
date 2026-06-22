import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Pitfalls guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() invalidates the active RAF
//   loop and any pending heckler timers (they read gen.isCurrent before
//   touching state).
// - overlay-input-leak: every input handler short-circuits unless
//   state === 'playing'.
// - hud-counter-synced-only-at-lifecycle-edges: meters & time are written
//   into the DOM inside the per-frame loop, not only on lifecycle edges.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual rules.
// - unreachable-start-state: overlay button + Enter/Space + click anywhere
//   on overlay all transition ready → playing.

const STORAGE_BEST = 'hatip.best';
const SPEECH_SECONDS = 90;
const COOLDOWN_MS = 1200;
const HECKLER_MIN_MS = 11000;
const HECKLER_MAX_MS = 17000;
const HECKLER_WINDOW_MS = 2800;
const HECKLER_MISS_PENALTY = 30;
const HECKLER_REWARD = 22;

type MeterKey = 'mantik' | 'duygu' | 'otorite' | 'mizah';
type ActionKey = 'veri' | 'hikaye' | 'ilke' | 'espri';
type GameState = 'ready' | 'playing' | 'gameover';

interface Action {
  boost: MeterKey;
  cost: MeterKey;
  boostAmount: number;
  costAmount: number;
}

const METERS: MeterKey[] = ['mantik', 'duygu', 'otorite', 'mizah'];

// Per-second decay rates. Tuned so the speech is doable with rotation but
// punishing if the speaker spams one tool.
const DECAY: Record<MeterKey, number> = {
  mantik: 2.6,
  duygu: 3.4,
  otorite: 2.0,
  mizah: 4.2,
};

const ACTIONS: Record<ActionKey, Action> = {
  veri:    { boost: 'mantik',  cost: 'mizah',   boostAmount: 28, costAmount: 9 },
  hikaye:  { boost: 'duygu',   cost: 'mantik',  boostAmount: 28, costAmount: 9 },
  ilke:    { boost: 'otorite', cost: 'duygu',   boostAmount: 28, costAmount: 9 },
  espri:   { boost: 'mizah',   cost: 'otorite', boostAmount: 28, costAmount: 9 },
};

const KEY_TO_ACTION: Record<string, ActionKey> = {
  '1': 'veri',
  '2': 'hikaye',
  '3': 'ilke',
  '4': 'espri',
};

const gen = createGenToken();

let state: GameState = 'ready';
let meters: Record<MeterKey, number> = { mantik: 60, duygu: 60, otorite: 60, mizah: 60 };
let cooldownUntil: Record<ActionKey, number> = { veri: 0, hikaye: 0, ilke: 0, espri: 0 };
let endsAt = 0;
let lastFrame = 0;
let score = 0;
let best = 0;
let hecklerActiveUntil = 0;
let nextHecklerAt = 0;
let hecklerAnswered = 0;
let rafId = 0;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayStartBtn!: HTMLButtonElement;
let hecklerEl!: HTMLElement;
let hecklerBtn!: HTMLButtonElement;

const meterFills: Record<MeterKey, HTMLElement> = {} as Record<MeterKey, HTMLElement>;
const meterVals: Record<MeterKey, HTMLElement> = {} as Record<MeterKey, HTMLElement>;
const actionEls: Record<ActionKey, HTMLButtonElement> = {} as Record<ActionKey, HTMLButtonElement>;

function clampMeter(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function fmtTime(sec: number): string {
  if (sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function paintMeters(): void {
  for (const k of METERS) {
    const v = meters[k];
    meterFills[k].style.width = `${v}%`;
    meterVals[k].textContent = String(Math.round(v));
    meterFills[k].classList.toggle('meter__fill--danger', v < 25);
  }
}

function paintCooldowns(now: number): void {
  for (const k of Object.keys(ACTIONS) as ActionKey[]) {
    const left = cooldownUntil[k] - now;
    const btn = actionEls[k];
    const cdEl = btn.querySelector<HTMLElement>('.action__cd');
    if (left > 0) {
      btn.classList.add('action--cooling');
      const ratio = Math.max(0, left / COOLDOWN_MS);
      if (cdEl) cdEl.style.transform = `scaleX(${ratio})`;
    } else {
      btn.classList.remove('action--cooling');
      if (cdEl) cdEl.style.transform = 'scaleX(0)';
    }
  }
}

function paintTime(now: number): void {
  const secLeft = (endsAt - now) / 1000;
  timeEl.textContent = fmtTime(secLeft);
}

function setScore(n: number): void {
  score = n;
  scoreEl.textContent = String(score);
}

function showHeckler(now: number): void {
  hecklerActiveUntil = now + HECKLER_WINDOW_MS;
  hecklerEl.classList.remove('heckler--hidden');
  hecklerEl.setAttribute('aria-hidden', 'false');
}

function hideHeckler(): void {
  hecklerActiveUntil = 0;
  hecklerEl.classList.add('heckler--hidden');
  hecklerEl.setAttribute('aria-hidden', 'true');
}

function scheduleNextHeckler(now: number): void {
  const span = HECKLER_MAX_MS - HECKLER_MIN_MS;
  nextHecklerAt = now + HECKLER_MIN_MS + Math.random() * span;
}

function answerHeckler(now: number): void {
  if (hecklerActiveUntil <= now) return;
  meters.otorite = clampMeter(meters.otorite + HECKLER_REWARD);
  hecklerAnswered++;
  setScore(score + 30);
  hideHeckler();
  scheduleNextHeckler(now);
}

function doAction(action: ActionKey, now: number): void {
  if (state !== 'playing') return;
  if (cooldownUntil[action] > now) return;
  const a = ACTIONS[action];
  meters[a.boost] = clampMeter(meters[a.boost] + a.boostAmount);
  meters[a.cost] = clampMeter(meters[a.cost] - a.costAmount);
  cooldownUntil[action] = now + COOLDOWN_MS;
  setScore(score + 5);
  actionEls[action].classList.remove('action--pulse');
  void actionEls[action].offsetWidth;
  actionEls[action].classList.add('action--pulse');
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function endGame(victorious: boolean): void {
  state = 'gameover';
  gen.bump();
  hideHeckler();
  const total = Math.round(meters.mantik + meters.duygu + meters.otorite + meters.mizah);
  if (victorious) setScore(score + 200 + total);
  commitBest();
  if (victorious) {
    overlayTitle.textContent = 'Salyangoz alkışı';
    overlayMsg.textContent = `Konuşmayı tamamladın. Bitiş ölçer toplamı: ${total} · Lafa karışan sayısı yanıtlanan: ${hecklerAnswered}. Skor: ${score}.`;
    overlayStartBtn.textContent = 'Tekrar kürsüye çık';
  } else {
    const fallen = METERS.find((k) => meters[k] <= 0);
    const fallenLabel = fallen ? labelOf(fallen) : 'Dinleyici';
    overlayTitle.textContent = `${fallenLabel} kaçtı`;
    overlayMsg.textContent = `Konuşma yarıda kaldı. Skor: ${score}. Boşluk veya butonla tekrar dene.`;
    overlayStartBtn.textContent = 'Yeniden dene';
  }
  showOverlay(overlayEl);
}

function labelOf(k: MeterKey): string {
  switch (k) {
    case 'mantik': return 'Mantık';
    case 'duygu': return 'Duygu';
    case 'otorite': return 'Otorite';
    case 'mizah': return 'Mizah';
  }
}

function loop(now: number, token: number): void {
  if (state !== 'playing') return;
  if (!gen.isCurrent(token)) return;

  const dt = Math.min(100, now - lastFrame) / 1000;
  lastFrame = now;

  for (const k of METERS) {
    meters[k] = clampMeter(meters[k] - DECAY[k] * dt);
  }

  if (hecklerActiveUntil > 0 && hecklerActiveUntil <= now) {
    // Window expired without an answer — speaker loses authority for
    // letting the heckler stand.
    meters.otorite = clampMeter(meters.otorite - HECKLER_MISS_PENALTY);
    hideHeckler();
    scheduleNextHeckler(now);
  } else if (hecklerActiveUntil === 0 && now >= nextHecklerAt) {
    showHeckler(now);
  }

  paintMeters();
  paintCooldowns(now);
  paintTime(now);

  const fallen = METERS.some((k) => meters[k] <= 0);
  if (fallen) {
    endGame(false);
    return;
  }
  if (now >= endsAt) {
    endGame(true);
    return;
  }

  rafId = requestAnimationFrame((t) => loop(t, token));
}

function startGame(): void {
  if (state === 'playing') return;
  gen.bump();
  const token = gen.current();
  state = 'playing';
  meters = { mantik: 65, duygu: 65, otorite: 65, mizah: 65 };
  cooldownUntil = { veri: 0, hikaye: 0, ilke: 0, espri: 0 };
  setScore(0);
  hecklerAnswered = 0;
  const now = performance.now();
  endsAt = now + SPEECH_SECONDS * 1000;
  lastFrame = now;
  scheduleNextHeckler(now);
  hideHeckler();
  hideOverlay(overlayEl);
  paintMeters();
  paintCooldowns(now);
  paintTime(now);
  rafId = requestAnimationFrame((t) => loop(t, token));
}

function reset(): void {
  gen.bump();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  state = 'ready';
  meters = { mantik: 60, duygu: 60, otorite: 60, mizah: 60 };
  cooldownUntil = { veri: 0, hikaye: 0, ilke: 0, espri: 0 };
  setScore(0);
  hideHeckler();
  paintMeters();
  paintCooldowns(performance.now());
  timeEl.textContent = fmtTime(SPEECH_SECONDS);
  overlayTitle.textContent = 'Hatip';
  overlayMsg.textContent =
    'Dört dinleyici ölçeri var: Mantık, Duygu, Otorite, Mizah. Her ölçer zamanla düşer. Dört aracın her biri birini güçlendirir ama diğerini zayıflatır. 90 saniye boyunca hiçbir ölçer sıfıra inmesin.';
  overlayStartBtn.textContent = 'Kürsüye çık';
  showOverlay(overlayEl);
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayStartBtn = document.querySelector<HTMLButtonElement>('#overlay-start')!;
  hecklerEl = document.querySelector<HTMLElement>('#heckler')!;
  hecklerBtn = document.querySelector<HTMLButtonElement>('#heckler-btn')!;

  for (const k of METERS) {
    meterFills[k] = document.querySelector<HTMLElement>(`#bar-${k}`)!;
    meterVals[k] = document.querySelector<HTMLElement>(`#val-${k}`)!;
  }
  for (const k of Object.keys(ACTIONS) as ActionKey[]) {
    actionEls[k] = document.querySelector<HTMLButtonElement>(`[data-action="${k}"]`)!;
    actionEls[k].addEventListener('click', () => doAction(k, performance.now()));
  }

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  const enterFromOverlay = (): void => {
    if (state === 'ready' || state === 'gameover') startGame();
  };

  overlayStartBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    enterFromOverlay();
  });
  overlayEl.addEventListener('click', enterFromOverlay);

  hecklerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    answerHeckler(performance.now());
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
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
    // state === 'playing'
    if (e.key === ' ') {
      if (hecklerActiveUntil > performance.now()) {
        e.preventDefault();
        answerHeckler(performance.now());
      }
      return;
    }
    const action = KEY_TO_ACTION[e.key];
    if (action) {
      e.preventDefault();
      doAction(action, performance.now());
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
