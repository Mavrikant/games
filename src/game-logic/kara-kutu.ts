import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';

// Kara Kutu — classic Black Box deduction puzzle.
// 8×8 hidden grid, 4 atoms placed at random. Player fires rays from edge
// ports; each ray ends as: Hit (absorbed by atom directly ahead),
// Reflection (bounced back out entry port — either edge or double-deflect),
// or Exit through some other port (paired with entry by letter).
// Goal: place exactly 4 markers on the cells you think hold atoms,
// then Solve. Score = shots used; lower is better.

const N = 8;
const ATOM_COUNT = 4;
const STORAGE_BEST = 'kara-kutu.best';

// Directions: 0=N (-1,0), 1=E (0,1), 2=S (1,0), 3=W (0,-1)
type Dir = 0 | 1 | 2 | 3;
const DR: readonly number[] = [-1, 0, 1, 0];
const DC: readonly number[] = [0, 1, 0, -1];
const turnLeft = (d: Dir): Dir => ((d + 3) % 4) as Dir;
const turnRight = (d: Dir): Dir => ((d + 1) % 4) as Dir;
const reverse = (d: Dir): Dir => ((d + 2) % 4) as Dir;

type Side = 'top' | 'right' | 'bottom' | 'left';

interface PortKey {
  side: Side;
  idx: number; // 0..N-1
}

interface RayHit {
  type: 'hit';
}
interface RayReflection {
  type: 'reflection';
}
interface RayExit {
  type: 'exit';
  exit: PortKey;
}
type RayResult = RayHit | RayReflection | RayExit;

interface PortMark {
  // What this port displays. Empty = not shot yet.
  // 'H' = hit absorbed, 'R' = reflection, or letter 'A'/'B'/... for paired exit.
  text: string;
  kind: 'empty' | 'hit' | 'refl' | 'pair';
}

type GameState = 'playing' | 'solved' | 'failed';

let atoms: Set<string> = new Set();
let portMarks = new Map<string, PortMark>();
let guesses = new Set<string>();
let shots = 0;
let pairLetterIndex = 0;
let best = Number.POSITIVE_INFINITY;
let state: GameState = 'playing';

// DOM
let boardEl!: HTMLElement;
let shotsEl!: HTMLElement;
let bestEl!: HTMLElement;
let statusEl!: HTMLElement;
let solveBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

// Skip I and O to avoid confusing with 1/0 and the H/R marker letters.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function cellKey(r: number, c: number): string {
  return `${r},${c}`;
}

function portKeyStr(p: PortKey): string {
  return `${p.side},${p.idx}`;
}

function placeAtoms(): void {
  atoms = new Set();
  while (atoms.size < ATOM_COUNT) {
    const r = Math.floor(Math.random() * N);
    const c = Math.floor(Math.random() * N);
    atoms.add(cellKey(r, c));
  }
}

function hasAtomAt(r: number, c: number): boolean {
  if (r < 0 || r >= N || c < 0 || c >= N) return false;
  return atoms.has(cellKey(r, c));
}

// Start cell/dir for a ray entering through a port.
function portStart(p: PortKey): { r: number; c: number; d: Dir } {
  switch (p.side) {
    case 'top':
      return { r: -1, c: p.idx, d: 2 };
    case 'bottom':
      return { r: N, c: p.idx, d: 0 };
    case 'left':
      return { r: p.idx, c: -1, d: 1 };
    case 'right':
      return { r: p.idx, c: N, d: 3 };
  }
}

// Convert an in-bounds (r, c) about to step out via direction d into a port.
function exitPort(r: number, c: number, d: Dir): PortKey {
  if (d === 0) return { side: 'top', idx: c };
  if (d === 1) return { side: 'right', idx: r };
  if (d === 2) return { side: 'bottom', idx: c };
  return { side: 'left', idx: r };
}

function samePort(a: PortKey, b: PortKey): boolean {
  return a.side === b.side && a.idx === b.idx;
}

