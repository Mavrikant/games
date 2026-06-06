// Blackjack (21) — clasic single-player vs dealer.
// Pitfalls actively guarded:
// - overlay-input-leak: state machine (betting | playerTurn | dealerTurn | gameOver);
//   hit/stand disabled unless state==='playerTurn'.
// - stale-async-callback: dealer's reveal loop uses a generation token; reset bumps it.
// - unguarded-storage: @shared/storage wraps localStorage.
// - duplicate-with-shared-layer: body has no <h1> or hint; layout renders these.
// - invisible-boot: first frame paints HUD, chips, "Dağıt" enabled, cards empty.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type Suit = '♠' | '♥' | '♦' | '♣';
interface Card {
  rank: string;
  suit: Suit;
  value: number; // 1-10 (Ace=1 here; counted as 11 in hand)
}
type GameState = 'betting' | 'playerTurn' | 'dealerTurn' | 'gameOver';

const SUITS: Suit[] = ['♠', '♥', '♦', '♣'];
const RANKS = [
  { rank: 'A', value: 1 },
  { rank: '2', value: 2 },
  { rank: '3', value: 3 },
  { rank: '4', value: 4 },
  { rank: '5', value: 5 },
  { rank: '6', value: 6 },
  { rank: '7', value: 7 },
  { rank: '8', value: 8 },
  { rank: '9', value: 9 },
  { rank: '10', value: 10 },
  { rank: 'J', value: 10 },
  { rank: 'Q', value: 10 },
  { rank: 'K', value: 10 },
];

const STARTING_CHIPS = 1000;
const MIN_BET = 10;
const BET_STEP = 10;

const KEY_CHIPS = 'blackjack.chips';
const KEY_WINS = 'blackjack.wins';
const KEY_LOSSES = 'blackjack.losses';
const KEY_BET = 'blackjack.bet';
// Leaderboard: highest chip bankroll reached at a round resolution.
const SCORE_DESC = { gameId: 'blackjack', storageKey: KEY_CHIPS, direction: 'higher' as const };

let chipsEl!: HTMLElement;
let betEl!: HTMLElement;
let betDisplayEl!: HTMLElement;
let winsEl!: HTMLElement;
let lossesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let dealerCardsEl!: HTMLElement;
let playerCardsEl!: HTMLElement;
let dealerTotalEl!: HTMLElement;
let playerTotalEl!: HTMLElement;
let statusEl!: HTMLElement;
let dealBtn!: HTMLButtonElement;
let hitBtn!: HTMLButtonElement;
let standBtn!: HTMLButtonElement;
let betPlusBtn!: HTMLButtonElement;
let betMinusBtn!: HTMLButtonElement;

let deck: Card[] = [];
let dealerHand: Card[] = [];
let playerHand: Card[] = [];
let dealerHidden = true;
let state: GameState = 'betting';
let chips = STARTING_CHIPS;
let wins = 0;
let losses = 0;
let bet = 50;
const gen = createGenToken();

function loadStat(key: string, fallback: number): number {
  const v = safeRead<number>(key, fallback);
  return Number.isFinite(v) ? v : fallback;
}

function buildDeck(): Card[] {
  const d: Card[] = [];
  for (const suit of SUITS) {
    for (const r of RANKS) {
      d.push({ rank: r.rank, suit, value: r.value });
    }
  }
  return d;
}

function shuffle(arr: Card[]): Card[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function handTotal(hand: Card[]): number {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    total += c.value;
    if (c.rank === 'A') aces += 1;
  }
  while (aces > 0 && total + 10 <= 21) {
    total += 10;
    aces -= 1;
  }
  return total;
}

function isBlackjack(hand: Card[]): boolean {
  return hand.length === 2 && handTotal(hand) === 21;
}

function renderCard(c: Card, hidden = false): string {
  if (hidden) {
    return '<span class="bj__card bj__card--back" aria-label="Kapalı kart">?</span>';
  }
  const red = c.suit === '♥' || c.suit === '♦';
  const cls = `bj__card${red ? ' bj__card--red' : ''}`;
  return `<span class="${cls}"><span class="bj__rank">${c.rank}</span><span class="bj__suit">${c.suit}</span></span>`;
}

