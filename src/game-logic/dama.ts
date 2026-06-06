// Dama — Anglosakson Checkers/Draughts 8×8 single-player vs AI.
// - Pieces move diagonally forward one square. Captures jump opponent piece.
// - Reaching back rank promotes to King; King moves any diagonal direction one square.
// - Multi-jumps (chain captures) supported.
//
// Pitfalls actively guarded:
// - explicit state machine; inputs gated
// - AI delay setTimeout uses gen token; reset bumps it
// - @shared/storage around localStorage
// - cell coordinate model single source of truth (CSS grid + dataset)
// - body has no <h1>/hint

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const SIZE = 8;
type Cell = 0 | 1 | 2 | 3 | 4;
// 0=empty, 1=player man, 2=player king, 3=ai man, 4=ai king

interface Move {
  from: number;
  to: number;
  captures: number[];
}

type GameState = 'playerTurn' | 'aiTurn' | 'gameOver';

const KEY_WINS = 'dama.wins';
const KEY_LOSSES = 'dama.losses';
// Leaderboard: cumulative wins (a "most wins" board).
const SCORE_DESC = { gameId: 'dama', storageKey: KEY_WINS, direction: 'higher' as const };

let boardEl!: HTMLElement;
let winsEl!: HTMLElement;
let lossesEl!: HTMLElement;
let turnEl!: HTMLElement;
let statusEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayAction!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

let board: Cell[] = new Array(SIZE * SIZE).fill(0);
let state: GameState = 'playerTurn';
let selected: number | null = null;
let availableMoves: Move[] = [];
let wins = 0;
let losses = 0;
const gen = createGenToken();

function loadStat(key: string): number {
  const v = safeRead<number>(key, 0);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function idx(r: number, c: number): number { return r * SIZE + c; }
function rc(i: number): [number, number] { return [Math.floor(i / SIZE), i % SIZE]; }
function inBounds(r: number, c: number): boolean { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }

function isPlayer(p: Cell): boolean { return p === 1 || p === 2; }
function isAi(p: Cell): boolean { return p === 3 || p === 4; }
function isKing(p: Cell): boolean { return p === 2 || p === 4; }

function pieceMoves(b: Cell[], i: number): Move[] {
  const p = b[i];
  if (!p) return [];
  const [r, c] = rc(i);
  const moves: Move[] = [];
  const dirs: [number, number][] = [];
  if (isKing(p)) {
    dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
  } else if (isPlayer(p)) {
    dirs.push([-1, -1], [-1, 1]);
  } else {
    dirs.push([1, -1], [1, 1]);
  }
  for (const [dr, dc] of dirs) {
    const nr = r + dr;
    const nc = c + dc;
    if (inBounds(nr, nc) && b[idx(nr, nc)] === 0) {
      moves.push({ from: i, to: idx(nr, nc), captures: [] });
    }
  }
  const captureMoves = findCaptures(b, i);
  return moves.concat(captureMoves);
}

function findCaptures(b: Cell[], i: number, path: number[] = []): Move[] {
  const p = b[i];
  if (!p) return [];
  const [r, c] = rc(i);
  const dirs: [number, number][] = [];
  if (isKing(p)) {
    dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
  } else if (isPlayer(p)) {
    dirs.push([-1, -1], [-1, 1]);
  } else {
    dirs.push([1, -1], [1, 1]);
  }
  const result: Move[] = [];
  for (const [dr, dc] of dirs) {
    const midR = r + dr;
    const midC = c + dc;
    const landR = r + 2 * dr;
    const landC = c + 2 * dc;
    if (!inBounds(landR, landC)) continue;
    const midI = idx(midR, midC);
    const landI = idx(landR, landC);
    const midP = b[midI];
    if (midP === undefined || midP === 0) continue;
    if (path.includes(midI)) continue;
    if ((isPlayer(p) && isAi(midP)) || (isAi(p) && isPlayer(midP))) {
      if (b[landI] !== 0) continue;
      const nb = b.slice();
      nb[i] = 0;
      nb[midI] = 0;
      nb[landI] = p;
      const further = findCaptures(nb, landI, path.concat(midI));
      if (further.length === 0) {
        result.push({ from: i, to: landI, captures: path.concat(midI) });
      } else {
        for (const fm of further) {
          result.push({ from: i, to: fm.to, captures: path.concat(midI, fm.captures) });
        }
      }
    }
  }
  return result;
}

function allMoves(b: Cell[], who: 'player' | 'ai'): Move[] {
  const moves: Move[] = [];
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    if (p === undefined || p === 0) continue;
    if (who === 'player' && !isPlayer(p)) continue;
    if (who === 'ai' && !isAi(p)) continue;
    for (const m of pieceMoves(b, i)) moves.push(m);
  }
  return moves;
}

function applyMove(b: Cell[], m: Move): Cell[] {
  const nb = b.slice();
  const p = nb[m.from]!;
  nb[m.from] = 0;
  for (const cap of m.captures) nb[cap] = 0;
  const [tr] = rc(m.to);
  let final: Cell = p;
  if (isPlayer(p) && tr === 0 && !isKing(p)) final = 2;
  if (isAi(p) && tr === SIZE - 1 && !isKing(p)) final = 4;
  nb[m.to] = final;
  return nb;
}

function setupInitial(): void {
  board = new Array(SIZE * SIZE).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < SIZE; c++) {
      if ((r + c) % 2 === 1) board[idx(r, c)] = 3;
    }
  }
  for (let r = SIZE - 3; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if ((r + c) % 2 === 1) board[idx(r, c)] = 1;
    }
  }
}

