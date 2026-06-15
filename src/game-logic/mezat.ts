import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';

// Mezat — müzayedeci. 8 mal arka arkaya satılığa çıkar; her mal için
// tellaller artırma yapar. Oyuncu tokmağı (Space / tıklama) tam tepe
// noktada indirmeli: erken vurursa para masada kalır, geç vurursa
// kalabalık dağılır ve mal yarı fiyata kapanır. Bidlerin gelme hızı
// fiyatın "gerçek değer"e olan oranına göre exponential olarak düşer
// (Poisson-benzeri). Heyecan barı son tekliften bu yana geçen zamanın
// görselleştirmesi — tepe noktada en yüksek, sönmeye başlayınca kapatma
// vakti.
//
// Pitfall önlemleri (docs/PITFALLS.md):
//  - module-level-dom-access: tüm DOM erişimi init() içinde, defineGame
//    queueMicrotask ile DOM hazırken çağırıyor.
//  - unguarded-storage: @shared/storage; safeRead/safeWrite Safari private
//    mode'da bile throw etmez.
//  - stale-async-callback: tüm setTimeout ve rAF gen-token ile korunuyor;
//    reset() bump eder, eski timer'lar no-op olur.
//  - overlay-input-leak: state enum (idle / bidding / closed / gameover).
//    keydown handler state'e bakar; gameover'da Space gavel'i değil
//    reset'i tetikler. Bidding dışında gavel butonu disabled.
//  - invisible-boot: reset() → ilk mal anında render, ilk bid 100-500ms
//    içinde gelir; HUD ve item kartı boot sonrası tek frame'de görünür.
//  - missing-overlay-css: .overlay / .overlay--hidden CSS dosyasında.
//  - hud-counter-synced-only-at-lifecycle-edges: skor satış anında
//    HUD'a yazılıyor (renderHud çağrısı sale flow içinde).
//  - designed-lose-condition-not-wired: geç kalma (sessizlik veya 14s
//    timeout) explicit autoClose dalına gider, %60 fiyat + status mesajı.
//  - duplicate-with-shared-layer: title/hint layout'tan; body'de yok.

// ---- Sabitler ----

const STORAGE_BEST = 'mezat.best';
const ITEMS_PER_ROUND = 8;
const ITEM_TIME_MS = 14_000;
const HISTORY_SHOWN = 6;
const POST_SALE_DELAY_MS = 1500;
const EXCITEMENT_DECAY_MS = 2400;
const AUTO_CLOSE_QUIET_MS = 3300;
const LATE_PENALTY_RATIO = 0.6;
const MIN_BID_INTERVAL_MS = 110;
const MAX_BID_INTERVAL_MS = 4500;

type State = 'idle' | 'bidding' | 'closed' | 'gameover';

interface ItemTemplate {
  name: string;
  icon: IconId;
  baseLow: number;
  baseHigh: number;
  mulLow: number;
  mulHigh: number;
}

type IconId =
  | 'vase'
  | 'clock'
  | 'tray'
  | 'bowl'
  | 'lamp'
  | 'coin'
  | 'frame'
  | 'rug'
  | 'candle'
  | 'pipe'
  | 'box'
  | 'pen'
  | 'ring'
  | 'mirror'
  | 'lute';

