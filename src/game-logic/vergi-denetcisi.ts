// Vergi Denetçisi — fatura anomali tespit oyunu.
// Pitfalls actively guarded:
// - overlay-input-leak: state machine ('playing' | 'gameOver'); row clicks no-op in gameOver.
// - stale-async-callback: round changes bump gen; reserved for future async work.
// - unguarded-storage: @shared/storage wraps localStorage with try/catch.
// - duplicate-with-shared-layer: body has no <h1>, hint or how-to; layout supplies these.
// - invisible-boot: init() renders first round + score=0 before any user input.
// - visual-vs-hitbox: DOM row buttons; click target = visual row, no offset math.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';

type GameState = 'playing' | 'gameOver';
type AnomalyKind = 'math' | 'future-date' | 'duplicate' | 'absurd' | 'wrong-vat';

interface Invoice {
  id: string;
  no: string;
  date: string;
  amount: number;
  vat: number;
  total: number;
  // Set of anomaly kinds present on this invoice; empty = clean row.
  anomalies: Set<AnomalyKind>;
}

const STORAGE_KEY_BEST = 'vergi-denetcisi.best';
const ROWS_PER_ROUND = 8;
const MAX_STRIKES = 3;
const STANDARD_VAT_RATE = 0.18;
const BASE_REWARD = 100;
const BONUS_PER_REMAINING_MS = 0.02; // 1ms remaining = 0.02 bonus; tuned so 5s = +100
const WRONG_PENALTY = 50;
const ROUND_TIME_MS = 30_000;

const ANOMALY_LABEL: Record<AnomalyKind, string> = {
  math: 'Tutar + KDV ≠ Toplam',
  'future-date': 'Geleceğin tarihi',
  duplicate: 'Tekrarlanan fatura no',
  absurd: 'Anormal yüksek tutar',
  'wrong-vat': 'Yanlış KDV oranı',
};

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let strikesEl!: HTMLElement;
let statusEl!: HTMLElement;
let rowsEl!: HTMLElement;
let nextBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayRestartBtn!: HTMLButtonElement;

let state: GameState = 'playing';
let invoices: Invoice[] = [];
let marked = new Set<string>();
let resolved = new Set<string>();
let score = 0;
let best = 0;
let round = 1;
let strikes = 0;
let roundStartedAt = 0;
const gen = createGenToken();

function loadBest(key: string, fallback: number): number {
  const v = safeRead<number>(key, fallback);
  return Number.isFinite(v) ? v : fallback;
}

// Deterministic pseudo-random helpers so rounds feel varied but reproducible per seed.
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick from empty array');
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function formatDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function pastDate(daysAgoMax: number): string {
  const d = new Date();
  d.setDate(d.getDate() - rand(1, Math.max(1, daysAgoMax)));
  return formatDate(d);
}
function futureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + rand(5, 365));
  return formatDate(d);
}

function fmtTL(n: number): string {
  return `${n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
}

let invoiceCounter = 1000;
function nextInvoiceNo(): string {
  invoiceCounter += rand(1, 7);
  return `F-${invoiceCounter}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Generate one clean invoice. Amount and VAT are consistent.
function cleanInvoice(): Invoice {
  const amount = round2(rand(50, 900) + Math.random());
  const vat = round2(amount * STANDARD_VAT_RATE);
  const total = round2(amount + vat);
  return {
    id: cryptoId(),
    no: nextInvoiceNo(),
    date: pastDate(60),
    amount,
    vat,
    total,
    anomalies: new Set(),
  };
}

let idCounter = 0;
function cryptoId(): string {
  idCounter += 1;
  return `inv-${idCounter}`;
}

// Mutate a clean invoice into an anomaly. Returns the same object.
function applyAnomaly(inv: Invoice, kind: AnomalyKind): Invoice {
  inv.anomalies.add(kind);
  switch (kind) {
    case 'math': {
      // Pick a non-trivial error: shift total by 10-90 TL, never zero.
      const drift = round2(rand(10, 90) + Math.random());
      const sign = Math.random() < 0.5 ? -1 : 1;
      inv.total = round2(inv.total + sign * drift);
      break;
    }
    case 'future-date': {
      inv.date = futureDate();
      break;
    }
    case 'absurd': {
      // 12-25x normal amount; keep amount+vat=total so only this anomaly triggers.
      const factor = rand(12, 25);
      inv.amount = round2(inv.amount * factor);
      inv.vat = round2(inv.amount * STANDARD_VAT_RATE);
      inv.total = round2(inv.amount + inv.vat);
      break;
    }
    case 'wrong-vat': {
      // Use a wrong VAT rate (28% or 33% or 8% on a row where 18% is expected).
      const wrong = pick([0.28, 0.33, 0.08, 0.45]);
      inv.vat = round2(inv.amount * wrong);
      inv.total = round2(inv.amount + inv.vat);
      // Make sure math still adds up (so player can rule out "math" anomaly).
      break;
    }
    case 'duplicate': {
      // Handled by generateRound (needs another invoice to share no with).
      break;
    }
  }
  return inv;
}

// Build a round of invoices. About 35-50% will be anomalies, exactly one per
// row (duplicate is paired so two rows share the marker).
function generateRound(): Invoice[] {
  const list: Invoice[] = [];
  for (let i = 0; i < ROWS_PER_ROUND; i++) {
    list.push(cleanInvoice());
  }

  // Decide anomaly count: 3-5 anomalous rows.
  const anomalyCount = rand(3, 5);
  const indices = list.map((_, i) => i);
  // Shuffle indices.
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = tmp;
  }
  const chosen = indices.slice(0, anomalyCount);

  // Always have at least one of each kind sometimes — but not forced.
  const kinds: AnomalyKind[] = ['math', 'future-date', 'absurd', 'wrong-vat'];

  // We treat duplicate specially: if selected, we mark TWO rows as duplicates
  // (both anomalous). We pick one of the chosen indices, then duplicate its
  // invoice no onto another clean (non-chosen) row.
  let usedDuplicate = false;
  if (Math.random() < 0.6 && chosen.length >= 1) {
    const a = chosen[0]!;
    // pick another index not in chosen
    const others = indices.filter((idx) => !chosen.includes(idx));
    if (others.length > 0) {
      const b = others[0]!;
      const inv = list[a]!;
      const partner = list[b]!;
      partner.no = inv.no;
      inv.anomalies.add('duplicate');
      partner.anomalies.add('duplicate');
      // chosen already covers `a`; partner becomes anomaly too (not counted in chosen)
      usedDuplicate = true;
    }
  }

  // Apply other anomalies to remaining chosen indices (skipping the duplicate-anchor if already used).
  const remaining = usedDuplicate ? chosen.slice(1) : chosen;
  // Ensure variety: rotate through kinds.
  let k = 0;
  for (const idx of remaining) {
    const inv = list[idx]!;
    // Skip if already anomalous (e.g. duplicate partner).
    if (inv.anomalies.size > 0) continue;
    const kind = kinds[k % kinds.length]!;
    applyAnomaly(inv, kind);
    k++;
  }

  return list;
}

