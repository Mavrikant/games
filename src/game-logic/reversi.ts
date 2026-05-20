// Reversi (Othello) — 8x8, human (black) vs AI (white).
// AI uses positional weighting (corner > edge > inner > X/C squares)
// combined with mobility — light heuristic, fast, no minimax tree.

const SIZE = 8;
const TOTAL = SIZE * SIZE;

// Board cells: 0 = empty, 1 = black (human), 2 = white (AI).
type Cell = 0 | 1 | 2;
type Player = 1 | 2;
type Board = Cell[];

// Eight directions for line traversal: (dr, dc).
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

// Positional weights — classic Reversi heuristic.
// Corners are gold; X and C squares (adjacent to corners) are dangerous;
// edges are decent; centre is mild.
const WEIGHTS: ReadonlyArray<number> = [
  120, -20,  20,   5,   5,  20, -20, 120,
  -20, -40,  -5,  -5,  -5,  -5, -40, -20,
   20,  -5,  15,   3,   3,  15,  -5,  20,
    5,  -5,   3,   3,   3,   3,  -5,   5,
    5,  -5,   3,   3,   3,   3,  -5,   5,
   20,  -5,  15,   3,   3,  15,  -5,  20,
  -20, -40,  -5,  -5,  -5,  -5, -40, -20,
  120, -20,  20,   5,   5,  20, -20, 120,
];

const STORAGE_WINS = 'reversi.wins';
const STORAGE_LOSSES = 'reversi.losses';

const AI_DELAY_MS = 420;

type GameState = 'PlayerTurn' | 'AiTurn' | 'GameOver';

const boardEl = document.querySelector<HTMLElement>('#rv-board')!;
const statusEl = document.querySelector<HTMLElement>('#rv-status')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#rv-restart')!;
const blackCountEl = document.querySelector<HTMLElement>('#rv-black-count')!;
const whiteCountEl = document.querySelector<HTMLElement>('#rv-white-count')!;
const winsEl = document.querySelector<HTMLElement>('#rv-wins')!;
const lossesEl = document.querySelector<HTMLElement>('#rv-losses')!;
const overlay = document.querySelector<HTMLElement>('#rv-overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#rv-overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#rv-overlay-msg')!;
const overlayRestart =
  document.querySelector<HTMLButtonElement>('#rv-overlay-restart')!;

let board: Board = new Array<Cell>(TOTAL).fill(0);
let cellEls: HTMLButtonElement[] = [];
let state: GameState = 'PlayerTurn';
let wins = 0;
let losses = 0;
// Generation token: any deferred AI / overlay callback bails if its token
// doesn't match the current gen. Reset/restart bumps this.
let gen = 0;

// -----------------------------------------------------------------------
// Storage (try/catch — Safari private mode etc. can throw).
// -----------------------------------------------------------------------
function safeReadNumber(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function safeWriteNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore (private mode, full disk, disabled) */
  }
}

// -----------------------------------------------------------------------
// Board geometry.
// -----------------------------------------------------------------------
function idx(r: number, c: number): number {
  return r * SIZE + c;
}

function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function opponent(p: Player): Player {
  return p === 1 ? 2 : 1;
}

// Returns the list of opponent cell indices that would be flipped if `p`
// played at (r, c). Empty array means the move is illegal.
function captures(b: Board, r: number, c: number, p: Player): number[] {
  if (!inBounds(r, c) || b[idx(r, c)] !== 0) return [];
  const opp = opponent(p);
  const captured: number[] = [];
  for (const [dr, dc] of DIRS) {
    const line: number[] = [];
    let rr = r + dr;
    let cc = c + dc;
    while (inBounds(rr, cc) && b[idx(rr, cc)] === opp) {
      line.push(idx(rr, cc));
      rr += dr;
      cc += dc;
    }
    // Need at least one opponent disc bracketed by our own disc.
    if (line.length > 0 && inBounds(rr, cc) && b[idx(rr, cc)] === p) {
      for (const k of line) captured.push(k);
    }
  }
  return captured;
}

function legalMoves(b: Board, p: Player): number[] {
  const moves: number[] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = idx(r, c);
      if (b[i] !== 0) continue;
      if (captures(b, r, c, p).length > 0) moves.push(i);
    }
  }
  return moves;
}