const CATALOG: ItemTemplate[] = [
  { name: 'Antik Vazo',         icon: 'vase',   baseLow:  80, baseHigh: 180, mulLow: 2.4, mulHigh: 4.2 },
  { name: 'Eski Cep Saati',     icon: 'clock',  baseLow:  60, baseHigh: 140, mulLow: 2.2, mulHigh: 3.8 },
  { name: 'Gümüş Tepsi',        icon: 'tray',   baseLow: 120, baseHigh: 240, mulLow: 1.8, mulHigh: 3.0 },
  { name: 'Porselen Kase',      icon: 'bowl',   baseLow:  50, baseHigh: 110, mulLow: 2.6, mulHigh: 4.6 },
  { name: 'Bronz Yağ Kandili',  icon: 'lamp',   baseLow:  70, baseHigh: 150, mulLow: 2.0, mulHigh: 3.6 },
  { name: 'Osmanlı Altın Lira', icon: 'coin',   baseLow: 200, baseHigh: 360, mulLow: 1.5, mulHigh: 2.4 },
  { name: 'Yağlı Boya Tablo',   icon: 'frame',  baseLow: 100, baseHigh: 220, mulLow: 2.2, mulHigh: 4.0 },
  { name: 'Anadolu Halısı',     icon: 'rug',    baseLow: 150, baseHigh: 280, mulLow: 1.9, mulHigh: 3.2 },
  { name: 'Pirinç Şamdan',      icon: 'candle', baseLow:  60, baseHigh: 130, mulLow: 2.3, mulHigh: 3.9 },
  { name: 'Lületaşı Pipo',      icon: 'pipe',   baseLow:  40, baseHigh:  90, mulLow: 2.8, mulHigh: 4.8 },
  { name: 'Sedef Kutu',         icon: 'box',    baseLow:  90, baseHigh: 180, mulLow: 2.0, mulHigh: 3.4 },
  { name: 'Hat Levhası',        icon: 'pen',    baseLow: 110, baseHigh: 210, mulLow: 2.1, mulHigh: 3.7 },
  { name: 'Telkâri Yüzük',      icon: 'ring',   baseLow:  70, baseHigh: 150, mulLow: 2.3, mulHigh: 4.0 },
  { name: 'Venedik Aynası',     icon: 'mirror', baseLow: 130, baseHigh: 250, mulLow: 1.8, mulHigh: 3.1 },
  { name: 'Sedef Ud',           icon: 'lute',   baseLow: 160, baseHigh: 300, mulLow: 1.7, mulHigh: 2.9 },
];

interface Item {
  name: string;
  icon: IconId;
  base: number;
  trueValue: number;
}

// ---- Async / state ----

const gen = createGenToken();
let state: State = 'idle';

let score = 0;
let best = 0;
let itemIdx = 0;
let items: Item[] = [];
let current: Item | null = null;
let currentBid = 0;
let bidsCount = 0;
let lastBidAt = 0;
let itemStartAt = 0;
let recentBids: number[] = [];

let bidTimerHandle: number | null = null;
let tickHandle: number | null = null;
let floaterTimerHandle: number | null = null;

// ---- DOM refs ----

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let itemCounterEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let itemIconEl!: HTMLElement;
let itemNameEl!: HTMLElement;
let itemFloorEl!: HTMLElement;

let bidValueEl!: HTMLElement;
let bidFloaterEl!: HTMLElement;
let bidHistoryEl!: HTMLElement;
let statusTextEl!: HTMLElement;

let excitementBarEl!: HTMLElement;
let roundBarFillEl!: HTMLElement;

let gavelBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayRestartEl!: HTMLButtonElement;

// ---- Helpers ----

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function buildItems(): Item[] {
  // Catalog'tan tekrarsız sıralamak için shuffle; gerekirse döngüye al.
  const pool = shuffle(CATALOG);
  const out: Item[] = [];
  for (let i = 0; i < ITEMS_PER_ROUND; i++) {
    const t = pool[i % pool.length]!;
    const base = roundTo(randRange(t.baseLow, t.baseHigh), 10);
    const mul = randRange(t.mulLow, t.mulHigh);
    const trueValue = roundTo(base * mul, 5);
    out.push({ name: t.name, icon: t.icon, base, trueValue });
  }
  return out;
}

// ---- Bid akışı ----

