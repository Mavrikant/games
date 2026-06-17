import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Para Üstü — cashier's-change game. A customer hands over a banknote, you
// click denominations to assemble the exact change in your tray, then submit.
// Each correct customer scores 1 + a bonus for using the minimum-piece change;
// wrong amount or running out of patience burns a life.
//
// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite for the best.
// - stale-async-callback: gen.bump() in reset() cancels the patience timer.
// - overlay-input-leak: explicit `state` enum; every handler bails early.
// - module-level-dom-access: all queries and listeners live in init().
// - missing-overlay-css: para-ustu.css ships .overlay--hidden { opacity:0 }.

const STORAGE_BEST = 'para-ustu.best';

type State = 'ready' | 'playing' | 'gameover';

// Cents — keep math integer to dodge floating-point drift on 0,25 / 0,50.
const DENOMS = [25, 50, 100, 500, 1000, 2000, 5000, 10000] as const;
type Denom = (typeof DENOMS)[number];

const PAID_NOTES = [500, 1000, 2000, 5000, 10000, 20000] as const; // 5,10,20,50,100,200 TL

interface ItemSpec {
  name: string;
  emoji: string;
  minPrice: number;
  maxPrice: number;
}

const ITEMS: readonly ItemSpec[] = [
  { name: 'ekmek', emoji: '🥖', minPrice: 500, maxPrice: 1500 },
  { name: 'süt', emoji: '🥛', minPrice: 1500, maxPrice: 3500 },
  { name: 'peynir', emoji: '🧀', minPrice: 3500, maxPrice: 8000 },
  { name: 'elma', emoji: '🍎', minPrice: 1000, maxPrice: 2500 },
  { name: 'çikolata', emoji: '🍫', minPrice: 2000, maxPrice: 5000 },
  { name: 'simit', emoji: '🥯', minPrice: 750, maxPrice: 1500 },
  { name: 'çay', emoji: '🍵', minPrice: 500, maxPrice: 1500 },
  { name: 'gazoz', emoji: '🥤', minPrice: 1500, maxPrice: 4000 },
  { name: 'sakız', emoji: '🍬', minPrice: 250, maxPrice: 750 },
  { name: 'kahve', emoji: '☕', minPrice: 3000, maxPrice: 7500 },
  { name: 'kek', emoji: '🧁', minPrice: 2000, maxPrice: 4500 },
  { name: 'yumurta', emoji: '🥚', minPrice: 2500, maxPrice: 5000 },
];

const HAPPY_FACES = ['🙂', '😊', '😎', '🤓', '🙃', '😌'];

