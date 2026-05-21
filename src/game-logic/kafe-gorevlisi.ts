import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

type State = 'ready' | 'showing' | 'waiting' | 'gameover';

interface Drink {
  id: string;
  emoji: string;
  label: string;
}

const DRINKS: Drink[] = [
  { id: 'kahve',     emoji: '☕', label: 'Kahve' },
  { id: 'cay',       emoji: '🍵', label: 'Çay' },
  { id: 'kola',      emoji: '🥤', label: 'Kola' },
  { id: 'meyvesuyu', emoji: '🧃', label: 'Meyve Suyu' },
  { id: 'su',        emoji: '💧', label: 'Su' },
  { id: 'limonata',  emoji: '🍋', label: 'Limonata' },
];

const SHOW_DURATION_MS = 2500;
const MAX_LIVES = 3;
const STORAGE_KEY = 'kafe-gorevlisi.best';

let state: State = 'ready';
let order: Drink[] = [];
let tray: Drink[] = [];
let score = 0;
let best = 0;
let lives = MAX_LIVES;
let orderLength = 1;
let showTimer: ReturnType<typeof setTimeout> | null = null;

let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let life1!: HTMLElement;
let life2!: HTMLElement;
let life3!: HTMLElement;
let orderItems!: HTMLElement;
let orderLabel!: HTMLElement;
let trayItems!: HTMLElement;
let submitBtn!: HTMLButtonElement;
let undoBtn!: HTMLButtonElement;
let kafeWrap!: HTMLElement;
let drinkBtns!: NodeListOf<HTMLButtonElement>;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function updateLives(): void {
  [life1, life2, life3].forEach((el, i) => {
    el.style.opacity = i < lives ? '1' : '0.2';
  });
}

function getDrink(id: string): Drink {
  return DRINKS.find((d) => d.id === id)!;
}

function randomOrder(length: number): Drink[] {
  const result: Drink[] = [];
  for (let i = 0; i < length; i++) {
    result.push(DRINKS[Math.floor(Math.random() * DRINKS.length)]!);
  }
  return result;
}

function renderOrderItems(visible: boolean): void {
  orderItems.innerHTML = '';
  order.forEach((d) => {
    const span = document.createElement('span');
    span.className = 'order-item' + (visible ? ' visible' : '');
    span.textContent = d.emoji;
    span.title = d.label;
    orderItems.appendChild(span);
  });
}

function renderTray(): void {
  trayItems.innerHTML = '';
  for (let i = 0; i < orderLength; i++) {
    const span = document.createElement('span');
    span.className = 'tray-item' + (i < tray.length ? ' filled' : '');
    span.textContent = i < tray.length ? tray[i]!.emoji : '';
    trayItems.appendChild(span);
  }
  submitBtn.disabled = tray.length !== orderLength;
  undoBtn.disabled = tray.length === 0;
}

function setDrinkBtnsEnabled(enabled: boolean): void {
  drinkBtns.forEach((btn) => { btn.disabled = !enabled; });
}

function startNewOrder(): void {
  order = randomOrder(orderLength);
  tray = [];
  state = 'showing';
  orderLabel.textContent = `Sipariş (${orderLength} içecek) — ezberle!`;
  renderOrderItems(true);
  renderTray();
  setDrinkBtnsEnabled(false);

  if (showTimer !== null) clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    orderLabel.textContent = 'Sipariş gizlendi — şimdi hazırla!';
    renderOrderItems(false);
    state = 'waiting';
    setDrinkBtnsEnabled(true);
  }, SHOW_DURATION_MS);
}

function flashWrap(type: 'ok' | 'err'): void {
  const cls = type === 'ok' ? 'flash-ok' : 'flash-err';
  kafeWrap.classList.remove('flash-ok', 'flash-err');
  void kafeWrap.offsetWidth;
  kafeWrap.classList.add(cls);
  setTimeout(() => kafeWrap.classList.remove(cls), 400);
}

function submitOrder(): void {
  if (state !== 'waiting') return;
  const correct = tray.every((d, i) => d.id === order[i]!.id);
  if (correct) {
    score++;
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      safeWrite(STORAGE_KEY, best);
    }
    orderLength = Math.min(orderLength + 1, 6);
    flashWrap('ok');
    setTimeout(() => startNewOrder(), 600);
  } else {
    lives--;
    updateLives();
    orderLength = Math.max(1, orderLength - 1);
    flashWrap('err');
    renderOrderItems(true);
    orderLabel.textContent = 'Yanlış! Doğru sipariş:';
    if (lives <= 0) {
      state = 'gameover';
      if (showTimer !== null) clearTimeout(showTimer);
      setDrinkBtnsEnabled(false);
      setTimeout(() => {
        showOverlay('Bitti!', `Skor: ${score} · R ile yeniden başla`);
      }, 1200);
    } else {
      state = 'showing';
      setDrinkBtnsEnabled(false);
      setTimeout(() => startNewOrder(), 1800);
    }
  }
}

function reset(): void {
  if (showTimer !== null) clearTimeout(showTimer);
  state = 'ready';
  order = [];
  tray = [];
  score = 0;
  lives = MAX_LIVES;
  orderLength = 1;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  updateLives();
  orderLabel.textContent = 'Sipariş bekleniyor…';
  orderItems.innerHTML = '';
  renderTray();
  setDrinkBtnsEnabled(false);
  hideOverlay();
  showOverlay('Kafe Görevlisi', 'Müşteri siparişini ezberle ve doğru sırayla hazırla.\nBaşlamak için aşağıdan bir içecek seç.');
}

function init(): void {
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  life1 = document.querySelector<HTMLElement>('#life-1')!;
  life2 = document.querySelector<HTMLElement>('#life-2')!;
  life3 = document.querySelector<HTMLElement>('#life-3')!;
  orderItems = document.querySelector<HTMLElement>('#order-items')!;
  orderLabel = document.querySelector<HTMLElement>('#order-label')!;
  trayItems = document.querySelector<HTMLElement>('#tray-items')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#submit-btn')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo-btn')!;
  kafeWrap = document.querySelector<HTMLElement>('#kafe-wrap')!;
  drinkBtns = document.querySelectorAll<HTMLButtonElement>('.drink-btn');

  best = safeRead<number>(STORAGE_KEY, 0);

  drinkBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state === 'ready') {
        hideOverlay();
        startNewOrder();
        return;
      }
      if (state !== 'waiting') return;
      if (tray.length >= orderLength) return;
      const drink = getDrink(btn.dataset.drink!);
      if (!drink) return;
      tray.push(drink);
      renderTray();
    });
  });

  submitBtn.addEventListener('click', submitOrder);

  undoBtn.addEventListener('click', () => {
    if (state !== 'waiting' || tray.length === 0) return;
    tray.pop();
    renderTray();
  });

  restartBtn.addEventListener('click', reset);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (state === 'waiting' && tray.length > 0) {
        tray.pop();
        renderTray();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state === 'waiting' && tray.length === orderLength) submitOrder();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      reset();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