function renderHands(): void {
  playerCardsEl.innerHTML = playerHand.map((c) => renderCard(c)).join('');
  dealerCardsEl.innerHTML = dealerHand
    .map((c, i) => renderCard(c, dealerHidden && i === 1))
    .join('');
  playerTotalEl.textContent = playerHand.length === 0 ? '—' : String(handTotal(playerHand));
  if (dealerHand.length === 0) {
    dealerTotalEl.textContent = '—';
  } else if (dealerHidden) {
    dealerTotalEl.textContent = `${dealerHand[0]!.value === 1 ? 11 : dealerHand[0]!.value}+?`;
  } else {
    dealerTotalEl.textContent = String(handTotal(dealerHand));
  }
}

function updateBetDisplay(): void {
  betEl.textContent = String(bet);
  betDisplayEl.textContent = String(bet);
}

function updateButtons(): void {
  dealBtn.disabled = state !== 'betting' || chips < bet;
  hitBtn.disabled = state !== 'playerTurn';
  standBtn.disabled = state !== 'playerTurn';
  betPlusBtn.disabled = state !== 'betting' || bet + BET_STEP > chips;
  betMinusBtn.disabled = state !== 'betting' || bet - BET_STEP < MIN_BET;
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function drawCard(): Card {
  if (deck.length === 0) deck = shuffle(buildDeck());
  return deck.pop()!;
}

function startHand(): void {
  if (state !== 'betting') return;
  if (chips < bet) {
    setStatus('Yeterli chip yok — bahsi azalt veya yeni oyunu sıfırla.');
    return;
  }
  gen.bump();
  chips -= bet;
  deck = shuffle(buildDeck());
  playerHand = [drawCard(), drawCard()];
  dealerHand = [drawCard(), drawCard()];
  dealerHidden = true;
  state = 'playerTurn';
  setStatus('Hit veya Stand?');
  renderHands();
  syncHud();
  updateButtons();

  // Blackjack check after deal
  if (isBlackjack(playerHand)) {
    state = 'dealerTurn';
    dealerHidden = false;
    if (isBlackjack(dealerHand)) {
      chips += bet; // push
      setStatus('Push! İki taraf da Blackjack.');
      endHand();
    } else {
      chips += Math.floor(bet * 2.5); // 3:2 payout
      wins += 1;
      setStatus('Blackjack! 3:2 ödeme aldın.');
      endHand();
    }
  }
}

function playerHit(): void {
  if (state !== 'playerTurn') return;
  playerHand.push(drawCard());
  renderHands();
  const total = handTotal(playerHand);
  if (total > 21) {
    losses += 1;
    setStatus('Bust! Krupiye kazandı.');
    dealerHidden = false;
    state = 'gameOver';
    renderHands();
    endHand();
  } else if (total === 21) {
    playerStand();
  }
}

function playerStand(): void {
  if (state !== 'playerTurn') return;
  state = 'dealerTurn';
  dealerHidden = false;
  renderHands();
  setStatus('Krupiye sırası…');
  updateButtons();
  runDealer(gen.current());
}

function runDealer(myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (state !== 'dealerTurn') return;
  if (handTotal(dealerHand) < 17) {
    window.setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      if (state !== 'dealerTurn') return;
      dealerHand.push(drawCard());
      renderHands();
      runDealer(myGen);
    }, 380);
    return;
  }
  // Dealer done; resolve.
  const pTotal = handTotal(playerHand);
  const dTotal = handTotal(dealerHand);
  if (dTotal > 21 || pTotal > dTotal) {
    chips += bet * 2;
    wins += 1;
    setStatus(dTotal > 21 ? 'Krupiye bust! Kazandın.' : `${pTotal} vs ${dTotal} — kazandın!`);
  } else if (pTotal < dTotal) {
    losses += 1;
    setStatus(`${pTotal} vs ${dTotal} — krupiye kazandı.`);
  } else {
    chips += bet;
    setStatus(`Push (${pTotal} vs ${dTotal}).`);
  }
  endHand();
}

function endHand(): void {
  state = 'gameOver';
  // Report the bankroll for this resolved round before any auto-refill kicks in.
  reportGameOver(SCORE_DESC, chips, { label: 'Çip' });
  if (chips < MIN_BET) {
    chips = STARTING_CHIPS;
    setStatus(statusEl.textContent + ' Chipler bitti — yeniden 1000 chip verildi.');
  }
  bet = Math.min(bet, chips);
  if (bet < MIN_BET) bet = MIN_BET;
  syncHud();
  updateButtons();
  // After a short pause, back to betting.
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'gameOver') return;
    state = 'betting';
    setStatus('Yeni el için bahsi ayarla ve "Dağıt"a bas.');
    updateButtons();
  }, 900);
}