function renderBoard(): void {
  let html = '';
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = idx(r, c);
      const dark = (r + c) % 2 === 1;
      const cellCls = `dama-cell ${dark ? 'dama-cell--dark' : 'dama-cell--light'}`;
      const selectedCls = selected === i ? ' dama-cell--selected' : '';
      const moveCls = selected !== null && availableMoves.some((m) => m.to === i && m.from === selected) ? ' dama-cell--move' : '';
      const captureCls = selected !== null && availableMoves.some((m) => m.to === i && m.from === selected && m.captures.length > 0) ? ' dama-cell--capture' : '';
      const piece = board[i] ?? 0;
      let pieceHtml = '';
      if (piece === 1) pieceHtml = '<span class="dama-piece dama-piece--player"></span>';
      else if (piece === 2) pieceHtml = '<span class="dama-piece dama-piece--player dama-piece--king"></span>';
      else if (piece === 3) pieceHtml = '<span class="dama-piece dama-piece--ai"></span>';
      else if (piece === 4) pieceHtml = '<span class="dama-piece dama-piece--ai dama-piece--king"></span>';
      html += `<button class="${cellCls}${selectedCls}${moveCls}${captureCls}" data-i="${i}" type="button"${dark ? '' : ' disabled tabindex="-1"'}>${pieceHtml}</button>`;
    }
  }
  boardEl.innerHTML = html;
}

function onCellClick(e: Event): void {
  if (state !== 'playerTurn') return;
  const target = e.target as HTMLElement;
  const btn = target.closest('.dama-cell') as HTMLElement | null;
  if (!btn || btn.hasAttribute('disabled')) return;
  const i = Number(btn.getAttribute('data-i'));
  if (!Number.isFinite(i)) return;
  const piece = board[i] ?? 0;
  if (selected !== null) {
    const move = availableMoves.find((m) => m.from === selected && m.to === i);
    if (move) {
      board = applyMove(board, move);
      selected = null;
      availableMoves = [];
      renderBoard();
      const aiHasPieces = board.some((p) => isAi(p));
      const aiMoves = allMoves(board, 'ai');
      if (!aiHasPieces || aiMoves.length === 0) {
        endGame('player');
        return;
      }
      state = 'aiTurn';
      turnEl.textContent = 'Rakip';
      setStatus('Rakip düşünüyor…');
      scheduleAi();
      return;
    }
  }
  if (isPlayer(piece)) {
    selected = i;
    availableMoves = pieceMoves(board, i);
    renderBoard();
  } else {
    selected = null;
    availableMoves = [];
    renderBoard();
  }
}

function evaluate(b: Cell[]): number {
  let score = 0;
  for (const p of b) {
    if (p === 3) score += 1;
    else if (p === 4) score += 1.7;
    else if (p === 1) score -= 1;
    else if (p === 2) score -= 1.7;
  }
  return score;
}

function aiPickBestMove(): Move | null {
  const moves = allMoves(board, 'ai');
  if (moves.length === 0) return null;
  let best: Move = moves[0]!;
  let bestScore = -Infinity;
  for (const m of moves) {
    const nb = applyMove(board, m);
    const e = evaluate(nb) + Math.random() * 0.15;
    const cs = m.captures.length * 2;
    const score = e + cs;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function scheduleAi(): void {
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'aiTurn') return;
    aiTurn();
  }, 480);
}

function aiTurn(): void {
  const move = aiPickBestMove();
  if (!move) {
    endGame('player');
    return;
  }
  board = applyMove(board, move);
  renderBoard();
  const playerMoves = allMoves(board, 'player');
  const playerHasPieces = board.some((p) => isPlayer(p));
  if (!playerHasPieces || playerMoves.length === 0) {
    endGame('ai');
    return;
  }
  state = 'playerTurn';
  turnEl.textContent = 'Sen';
  setStatus('Sıra sende.');
}

function endGame(winner: 'player' | 'ai'): void {
  state = 'gameOver';
  if (winner === 'player') {
    wins += 1;
    showOverlay('Kazandın!', 'Rakibin pulları bitti veya hamlesi kalmadı.');
  } else {
    losses += 1;
    showOverlay('Kaybettin', 'Pullarını veya hamleni kaybettin.');
  }
  safeWrite(KEY_WINS, wins);
  safeWrite(KEY_LOSSES, losses);
  syncHud();
  if (winner === 'player') reportGameOver(SCORE_DESC, wins, { label: 'Galibiyet' });
}

function setStatus(s: string): void {
  statusEl.textContent = s;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}
function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function syncHud(): void {
  winsEl.textContent = String(wins);
  lossesEl.textContent = String(losses);
}

function newGame(): void {
  gen.bump();
  setupInitial();
  selected = null;
  availableMoves = [];
  state = 'playerTurn';
  turnEl.textContent = 'Sen';
  setStatus('Pul seç ve çapraz hareket et.');
  hideOverlay();
  renderBoard();
  syncHud();
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  winsEl = document.querySelector<HTMLElement>('#wins')!;
  lossesEl = document.querySelector<HTMLElement>('#losses')!;
  turnEl = document.querySelector<HTMLElement>('#turn')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayAction = document.querySelector<HTMLButtonElement>('#overlay-action')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  wins = loadStat(KEY_WINS);
  losses = loadStat(KEY_LOSSES);

  boardEl.addEventListener('click', onCellClick);
  restartBtn.addEventListener('click', newGame);
  overlayAction.addEventListener('click', newGame);
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'r') {
      newGame();
      e.preventDefault();
    } else if (state === 'gameOver' && (e.key === 'Enter' || e.key === ' ')) {
      newGame();
      e.preventDefault();
    }
  });

  newGame();
}

export const game = defineGame({ init, reset: newGame });
