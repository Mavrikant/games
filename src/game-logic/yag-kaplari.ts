import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

interface Level {
  caps: number[];
  target: number;
}

const LEVELS: readonly Level[] = [
  { caps: [5, 3], target: 4 },
  { caps: [8, 5], target: 6 },
  { caps: [9, 4], target: 6 },
  { caps: [8, 5, 3], target: 4 },
  { caps: [10, 7, 3], target: 5 },
  { caps: [12, 8, 5], target: 6 },
  { caps: [9, 7, 4], target: 6 },
  { caps: [15, 11, 6], target: 8 },
];

const STORAGE_BEST = 'yag-kaplari.best';
const SCORE_DESC = {
  gameId: 'yag-kaplari',
  storageKey: STORAGE_BEST,
  direction: 'lower' as const,
};

type State = 'playing' | 'level-won' | 'complete';

let levelIdx = 0;
let amounts: number[] = [];
let moves = 0;
let totalMoves = 0;
let selected: number | null = null;
let state: State = 'playing';
let best: number | null = null;

let levelEl!: HTMLElement;
let movesEl!: HTMLElement;
let totalEl!: HTMLElement;
let bestEl!: HTMLElement;
let goalEl!: HTMLElement;
let hintEl!: HTMLElement;
let jugsEl!: HTMLElement;
let resetLevelBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function currentLevel(): Level {
  return LEVELS[levelIdx]!;
}

function formatBest(): string {
  return best === null ? '—' : String(best);
}

function updateHud(): void {
  levelEl.textContent = `${levelIdx + 1} / ${LEVELS.length}`;
  movesEl.textContent = String(moves);
  totalEl.textContent = String(totalMoves);
  bestEl.textContent = formatBest();
  goalEl.textContent = String(currentLevel().target);
}

function setHint(text: string): void {
  hintEl.textContent = text;
}

function buildJugs(): void {
  const lvl = currentLevel();
  jugsEl.innerHTML = '';
  lvl.caps.forEach((cap, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'yk-jug';
    wrap.dataset['idx'] = String(i);

    const body = document.createElement('button');
    body.className = 'yk-jug__body';
    body.type = 'button';
    body.setAttribute(
      'aria-label',
      `Kap ${i + 1}, kapasite ${cap} litre`,
    );

    const fill = document.createElement('div');
    fill.className = 'yk-jug__fill';
    body.appendChild(fill);

    const cap_label = document.createElement('div');
    cap_label.className = 'yk-jug__cap';
    cap_label.textContent = `${cap}L`;
    body.appendChild(cap_label);

    const amount = document.createElement('div');
    amount.className = 'yk-jug__amount';
    amount.textContent = '0';
    body.appendChild(amount);

    body.addEventListener('click', () => onJugClick(i));

    wrap.appendChild(body);

    const btnRow = document.createElement('div');
    btnRow.className = 'yk-jug__btns';

    const fillBtn = document.createElement('button');
    fillBtn.className = 'yk-jug__btn';
    fillBtn.type = 'button';
    fillBtn.textContent = 'Doldur';
    fillBtn.addEventListener('click', () => doFill(i));
    btnRow.appendChild(fillBtn);

    const emptyBtn = document.createElement('button');
    emptyBtn.className = 'yk-jug__btn';
    emptyBtn.type = 'button';
    emptyBtn.textContent = 'Boşalt';
    emptyBtn.addEventListener('click', () => doEmpty(i));
    btnRow.appendChild(emptyBtn);

    wrap.appendChild(btnRow);

    jugsEl.appendChild(wrap);
  });
  paintJugs();
}

function paintJugs(): void {
  const lvl = currentLevel();
  const wraps = jugsEl.querySelectorAll<HTMLElement>('.yk-jug');
  wraps.forEach((wrap, i) => {
    const cap = lvl.caps[i]!;
    const amt = amounts[i]!;
    const body = wrap.querySelector<HTMLElement>('.yk-jug__body')!;
    const fill = wrap.querySelector<HTMLElement>('.yk-jug__fill')!;
    const amount = wrap.querySelector<HTMLElement>('.yk-jug__amount')!;
    const pct = cap === 0 ? 0 : (amt / cap) * 100;
    fill.style.height = `${pct}%`;
    amount.textContent = String(amt);
    body.classList.toggle('yk-jug__body--selected', selected === i);
    body.classList.toggle('yk-jug__body--target', amt === lvl.target);
  });
}

function loadLevel(idx: number): void {
  levelIdx = idx;
  const lvl = currentLevel();
  amounts = lvl.caps.map(() => 0);
  moves = 0;
  selected = null;
  state = 'playing';
  buildJugs();
  updateHud();
  setHint(
    `Hedef ${lvl.target} L — kapları ${lvl.caps.join('L, ')}L. Bir kabı seç → diğerine tıkla.`,
  );
}

function recordMove(): void {
  moves++;
  totalMoves++;
  updateHud();
  paintJugs();
  checkWin();
}

function checkWin(): void {
  if (state !== 'playing') return;
  const t = currentLevel().target;
  if (amounts.some((a) => a === t)) {
    state = 'level-won';
    selected = null;
    paintJugs();
    onLevelWin();
  }
}