function countDiscs(b: Board): { black: number; white: number; empty: number } {
  let black = 0;
  let white = 0;
  let empty = 0;
  for (let i = 0; i < TOTAL; i++) {
    const v = b[i];
    if (v === 1) black++;
    else if (v === 2) white++;
    else empty++;
  }
  return { black, white, empty };
}

// Apply move in place. Caller guarantees the move is legal (captures > 0).
function applyMove(b: Board, i: number, p: Player): void {
  const r = Math.floor(i / SIZE);
  const c = i % SIZE;
  const flips = captures(b, r, c, p);
  if (flips.length === 0) return;
  b[i] = p;
  for (const k of flips) b[k] = p;
}

// -----------------------------------------------------------------------
// AI — greedy with positional weights + mobility tiebreaker.
// Fast (O(64 * 8) per evaluation) and produces a solid opponent without
// the latency or code-size of full minimax.
// -----------------------------------------------------------------------
function evaluateAfter(b: Board, move: number, p: Player): number {
  const sim = b.slice();
  applyMove(sim, move, p);
  let positional = 0;
  for (let i = 0; i < TOTAL; i++) {
    const v = sim[i]!;
    const w = WEIGHTS[i]!;
    if (v === p) positional += w;
    else if (v === opponent(p)) positional -= w;
  }
  // Mobility: more options for us, fewer for opponent → better.
  const ourMoves = legalMoves(sim, p).length;
  const oppMoves = legalMoves(sim, opponent(p)).length;
  const mobility = (ourMoves - oppMoves) * 8;
  // Slight randomisation so the AI doesn't always pick the lexically
  // first tied move — keeps games varied.
  const jitter = Math.random() * 0.5;
  return positional + mobility + jitter;
}

function chooseAiMove(b: Board): number | null {
  const moves = legalMoves(b, 2);
  if (moves.length === 0) return null;
  let best = moves[0]!;
  let bestScore = -Infinity;
  for (const m of moves) {
    const score = evaluateAfter(b, m, 2);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

// -----------------------------------------------------------------------
// Rendering.
// -----------------------------------------------------------------------
function buildBoard(): void {
  boardEl.innerHTML = '';
  cellEls = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rv-cell';
      btn.setAttribute('role', 'gridcell');
      btn.setAttribute('aria-label', `${r + 1}. satır, ${c + 1}. sütun`);
      btn.dataset.i = String(idx(r, c));
      btn.addEventListener('click', onCellClick);
      boardEl.appendChild(btn);
      cellEls.push(btn);
    }
  }
}

function renderBoard(): void {
  const playerMoves =
    state === 'PlayerTurn' ? new Set(legalMoves(board, 1)) : null;
  for (let i = 0; i < TOTAL; i++) {
    const el = cellEls[i]!;
    const v = board[i]!;
    el.classList.toggle('rv-cell--black', v === 1);
    el.classList.toggle('rv-cell--white', v === 2);
    el.classList.toggle(
      'rv-cell--legal',
      playerMoves !== null && playerMoves.has(i),
    );
    // Cells are disabled when not the player's turn or already occupied
    // or not a legal move. The overlay also guards via state.
    const isLegal = playerMoves !== null && playerMoves.has(i);
    el.disabled = !isLegal || state !== 'PlayerTurn';
    // Clear any text/children — disc is drawn via ::before.
    if (el.textContent !== '') el.textContent = '';
  }
}

