import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// Kuluçka — dört yumurtayı paralel olarak kişiye özgü sıcaklık bantlarında tut.
//
// Mekanik (özet):
//   - 4 yumurta, 2x2 grid. Her birinin termometresi + çatlama-ilerleme barı var.
//   - Yumurta basılı tutulduğu sürece (pointer veya 1-4) sıcaklığı yükselir,
//     bırakıldığında ortam sıcaklığına doğru düşer.
//   - Sıcaklık yeşil bandın içindeyse progress dolar, dışındaysa yavaşça boşalır.
//   - Bant min - FREEZE_GAP'in altına düşerse veya bant max + BURN_GAP'in
//     üstüne çıkarsa yumurta kaybedilir. -5 puan.
//   - Progress %100'e ulaşırsa çatlar: +10 puan, yeni yumurta.
//
// Pitfalls önlemleri:
//   - module-level-dom-access: tüm DOM erişimi init() içinde.
//   - unguarded-storage: safeRead/safeWrite kullanılıyor.
//   - stale-async-callback: tek RAF loop + gen-token; reset() bump eder,
//     loop early-return ile bırakılır.
//   - visual-vs-hitbox: termometre band konumu = oyun mantığındaki band ile
//     tek `tempToPct` üzerinden besleniyor.
//   - overlay-input-leak: state enum ile gameOver durumunda input no-op.
//   - missing-overlay-css: overlay--hidden tanımı CSS'te.
//   - duplicate-with-shared-layer: body title/hint shared layout'tan; biz
//     sadece oyun yüzeyini koyduk.

// ---- Sabitler ----

const STORAGE_BEST = 'kulucka.best';
const EGG_COUNT = 4;
const ROUND_SEC = 90;

// Sıcaklık modeli (her şey °C / sn).
const COOL_RATE = 4; // pasif soğuma (°C/sn)
const HEAT_RATE = 9; // ısıtma rate'i (°C/sn) — net yükseliş ~5°C/sn
const TEMP_MIN_DISPLAY = 0;
const TEMP_MAX_DISPLAY = 60;
const FREEZE_GAP = 8; // band min - 8°C → donar
const BURN_GAP = 8; // band max + 8°C → yanar
const AMBIENT_TEMP = 18; // ortam — soğutmanın hedefi değil; sadece görsel tint için.

// Çatlama ilerlemesi.
const PROG_FILL_RATE = 0.25; // %25/sn band içindeyken
const PROG_DRAIN_RATE = 0.10; // %10/sn band dışındayken
const PROG_HATCH = 1.0;

// Skor.
const SCORE_HATCH = 10;
const SCORE_LOSE = -5;

// Bant şablonları — geniş/orta/dar zorluk karışımı.
interface BandSpec {
  min: number;
  max: number;
}
const BAND_TEMPLATES: BandSpec[] = [
  { min: 28, max: 36 },
  { min: 34, max: 40 },
  { min: 38, max: 44 },
  { min: 32, max: 38 },
  { min: 36, max: 41 },
  { min: 40, max: 45 },
  { min: 30, max: 35 },
  { min: 33, max: 39 },
];

// ---- DOM refs ----

let timeEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayRestart!: HTMLButtonElement;

interface EggUI {
  root: HTMLButtonElement;
  band: HTMLElement;
  needle: HTMLElement;
  progress: HTMLElement;
  label: HTMLElement;
  crack: SVGPathElement;
  eggPath: SVGPathElement;
}

const eggUis: EggUI[] = [];

// ---- State ----

type GameState = 'playing' | 'gameOver';

interface Egg {
  band: BandSpec;
  temp: number;
  progress: number; // 0..1
  hot: boolean;
}

const gen = createGenToken();
let state: GameState = 'playing';
let score = 0;
let best = 0;
let timeLeft = ROUND_SEC;
const eggs: Egg[] = [];

const pressedKeys = new Set<string>(); // "1" "2" "3" "4"
const pressedEggs = new Set<number>();

let rafId: number | null = null;
let lastTs = 0;

// ---- Helpers ----

function pickBand(prev?: BandSpec): BandSpec {
  let safety = 12;
  while (safety-- > 0) {
    const idx = Math.floor(Math.random() * BAND_TEMPLATES.length);
    const cand = BAND_TEMPLATES[idx]!;
    if (!prev || cand.min !== prev.min || cand.max !== prev.max) return cand;
  }
  return BAND_TEMPLATES[0]!;
}

function freshEgg(prev?: BandSpec): Egg {
  const band = pickBand(prev);
  // Yeni yumurta bandının üst-orta noktasında doğsun — anında donmasın,
  // birkaç saniye sonra bant altına kaymaya başlasın.
  const startTemp = band.min + (band.max - band.min) * 0.7;
  return {
    band,
    temp: startTemp,
    progress: 0,
    hot: false,
  };
}