function traceRay(entry: PortKey): RayResult {
  const { r: sr, c: sc, d: sd } = portStart(entry);
  let r = sr,
    c = sc,
    d: Dir = sd;
  let entered = false;
  // Safety: an 8x8 with 4 atoms can have long bounces, but is bounded.
  // 4096 iterations is well beyond any reachable trajectory.
  for (let i = 0; i < 4096; i++) {
    const nr = r + DR[d]!;
    const nc = c + DC[d]!;

    // About to step out of bounds → exit (or reflection if never entered).
    if (nr < 0 || nr >= N || nc < 0 || nc >= N) {
      if (!entered) return { type: 'reflection' };
      const ex = exitPort(r, c, d);
      if (samePort(ex, entry)) return { type: 'reflection' };
      return { type: 'exit', exit: ex };
    }

    // Atom directly ahead → absorbed.
    if (hasAtomAt(nr, nc)) return { type: 'hit' };

    // Look at diagonals (perpendicular sides of the next cell).
    const ld = turnLeft(d);
    const rd = turnRight(d);
    const atomL = hasAtomAt(nr + DR[ld]!, nc + DC[ld]!);
    const atomR = hasAtomAt(nr + DR[rd]!, nc + DC[rd]!);

    if (atomL && atomR) {
      d = reverse(d);
    } else if (atomL) {
      d = turnRight(d);
    } else if (atomR) {
      d = turnLeft(d);
    } else {
      r = nr;
      c = nc;
      entered = true;
    }
  }
  return { type: 'reflection' };
}

function setPortMark(p: PortKey, mark: PortMark): void {
  portMarks.set(portKeyStr(p), mark);
}

function fireRay(p: PortKey): void {
  if (state !== 'playing') return;
  if (portMarks.has(portKeyStr(p))) return; // already shot from this port

  shots++;
  shotsEl.textContent = String(shots);

  const result = traceRay(p);
  if (result.type === 'hit') {
    setPortMark(p, { text: 'H', kind: 'hit' });
  } else if (result.type === 'reflection') {
    setPortMark(p, { text: 'R', kind: 'refl' });
  } else {
    const exit = result.exit;
    const existing = portMarks.get(portKeyStr(exit));
    if (existing && existing.kind === 'pair') {
      // Bidirectional rays produce identical exit; reuse the letter.
      setPortMark(p, { text: existing.text, kind: 'pair' });
    } else {
      const letter = LETTERS[pairLetterIndex % LETTERS.length]!;
      pairLetterIndex++;
      setPortMark(p, { text: letter, kind: 'pair' });
      setPortMark(exit, { text: letter, kind: 'pair' });
    }
  }
  renderPorts();
  updateSolveButton();
  statusEl.textContent = `${shots} atış · ${guesses.size}/${ATOM_COUNT} işaret · 'Çöz' için 4 işaret koy.`;
  statusEl.className = 'kk-status';
}

function toggleGuess(r: number, c: number): void {
  if (state !== 'playing') return;
  const key = cellKey(r, c);
  if (guesses.has(key)) guesses.delete(key);
  else if (guesses.size < ATOM_COUNT) guesses.add(key);
  // 4 işareti aştıysa sessizce yoksay
  renderInner();
  updateSolveButton();
  if (state === 'playing') {
    statusEl.textContent = `${shots} atış · ${guesses.size}/${ATOM_COUNT} işaret · 'Çöz' için 4 işaret koy.`;
    statusEl.className = 'kk-status';
  }
}

function updateSolveButton(): void {
  solveBtn.disabled = state !== 'playing' || guesses.size !== ATOM_COUNT;
}

function solve(): void {
  if (state !== 'playing') return;
  if (guesses.size !== ATOM_COUNT) return;
  // Compare guesses vs atoms.
  let correct = 0;
  for (const k of guesses) if (atoms.has(k)) correct++;
  if (correct === ATOM_COUNT) {
    state = 'solved';
    if (shots < best) {
      best = shots;
      safeWrite(STORAGE_BEST, best);
      bestEl.textContent = String(best);
    }
    statusEl.textContent = `Çözüldü! ${shots} atış. Rekor: ${best}. R ile yeni oyun.`;
    statusEl.className = 'kk-status kk-status--win';
  } else {
    state = 'failed';
    statusEl.textContent = `${correct}/${ATOM_COUNT} doğru. Yeşil halkalar kaçırdıkların, kırmızılar yanlış. R ile yeni oyun.`;
    statusEl.className = 'kk-status kk-status--fail';
  }
  renderInner();
  renderPorts();
  updateSolveButton();
}

function newGame(): void {
  placeAtoms();
  portMarks = new Map();
  guesses = new Set();
  shots = 0;
  pairLetterIndex = 0;
  state = 'playing';
  shotsEl.textContent = '0';
  statusEl.textContent = `4 atom gizli. Portlara tıkla, izleri oku.`;
  statusEl.className = 'kk-status';
  renderPorts();
  renderInner();
  updateSolveButton();
}

// ------- rendering -------

