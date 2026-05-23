import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Deduction game: one coin is heavier; find it with the fewest weighings.
// Turn-based — no animation loop, so no stale-async-callback surface.
// All DOM/storage access lives in init() (PITFALLS#module-level-dom-access).

type State = 'ready' | 'playing' | 'won' | 'lost';
type Pan = 'L' | 'R' | null;
type Result = 'L' | 'R' | '=';

const STORAGE_BEST = 'sahte-para.best';
const TILT_DEG = 9;

let state: State = 'ready';
let accuseMode = false;
let round = 1;
let coinCount = 0;
let fakeIndex = 0;
let weighAllowed = 0;
let weighUsed = 0;
let best = 0;
let assign: Pan[] = [];

let roundEl!: HTMLElement;
let weighEl!: HTMLElement;
let bestEl!: HTMLElement;
let coinsEl!: HTMLElement;
let statusEl!: HTMLElement;
let verdictEl!: HTMLElement;
let logEl!: HTMLElement;
let beamEl!: SVGGElement;
let panLeftEl!: SVGGElement;
let panRightEl!: SVGGElement;
let weighBtn!: HTMLButtonElement;
let clearBtn!: HTMLButtonElement;
let accuseBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function configFor(r: number): { n: number; w: number } {
  const n = Math.min(18, 6 + r * 3);
  const w = n <= 9 ? 2 : 3;
  return { n, w };
}

function setTilt(result: Result): void {
  const deg = result === 'L' ? -TILT_DEG : result === 'R' ? TILT_DEG : 0;
  beamEl.style.transform = `rotate(${deg}deg)`;
}

function renderCoins(): void {
  coinsEl.innerHTML = '';
  coinsEl.classList.toggle('sp-coins--accusing', accuseMode);
  for (let i = 0; i < coinCount; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-coin';
    if (assign[i] === 'L') btn.classList.add('sp-coin--left');
    else if (assign[i] === 'R') btn.classList.add('sp-coin--right');
    btn.textContent = String(i + 1);
    btn.setAttribute('aria-label', `Para ${i + 1}`);
    btn.addEventListener('click', () => onCoin(i));
    coinsEl.appendChild(btn);
  }
}

function onCoin(i: number): void {
  if (state !== 'playing') return;
  if (accuseMode) {
    doAccuse(i);
    return;
  }
  assign[i] = assign[i] === null ? 'L' : assign[i] === 'L' ? 'R' : null;
  renderCoins();
}

function clearPans(): void {
  assign = new Array<Pan>(coinCount).fill(null);
}

function remainingMsg(): string {
  const left = weighAllowed - weighUsed;
  if (left <= 0) return 'Tartım hakkın bitti — Suçla ile sahteyi seç.';
  return `${left} tartım hakkın kaldı. Kefelere eşit sayıda para koy ve Tart'a bas.`;
}

function setAccuseMode(on: boolean): void {
  accuseMode = on;
  accuseBtn.classList.toggle('sp-btn--active', on);
  weighBtn.disabled = on;
  clearBtn.disabled = on;
  if (on) {
    clearPans();
    statusEl.textContent = 'Sahte olduğunu düşündüğün paraya dokun. (İptal için tekrar Suçla)';
  } else {
    statusEl.textContent = remainingMsg();
  }
  renderCoins();
}

function logWeigh(left: number[], right: number[], result: Result): void {
  const li = document.createElement('li');
  const fmt = (arr: number[]) => arr.map((x) => x + 1).join(',');
  const sym = result === 'L' ? 'sol ağır' : result === 'R' ? 'sağ ağır' : 'dengede';
  li.textContent = `{${fmt(left)}} ⚖ {${fmt(right)}} → ${sym}`;
  li.className = `sp-log__item sp-log__item--${result === '=' ? 'eq' : 'ne'}`;
  logEl.appendChild(li);
}

function weigh(): void {
  if (state !== 'playing' || accuseMode) return;
  if (weighUsed >= weighAllowed) {
    statusEl.textContent = 'Tartım hakkın bitti — Suçla ile sahteyi seç.';
    return;
  }
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < coinCount; i++) {
    if (assign[i] === 'L') left.push(i);
    else if (assign[i] === 'R') right.push(i);
  }
  if (left.length === 0 || right.length === 0) {
    statusEl.textContent = 'Her iki kefeye de en az bir para koymalısın.';
    return;
  }
  if (left.length !== right.length) {
    statusEl.textContent = 'Anlamlı bir tartım için iki kefede eşit sayıda para olmalı.';
    return;
  }

  const result: Result = left.includes(fakeIndex) ? 'L' : right.includes(fakeIndex) ? 'R' : '=';
  weighUsed++;
  weighEl.textContent = `${weighUsed}/${weighAllowed}`;
  setTilt(result);
  verdictEl.textContent =
    result === 'L' ? 'Sol kefe ağır' : result === 'R' ? 'Sağ kefe ağır' : 'İki kefe dengede';
  logWeigh(left, right, result);
  clearPans();
  renderCoins();
  statusEl.textContent = remainingMsg();
}

