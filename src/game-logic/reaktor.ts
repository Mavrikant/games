import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Reaktör — nükleer reaktör operatörü simülasyonu
// PITFALLS guarded:
//   - unguarded-storage: safeRead/safeWrite.
//   - module-level-dom-access: tüm DOM erişimi init() içinde.
//   - stale-async-callback: rafId yönetimi + loop tepesinde state guard.
//   - overlay-input-leak: state enum + her handler'da state guard.
//   - missing-overlay-css: .overlay--hidden CSS'te tanımlı.
//   - invisible-boot: ilk render reset()'te göstergeleri/çubukları çizer.
//   - unreachable-start-state: Başla butonu + Space/Enter + R aynı geçişi tetikler.

const STORAGE_BEST = 'reaktor.best';
const SCORE_DESC = { gameId: 'reaktor', storageKey: STORAGE_BEST, direction: 'higher' as const };

const ROD_COUNT = 4;
const AMBIENT_T = 25;
const SAFE_LOW_T = 200;
const SAFE_HIGH_T = 900;
const HOT_T = 1000;
const MELTDOWN_T = 1200;
// Heat balance: F=37.5 → eq T≈550 (peak eff). F=100 → eq T≈1425 → meltdown.
const HEAT_PER_F = 14;
const COOL_COEF = 1.0;
const RESPONSE_SLOW = 0.4;
const POWER_PER_F = 8;
const OPT_T = 550;
const EFF_SIGMA = 240;
const POWER_MAX_DISPLAY = 500;
const DEMAND_TOL = 30;
const DEMAND_CHANGE_S = 8;

type State = 'ready' | 'playing' | 'meltdown';

let state: State = 'ready';
let temperature = AMBIENT_T;
let activity: number[] = new Array<number>(ROD_COUNT).fill(0);
let demand = 200;
let demandTimer = DEMAND_CHANGE_S;
let score = 0;
let best = 0;
let scoreAccumulator = 0;
let selectedRod = 0;
let lastTickMs = 0;
let rafId: number | null = null;
let activeDragRod: number | null = null;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let tempValEl!: HTMLElement;
let tempNeedleEl!: HTMLElement;
let tempWarnEl!: HTMLElement;
let powerValEl!: HTMLElement;
let powerBarEl!: HTMLElement;
let demandBandEl!: HTMLElement;
let demandValEl!: HTMLElement;
let demandTimerEl!: HTMLElement;
let effValEl!: HTMLElement;
let statusTip!: HTMLElement;
const rodDivs: HTMLElement[] = [];
const rodSliders: HTMLElement[] = [];
const rodFills: HTMLElement[] = [];
const rodHandles: HTMLElement[] = [];
const rodPcts: HTMLElement[] = [];
const rodUpBtns: HTMLButtonElement[] = [];
const rodDownBtns: HTMLButtonElement[] = [];

function totalActivity(): number {
  let s = 0;
  for (const a of activity) s += a;
  return s;
}

function efficiency(T: number): number {
  const x = (T - OPT_T) / EFF_SIGMA;
  return Math.exp(-x * x);
}

function powerOutput(T: number): number {
  const F = totalActivity() / ROD_COUNT; // 0..100
  return F * POWER_PER_F * efficiency(T);
}

function rollDemand(): void {
  // Achievable sustained power range ~ 60..280 MW. Spice slowly with score.
  const lo = Math.max(60, 120 - score * 0.3);
  const hi = Math.min(310, 200 + score * 0.6);
  demand = Math.round(lo + Math.random() * (hi - lo));
  demandTimer = DEMAND_CHANGE_S;
}

function tempZone(T: number): 'cold' | 'safe' | 'hot' | 'danger' {
  if (T < SAFE_LOW_T) return 'cold';
  if (T <= SAFE_HIGH_T) return 'safe';
  if (T < HOT_T + 100) return 'hot';
  return 'danger';
}