function isAnomaly(inv: Invoice): boolean {
  return inv.anomalies.size > 0;
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  roundEl.textContent = String(round);
  strikesEl.textContent = `${strikes}/${MAX_STRIKES}`;
}

function renderRows(): void {
  // Build DOM once per round; reuse for clicks via dataset.
  rowsEl.innerHTML = '';
  for (const inv of invoices) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'vd-row';
    row.dataset.id = inv.id;
    row.setAttribute('role', 'row');
    row.setAttribute(
      'aria-label',
      `Fatura ${inv.no}, tarih ${inv.date}, tutar ${fmtTL(inv.amount)}, KDV ${fmtTL(inv.vat)}, toplam ${fmtTL(inv.total)}`,
    );
    row.innerHTML = `
      <span class="vd-cell vd-cell--no">${escapeHtml(inv.no)}</span>
      <span class="vd-cell vd-cell--date">${escapeHtml(inv.date)}</span>
      <span class="vd-cell vd-cell--num">${fmtTL(inv.amount)}</span>
      <span class="vd-cell vd-cell--num">${fmtTL(inv.vat)}</span>
      <span class="vd-cell vd-cell--num">${fmtTL(inv.total)}</span>
    `;
    rowsEl.appendChild(row);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
      ? '&lt;'
      : c === '>'
      ? '&gt;'
      : c === '"'
      ? '&quot;'
      : '&#39;',
  );
}

function updateRowVisuals(): void {
  const rowEls = rowsEl.querySelectorAll<HTMLButtonElement>('button.vd-row');
  rowEls.forEach((el) => {
    const id = el.dataset.id ?? '';
    el.classList.toggle('vd-row--marked', marked.has(id));
    const r = resolved.has(id);
    el.classList.toggle('vd-row--resolved', r);
    if (r) {
      const inv = invoices.find((i) => i.id === id);
      if (inv && isAnomaly(inv)) {
        el.classList.add('vd-row--correct');
      } else if (inv) {
        el.classList.add('vd-row--wrong');
      }
    }
    el.disabled = state !== 'playing' || r;
  });
}

function handleRowClick(id: string): void {
  if (state !== 'playing') return;
  if (resolved.has(id)) return;
  const inv = invoices.find((i) => i.id === id);
  if (!inv) return;

  if (isAnomaly(inv)) {
    // Correct mark. Award reward + speed bonus.
    const elapsed = Math.max(0, performance.now() - roundStartedAt);
    const remaining = Math.max(0, ROUND_TIME_MS - elapsed);
    const bonus = Math.round(remaining * BONUS_PER_REMAINING_MS);
    score += BASE_REWARD + bonus;
    marked.add(id);
    resolved.add(id);
    const labels = Array.from(inv.anomalies).map((k) => ANOMALY_LABEL[k]).join(', ');
    setStatus(`+${BASE_REWARD + bonus} puan — ${labels}`);
  } else {
    // Wrong mark. Penalty + strike.
    score = Math.max(0, score - WRONG_PENALTY);
    strikes += 1;
    marked.add(id);
    resolved.add(id);
    setStatus(`Yanlış işaret — -${WRONG_PENALTY} puan. Hata ${strikes}/${MAX_STRIKES}.`);
    if (strikes >= MAX_STRIKES) {
      endGame('Üç hata yaptın. Müfettişlik koltuğunu kaybettin.');
      syncHud();
      updateRowVisuals();
      return;
    }
  }
  saveBest();
  syncHud();
  updateRowVisuals();
  maybeEndRoundEarly();
}