function tempToPct(t: number): number {
  const r = (t - TEMP_MIN_DISPLAY) / (TEMP_MAX_DISPLAY - TEMP_MIN_DISPLAY);
  return Math.max(0, Math.min(1, r)) * 100;
}

// ---- Render ----

function renderHud(): void {
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

function renderEgg(i: number): void {
  const egg = eggs[i];
  const ui = eggUis[i];
  if (!egg || !ui) return;

  const bandBottomPct = tempToPct(egg.band.min);
  const bandTopPct = tempToPct(egg.band.max);
  ui.band.style.bottom = `${bandBottomPct.toFixed(2)}%`;
  ui.band.style.height = `${(bandTopPct - bandBottomPct).toFixed(2)}%`;

  const needlePct = tempToPct(egg.temp);
  ui.needle.style.bottom = `${needlePct.toFixed(2)}%`;

  const inBand = egg.temp >= egg.band.min && egg.temp <= egg.band.max;
  const tooCold = egg.temp < egg.band.min;
  const tooHot = egg.temp > egg.band.max;

  ui.needle.classList.toggle('egg__needle--ok', inBand);
  ui.needle.classList.toggle('egg__needle--cold', tooCold);
  ui.needle.classList.toggle('egg__needle--hot', tooHot);

  const pct = Math.max(0, Math.min(1, egg.progress)) * 100;
  ui.progress.style.width = `${pct.toFixed(2)}%`;
  ui.progress.classList.toggle('egg__progressFill--ready', egg.progress >= 0.98);

  // Shell tint by temperature.
  let fill = '#e9c97a';
  if (egg.temp < AMBIENT_TEMP + 4) fill = '#a8c5db';
  else if (egg.temp > egg.band.max + 4) fill = '#d57a4a';
  else if (egg.temp > egg.band.max) fill = '#deaa6b';
  ui.eggPath.setAttribute('fill', fill);

  if (egg.progress > 0.6) {
    const p = (egg.progress - 0.6) / 0.4;
    const len = Math.min(1, p);
    const points: [number, number][] = [
      [50, 40],
      [42, 52 + len * 4],
      [56, 64 + len * 4],
      [44, 78 + len * 6],
      [58, 92 + len * 8],
    ];
    const d = points
      .map((pt, idx) => (idx === 0 ? `M${pt[0]},${pt[1]}` : `L${pt[0]},${pt[1]}`))
      .join(' ');
    ui.crack.setAttribute('d', d);
    ui.crack.setAttribute('opacity', String(0.4 + len * 0.6));
  } else {
    ui.crack.setAttribute('opacity', '0');
  }

  ui.root.classList.toggle('egg--heating', egg.hot);

  ui.label.textContent = `${egg.band.min}-${egg.band.max}°C`;
}

function renderAll(): void {
  renderHud();
  for (let i = 0; i < EGG_COUNT; i++) renderEgg(i);
}

// ---- Game loop ----

function loop(ts: number): void {
  if (state !== 'playing') return;
  const myGen = gen.current();
  if (rafId === null) return;
  if (lastTs === 0) lastTs = ts;
  const dtRaw = (ts - lastTs) / 1000;
  const dt = Math.max(0, Math.min(0.1, dtRaw));
  lastTs = ts;

  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    renderHud();
    endGame();
    return;
  }

  for (let i = 0; i < EGG_COUNT; i++) {
    const egg = eggs[i]!;
    const heating = pressedKeys.has(String(i + 1)) || pressedEggs.has(i);
    egg.hot = heating;
    if (heating) {
      egg.temp += HEAT_RATE * dt;
    } else {
      egg.temp -= COOL_RATE * dt;
    }
    if (egg.temp < TEMP_MIN_DISPLAY) egg.temp = TEMP_MIN_DISPLAY;
    if (egg.temp > TEMP_MAX_DISPLAY) egg.temp = TEMP_MAX_DISPLAY;

    const inBand = egg.temp >= egg.band.min && egg.temp <= egg.band.max;
    if (inBand) {
      egg.progress += PROG_FILL_RATE * dt;
    } else {
      egg.progress -= PROG_DRAIN_RATE * dt;
      if (egg.progress < 0) egg.progress = 0;
    }

    if (egg.progress >= PROG_HATCH) {
      score += SCORE_HATCH;
      flashEgg(i, 'hatch');
      eggs[i] = freshEgg(egg.band);
      continue;
    }

    const freezeThr = egg.band.min - FREEZE_GAP;
    const burnThr = egg.band.max + BURN_GAP;
    if (egg.temp <= freezeThr || egg.temp >= burnThr) {
      score += SCORE_LOSE;
      if (score < 0) score = 0;
      flashEgg(i, egg.temp <= freezeThr ? 'freeze' : 'burn');
      eggs[i] = freshEgg(egg.band);
      continue;
    }
  }

  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }

  renderAll();

  if (myGen === gen.current() && state === 'playing') {
    rafId = window.requestAnimationFrame(loop);
  }
}