function render(): void {
  const p = powerOutput(temperature);

  tempValEl.textContent = `${Math.round(temperature)}°`;
  const tempSpan = MELTDOWN_T - AMBIENT_T;
  const tempPct = Math.min(
    100,
    Math.max(0, ((temperature - AMBIENT_T) / tempSpan) * 100),
  );
  tempNeedleEl.style.left = `${tempPct}%`;
  const zone = tempZone(temperature);
  tempNeedleEl.dataset.zone = zone;
  tempWarnEl.textContent =
    zone === 'danger'
      ? '⚠ KRİTİK'
      : zone === 'hot'
        ? '⚠ Yüksek'
        : zone === 'cold'
          ? 'Soğuk'
          : '✓ Güvenli';
  tempWarnEl.dataset.zone = zone;

  powerValEl.textContent = `${Math.round(p)} MW`;
  const powerPct = Math.min(100, (p / POWER_MAX_DISPLAY) * 100);
  powerBarEl.style.width = `${powerPct}%`;
  const demandPctC = (demand / POWER_MAX_DISPLAY) * 100;
  const tolPct = ((DEMAND_TOL * 2) / POWER_MAX_DISPLAY) * 100;
  demandBandEl.style.left = `${Math.max(0, demandPctC - tolPct / 2)}%`;
  demandBandEl.style.width = `${tolPct}%`;

  demandValEl.textContent = String(demand);
  demandTimerEl.textContent = String(Math.max(0, Math.ceil(demandTimer)));
  effValEl.textContent = `${Math.round(efficiency(temperature) * 100)}%`;

  scoreEl.textContent = String(score);
  bestEl.textContent = String(Math.max(best, score));

  for (let i = 0; i < ROD_COUNT; i++) {
    const a = activity[i] ?? 0;
    rodFills[i]!.style.height = `${a}%`;
    rodHandles[i]!.style.bottom = `${a}%`;
    rodHandles[i]!.setAttribute('aria-valuenow', String(Math.round(a)));
    rodPcts[i]!.textContent = `${Math.round(a)}%`;
    rodDivs[i]!.classList.toggle('rk-rod--selected', selectedRod === i);
  }

  let tip = '';
  if (state === 'ready') {
    tip = 'Başla\'ya bas, sonra çubukları çek — kontrol senin.';
  } else if (state === 'meltdown') {
    tip = '💥 Meltdown! Yeniden başla.';
  } else {
    const diff = p - demand;
    if (temperature >= HOT_T) tip = '⚠ Sıcaklık kritik — çubukları sok!';
    else if (Math.abs(diff) <= DEMAND_TOL) tip = '✓ Talep karşılandı, böyle devam.';
    else if (diff < -DEMAND_TOL * 3) tip = 'Güç çok düşük — çubukları çek.';
    else if (diff > DEMAND_TOL * 3) tip = 'Güç fazla — çubukları biraz sok.';
    else tip = 'İnce ayar yap...';
  }
  statusTip.textContent = tip;
}

function tick(dt: number): void {
  if (state !== 'playing') return;
  const F = totalActivity() / ROD_COUNT;
  const heatGen = F * HEAT_PER_F;
  const cooling = (temperature - AMBIENT_T) * COOL_COEF;
  temperature += (heatGen - cooling) * dt * RESPONSE_SLOW;
  if (temperature < AMBIENT_T) temperature = AMBIENT_T;

  demandTimer -= dt;
  if (demandTimer <= 0) rollDemand();

  const p = powerOutput(temperature);
  const onTarget = Math.abs(p - demand) <= DEMAND_TOL;
  const safeTemp = temperature >= SAFE_LOW_T && temperature <= SAFE_HIGH_T;
  if (onTarget && safeTemp) {
    scoreAccumulator += dt;
    while (scoreAccumulator >= 1) {
      score += 1;
      scoreAccumulator -= 1;
    }
  } else if (scoreAccumulator > 0) {
    scoreAccumulator = Math.max(0, scoreAccumulator - dt * 0.5);
  }

  if (temperature >= MELTDOWN_T) {
    gameOver();
    return;
  }

  render();
}

function loop(nowMs: number): void {
  if (state !== 'playing') {
    rafId = null;
    return;
  }
  if (lastTickMs === 0) lastTickMs = nowMs;
  // Clamp dt to avoid catch-up explosions when the tab returns from background.
  const dt = Math.min(0.1, (nowMs - lastTickMs) / 1000);
  lastTickMs = nowMs;
  tick(dt);
  if (state === 'playing') {
    rafId = requestAnimationFrame(loop);
  } else {
    rafId = null;
  }
}

function startGame(): void {
  if (state === 'playing') return;
  if (state === 'meltdown') {
    resetSilent();
  }
  state = 'playing';
  hideOverlayEl(overlay);
  lastTickMs = 0;
  rollDemand();
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
  render();
}

function gameOver(): void {
  state = 'meltdown';
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  reportGameOver(SCORE_DESC, score);
  overlayTitle.textContent = '💥 MELTDOWN!';
  overlayMsg.textContent = `Sıcaklık ${MELTDOWN_T}° eşiğini aştı.\nSkor: ${score}   Rekor: ${best}`;
  startBtn.textContent = 'Yeniden başla';
  showOverlayEl(overlay);
  render();
}

function resetSilent(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  state = 'ready';
  temperature = AMBIENT_T;
  for (let i = 0; i < ROD_COUNT; i++) activity[i] = 0;
  score = 0;
  scoreAccumulator = 0;
  selectedRod = 0;
  demand = 200;
  demandTimer = DEMAND_CHANGE_S;
  activeDragRod = null;
  lastTickMs = 0;
}

