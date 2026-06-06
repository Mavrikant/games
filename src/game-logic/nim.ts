// Nim (last stone wins). 3 piles with sizes [3, 4, 5]. Human plays first;
// computer responds with optimal play via XOR (nim-sum) strategy. A move is
// "pick a stone in a row" — that stone and every stone to its right in the
// same row are removed (so a single click can remove 1..rowSize stones).
//
// AI: if nim-sum != 0, find a pile to reduce so total XOR becomes 0; that's
// the winning move under normal play. If nim-sum == 0 (already losing
// position), take 1 from the largest non-empty pile and hope the human errs.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const INITIAL_PILES: readonly number[] = [3, 4, 5];
const AI_DELAY_MS = 520;
const STORAGE_SCORE = 'nim.score';

// Global leaderboard: cumulative player wins ("most wins" board). The game's
// own score lives inside an object (nim.score), so we mirror to a flat key.
const SCORE_DESC = { gameId: 'nim', storageKey: 'nim.lb', direction: 'higher' as const };

type Turn = 'human' | 'ai';
type State = 'playing' | 'over';

interface Scores {
  wins: number;
  losses: number;
}

const gen = createGenToken();

let piles: number[] = [];
let turn: Turn = 'human';
let state: State = 'playing';
let scores: Scores = { wins: 0, losses: 0 };

let boardEl!: HTMLElement;
let statusEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

function nimSum(p: readonly number[]): number {
  let s = 0;
  for (const v of p) s ^= v;
  return s;
}

function aiPick(p: readonly number[]): { row: number; take: number } {
  const s = nimSum(p);
  if (s !== 0) {
    for (let i = 0; i < p.length; i++) {
      const target = p[i]! ^ s;
      if (target < p[i]!) {
        return { row: i, take: p[i]! - target };
      }
    }
  }
  let bestRow = -1;
  for (let i = 0; i < p.length; i++) {
    if (p[i]! > 0 && (bestRow === -1 || p[i]! > p[bestRow]!)) bestRow = i;
  }
  return { row: bestRow, take: 1 };
}

function totalStones(): number {
  let t = 0;
  for (const v of piles) t += v;
  return t;
}

function render(): void {
  boardEl.innerHTML = '';
  for (let r = 0; r < piles.length; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'nim-row';
    rowEl.setAttribute('role', 'group');
    rowEl.setAttribute('aria-label', `Sıra ${r + 1}: ${piles[r]} taş`);

    const rowSize = piles[r]!;
    const origSize = INITIAL_PILES[r]!;
    for (let c = 0; c < origSize; c++) {
      const stone = document.createElement('button');
      stone.type = 'button';
      stone.className = 'nim-stone';
      const present = c < rowSize;
      if (!present) stone.classList.add('nim-stone--gone');
      stone.disabled = !present || state !== 'playing' || turn !== 'human';
      if (present) {
        const takeCount = rowSize - c;
        stone.setAttribute(
          'aria-label',
          `Sıra ${r + 1}'den ${takeCount} taş al`,
        );
        stone.addEventListener('click', () => onStoneClick(r, c));
        stone.addEventListener('mouseenter', () => previewRow(r, c));
        stone.addEventListener('mouseleave', clearPreview);
        stone.addEventListener('focus', () => previewRow(r, c));
        stone.addEventListener('blur', clearPreview);
      }
      stone.dataset.row = String(r);
      stone.dataset.col = String(c);
      rowEl.appendChild(stone);
    }
    boardEl.appendChild(rowEl);
  }
}

function previewRow(row: number, col: number): void {
  if (state !== 'playing' || turn !== 'human') return;
  const stones = boardEl.querySelectorAll<HTMLButtonElement>('.nim-stone');
  stones.forEach((s) => {
    const r = Number(s.dataset.row);
    const c = Number(s.dataset.col);
    const inRow = r === row;
    const rowSize = piles[r]!;
    const willTake = inRow && c >= col && c < rowSize;
    s.classList.toggle('nim-stone--preview', willTake);
  });
}

function clearPreview(): void {
  const stones = boardEl.querySelectorAll<HTMLButtonElement>('.nim-stone');
  stones.forEach((s) => s.classList.remove('nim-stone--preview'));
}

function onStoneClick(row: number, col: number): void {
  if (state !== 'playing' || turn !== 'human') return;
  const rowSize = piles[row]!;
  if (col >= rowSize) return;
  const take = rowSize - col;
  const ended = applyMove(row, take);
  if (ended) return;
  turn = 'ai';
  updateStatus();
  scheduleAi();
}

// Returns true when this move ended the game.
function applyMove(row: number, take: number): boolean {
  piles[row] = piles[row]! - take;
  render();
  if (totalStones() === 0) {
    state = 'over';
    if (turn === 'human') {
      scores.wins++;
      statusEl.textContent = `Kazandın! Son taşı sen aldın.  (${scores.wins}-${scores.losses})`;
      reportGameOver(SCORE_DESC, scores.wins, { label: 'Galibiyet' });
    } else {
      scores.losses++;
      statusEl.textContent = `Bilgisayar kazandı. Son taşı o aldı.  (${scores.wins}-${scores.losses})`;
    }
    saveScores();
    return true;
  }
  return false;
}

function scheduleAi(): void {
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing' || turn !== 'ai') return;
    const move = aiPick(piles);
    if (move.row < 0) return;
    const ended = applyMove(move.row, move.take);
    if (ended) return;
    turn = 'human';
    updateStatus();
  }, AI_DELAY_MS);
}

function updateStatus(): void {
  if (state === 'over') return;
  const score = `(${scores.wins}-${scores.losses})`;
  statusEl.textContent =
    turn === 'human' ? `Sıra: Sen  ${score}` : `Bilgisayar düşünüyor…  ${score}`;
}

function saveScores(): void {
  safeWrite(STORAGE_SCORE, scores);
}

function reset(): void {
  gen.bump();
  piles = [...INITIAL_PILES];
  turn = 'human';
  state = 'playing';
  updateStatus();
  render();
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  const raw = safeRead<Partial<Scores>>(STORAGE_SCORE, {});
  scores = {
    wins: Number(raw.wins) || 0,
    losses: Number(raw.losses) || 0,
  };

  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