function renderPorts(): void {
  const ports = boardEl.querySelectorAll<HTMLButtonElement>('.kk-cell--port');
  for (const el of ports) {
    const side = el.dataset.side as Side;
    const idx = Number(el.dataset.idx);
    const mark = portMarks.get(`${side},${idx}`);
    el.classList.remove(
      'kk-cell--port-hit',
      'kk-cell--port-refl',
      'kk-cell--port-pair',
    );
    if (!mark) {
      el.textContent = '';
      el.disabled = state !== 'playing';
    } else {
      el.textContent = mark.text;
      el.disabled = true;
      if (mark.kind === 'hit') el.classList.add('kk-cell--port-hit');
      else if (mark.kind === 'refl') el.classList.add('kk-cell--port-refl');
      else el.classList.add('kk-cell--port-pair');
    }
  }
}

function renderInner(): void {
  const inner = boardEl.querySelectorAll<HTMLButtonElement>('.kk-cell--inner');
  for (const el of inner) {
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    const key = cellKey(r, c);
    const guessed = guesses.has(key);
    const isAtom = atoms.has(key);
    el.classList.remove(
      'kk-cell--guess',
      'kk-cell--atom',
      'kk-cell--wrong',
      'kk-cell--missed',
    );
    if (state === 'playing') {
      if (guessed) el.classList.add('kk-cell--guess');
      el.disabled = false;
    } else {
      // Reveal atoms; mark wrong/missed.
      if (guessed && isAtom) el.classList.add('kk-cell--atom');
      else if (guessed && !isAtom) el.classList.add('kk-cell--wrong');
      else if (!guessed && isAtom)
        el.classList.add('kk-cell--atom', 'kk-cell--missed');
      el.disabled = true;
    }
  }
}

function buildBoard(): void {
  boardEl.replaceChildren();
  const frag = document.createDocumentFragment();
  // 10x10 cells.
  for (let row = 0; row < N + 2; row++) {
    for (let col = 0; col < N + 2; col++) {
      const isCornerRow = row === 0 || row === N + 1;
      const isCornerCol = col === 0 || col === N + 1;
      const isCorner = isCornerRow && isCornerCol;
      const isTopPort = row === 0 && !isCornerCol;
      const isBottomPort = row === N + 1 && !isCornerCol;
      const isLeftPort = col === 0 && !isCornerRow;
      const isRightPort = col === N + 1 && !isCornerRow;
      const isPort = isTopPort || isBottomPort || isLeftPort || isRightPort;

      const el = document.createElement('button');
      el.type = 'button';
      el.classList.add('kk-cell');

      if (isCorner) {
        el.classList.add('kk-cell--corner');
        el.disabled = true;
        el.tabIndex = -1;
        el.setAttribute('aria-hidden', 'true');
      } else if (isPort) {
        el.classList.add('kk-cell--port');
        let side: Side = 'top';
        let idx = 0;
        if (isTopPort) {
          side = 'top';
          idx = col - 1;
        } else if (isBottomPort) {
          side = 'bottom';
          idx = col - 1;
        } else if (isLeftPort) {
          side = 'left';
          idx = row - 1;
        } else if (isRightPort) {
          side = 'right';
          idx = row - 1;
        }
        el.dataset.side = side;
        el.dataset.idx = String(idx);
        el.setAttribute('aria-label', `${side} port ${idx + 1}`);
        el.addEventListener('click', () => fireRay({ side, idx }));
      } else {
        const r = row - 1;
        const c = col - 1;
        el.classList.add('kk-cell--inner');
        el.dataset.r = String(r);
        el.dataset.c = String(c);
        el.setAttribute(
          'aria-label',
          `iç hücre satır ${r + 1} sütun ${c + 1}`,
        );
        el.addEventListener('click', () => toggleGuess(r, c));
      }
      frag.appendChild(el);
    }
  }
  boardEl.appendChild(frag);
}

function onKey(e: KeyboardEvent): void {
  if (e.key.toLowerCase() === 'r') {
    e.preventDefault();
    newGame();
  }
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  shotsEl = document.querySelector<HTMLElement>('#shots')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  solveBtn = document.querySelector<HTMLButtonElement>('#solve')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  const stored = safeRead<number>(STORAGE_BEST, 0);
  if (stored > 0) {
    best = stored;
    bestEl.textContent = String(best);
  }

  solveBtn.addEventListener('click', solve);
  restartBtn.addEventListener('click', newGame);
  window.addEventListener('keydown', onKey);

  buildBoard();
  newGame();
}

export const game = defineGame({ init, reset: newGame });