function reset(): void {
  resetSilent();
  overlayTitle.textContent = 'Reaktöre hoşgeldin';
  overlayMsg.textContent = `Hedef: güç talebini ±${DEMAND_TOL} MW içinde karşıla.\nSıcaklığı ${SAFE_LOW_T}°–${SAFE_HIGH_T}° arası tut. ${MELTDOWN_T}°+ = meltdown.`;
  startBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  render();
}

function setRodFromPointer(rodIdx: number, evt: PointerEvent): void {
  if (state !== 'playing') return;
  const slider = rodSliders[rodIdx]!;
  const rect = slider.getBoundingClientRect();
  if (rect.height <= 0) return;
  const y = evt.clientY - rect.top;
  // Top = 100% active; bottom = 0%.
  const a = Math.min(100, Math.max(0, ((rect.height - y) / rect.height) * 100));
  activity[rodIdx] = a;
  render();
}

function adjustRod(rodIdx: number, delta: number): void {
  if (state !== 'playing') return;
  const cur = activity[rodIdx] ?? 0;
  activity[rodIdx] = Math.min(100, Math.max(0, cur + delta));
  render();
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  tempValEl = document.querySelector<HTMLElement>('#temp-val')!;
  tempNeedleEl = document.querySelector<HTMLElement>('#temp-needle')!;
  tempWarnEl = document.querySelector<HTMLElement>('#temp-warn')!;
  powerValEl = document.querySelector<HTMLElement>('#power-val')!;
  powerBarEl = document.querySelector<HTMLElement>('#power-bar')!;
  demandBandEl = document.querySelector<HTMLElement>('#demand-band')!;
  demandValEl = document.querySelector<HTMLElement>('#demand-val')!;
  demandTimerEl = document.querySelector<HTMLElement>('#demand-timer')!;
  effValEl = document.querySelector<HTMLElement>('#eff-val')!;
  statusTip = document.querySelector<HTMLElement>('#status-tip')!;

  for (let i = 0; i < ROD_COUNT; i++) {
    rodDivs.push(document.querySelector<HTMLElement>(`[data-rod="${i}"]`)!);
    rodSliders.push(
      document.querySelector<HTMLElement>(`[data-rod-slider="${i}"]`)!,
    );
    rodFills.push(
      document.querySelector<HTMLElement>(`[data-rod-fill="${i}"]`)!,
    );
    rodHandles.push(
      document.querySelector<HTMLElement>(`[data-rod-handle="${i}"]`)!,
    );
    rodPcts.push(
      document.querySelector<HTMLElement>(`[data-rod-pct="${i}"]`)!,
    );
    rodUpBtns.push(
      document.querySelector<HTMLButtonElement>(`[data-rod-up="${i}"]`)!,
    );
    rodDownBtns.push(
      document.querySelector<HTMLButtonElement>(`[data-rod-down="${i}"]`)!,
    );
  }

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  startBtn.addEventListener('click', startGame);

  for (let i = 0; i < ROD_COUNT; i++) {
    const idx = i;
    rodUpBtns[i]!.addEventListener('click', () => {
      if (state !== 'playing') {
        startGame();
      }
      selectedRod = idx;
      adjustRod(idx, +5);
    });
    rodDownBtns[i]!.addEventListener('click', () => {
      if (state !== 'playing') return;
      selectedRod = idx;
      adjustRod(idx, -5);
    });
    const slider = rodSliders[i]!;
    slider.addEventListener('pointerdown', (e: PointerEvent) => {
      if (state !== 'playing') return;
      activeDragRod = idx;
      selectedRod = idx;
      try {
        slider.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setRodFromPointer(idx, e);
      e.preventDefault();
    });
    slider.addEventListener('pointermove', (e: PointerEvent) => {
      if (activeDragRod !== idx) return;
      setRodFromPointer(idx, e);
    });
    slider.addEventListener('pointerup', (e: PointerEvent) => {
      if (activeDragRod === idx) {
        activeDragRod = null;
        try {
          slider.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    });
    slider.addEventListener('pointercancel', () => {
      if (activeDragRod === idx) activeDragRod = null;
    });
  }

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'r' || k === 'R') {
      reset();
      return;
    }
    if (k === ' ' || k === 'Enter') {
      if (state !== 'playing') {
        e.preventDefault();
        startGame();
      }
      return;
    }
    if (k >= '1' && k <= '4') {
      selectedRod = Number(k) - 1;
      render();
      return;
    }
    if (state !== 'playing') return;
    if (k === 'ArrowUp') {
      e.preventDefault();
      adjustRod(selectedRod, +5);
    } else if (k === 'ArrowDown') {
      e.preventDefault();
      adjustRod(selectedRod, -5);
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