function nextBidInterval(): number {
  if (!current) return MAX_BID_INTERVAL_MS;
  const ratio = currentBid / current.trueValue;
  // Mean interval grows exponentially with ratio.
  //   ratio=0  → ~220ms
  //   ratio=0.7→ ~660ms
  //   ratio=1.0→ ~1500ms
  //   ratio=1.3→ ~3300ms
  const mean = 220 * Math.exp(2.5 * Math.max(0, ratio));
  // Exponential distribution sample for Poisson process.
  const u = Math.max(1e-6, Math.random());
  const dt = -Math.log(u) * mean;
  return Math.max(MIN_BID_INTERVAL_MS, Math.min(MAX_BID_INTERVAL_MS, dt));
}

function nextBidIncrement(): number {
  if (!current) return 5;
  const remaining = current.trueValue - currentBid;
  let inc: number;
  if (remaining > 0) {
    // Near start: bigger jumps; near peak: smaller jumps.
    const frac = randRange(0.06, 0.16);
    inc = Math.max(5, frac * Math.max(60, remaining));
  } else {
    // Overshoot: küçük artışlar
    inc = randRange(5, 18);
  }
  return Math.max(5, roundTo(inc, 5));
}

function scheduleBid(): void {
  if (state !== 'bidding') return;
  const tok = gen.current();
  const dt = nextBidInterval();
  bidTimerHandle = window.setTimeout(() => {
    if (!gen.isCurrent(tok)) return;
    if (state !== 'bidding') return;
    onBidArrive();
  }, dt);
}

function onBidArrive(): void {
  if (state !== 'bidding' || !current) return;
  const inc = nextBidIncrement();
  currentBid += inc;
  bidsCount++;
  recentBids.push(currentBid);
  if (recentBids.length > HISTORY_SHOWN + 2) recentBids.shift();
  lastBidAt = performance.now();
  renderBid();
  renderHistory();
  showFloater(inc);
  setExcitement(1);
  pulseBid();
  scheduleBid();
}

// ---- Tick loop ----

function startTick(): void {
  if (tickHandle !== null) cancelAnimationFrame(tickHandle);
  const tok = gen.current();
  const loop = (): void => {
    if (!gen.isCurrent(tok)) return;
    if (state !== 'bidding') return;
    const now = performance.now();
    const elapsed = now - itemStartAt;
    const sinceLast = now - lastBidAt;
    const excitement = Math.max(0, 1 - sinceLast / EXCITEMENT_DECAY_MS);
    setExcitement(excitement);
    renderRoundBar(elapsed / ITEM_TIME_MS);
    if (elapsed >= ITEM_TIME_MS) {
      autoCloseItem('timeout');
      return;
    }
    if (sinceLast > AUTO_CLOSE_QUIET_MS && bidsCount > 0) {
      autoCloseItem('quiet');
      return;
    }
    tickHandle = requestAnimationFrame(loop);
  };
  tickHandle = requestAnimationFrame(loop);
}

// ---- Round flow ----

function startItem(): void {
  current = items[itemIdx] ?? null;
  if (!current) {
    gameOver();
    return;
  }
  currentBid = current.base;
  bidsCount = 0;
  recentBids = [current.base];
  const now = performance.now();
  itemStartAt = now;
  lastBidAt = now;
  state = 'bidding';
  renderItemCard();
  renderBid();
  renderHistory();
  renderHud();
  renderStatus('Tellal başladı — tokmağı zirveye iyi vur!');
  gavelBtn.disabled = false;
  setExcitement(1);
  startTick();
  scheduleBid();
}

function onGavel(): void {
  if (state !== 'bidding') return;
  cancelTimers();
  state = 'closed';
  const sale = currentBid;
  score += sale;
  commitBest();
  gavelBtn.disabled = true;
  renderHud();
  renderStatus(`SATILDI! ${sale}₺ — komisyon cebine.`);
  pulseSold('sold');
  itemIdx++;
  scheduleNext();
}

