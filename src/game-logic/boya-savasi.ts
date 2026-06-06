// Boya Savaşı — territory flood-fill strategy vs AI (Filler-style).
//
// Two seeds start in opposite corners (player: bottom-left, AI: top-right).
// On your turn you pick a colour; every cell you already own turns that
// colour, then the region floods outward, absorbing every adjacent neutral
// cell of the chosen colour (repeat to fixpoint). You may NOT pick your own
// current colour, nor the opponent's current colour. Most cells when the
// board is full wins.
//
// The starting board is generated so no two hex-adjacent (6-neighbour) cells
// share a colour — this guarantees each seed is a single cell and every
// pick has a well-defined, bounded gain.
//
// The board is a pointy-top hexagonal grid in "odd-r" offset coordinates
// (odd rows are shifted right by half a cell). Cells are laid out by absolute
// percentage positions inside an aspect-ratio'd board so they scale fluidly.
//
// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage: all localStorage via @shared/storage.
// - stale-async-callback: gen.bump() in reset() cancels the pending AI move.
// - overlay-input-leak: explicit `state` enum; every handler bails unless
//   it is the player's turn.
// - module-level-dom-access: all DOM access happens inside init().

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const COLS = 8;
const ROWS = 11;
const TOTAL = COLS * ROWS;
const NUM_COLORS = 6;

const PLAYER = 0;
const AI = 1;
const NEUTRAL = -1;

const PLAYER_START = (ROWS - 1) * COLS; // bottom-left
const AI_START = COLS - 1; // top-right

const AI_DELAY_MS = 480;
// Hard safety cap so a degenerate board can never hang the turn loop.
const MAX_MOVES = TOTAL * 3;

// --- Hex layout (pointy-top, "odd-r" offset) -------------------------------
// All values are percentages of the board box, whose aspect-ratio is set so
// each clip-path hexagon renders as a regular hexagon at any board width.
// V = total board height measured in hex circumradii (R): top row spans 2R,
// every further row adds 1.5R.
const HEX_V = 0.5 + 1.5 * ROWS;
const HEX_W_PCT = 100 / (COLS + 0.5); // hex flat-to-flat width, % of board
const HEX_H_PCT = (2 / HEX_V) * 100; // hex point-to-point height, % of board
const ROW_PITCH_PCT = (1.5 / HEX_V) * 100; // vertical centre-to-centre, % of board
const BOARD_ASPECT = ((COLS + 0.5) * Math.sqrt(3)) / HEX_V; // width / height

// Hex neighbour offsets [dCol, dRow] for "odd-r" rows.
const EVEN_ROW_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];
const ODD_ROW_DELTAS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [0, 1],
  [1, 1],
];

const STORAGE_WINS = 'boya-savasi.wins';
const STORAGE_LOSSES = 'boya-savasi.losses';
// Leaderboard: territory the player ends up owning (higher is better). Flat
// mirror key so it never clashes with the win/loss tallies.
const SCORE_DESC = { gameId: 'boya-savasi', storageKey: 'boya-savasi.lb', direction: 'higher' as const };

type GameState = 'PlayerTurn' | 'AiTurn' | 'GameOver';

const gen = createGenToken();

let color = new Int8Array(TOTAL); // colour index 0..5 per cell
let owner = new Int8Array(TOTAL); // PLAYER | AI | NEUTRAL
let playerColor = 0;
let aiColor = 0;
let moveCount = 0;
let state: GameState = 'PlayerTurn';
let wins = 0;
let losses = 0;

let boardEl!: HTMLElement;
let cellEls: HTMLElement[] = [];
let paletteEl!: HTMLElement;
let swatchEls: HTMLButtonElement[] = [];
let statusEl!: HTMLElement;
let mineCountEl!: HTMLElement;
let aiCountEl!: HTMLElement;
let winsEl!: HTMLElement;
let lossesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayRestart!: HTMLButtonElement;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
function loadStat(key: string): number {
  const v = safeRead<number>(key, 0);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
function hexNeighbors(i: number): number[] {
  const r = Math.floor(i / COLS);
  const c = i % COLS;
  const deltas = r % 2 === 0 ? EVEN_ROW_DELTAS : ODD_ROW_DELTAS;
  const out: number[] = [];
  for (const [dc, dr] of deltas) {
    const nc = c + dc;
    const nr = r + dr;
    if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS) out.push(nr * COLS + nc);
  }
  return out;
}