function doAccuse(i: number): void {
  if (i === fakeIndex) {
    roundWon();
  } else {
    gameOver();
  }
}

function roundWon(): void {
  state = 'won';
  setAccuseMode(false);
  if (round > best) {
    best = round;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  showOverlayEl(overlay);
  overlayTitle.textContent = 'Doğru!';
  overlayMsg.textContent = `Tur ${round} tamamlandı. Sahte para No. ${fakeIndex + 1} idi.`;
  overlayBtn.textContent = 'Sonraki tur';
  round++;
}

function gameOver(): void {
  state = 'lost';
  setAccuseMode(false);
  const cleared = round - 1;
  if (cleared > best) {
    best = cleared;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  setTilt('=');
  showOverlayEl(overlay);
  overlayTitle.textContent = 'Yanlış tahmin!';
  overlayMsg.textContent = `Sahte para No. ${fakeIndex + 1} idi.\nGeçilen tur: ${cleared}`;
  overlayBtn.textContent = 'Yeniden başla';
}

function beginRound(r: number): void {
  const cfg = configFor(r);
  round = r;
  coinCount = cfg.n;
  weighAllowed = cfg.w;
  weighUsed = 0;
  fakeIndex = Math.floor(Math.random() * coinCount);
  accuseMode = false;
  accuseBtn.classList.remove('sp-btn--active');
  weighBtn.disabled = false;
  clearBtn.disabled = false;
  state = 'playing';
  clearPans();
  logEl.innerHTML = '';
  setTilt('=');
  verdictEl.textContent = `${coinCount} para — biri ağır.`;
  roundEl.textContent = String(round);
  weighEl.textContent = `0/${weighAllowed}`;
  bestEl.textContent = String(best);
  hideOverlayEl(overlay);
  renderCoins();
  statusEl.textContent = remainingMsg();
}

function startGame(): void {
  if (best < 0) best = 0;
  beginRound(1);
}

function showIntro(): void {
  state = 'ready';
  overlayTitle.textContent = 'Sahte Para';
  overlayMsg.textContent =
    'Paralardan biri diğerlerinden biraz ağır. Teraziyi kullanarak en az tartımda hangisinin sahte olduğunu bul, sonra Suçla ile seç. Doğru bilirsen bir sonraki (daha zor) tura geçersin.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function reset(): void {
  startGame();
}

function onOverlayBtn(): void {
  if (state === 'lost' || state === 'ready') {
    startGame();
  } else if (state === 'won') {
    beginRound(round);
  }
}

function init(): void {
  roundEl = document.querySelector<HTMLElement>('#round')!;
  weighEl = document.querySelector<HTMLElement>('#weigh')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  coinsEl = document.querySelector<HTMLElement>('#coins')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  verdictEl = document.querySelector<HTMLElement>('#verdict')!;
  logEl = document.querySelector<HTMLElement>('#log')!;
  beamEl = document.querySelector<SVGGElement>('#beam')!;
  panLeftEl = document.querySelector<SVGGElement>('#pan-left')!;
  panRightEl = document.querySelector<SVGGElement>('#pan-right')!;
  weighBtn = document.querySelector<HTMLButtonElement>('#weigh-btn')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear-btn')!;
  accuseBtn = document.querySelector<HTMLButtonElement>('#accuse-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  panLeftEl.setAttribute('transform', 'translate(40 34)');
  panRightEl.setAttribute('transform', 'translate(280 34)');

  best = safeRead<number>(STORAGE_BEST, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;
  bestEl.textContent = String(best);

  weighBtn.addEventListener('click', weigh);
  clearBtn.addEventListener('click', () => {
    if (state !== 'playing' || accuseMode) return;
    clearPans();
    renderCoins();
    statusEl.textContent = remainingMsg();
  });
  accuseBtn.addEventListener('click', () => {
    if (state !== 'playing') return;
    setAccuseMode(!accuseMode);
  });
  restartBtn.addEventListener('click', startGame);
  overlayBtn.addEventListener('click', onOverlayBtn);

  showIntro();
}

export const game = defineGame({ init, reset });