function autoCloseItem(reason: 'timeout' | 'quiet'): void {
  if (state !== 'bidding') return;
  cancelTimers();
  state = 'closed';
  gavelBtn.disabled = true;
  if (bidsCount === 0) {
    renderStatus('Tek teklif gelmedi — satılamadı (0₺).');
    pulseSold('unsold');
  } else {
    const sale = Math.max(5, roundTo(currentBid * LATE_PENALTY_RATIO, 5));
    score += sale;
    commitBest();
    const why = reason === 'quiet'
      ? `Kalabalık dağıldı — yarı fiyatına: ${sale}₺.`
      : `Süre bitti — yarı fiyatına: ${sale}₺.`;
    renderStatus(why);
    pulseSold('late');
  }
  renderHud();
  itemIdx++;
  scheduleNext();
}

function scheduleNext(): void {
  const tok = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(tok)) return;
    if (state !== 'closed') return;
    if (itemIdx >= items.length) {
      gameOver();
    } else {
      startItem();
    }
  }, POST_SALE_DELAY_MS);
}

function gameOver(): void {
  cancelTimers();
  state = 'gameover';
  gavelBtn.disabled = true;
  showOverlay();
}

function cancelTimers(): void {
  if (bidTimerHandle !== null) {
    clearTimeout(bidTimerHandle);
    bidTimerHandle = null;
  }
  if (tickHandle !== null) {
    cancelAnimationFrame(tickHandle);
    tickHandle = null;
  }
  if (floaterTimerHandle !== null) {
    clearTimeout(floaterTimerHandle);
    floaterTimerHandle = null;
  }
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

// ---- Render ----

function renderHud(): void {
  scoreEl.textContent = `${score}₺`;
  bestEl.textContent = `${best}₺`;
  const shown = Math.min(itemIdx + 1, ITEMS_PER_ROUND);
  itemCounterEl.textContent = `${shown}/${ITEMS_PER_ROUND}`;
}

function renderItemCard(): void {
  if (!current) return;
  itemNameEl.textContent = current.name;
  itemFloorEl.textContent = `${current.base}₺`;
  itemIconEl.innerHTML = iconSvg(current.icon);
  // Reset card animation
  itemIconEl.classList.remove('item-card__icon--pop');
  void itemIconEl.offsetWidth;
  itemIconEl.classList.add('item-card__icon--pop');
}

function renderBid(): void {
  bidValueEl.textContent = `${currentBid}₺`;
}

function renderHistory(): void {
  bidHistoryEl.innerHTML = '';
  const shown = recentBids.slice(-HISTORY_SHOWN);
  if (shown.length === 0) return;
  let max = shown[0]!;
  let min = shown[0]!;
  for (const v of shown) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  const spread = Math.max(1, max - min);
  for (let i = 0; i < shown.length; i++) {
    const v = shown[i]!;
    const row = document.createElement('div');
    row.className = 'bid-history__row';
    const ratio = (v - min) / spread;
    row.style.setProperty('--ratio', (0.18 + ratio * 0.82).toFixed(3));
    if (i === shown.length - 1) row.classList.add('bid-history__row--latest');
    row.textContent = `${v}₺`;
    bidHistoryEl.appendChild(row);
  }
}

function renderStatus(text: string): void {
  statusTextEl.textContent = text;
}

function renderRoundBar(ratio: number): void {
  const r = Math.max(0, Math.min(1, 1 - ratio));
  roundBarFillEl.style.transform = `scaleX(${r.toFixed(4)})`;
  roundBarFillEl.classList.toggle('round-bar__fill--low', r < 0.34);
}

function setExcitement(v: number): void {
  const clamped = Math.max(0, Math.min(1, v));
  excitementBarEl.style.transform = `scaleY(${clamped.toFixed(4)})`;
  excitementBarEl.classList.toggle('excitement-bar--hot', clamped > 0.66);
  excitementBarEl.classList.toggle('excitement-bar--warm', clamped > 0.33 && clamped <= 0.66);
  excitementBarEl.classList.toggle('excitement-bar--cool', clamped <= 0.33);
}

function pulseBid(): void {
  bidValueEl.classList.remove('bid-value--pulse');
  void bidValueEl.offsetWidth;
  bidValueEl.classList.add('bid-value--pulse');
}

function pulseSold(kind: 'sold' | 'late' | 'unsold'): void {
  const cls = `bid-value--${kind}`;
  bidValueEl.classList.remove('bid-value--sold', 'bid-value--late', 'bid-value--unsold');
  void bidValueEl.offsetWidth;
  bidValueEl.classList.add(cls);
}

function showFloater(inc: number): void {
  bidFloaterEl.textContent = `+${inc}₺`;
  bidFloaterEl.classList.remove('bid-floater--show');
  void bidFloaterEl.offsetWidth;
  bidFloaterEl.classList.add('bid-floater--show');
  if (floaterTimerHandle !== null) clearTimeout(floaterTimerHandle);
  const tok = gen.current();
  floaterTimerHandle = window.setTimeout(() => {
    if (!gen.isCurrent(tok)) return;
    bidFloaterEl.classList.remove('bid-floater--show');
    floaterTimerHandle = null;
  }, 720);
}

// ---- Overlay ----

function showOverlay(): void {
  const isRecord = score > 0 && score >= best;
  overlayTitleEl.textContent = isRecord ? 'Yeni rekor!' : 'Vardiya bitti';
  overlayMsgEl.textContent = `Toplam: ${score}₺\nEn iyi: ${best}₺`;
  overlayEl.classList.remove('overlay--hidden');
  overlayEl.setAttribute('aria-hidden', 'false');
  try {
    overlayRestartEl.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function hideOverlay(): void {
  overlayEl.classList.add('overlay--hidden');
  overlayEl.setAttribute('aria-hidden', 'true');
}

// ---- Reset ----

function reset(): void {
  gen.bump();
  cancelTimers();
  hideOverlay();
  score = 0;
  itemIdx = 0;
  bidsCount = 0;
  currentBid = 0;
  recentBids = [];
  current = null;
  items = buildItems();
  state = 'idle';
  renderHud();
  renderRoundBar(0);
  setExcitement(1);
  startItem();
}

// ---- Icons ----

function iconSvg(id: IconId): string {
  // Tek-renkli (currentColor) minimal SVG'ler — kart üstünde kategori ipucu.
  switch (id) {
    case 'vase':
      return svgPath('M22 5h16v8c4 4 6 9 6 16s-2 14-6 18l-2 8H24l-2-8c-4-4-6-11-6-18s2-12 6-16z');
    case 'clock':
      return `<svg viewBox="0 0 60 60" class="iconlet"><circle cx="30" cy="30" r="22" fill="none" stroke="currentColor" stroke-width="3"/><path d="M30 14v17l10 6" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
    case 'tray':
      return svgPath('M6 24h48c1 0 2 1 2 2v3c0 1-1 2-2 2H6c-1 0-2-1-2-2v-3c0-1 1-2 2-2zm6 9h36v4l-2 6H14l-2-6z');
    case 'bowl':
      return svgPath('M8 22h44c0 12-10 22-22 22S8 34 8 22zm0-2c0-1 1-2 2-2h40c1 0 2 1 2 2z');
    case 'lamp':
      return svgPath('M30 6c2 0 4 2 4 4v3h10c2 0 3 3 1 5l-9 8c1 9-4 18-13 22-2 1-3-1-2-2 7-3 11-10 11-18l-9-9c-2-2-1-5 1-5h10v-4c0-2 2-4 4-4z');
    case 'coin':
      return `<svg viewBox="0 0 60 60" class="iconlet"><circle cx="30" cy="30" r="22" fill="currentColor"/><text x="30" y="38" font-family="Georgia" font-weight="700" font-size="22" text-anchor="middle" fill="#0b0c10">₺</text></svg>`;
    case 'frame':
      return svgPath('M8 10h44c1 0 2 1 2 2v36c0 1-1 2-2 2H8c-1 0-2-1-2-2V12c0-1 1-2 2-2zm4 4v32h36V14H12zm4 4h28v12L34 24l-8 8-4-4-6 8V18z');
    case 'rug':
      return svgPath('M5 18h50v3l-3 2v18l3 2v3H5v-3l3-2V23l-3-2zM12 23v18h36V23zm6 4h24v4H18zm0 7h24v4H18z');
    case 'candle':
      return svgPath('M30 6c2 3 5 5 5 9s-2 5-5 5-5-1-5-5 3-6 5-9zm-6 18h12v25c0 2-1 3-3 3h-6c-2 0-3-1-3-3z');
    case 'pipe':
      return svgPath('M5 30c0-8 6-14 14-14h26c5 0 9 4 9 9s-4 9-9 9h-7v6c0 6-5 11-11 11s-11-5-11-11v-3c-6-1-11-3-11-7z');
    case 'box':
      return svgPath('M8 16h44v8H8zm2 10h40v22c0 1-1 2-2 2H12c-1 0-2-1-2-2zm16-2h8v6h-8z');
    case 'pen':
      return svgPath('M8 10h44c1 0 2 1 2 2v36c0 1-1 2-2 2H8c-1 0-2-1-2-2V12c0-1 1-2 2-2zm4 4v32h36V14zm4 5h28v3H16zm0 8h22v3H16zm0 8h26v3H16zm0 8h18v3H16z');
    case 'ring':
      return `<svg viewBox="0 0 60 60" class="iconlet"><circle cx="30" cy="36" r="16" fill="none" stroke="currentColor" stroke-width="5"/><path d="M22 18l8-10 8 10z" fill="currentColor"/></svg>`;
    case 'mirror':
      return svgPath('M30 4c10 0 18 9 18 20s-8 20-18 20-18-9-18-20S20 4 30 4zm0 4c-7 0-14 7-14 16s7 16 14 16 14-7 14-16-7-16-14-16zm-2 38h4v8h6v4H22v-4h6z');
    case 'lute':
      return svgPath('M40 6l8 8-6 6 4 4-6 6c4 6 2 14-4 18-7 5-17 3-22-2-5-5-7-15-2-22 4-6 12-8 18-4l6-6 4 4 6-6z');
  }
}

function svgPath(d: string): string {
  return `<svg viewBox="0 0 60 60" class="iconlet"><path d="${d}" fill="currentColor"/></svg>`;
}

// ---- Input ----

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'Enter' || k === 'Spacebar') {
    if (state === 'bidding') {
      onGavel();
      e.preventDefault();
      return;
    }
    if (state === 'gameover') {
      reset();
      e.preventDefault();
      return;
    }
    // closed durumunda Space yutulur (next item otomatik gelir)
    if (state === 'closed') {
      e.preventDefault();
    }
  }
}

// ---- Init ----

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  itemCounterEl = document.querySelector<HTMLElement>('#item-counter')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  itemIconEl = document.querySelector<HTMLElement>('#item-icon')!;
  itemNameEl = document.querySelector<HTMLElement>('#item-name')!;
  itemFloorEl = document.querySelector<HTMLElement>('#item-floor')!;

  bidValueEl = document.querySelector<HTMLElement>('#bid-value')!;
  bidFloaterEl = document.querySelector<HTMLElement>('#bid-floater')!;
  bidHistoryEl = document.querySelector<HTMLElement>('#bid-history')!;
  statusTextEl = document.querySelector<HTMLElement>('#status-text')!;

  excitementBarEl = document.querySelector<HTMLElement>('#excitement-bar')!;
  roundBarFillEl = document.querySelector<HTMLElement>('#round-bar-fill')!;

  gavelBtn = document.querySelector<HTMLButtonElement>('#gavel')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestartEl = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  gavelBtn.addEventListener('click', () => {
    if (state === 'bidding') onGavel();
  });
  restartBtn.addEventListener('click', reset);
  overlayRestartEl.addEventListener('click', reset);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