interface Customer {
  items: { name: string; emoji: string; price: number }[];
  total: number; // cents
  paid: number; // cents
  change: number; // cents
  optimalPieces: number;
  patienceMs: number; // total per-customer patience
  startedAt: number;
  face: string;
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let lives = 3;
let customer: Customer | null = null;
let tray: Denom[] = [];
let trayTotal = 0; // cents
let rafId: number | null = null;
let customersServed = 0;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let avatarEl!: HTMLElement;
let itemsEl!: HTMLElement;
let totalEl!: HTMLElement;
let paidEl!: HTMLElement;
let changeEl!: HTMLElement;
let patienceFill!: HTMLElement;
let trayItemsEl!: HTMLElement;
let trayTotalEl!: HTMLElement;
let denomsEl!: HTMLElement;
let clearBtn!: HTMLButtonElement;
let submitBtn!: HTMLButtonElement;
let customerCard!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayAction!: HTMLButtonElement;

function fmtTL(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const lira = Math.floor(abs / 100);
  const kurus = abs % 100;
  if (kurus === 0) return `${sign}${lira} ₺`;
  return `${sign}${lira},${kurus.toString().padStart(2, '0')} ₺`;
}

function denomLabel(d: Denom): { value: string; kind: string } {
  if (d < 100) return { value: `${d} kr`, kind: 'metal' };
  return { value: `${d / 100} ₺`, kind: d >= 500 ? 'banknot' : 'metal' };
}

// Greedy works for our denomination set (each next bigger denom is an
// integer multiple of the previous one, so greedy is optimal).
function minPieces(amount: number): number {
  let remaining = amount;
  let count = 0;
  for (let i = DENOMS.length - 1; i >= 0; i--) {
    const d = DENOMS[i]!;
    while (remaining >= d) {
      remaining -= d;
      count++;
    }
  }
  return count;
}

function pickItem(): { name: string; emoji: string; price: number } {
  const spec = ITEMS[Math.floor(Math.random() * ITEMS.length)]!;
  const span = spec.maxPrice - spec.minPrice;
  // Snap to 25kr to keep totals readable and reachable with our denoms.
  const raw = spec.minPrice + Math.floor(Math.random() * (span + 1));
  const price = Math.max(25, Math.round(raw / 25) * 25);
  return { name: spec.name, emoji: spec.emoji, price };
}

function pickPaid(total: number): number {
  // Choose the smallest banknote at least 1 lira above the total — but
  // sometimes bump up to the next note for variety / harder change.
  const eligible = PAID_NOTES.filter((n) => n > total + 50);
  if (eligible.length === 0) return PAID_NOTES[PAID_NOTES.length - 1]!;
  const tier = Math.min(eligible.length - 1, Math.floor(Math.random() * 2));
  return eligible[tier]!;
}

function makeCustomer(): Customer {
  const itemCount = 1 + Math.floor(Math.random() * 3); // 1..3 items
  const items: { name: string; emoji: string; price: number }[] = [];
  let total = 0;
  for (let i = 0; i < itemCount; i++) {
    const it = pickItem();
    items.push(it);
    total += it.price;
  }
  const paid = pickPaid(total);
  const change = paid - total;
  const optimalPieces = minPieces(change);

  // Patience decays as the player advances: starts generous, tightens later.
  const tier = Math.min(customersServed, 12);
  const patienceMs = 22000 - tier * 1100; // 22s → ~9s

  return {
    items,
    total,
    paid,
    change,
    optimalPieces,
    patienceMs,
    startedAt: performance.now(),
    face: HAPPY_FACES[Math.floor(Math.random() * HAPPY_FACES.length)]!,
  };
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = String(lives);
}

function renderCustomer(): void {
  if (!customer) {
    avatarEl.textContent = '🙂';
    itemsEl.textContent = 'Müşteri bekleniyor…';
    totalEl.textContent = fmtTL(0);
    paidEl.textContent = fmtTL(0);
    changeEl.textContent = fmtTL(0);
    return;
  }
  avatarEl.textContent = customer.face;
  itemsEl.innerHTML = customer.items
    .map(
      (it) =>
        `<span class="pu-item">${it.emoji} ${it.name} <strong>${fmtTL(it.price)}</strong></span>`,
    )
    .join(' · ');
  totalEl.textContent = fmtTL(customer.total);
  paidEl.textContent = fmtTL(customer.paid);
  changeEl.textContent = fmtTL(customer.change);
}

function renderTray(): void {
  trayTotalEl.textContent = fmtTL(trayTotal);
  if (tray.length === 0) {
    trayItemsEl.innerHTML =
      '<span class="pu-chip pu-chip--empty">Kupürleri buraya ekleyin</span>';
    return;
  }
  trayItemsEl.innerHTML = tray
    .map((d, i) => {
      const lbl = denomLabel(d).value;
      return `<button type="button" class="pu-chip" data-tray-idx="${i}" aria-label="${lbl} kaldır">${lbl} ×</button>`;
    })
    .join('');
}

function renderDenoms(): void {
  // Stable layout; built once in init().
  denomsEl.innerHTML = DENOMS.map((d) => {
    const { value, kind } = denomLabel(d);
    return `<button type="button" class="pu-denom" data-denom="${d}" aria-label="${value} ekle">${value}<span class="pu-denom__kind">${kind}</span></button>`;
  }).join('');
}

function updatePatience(): void {
  if (!customer || state !== 'playing') {
    patienceFill.style.transform = 'scaleX(1)';
    return;
  }
  const elapsed = performance.now() - customer.startedAt;
  const remaining = Math.max(0, 1 - elapsed / customer.patienceMs);
  patienceFill.style.transform = `scaleX(${remaining})`;
  if (remaining <= 0) {
    handleTimeout();
  }
}

function loop(): void {
  if (state !== 'playing') {
    rafId = null;
    return;
  }
  updatePatience();
  // updatePatience() may have transitioned us to gameover via timeout — only
  // schedule the next frame if we're still playing.
  if (state !== 'playing') {
    rafId = null;
    return;
  }
  rafId = requestAnimationFrame(loop);
}

function startLoop(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function flash(className: 'pu-customer--good' | 'pu-customer--bad'): void {
  customerCard.classList.remove('pu-customer--good', 'pu-customer--bad');
  // Force reflow so the animation re-plays on rapid repeats.
  void customerCard.offsetWidth;
  customerCard.classList.add(className);
}

function addDenom(d: Denom): void {
  if (state !== 'playing') return;
  tray.push(d);
  trayTotal += d;
  renderTray();
}

function removeAtTray(idx: number): void {
  if (state !== 'playing') return;
  const removed = tray[idx];
  if (removed === undefined) return;
  tray.splice(idx, 1);
  trayTotal -= removed;
  renderTray();
}

function clearTray(): void {
  if (state !== 'playing') return;
  tray = [];
  trayTotal = 0;
  renderTray();
}

function nextCustomer(): void {
  customersServed++;
  customer = makeCustomer();
  tray = [];
  trayTotal = 0;
  renderCustomer();
  renderTray();
  updatePatience();
}

function handleSubmit(): void {
  if (state !== 'playing' || !customer) return;
  if (trayTotal !== customer.change) {
    // Wrong amount: lose a life, keep customer (they're patient enough to retry
    // unless patience runs out).
    lives--;
    updateHud();
    flash('pu-customer--bad');
    if (lives <= 0) {
      gameOver('Hesap tutmadı.');
      return;
    }
    // Clear the wrong attempt so they can recount.
    tray = [];
    trayTotal = 0;
    renderTray();
    return;
  }
  // Correct change.
  let earned = 1;
  if (tray.length === customer.optimalPieces) earned = 2; // perfect bonus
  score += earned;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  flash('pu-customer--good');
  nextCustomer();
}

function handleTimeout(): void {
  if (state !== 'playing' || !customer) return;
  lives--;
  updateHud();
  flash('pu-customer--bad');
  if (lives <= 0) {
    gameOver('Müşteri sabrı tükendi.');
    return;
  }
  nextCustomer();
}

function showOverlay(title: string, msg: string, action: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayAction.textContent = action;
  showOverlayEl(overlay);
}

function gameOver(reason: string): void {
  state = 'gameover';
  stopLoop();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  showOverlay(
    'Bitti!',
    `${reason}\nServis ettiğin müşteri: ${customersServed - 1}\nSkor: ${score} · Rekor: ${best}`,
    'Yeniden başla',
  );
}

function startGame(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  lives = 3;
  customersServed = 0;
  tray = [];
  trayTotal = 0;
  updateHud();
  nextCustomer();
  hideOverlayEl(overlay);
  startLoop();
}

function resetToReady(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  score = 0;
  lives = 3;
  customersServed = 0;
  customer = null;
  tray = [];
  trayTotal = 0;
  updateHud();
  renderCustomer();
  renderTray();
  patienceFill.style.transform = 'scaleX(1)';
  showOverlay(
    'Para Üstü',
    'Kasiyer ol. Müşteri parayı uzattıktan sonra altta toplam ile verilen arasındaki para üstünü en az kupürle çekmeceye ekleyip onayla. Üç canın var.',
    'Başla',
  );
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    resetToReady();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === 'enter' || k === ' ' || k === 'spacebar') {
      startGame();
      e.preventDefault();
    }
    return;
  }
  // playing
  if (k === 'enter') {
    handleSubmit();
    e.preventDefault();
  } else if (k === 'backspace') {
    if (tray.length > 0) {
      removeAtTray(tray.length - 1);
      e.preventDefault();
    }
  } else if (k === 'escape') {
    clearTray();
    e.preventDefault();
  } else if (/^[1-8]$/.test(k)) {
    const idx = Number(k) - 1;
    const d = DENOMS[idx];
    if (d !== undefined) {
      addDenom(d);
      e.preventDefault();
    }
  }
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  avatarEl = document.querySelector<HTMLElement>('#pu-avatar')!;
  itemsEl = document.querySelector<HTMLElement>('#pu-items')!;
  totalEl = document.querySelector<HTMLElement>('#pu-total')!;
  paidEl = document.querySelector<HTMLElement>('#pu-paid')!;
  changeEl = document.querySelector<HTMLElement>('#pu-change')!;
  patienceFill = document.querySelector<HTMLElement>('#pu-patience')!;
  trayItemsEl = document.querySelector<HTMLElement>('#pu-tray')!;
  trayTotalEl = document.querySelector<HTMLElement>('#pu-tray-total')!;
  denomsEl = document.querySelector<HTMLElement>('#pu-denoms')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#pu-clear')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#pu-submit')!;
  customerCard = document.querySelector<HTMLElement>('.pu-customer')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayAction = document.querySelector<HTMLButtonElement>('#overlay-action')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  renderDenoms();

  denomsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-denom]');
    if (!btn) return;
    const v = Number(btn.dataset.denom);
    if (!Number.isFinite(v)) return;
    addDenom(v as Denom);
  });

  trayItemsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tray-idx]');
    if (!btn) return;
    const idx = Number(btn.dataset.trayIdx);
    if (Number.isFinite(idx)) removeAtTray(idx);
  });

  clearBtn.addEventListener('click', clearTray);
  submitBtn.addEventListener('click', handleSubmit);
  overlayAction.addEventListener('click', startGame);
  restartBtn.addEventListener('click', resetToReady);

  window.addEventListener('keydown', onKey);

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