function onLevelWin(): void {
  const isLast = levelIdx + 1 >= LEVELS.length;
  if (isLast) {
    state = 'complete';
    let bestText = '';
    if (best === null || totalMoves < best) {
      best = totalMoves;
      safeWrite(STORAGE_BEST, best);
      bestText = ' (Yeni rekor!)';
    }
    updateHud();
    reportGameOver(SCORE_DESC, totalMoves, { label: 'Toplam Hamle', unit: 'hamle' });
    showOverlay(
      'Tebrikler!',
      `Sekiz seviyenin tamamını ${totalMoves} hamlede bitirdin.${bestText}\nDaha az hamleyle tekrar denemek için Baştan'a bas.`,
      'Baştan',
    );
  } else {
    showOverlay(
      `Seviye ${levelIdx + 1} ✓`,
      `Bu seviyeyi ${moves} hamlede çözdün.\nToplam: ${totalMoves} hamle.`,
      'Sonraki',
    );
  }
}

function doFill(i: number): void {
  if (state !== 'playing') return;
  const cap = currentLevel().caps[i]!;
  if (amounts[i] === cap) {
    setHint('Bu kap zaten dolu.');
    return;
  }
  amounts[i] = cap;
  selected = null;
  recordMove();
  setHint(`${cap}L kabını doldurdun.`);
}

function doEmpty(i: number): void {
  if (state !== 'playing') return;
  if (amounts[i] === 0) {
    setHint('Bu kap zaten boş.');
    return;
  }
  amounts[i] = 0;
  selected = null;
  recordMove();
  setHint(`${currentLevel().caps[i]}L kabını boşalttın.`);
}

function doPour(from: number, to: number): void {
  if (state !== 'playing') return;
  if (from === to) return;
  const caps = currentLevel().caps;
  const space = caps[to]! - amounts[to]!;
  const flow = Math.min(amounts[from]!, space);
  if (flow === 0) {
    setHint(
      amounts[from] === 0
        ? `${caps[from]}L kabı zaten boş.`
        : `${caps[to]}L kabı zaten dolu.`,
    );
    selected = null;
    paintJugs();
    return;
  }
  amounts[from]! -= flow;
  amounts[to]! += flow;
  selected = null;
  recordMove();
  setHint(`${caps[from]}L → ${caps[to]}L: ${flow}L aktarıldı.`);
}

function onJugClick(i: number): void {
  if (state !== 'playing') {
    return;
  }
  if (selected === null) {
    if (amounts[i] === 0) {
      setHint('Boş kaptan aktarım yapılamaz — önce doldur.');
      return;
    }
    selected = i;
    paintJugs();
    setHint(`${currentLevel().caps[i]}L kabı seçildi. Hedef kaba tıkla.`);
  } else if (selected === i) {
    selected = null;
    paintJugs();
    setHint('Seçim iptal.');
  } else {
    doPour(selected, i);
  }
}

function showOverlay(title: string, msg: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnLabel;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function onOverlayBtn(): void {
  if (state === 'complete') {
    restart();
  } else if (state === 'level-won') {
    loadLevel(levelIdx + 1);
    hideOverlay();
  }
}

function resetCurrentLevel(): void {
  if (state === 'complete') return;
  const lvl = currentLevel();
  totalMoves -= moves;
  amounts = lvl.caps.map(() => 0);
  moves = 0;
  selected = null;
  state = 'playing';
  hideOverlay();
  paintJugs();
  updateHud();
  setHint('Seviye sıfırlandı.');
}

function restart(): void {
  totalMoves = 0;
  loadLevel(0);
  hideOverlay();
}

function reset(): void {
  restart();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    resetCurrentLevel();
    e.preventDefault();
  } else if (k === 'escape') {
    if (selected !== null) {
      selected = null;
      paintJugs();
      setHint('Seçim iptal.');
      e.preventDefault();
    }
  } else if (k === 'enter' || k === ' ') {
    if (state === 'level-won' || state === 'complete') {
      onOverlayBtn();
      e.preventDefault();
    }
  } else if (k >= '1' && k <= '9') {
    const idx = parseInt(k, 10) - 1;
    if (idx < currentLevel().caps.length) {
      onJugClick(idx);
      e.preventDefault();
    }
  }
}

function init(): void {
  levelEl = document.querySelector<HTMLElement>('#level')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  totalEl = document.querySelector<HTMLElement>('#total')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  goalEl = document.querySelector<HTMLElement>('#goal')!;
  hintEl = document.querySelector<HTMLElement>('#hint')!;
  jugsEl = document.querySelector<HTMLElement>('#jugs')!;
  resetLevelBtn = document.querySelector<HTMLButtonElement>('#reset-level')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  const stored = safeRead<number | null>(STORAGE_BEST, null);
  best = typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : null;

  resetLevelBtn.addEventListener('click', resetCurrentLevel);
  restartBtn.addEventListener('click', restart);
  overlayBtn.addEventListener('click', onOverlayBtn);
  window.addEventListener('keydown', onKey);

  restart();
}

export const game = defineGame({ init, reset });