function flashEgg(i: number, kind: 'hatch' | 'freeze' | 'burn'): void {
  const ui = eggUis[i];
  if (!ui) return;
  const cls =
    kind === 'hatch' ? 'egg--hatch' : kind === 'freeze' ? 'egg--freeze' : 'egg--burn';
  ui.root.classList.add(cls);
  const token = gen.current();
  window.setTimeout(() => {
    if (token !== gen.current()) return;
    ui.root.classList.remove(cls);
  }, 420);
}

// ---- Lifecycle ----

function startLoop(): void {
  if (rafId !== null) return;
  lastTs = 0;
  rafId = window.requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (rafId !== null) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function endGame(): void {
  if (state !== 'playing') return;
  state = 'gameOver';
  stopLoop();
  pressedKeys.clear();
  pressedEggs.clear();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  presentOverlay();
}

function presentOverlay(): void {
  overlayTitle.textContent = score > 0 && score === best ? 'Yeni rekor!' : 'Süre doldu';
  overlayMsg.textContent =
    score === 0
      ? 'Hiç yumurta çatlatamadın. Tekrar dene!'
      : `Skor: ${score} · En iyi: ${best}`;
  showOverlay(overlayEl);
  try {
    overlayRestart.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function resetGame(): void {
  gen.bump();
  stopLoop();
  state = 'playing';
  score = 0;
  timeLeft = ROUND_SEC;
  pressedKeys.clear();
  pressedEggs.clear();
  for (let i = 0; i < EGG_COUNT; i++) {
    eggs[i] = freshEgg();
  }
  for (const ui of eggUis) {
    ui.root.classList.remove(
      'egg--heating',
      'egg--hatch',
      'egg--freeze',
      'egg--burn',
    );
  }
  hideOverlay(overlayEl);
  renderAll();
  startLoop();
}

// ---- Input ----

function bindEgg(ui: EggUI, idx: number): void {
  const onDown = (e: PointerEvent): void => {
    if (state !== 'playing') return;
    pressedEggs.add(idx);
    e.preventDefault();
    try {
      ui.root.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onUp = (e: PointerEvent): void => {
    pressedEggs.delete(idx);
    try {
      ui.root.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  ui.root.addEventListener('pointerdown', onDown);
  ui.root.addEventListener('pointerup', onUp);
  ui.root.addEventListener('pointercancel', onUp);
  ui.root.addEventListener('pointerleave', (e) => {
    if (!ui.root.hasPointerCapture(e.pointerId)) {
      pressedEggs.delete(idx);
    }
  });
  ui.root.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
  });
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  const k = e.key;
  if (k === 'r' || k === 'R') {
    resetGame();
    e.preventDefault();
    return;
  }
  if (k >= '1' && k <= '4') {
    if (state !== 'playing') return;
    pressedKeys.add(k);
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  if (k >= '1' && k <= '4') {
    pressedKeys.delete(k);
    e.preventDefault();
  }
}

function onBlur(): void {
  pressedKeys.clear();
  pressedEggs.clear();
}

function onVisibility(): void {
  if (document.hidden) {
    pressedKeys.clear();
    pressedEggs.clear();
  }
}

// ---- Init ----

function init(): void {
  timeEl = document.querySelector<HTMLElement>('#time')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestart = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  for (let i = 0; i < EGG_COUNT; i++) {
    const root = document.querySelector<HTMLButtonElement>(`#egg-${i}`)!;
    const band = root.querySelector<HTMLElement>('[data-role="band"]')!;
    const needle = root.querySelector<HTMLElement>('[data-role="needle"]')!;
    const progress = root.querySelector<HTMLElement>('[data-role="progress"]')!;
    const label = root.querySelector<HTMLElement>('[data-role="label"]')!;
    const eggPath = root.querySelector<SVGPathElement>('[data-role="egg-path"]')!;
    const crack = root.querySelector<SVGPathElement>('[data-role="crack"]')!;
    const ui: EggUI = { root, band, needle, progress, label, crack, eggPath };
    eggUis.push(ui);
    bindEgg(ui, i);
  }

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', resetGame);
  overlayRestart.addEventListener('click', resetGame);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  resetGame();
}

export const game = defineGame({ init, reset: resetGame });
