type Mark = 'X' | 'O' | '';
type Board = Mark[];

const LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const STORAGE_KEY = 'xox.scores';

interface Scores {
  x: number;
  o: number;
  d: number;
}

const cellEls = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.cell'),
);
const statusEl = document.querySelector<HTMLElement>('#status')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const scoreXEl = document.querySelector<HTMLElement>('#score-x')!;
const scoreOEl = document.querySelector<HTMLElement>('#score-o')!;
const scoreDEl = document.querySelector<HTMLElement>('#score-d')!;

let board: Board = Array(9).fill('') as Board;
let scores: Scores = loadScores();
let humanTurn = true;
let gameOver = false;

function loadScores(): Scores {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { x: 0, o: 0, d: 0 };
    const parsed = JSON.parse(raw) as Partial<Scores>;
    return {
      x: Number(parsed.x) || 0,
      o: Number(parsed.o) || 0,
      d: Number(parsed.d) || 0,
    };
  } catch {
    return { x: 0, o: 0, d: 0 };
  }
}

function saveScores(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
  } catch {
    /* ignore */
  }
}

function renderScores(): void {
  scoreXEl.textContent = String(scores.x);
  scoreOEl.textContent = String(scores.o);
  scoreDEl.textContent = String(scores.d);
}

function winnerOf(b: Board): { mark: Mark; line: readonly number[] } | null {
  for (const line of LINES) {
    const [a, b1, c] = line;
    if (b[a] && b[a] === b[b1] && b[a] === b[c]) {
      return { mark: b[a]!, line };
    }
  }
  return null;
}

function isFull(b: Board): boolean {
  return b.every((c) => c !== '');
}

function emptyCells(b: Board): number[] {
  const out: number[] = [];
  b.forEach((c, i) => {
    if (c === '') out.push(i);
  });
  return out;
}

function findWinningMove(b: Board, mark: Mark): number | null {
  for (const i of emptyCells(b)) {
    const next = [...b];
    next[i] = mark;
    if (winnerOf(next)?.mark === mark) return i;
  }
  return null;
}

function aiMove(): number {
  const win = findWinningMove(board, 'O');
  if (win !== null) return win;
  const block = findWinningMove(board, 'X');
  if (block !== null) return block;
  if (board[4] === '') return 4;
  const corners = [0, 2, 6, 8].filter((i) => board[i] === '');
  if (corners.length > 0) {
    return corners[Math.floor(Math.random() * corners.length)]!;
  }
  const rest = emptyCells(board);
  return rest[Math.floor(Math.random() * rest.length)]!;
}

function render(): void {
  cellEls.forEach((el, i) => {
    const mark = board[i] ?? '';
    el.textContent = mark;
    el.classList.toggle('cell--x', mark === 'X');
    el.classList.toggle('cell--o', mark === 'O');
    el.classList.remove('cell--win');
    el.disabled = mark !== '' || gameOver || !humanTurn;
  });
}

function endGame(result: 'x' | 'o' | 'd', line?: readonly number[]): void {
  gameOver = true;
  if (line) {
    for (const i of line) {
      cellEls[i]?.classList.add('cell--win');
    }
  }
  if (result === 'x') {
    scores.x++;
    statusEl.textContent = 'Kazandın!';
  } else if (result === 'o') {
    scores.o++;
    statusEl.textContent = 'Bilgisayar kazandı.';
  } else {
    scores.d++;
    statusEl.textContent = 'Berabere.';
  }
  saveScores();
  renderScores();
  cellEls.forEach((el) => {
    el.disabled = true;
  });
}

function checkEndOrAdvance(): void {
  const w = winnerOf(board);
  if (w) {
    endGame(w.mark === 'X' ? 'x' : 'o', w.line);
    return;
  }
  if (isFull(board)) {
    endGame('d');
    return;
  }
  humanTurn = !humanTurn;
  statusEl.textContent = humanTurn ? 'Sıra: Sen (X)' : 'Bilgisayar düşünüyor…';
  render();
  if (!humanTurn) {
    setTimeout(() => {
      const i = aiMove();
      board[i] = 'O';
      checkEndOrAdvance();
    }, 300);
  }
}

function playHuman(i: number): void {
  if (gameOver || !humanTurn || board[i] !== '') return;
  board[i] = 'X';
  checkEndOrAdvance();
}

function reset(): void {
  board = Array(9).fill('') as Board;
  humanTurn = true;
  gameOver = false;
  statusEl.textContent = 'Sıra: Sen (X)';
  render();
}

cellEls.forEach((el, i) => {
  el.addEventListener('click', () => playHuman(i));
});
restartBtn.addEventListener('click', reset);
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r') reset();
});

renderScores();
reset();