function maybeEndRoundEarly(): void {
  // Round ends auto when all anomalies have been correctly identified.
  const anomalies = invoices.filter(isAnomaly);
  const allFound = anomalies.every((inv) => resolved.has(inv.id) && marked.has(inv.id) && isAnomaly(inv));
  if (allFound) {
    const allMarksAreCorrect = Array.from(marked).every((id) => {
      const inv = invoices.find((i) => i.id === id);
      return inv ? isAnomaly(inv) : false;
    });
    if (allMarksAreCorrect) {
      setStatus(`Tüm anomaliler tespit edildi! "Sonraki tur"a bas.`);
    }
  }
}

function endRound(): void {
  if (state !== 'playing') return;
  // Reveal: mark every un-resolved anomaly as missed (no penalty, but no bonus).
  let missed = 0;
  for (const inv of invoices) {
    if (isAnomaly(inv) && !resolved.has(inv.id)) {
      missed++;
      // We don't mark missed anomalies as 'wrong' — but they count as misses.
    }
  }
  if (missed > 0) {
    setStatus(`${missed} anomali kaçırıldı. Bir sonraki turda dikkat et.`);
  } else {
    setStatus('Tüm anomalileri yakaladın! Bir sonraki tur.');
  }
  round += 1;
  // Don't reset strikes; they're cumulative across rounds.
  startRound();
}

function startRound(): void {
  gen.bump();
  invoices = generateRound();
  marked = new Set();
  resolved = new Set();
  roundStartedAt = performance.now();
  state = 'playing';
  hideOverlay();
  syncHud();
  renderRows();
  updateRowVisuals();
}

function fullReset(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  strikes = 0;
  round = 1;
  invoiceCounter = 1000 + rand(0, 500);
  hideOverlay();
  setStatus('Yeni denetim. Anomalili satırları işaretle.');
  startRound();
}

function showOverlay(msg: string): void {
  overlayMsgEl.textContent = msg;
  overlayEl.hidden = false;
  overlayEl.setAttribute('aria-hidden', 'false');
  overlayEl.classList.add('vd-overlay--open');
}
function hideOverlay(): void {
  overlayEl.hidden = true;
  overlayEl.setAttribute('aria-hidden', 'true');
  overlayEl.classList.remove('vd-overlay--open');
}

function endGame(msg: string): void {
  state = 'gameOver';
  saveBest();
  showOverlay(`${msg} Skor: ${score}. En iyi: ${best}.`);
}

function saveBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY_BEST, best);
  }
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  strikesEl = document.querySelector<HTMLElement>('#strikes')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  rowsEl = document.querySelector<HTMLElement>('#rows')!;
  nextBtn = document.querySelector<HTMLButtonElement>('#next')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestartBtn = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  best = loadBest(STORAGE_KEY_BEST, 0);
  score = 0;
  strikes = 0;
  round = 1;
  invoiceCounter = 1000 + rand(0, 500);

  // Click delegation to the rows container — robust against re-render.
  rowsEl.addEventListener('click', (e) => {
    if (state !== 'playing') return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const row = target.closest<HTMLElement>('.vd-row');
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;
    handleRowClick(id);
  });

  nextBtn.addEventListener('click', () => {
    if (state !== 'playing') return;
    endRound();
  });

  restartBtn.addEventListener('click', fullReset);
  overlayRestartBtn.addEventListener('click', fullReset);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      fullReset();
      e.preventDefault();
      return;
    }
    if (state === 'gameOver') return;
    if (k === 'enter' || k === ' ' || k === 'n') {
      endRound();
      e.preventDefault();
    }
  });

  setStatus('Anomalili satırlara tıkla. Temiz satıra tıklarsan hata sayılır.');
  startRound();
  syncHud();
}

export const game = defineGame({ init, reset: fullReset });

// Expose for headless testing only (test harness reads this).
declare global {
  interface Window {
    __vd?: {
      getState: () => GameState;
      getScore: () => number;
      getStrikes: () => number;
      getRound: () => number;
      getInvoices: () => Invoice[];
      clickRowById: (id: string) => void;
      nextRound: () => void;
      reset: () => void;
      isAnomaly: (inv: Invoice) => boolean;
    };
  }
}
if (typeof window !== 'undefined') {
  window.__vd = {
    getState: () => state,
    getScore: () => score,
    getStrikes: () => strikes,
    getRound: () => round,
    getInvoices: () => invoices,
    clickRowById: (id: string) => handleRowClick(id),
    nextRound: () => endRound(),
    reset: () => fullReset(),
    isAnomaly,
  };
}