function renderHud(): void {
  const { black, white } = countDiscs(board);
  blackCountEl.textContent = String(black);
  whiteCountEl.textContent = String(white);
  winsEl.textContent = String(wins);
  lossesEl.textContent = String(losses);
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('rv-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
  overlayRestart.focus({ preventScroll: true });
}

function hideOverlay(): void {
  overlay.classList.add('rv-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// -----------------------------------------------------------------------
// Turn flow.
// -----------------------------------------------------------------------
function endGame(): void {
  const { black, white } = countDiscs(board);
  state = 'GameOver';
  renderBoard();
  let title: string;
  let msg: string;
  if (black > white) {
    wins++;
    safeWriteNumber(STORAGE_WINS, wins);
    title = 'Kazandın!';
    msg = `Siyah ${black} – Beyaz ${white}.`;
  } else if (white > black) {
    losses++;
    safeWriteNumber(STORAGE_LOSSES, losses);
    title = 'Kaybettin.';
    msg = `Siyah ${black} – Beyaz ${white}.`;
  } else {
    title = 'Berabere.';
    msg = `Siyah ${black} – Beyaz ${white}.`;
  }
  renderHud();
  setStatus(`${title} ${msg}`);
  showOverlay(title, msg);
}

function startAiTurn(): void {
  // Already in AiTurn state by caller.
  const aiMoves = legalMoves(board, 2);
  if (aiMoves.length === 0) {
    // AI passes. Back to player if they have any move; otherwise game over.
    const playerMoves = legalMoves(board, 1);
    if (playerMoves.length === 0) {
      endGame();
      return;
    }
    state = 'PlayerTurn';
    setStatus('Beyaz pas geçti — sıra yine sende.');
    renderBoard();
    return;
  }
  const myGen = gen;
  setStatus('Beyaz düşünüyor…');
  window.setTimeout(() => {
    // Generation guard: if reset happened during the delay, bail.
    if (myGen !== gen) return;
    if (state !== 'AiTurn') return;
    const move = chooseAiMove(board);
    if (move === null) {
      // No move (shouldn't happen — we just checked above, but be safe).
      state = 'PlayerTurn';
      setStatus('Beyaz pas geçti — sıra yine sende.');
      renderBoard();
      return;
    }
    applyMove(board, move, 2);
    renderHud();
    // Check terminal / pass / hand back.
    const { empty } = countDiscs(board);
    if (empty === 0) {
      endGame();
      return;
    }
    const playerMoves = legalMoves(board, 1);
    if (playerMoves.length === 0) {
      // Player must pass; check if AI still has moves.
      const stillAi = legalMoves(board, 2);
      if (stillAi.length === 0) {
        endGame();
        return;
      }
      state = 'AiTurn';
      setStatus('Sen pas geçtin — sıra yine beyazda.');
      renderBoard();
      startAiTurn();
      return;
    }
    state = 'PlayerTurn';
    setStatus('Sıra sende — yasal hamleler vurgulandı.');
    renderBoard();
  }, AI_DELAY_MS);
}

function onCellClick(e: MouseEvent): void {
  // Overlay-input-leak guard: nothing happens unless it's the player's turn.
  if (state !== 'PlayerTurn') return;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target) return;
  const i = Number(target.dataset.i);
  if (!Number.isInteger(i) || i < 0 || i >= TOTAL) return;
  if (board[i] !== 0) return;
  const r = Math.floor(i / SIZE);
  const c = i % SIZE;
  const flips = captures(board, r, c, 1);
  if (flips.length === 0) return; // illegal: no captures
  // Apply move.
  board[i] = 1;
  for (const k of flips) board[k] = 1;
  renderHud();
  // Determine next phase.
  const { empty } = countDiscs(board);
  if (empty === 0) {
    endGame();
    return;
  }
  const aiMoves = legalMoves(board, 2);
  if (aiMoves.length === 0) {
    // AI passes; if player still has moves, stay on player; else game over.
    const playerMoves = legalMoves(board, 1);
    if (playerMoves.length === 0) {
      endGame();
      return;
    }
    state = 'PlayerTurn';
    setStatus('Beyaz pas geçti — sıra yine sende.');
    renderBoard();
    return;
  }
  state = 'AiTurn';
  renderBoard();
  startAiTurn();
}

// -----------------------------------------------------------------------
// Reset / boot.
// -----------------------------------------------------------------------
function setupInitialPosition(): void {
  board = new Array<Cell>(TOTAL).fill(0);
  // Standard Reversi opening: white on (3,3) & (4,4), black on (3,4) & (4,3).
  board[idx(3, 3)] = 2;
  board[idx(4, 4)] = 2;
  board[idx(3, 4)] = 1;
  board[idx(4, 3)] = 1;
}

function reset(): void {
  // Bump generation: cancels any pending AI setTimeout from the prior game.
  gen++;
  setupInitialPosition();
  state = 'PlayerTurn';
  hideOverlay();
  setStatus('Sıra sende — yasal hamleler vurgulandı.');
  renderHud();
  renderBoard();
}

// -----------------------------------------------------------------------
// Wire up.
// -----------------------------------------------------------------------
wins = safeReadNumber(STORAGE_WINS);
losses = safeReadNumber(STORAGE_LOSSES);

restartBtn.addEventListener('click', reset);
overlayRestart.addEventListener('click', reset);

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    reset();
    e.preventDefault();
  } else if (e.key === 'Enter' && state === 'GameOver') {
    reset();
    e.preventDefault();
  }
});

buildBoard();
reset();