function syncHud(): void {
  chipsEl.textContent = String(chips);
  winsEl.textContent = String(wins);
  lossesEl.textContent = String(losses);
  updateBetDisplay();
  safeWrite(KEY_CHIPS, chips);
  safeWrite(KEY_WINS, wins);
  safeWrite(KEY_LOSSES, losses);
  safeWrite(KEY_BET, bet);
}

function fullReset(): void {
  gen.bump();
  state = 'betting';
  chips = STARTING_CHIPS;
  wins = 0;
  losses = 0;
  bet = 50;
  deck = [];
  dealerHand = [];
  playerHand = [];
  dealerHidden = true;
  safeWrite(KEY_CHIPS, chips);
  safeWrite(KEY_WINS, wins);
  safeWrite(KEY_LOSSES, losses);
  safeWrite(KEY_BET, bet);
  setStatus('Yeni oyun başladı. Bahsi ayarla ve dağıt.');
  renderHands();
  syncHud();
  updateButtons();
}

function init(): void {
  chipsEl = document.querySelector<HTMLElement>('#chips')!;
  betEl = document.querySelector<HTMLElement>('#bet')!;
  betDisplayEl = document.querySelector<HTMLElement>('#bet-display')!;
  winsEl = document.querySelector<HTMLElement>('#wins')!;
  lossesEl = document.querySelector<HTMLElement>('#losses')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  dealerCardsEl = document.querySelector<HTMLElement>('#dealer-cards')!;
  playerCardsEl = document.querySelector<HTMLElement>('#player-cards')!;
  dealerTotalEl = document.querySelector<HTMLElement>('#dealer-total')!;
  playerTotalEl = document.querySelector<HTMLElement>('#player-total')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  dealBtn = document.querySelector<HTMLButtonElement>('#deal')!;
  hitBtn = document.querySelector<HTMLButtonElement>('#hit')!;
  standBtn = document.querySelector<HTMLButtonElement>('#stand')!;
  betPlusBtn = document.querySelector<HTMLButtonElement>('#bet-plus')!;
  betMinusBtn = document.querySelector<HTMLButtonElement>('#bet-minus')!;

  chips = loadStat(KEY_CHIPS, STARTING_CHIPS);
  wins = loadStat(KEY_WINS, 0);
  losses = loadStat(KEY_LOSSES, 0);
  bet = loadStat(KEY_BET, 50);
  if (chips < MIN_BET) chips = STARTING_CHIPS;
  if (bet < MIN_BET) bet = MIN_BET;
  if (bet > chips) bet = chips;
  state = 'betting';

  dealBtn.addEventListener('click', startHand);
  hitBtn.addEventListener('click', playerHit);
  standBtn.addEventListener('click', playerStand);
  betPlusBtn.addEventListener('click', () => {
    if (state !== 'betting') return;
    if (bet + BET_STEP <= chips) {
      bet += BET_STEP;
      syncHud();
      updateButtons();
    }
  });
  betMinusBtn.addEventListener('click', () => {
    if (state !== 'betting') return;
    if (bet - BET_STEP >= MIN_BET) {
      bet -= BET_STEP;
      syncHud();
      updateButtons();
    }
  });
  restartBtn.addEventListener('click', fullReset);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      fullReset();
      e.preventDefault();
      return;
    }
    if (state === 'playerTurn') {
      if (k === 'h') {
        playerHit();
        e.preventDefault();
      } else if (k === 's') {
        playerStand();
        e.preventDefault();
      }
    } else if (state === 'betting') {
      if (k === 'enter' || k === ' ') {
        startHand();
        e.preventDefault();
      } else if (k === '+' || k === '=') {
        betPlusBtn.click();
        e.preventDefault();
      } else if (k === '-' || k === '_') {
        betMinusBtn.click();
        e.preventDefault();
      }
    }
  });

  renderHands();
  syncHud();
  updateButtons();
  setStatus('Bahis ayarla ve "Dağıt"a bas.');
}

export const game = defineGame({ init, reset: fullReset });