function neighborsOwnedBy(o: Int8Array, i: number, p: number): boolean {
  for (const n of hexNeighbors(i)) if (o[n] === p) return true;
  return false;
}

// Recolour everything owned by p to `c`, then absorb all reachable neutral
// cells of colour `c`. Mutates the passed arrays. Returns cells gained.
function flood(o: Int8Array, col: Int8Array, p: number, c: number): number {
  for (let i = 0; i < TOTAL; i++) {
    if (o[i] === p) col[i] = c;
  }
  let gained = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < TOTAL; i++) {
      if (o[i] === NEUTRAL && col[i] === c && neighborsOwnedBy(o, i, p)) {
        o[i] = p;
        gained++;
        changed = true;
      }
    }
  }
  return gained;
}

function countOwned(p: number): number {
  let n = 0;
  for (let i = 0; i < TOTAL; i++) if (owner[i] === p) n++;
  return n;
}

function neutralCount(): number {
  let n = 0;
  for (let i = 0; i < TOTAL; i++) if (owner[i] === NEUTRAL) n++;
  return n;
}

function legalColorsFor(ownColor: number, oppColor: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < NUM_COLORS; c++) {
    if (c !== ownColor && c !== oppColor) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI — greedy: pick the legal colour that absorbs the most cells right now.
// ---------------------------------------------------------------------------
function chooseAiColor(): number {
  const legal = legalColorsFor(aiColor, playerColor);
  let best = legal[0]!;
  let bestScore = -1;
  for (const c of legal) {
    const o = owner.slice();
    const col = color.slice();
    const gain = flood(o, col, AI, c);
    // Tiny jitter keeps tied moves from always resolving the same way.
    const score = gain + Math.random() * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Board generation — no two adjacent cells share a colour.
// ---------------------------------------------------------------------------
function generateBoard(): void {
  color = new Int8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    // Ban the colours of already-placed hex neighbours (those with a smaller
    // index in row-major order). At most three such neighbours exist, so with
    // six colours there are always at least three choices left.
    const banned = new Set<number>();
    for (const n of hexNeighbors(i)) if (n < i) banned.add(color[n]!);
    const choices: number[] = [];
    for (let k = 0; k < NUM_COLORS; k++) if (!banned.has(k)) choices.push(k);
    color[i] = choices[Math.floor(Math.random() * choices.length)]!;
  }

  owner = new Int8Array(TOTAL).fill(NEUTRAL);
  owner[PLAYER_START] = PLAYER;
  owner[AI_START] = AI;
  playerColor = color[PLAYER_START]!;

  // Guarantee the two seeds differ, keeping the no-adjacent-match invariant
  // around the AI seed (a corner cell with at most three neighbours).
  const aiBanned = new Set<number>([playerColor]);
  for (const n of hexNeighbors(AI_START)) aiBanned.add(color[n]!);
  if (aiBanned.has(color[AI_START]!)) {
    for (let k = 0; k < NUM_COLORS; k++) {
      if (!aiBanned.has(k)) {
        color[AI_START] = k;
        break;
      }
    }
  }
  aiColor = color[AI_START]!;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function buildBoard(): void {
  boardEl.style.aspectRatio = String(BOARD_ASPECT);
  boardEl.style.setProperty('--hex-w', `${HEX_W_PCT}%`);
  boardEl.style.setProperty('--hex-h', `${HEX_H_PCT}%`);
  boardEl.innerHTML = '';
  cellEls = [];
  for (let i = 0; i < TOTAL; i++) {
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    const odd = r % 2 === 1;
    const cell = document.createElement('div');
    cell.className = 'bs-cell';
    cell.setAttribute('role', 'gridcell');
    cell.style.left = `${(odd ? c + 0.5 : c) * HEX_W_PCT}%`;
    cell.style.top = `${r * ROW_PITCH_PCT}%`;
    boardEl.appendChild(cell);
    cellEls.push(cell);
  }
}

function buildPalette(): void {
  paletteEl.innerHTML = '';
  swatchEls = [];
  for (let c = 0; c < NUM_COLORS; c++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `bs-swatch bs-swatch--c${c}`;
    btn.dataset.c = String(c);
    btn.textContent = String(c + 1);
    btn.setAttribute('aria-label', `${c + 1}. renk`);
    btn.addEventListener('click', () => onPick(c));
    paletteEl.appendChild(btn);
    swatchEls.push(btn);
  }
}

function renderBoard(): void {
  for (let i = 0; i < TOTAL; i++) {
    const el = cellEls[i]!;
    el.className = `bs-cell bs-cell--c${color[i]}`;
    const o = owner[i];
    if (o === PLAYER) el.classList.add('bs-cell--mine');
    else if (o === AI) el.classList.add('bs-cell--ai');
  }
}

function renderPalette(): void {
  const legal = new Set(
    state === 'PlayerTurn' ? legalColorsFor(playerColor, aiColor) : [],
  );
  for (let c = 0; c < NUM_COLORS; c++) {
    swatchEls[c]!.disabled = !legal.has(c);
  }
}

function renderHud(): void {
  mineCountEl.textContent = String(countOwned(PLAYER));
  aiCountEl.textContent = String(countOwned(AI));
  winsEl.textContent = String(wins);
  lossesEl.textContent = String(losses);
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('bs-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
  overlayRestart.focus({ preventScroll: true });
}

function hideOverlay(): void {
  overlay.classList.add('bs-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// ---------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------
function endGame(): void {
  state = 'GameOver';
  const mine = countOwned(PLAYER);
  const ai = countOwned(AI);
  renderBoard();
  renderPalette();
  let title: string;
  if (mine > ai) {
    wins++;
    safeWrite(STORAGE_WINS, wins);
    title = 'Kazandın!';
  } else if (ai > mine) {
    losses++;
    safeWrite(STORAGE_LOSSES, losses);
    title = 'Kaybettin.';
  } else {
    title = 'Berabere.';
  }
  const msg = `Sen ${mine} – Yapay zekâ ${ai}`;
  renderHud();
  setStatus(`${title} ${msg}`);
  reportGameOver(SCORE_DESC, mine, { label: 'Skor' });
  showOverlay(title, msg);
}

function afterMove(): boolean {
  moveCount++;
  if (neutralCount() === 0 || moveCount >= MAX_MOVES) {
    endGame();
    return true;
  }
  return false;
}

function startAiTurn(): void {
  const myGen = gen.current();
  setStatus('Yapay zekâ düşünüyor…');
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return; // reset during the delay → bail
    if (state !== 'AiTurn') return;
    const c = chooseAiColor();
    flood(owner, color, AI, c);
    aiColor = c;
    renderBoard();
    renderHud();
    if (afterMove()) return;
    state = 'PlayerTurn';
    renderPalette();
    setStatus('Sıra sende — bir renk seç.');
  }, AI_DELAY_MS);
}

function onPick(c: number): void {
  // overlay-input-leak guard
  if (state !== 'PlayerTurn') return;
  if (c === playerColor || c === aiColor) return; // illegal
  flood(owner, color, PLAYER, c);
  playerColor = c;
  renderBoard();
  renderHud();
  if (afterMove()) return;
  state = 'AiTurn';
  renderPalette();
  startAiTurn();
}

// ---------------------------------------------------------------------------
// Reset / boot
// ---------------------------------------------------------------------------
function reset(): void {
  gen.bump(); // cancel any pending AI move from the previous game
  generateBoard();
  moveCount = 0;
  state = 'PlayerTurn';
  hideOverlay();
  renderBoard();
  renderPalette();
  renderHud();
  setStatus('Sıra sende — bir renk seç.');
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#bs-board')!;
  paletteEl = document.querySelector<HTMLElement>('#bs-palette')!;
  statusEl = document.querySelector<HTMLElement>('#bs-status')!;
  mineCountEl = document.querySelector<HTMLElement>('#bs-mine')!;
  aiCountEl = document.querySelector<HTMLElement>('#bs-ai')!;
  winsEl = document.querySelector<HTMLElement>('#bs-wins')!;
  lossesEl = document.querySelector<HTMLElement>('#bs-losses')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#bs-restart')!;
  overlay = document.querySelector<HTMLElement>('#bs-overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#bs-ov-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#bs-ov-msg')!;
  overlayRestart = document.querySelector<HTMLButtonElement>('#bs-ov-restart')!;

  wins = loadStat(STORAGE_WINS);
  losses = loadStat(STORAGE_LOSSES);

  restartBtn.addEventListener('click', reset);
  overlayRestart.addEventListener('click', reset);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && state === 'GameOver') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'PlayerTurn' && e.key >= '1' && e.key <= String(NUM_COLORS)) {
      onPick(Number(e.key) - 1);
      e.preventDefault();
    }
  });

  buildBoard();
  buildPalette();
  reset();
}

export const game = defineGame({ init, reset });
