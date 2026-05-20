// Mangala — Türk Mancala
//
// Board layout (indices in `pits` array, 14 slots):
//
//          AI side (indices 12 → 7, sown CCW from player view)
//
//   [13] +-----+-----+-----+-----+-----+-----+ [ 6]
//        | 12  | 11  | 10  |  9  |  8  |  7  |
//   AI   +-----+-----+-----+-----+-----+-----+   YOU
//   store|  0  |  1  |  2  |  3  |  4  |  5  | store
//        +-----+-----+-----+-----+-----+-----+
//
//          YOU side (indices 0 → 5, sown CCW)
//
// Sowing direction (CCW from player view):
//   you[0] → you[1] → you[2] → you[3] → you[4] → you[5] →
//   your store (6) → ai[7] → ai[8] → ai[9] → ai[10] → ai[11] → ai[12] →
//   (skip AI store 13) → loop back to you[0]
//
// Pit indices: 0..5 player, 6 player store, 7..12 AI, 13 AI store.
//
// Rules implemented (Türk Mangala — simplified classic):
//   * Each small pit starts with 4 stones; stores start at 0.
//   * On your turn: pick one of your non-empty pits 0..5. Drop ONE stone
//     in the source pit (Türk varyantı; "first stone stays"), then sow
//     remaining stones one-by-one CCW. Your store counts; opponent store
//     is skipped.
//   * If the last stone lands in your store → extra turn.
//   * If the last stone lands in an empty pit on YOUR side → capture
//     that stone + all stones in the opposite AI pit into your store.
//   * If the last stone lands in a pit on OPPONENT side and the new total
//     in that pit is EVEN (2, 4, 6, …) → capture ALL stones in that pit
//     into your store (Türk-kuralı çift sayı çekme).
//   * Game ends when one side's 6 small pits are entirely empty. The
//     opponent's remaining stones go into the opponent's store. Player
//     with more stones in store wins.
//
// AI: minimax with depth 2 + heuristic (store diff + on-board diff).

const PITS = 14;
const PLAYER_STORE = 6;
const AI_STORE = 13;

// Standard CCW order from each pit; precomputed for clarity & speed.
// next[i] = where a sown stone from pit i moves to (raw ring order).
// The applyMove function additionally skips the opponent's store.
const NEXT: ReadonlyArray<number> = [
  /* 0 */ 1,
  /* 1 */ 2,
  /* 2 */ 3,
  /* 3 */ 4,
  /* 4 */ 5,
  /* 5 */ 6, // player store (next from player pit 5)
  /* 6 player store */ 7, // → AI pit 7
  /* 7 */ 8,
  /* 8 */ 9,
  /* 9 */ 10,
  /* 10 */ 11,
  /* 11 */ 12,
  /* 12 */ 13, // → AI store
  /* 13 AI store */ 0, // → player pit 0
];

// Opposite-side index for capture rule. Mirrors across the board.
// you[0] ↔ ai[12], you[1] ↔ ai[11], …, you[5] ↔ ai[7].
const OPPOSITE: ReadonlyArray<number> = [
  /* 0 */ 12,
  /* 1 */ 11,
  /* 2 */ 10,
  /* 3 */ 9,
  /* 4 */ 8,
  /* 5 */ 7,
  /* 6 */ -1,
  /* 7 */ 5,
  /* 8 */ 4,
  /* 9 */ 3,
  /* 10 */ 2,
  /* 11 */ 1,
  /* 12 */ 0,
  /* 13 */ -1,
];

type Side = 0 | 1; // 0 = player (you), 1 = AI
type GameState = 'PlayerTurn' | 'AiTurn' | 'GameOver';

const STORAGE_WINS = 'mangala.wins';
const STORAGE_LOSSES = 'mangala.losses';

const AI_DELAY_MS = 480;

// --- DOM ---
const youStoreEl = document.querySelector<HTMLElement>('#mg-store-you')!;
const aiStoreEl = document.querySelector<HTMLElement>('#mg-store-ai')!;
const youStoreHud = document.querySelector<HTMLElement>('#mg-you-store')!;
const aiStoreHud = document.querySelector<HTMLElement>('#mg-ai-store')!;
const winsEl = document.querySelector<HTMLElement>('#mg-wins')!;
const lossesEl = document.querySelector<HTMLElement>('#mg-losses')!;
const statusEl = document.querySelector<HTMLElement>('#mg-status')!;
const rowAiEl = document.querySelector<HTMLElement>('#mg-row-ai')!;
const rowYouEl = document.querySelector<HTMLElement>('#mg-row-you')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#mg-restart')!;
const overlay = document.querySelector<HTMLElement>('#mg-overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#mg-overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#mg-overlay-msg')!;
const overlayRestart =
  document.querySelector<HTMLButtonElement>('#mg-overlay-restart')!;

// --- State ---
let pits: number[] = new Array<number>(PITS).fill(0);
let state: GameState = 'PlayerTurn';
let wins = 0;
let losses = 0;
// Generation token — any deferred AI / animation callback bails if its
// token doesn't match. reset() bumps it.
let gen = 0;

// DOM cell handles per pit index.
const pitEls: (HTMLButtonElement | null)[] = new Array<HTMLButtonElement | null>(
  PITS,
).fill(null);

// ----------------------------------------------------------------------
// Storage (try/catch — Safari private mode etc. throws).
// ----------------------------------------------------------------------
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

// ----------------------------------------------------------------------
// Pure rules engine (operates on `number[]`, no DOM).
// ----------------------------------------------------------------------
function makeInitialPits(): number[] {
  const p = new Array<number>(PITS).fill(0);
  // Each of the 12 small pits starts with 4 stones.
  for (let i = 0; i < PITS; i++) {
    if (i === PLAYER_STORE || i === AI_STORE) continue;
    p[i] = 4;
  }
  return p;
}

function isOwnPit(side: Side, i: number): boolean {
  if (i === PLAYER_STORE || i === AI_STORE) return false;
  return side === 0 ? i >= 0 && i <= 5 : i >= 7 && i <= 12;
}

function storeOf(side: Side): number {
  return side === 0 ? PLAYER_STORE : AI_STORE;
}

function opponentStore(side: Side): number {
  return side === 0 ? AI_STORE : PLAYER_STORE;
}

// Sum of stones in a side's six small pits.
function sumSide(p: ReadonlyArray<number>, side: Side): number {
  let s = 0;
  if (side === 0) {
    for (let i = 0; i <= 5; i++) s += p[i]!;
  } else {
    for (let i = 7; i <= 12; i++) s += p[i]!;
  }
  return s;
}

// Returns the list of legal source-pit indices for `side`.
function legalMoves(p: ReadonlyArray<number>, side: Side): number[] {
  const out: number[] = [];
  if (side === 0) {
    for (let i = 0; i <= 5; i++) if (p[i]! > 0) out.push(i);
  } else {
    for (let i = 7; i <= 12; i++) if (p[i]! > 0) out.push(i);
  }
  return out;
}

// Apply a move (Türk Mangala). Mutates `p`. Returns:
//   { lastIndex, extraTurn, gameOver }
//
// Rules summary (see file header):
//   * One stone stays in the source pit.
//   * Sow remaining stones CCW; skip opponent store.
//   * Extra turn if last stone in own store.
//   * Capture if last stone lands in own empty pit (own + opposite into store).
//   * Capture if last stone lands on opponent side and resulting pit count
//     is even (entire pit into own store).
//   * If after the move one side has no stones in pits, end the game and
//     sweep the opponent's pits into the opponent's store.
function applyMove(
  p: number[],
  side: Side,
  from: number,
): { lastIndex: number; extraTurn: boolean; gameOver: boolean } {
  // Caller must guarantee legality (own pit + non-empty).
  const stones = p[from]!;
  // Türk varyantı: first stone stays in source.
  p[from] = 1;
  let remaining = stones - 1;
  let i = from;
  while (remaining > 0) {
    i = NEXT[i]!;
    if (i === opponentStore(side)) {
      // Should not happen — NEXT[12] skips AI_STORE for player side; and
      // NEXT[5] for AI side... wait: AI sowing crosses player store too.
      // Defensive skip.
      i = NEXT[i]!;
    }
    p[i] = p[i]! + 1;
    remaining--;
  }
  const last = i;

  // Extra turn: last stone in own store.
  let extraTurn = false;
  if (last === storeOf(side)) {
    extraTurn = true;
  } else if (
    isOwnPit(side, last) &&
    p[last] === 1 &&
    last !== from &&
    stones > 1
  ) {
    // Capture on own side: pit was empty BEFORE the last sown stone.
    // We guard with `last !== from` and `stones > 1` so the no-sow case
    // (source pit with 1 stone played) doesn't fake-capture. Likewise,
    // a single-stone wrap-around can't land back on source as 1 because
    // sowing-through-source would deposit a stone (making it ≥ 2).
    const opp = OPPOSITE[last]!;
    const oppCount = p[opp]!;
    if (oppCount > 0) {
      p[storeOf(side)] = p[storeOf(side)]! + p[last]! + oppCount;
      p[last] = 0;
      p[opp] = 0;
    }
    // If opposite is empty, no capture (still a placed stone there, per
    // standard Turkish rule: capture only fires when opposite has stones).
  } else if (!isOwnPit(side, last) && last !== AI_STORE && last !== PLAYER_STORE) {
    // Last stone landed on opponent's pit. Türk-kuralı: if resulting count
    // is even (2, 4, 6, …), capture entire pit.
    if (p[last]! % 2 === 0 && p[last]! > 0) {
      p[storeOf(side)] = p[storeOf(side)]! + p[last]!;
      p[last] = 0;
    }
  }

  // Check end-of-game: one side's small pits all empty.
  const youEmpty = sumSide(p, 0) === 0;
  const aiEmpty = sumSide(p, 1) === 0;
  let gameOver = false;
  if (youEmpty || aiEmpty) {
    // Sweep remaining stones into the side that still has them
    // (this is the "last mover" / "owner of remaining" rule — Türk).
    if (youEmpty) {
      // Sweep AI pits → AI store.
      for (let k = 7; k <= 12; k++) {
        p[AI_STORE] = p[AI_STORE]! + p[k]!;
        p[k] = 0;
      }
    } else {
      // Sweep player pits → player store.
      for (let k = 0; k <= 5; k++) {
        p[PLAYER_STORE] = p[PLAYER_STORE]! + p[k]!;
        p[k] = 0;
      }
    }
    gameOver = true;
  }

  return { lastIndex: last, extraTurn, gameOver };
}

// ----------------------------------------------------------------------
// AI — minimax with depth 2 (player turn after AI move counts as "ply").
// ----------------------------------------------------------------------
function evaluate(p: ReadonlyArray<number>, side: Side): number {
  // Maximize own store - opponent store; small bonus for stones still on
  // own side (potential captures).
  const own = p[storeOf(side)]!;
  const opp = p[opponentStore(side)]!;
  const ownSide = sumSide(p, side);
  const oppSide = sumSide(p, side === 0 ? 1 : 0);
  return (own - opp) * 4 + (ownSide - oppSide);
}

function minimax(
  p: ReadonlyArray<number>,
  side: Side,
  rootSide: Side,
  depth: number,
): number {
  if (depth === 0 || sumSide(p, 0) === 0 || sumSide(p, 1) === 0) {
    return evaluate(p, rootSide);
  }
  const moves = legalMoves(p, side);
  if (moves.length === 0) {
    return evaluate(p, rootSide);
  }
  const isMax = side === rootSide;
  let best = isMax ? -Infinity : Infinity;
  for (const m of moves) {
    const sim = p.slice();
    const res = applyMove(sim, side, m);
    let nextSide: Side;
    if (res.gameOver) {
      nextSide = side; // doesn't matter — depth 0 will trigger
    } else if (res.extraTurn) {
      nextSide = side;
    } else {
      nextSide = side === 0 ? 1 : 0;
    }
    // If we just took an extra turn we don't decrement depth — the same
    // ply hasn't ended. But cap by safety: if extra turn keeps happening,
    // bound recursion with a tiny -0.1 step.
    const nextDepth =
      res.extraTurn && !res.gameOver ? depth : depth - 1;
    const score = minimax(sim, nextSide, rootSide, nextDepth);
    if (isMax) {
      if (score > best) best = score;
    } else {
      if (score < best) best = score;
    }
  }
  return best;
}

function chooseAiMove(p: ReadonlyArray<number>): number | null {
  const moves = legalMoves(p, 1);
  if (moves.length === 0) return null;
  let best = moves[0]!;
  let bestScore = -Infinity;
  for (const m of moves) {
    const sim = p.slice();
    const res = applyMove(sim, 1, m);
    let nextSide: Side;
    if (res.gameOver) {
      nextSide = 1;
    } else if (res.extraTurn) {
      nextSide = 1;
    } else {
      nextSide = 0;
    }
    const nextDepth = res.extraTurn && !res.gameOver ? 2 : 1;
    const score = minimax(sim, nextSide, 1, nextDepth);
    // Tiny jitter to avoid always picking the lexically-first tied move.
    const jitter = Math.random() * 0.2;
    if (score + jitter > bestScore) {
      bestScore = score + jitter;
      best = m;
    }
  }
  return best;
}

// ----------------------------------------------------------------------
// Rendering.
// ----------------------------------------------------------------------
function buildBoard(): void {
  rowAiEl.innerHTML = '';
  rowYouEl.innerHTML = '';
  for (let i = 0; i < PITS; i++) pitEls[i] = null;

  // AI row: visually goes left → right but contains AI pits 12 → 7 (so
  // that the AI's pit nearest the player's store sits beneath the player's
  // pit 5, mirroring a real mancala board).
  for (let c = 0; c < 6; c++) {
    const i = 12 - c; // 12, 11, 10, 9, 8, 7
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mg-pit mg-pit--ai';
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-label', `AI çukuru, ${c + 1}. sıra`);
    btn.disabled = true; // AI pits never accept clicks
    btn.dataset.i = String(i);
    const count = document.createElement('span');
    count.className = 'mg-pit__count';
    count.textContent = '0';
    btn.appendChild(count);
    rowAiEl.appendChild(btn);
    pitEls[i] = btn;
  }

  // Player row: 0..5 left → right (CCW means stones flow rightward).
  for (let c = 0; c < 6; c++) {
    const i = c;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mg-pit mg-pit--you';
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-label', `Senin çukurun, ${c + 1}. sıra`);
    btn.dataset.i = String(i);
    btn.addEventListener('click', onPitClick);
    const count = document.createElement('span');
    count.className = 'mg-pit__count';
    count.textContent = '0';
    btn.appendChild(count);
    rowYouEl.appendChild(btn);
    pitEls[i] = btn;
  }
}

function renderPits(): void {
  const playable = state === 'PlayerTurn';
  for (let i = 0; i < PITS; i++) {
    if (i === PLAYER_STORE || i === AI_STORE) continue;
    const el = pitEls[i];
    if (!el) continue;
    const count = pits[i]!;
    const countSpan = el.querySelector<HTMLElement>('.mg-pit__count');
    if (countSpan) countSpan.textContent = String(count);
    el.classList.toggle('mg-pit--empty', count === 0);
    if (i >= 0 && i <= 5) {
      const legal = playable && count > 0;
      el.disabled = !legal;
      el.classList.toggle('mg-pit--legal', legal);
    }
  }
  youStoreEl.textContent = String(pits[PLAYER_STORE]!);
  aiStoreEl.textContent = String(pits[AI_STORE]!);
  youStoreHud.textContent = String(pits[PLAYER_STORE]!);
  aiStoreHud.textContent = String(pits[AI_STORE]!);
}

function renderHudWins(): void {
  winsEl.textContent = String(wins);
  lossesEl.textContent = String(losses);
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('mg-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
  overlayRestart.focus({ preventScroll: true });
}

function hideOverlay(): void {
  overlay.classList.add('mg-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// ----------------------------------------------------------------------
// Turn flow.
// ----------------------------------------------------------------------
function endGame(): void {
  state = 'GameOver';
  renderPits();
  const you = pits[PLAYER_STORE]!;
  const ai = pits[AI_STORE]!;
  let title: string;
  let msg: string;
  if (you > ai) {
    wins++;
    safeWriteNumber(STORAGE_WINS, wins);
    title = 'Kazandın!';
    msg = `Sen ${you} – AI ${ai}.`;
  } else if (ai > you) {
    losses++;
    safeWriteNumber(STORAGE_LOSSES, losses);
    title = 'Kaybettin.';
    msg = `Sen ${you} – AI ${ai}.`;
  } else {
    title = 'Berabere.';
    msg = `Sen ${you} – AI ${ai}.`;
  }
  renderHudWins();
  setStatus(`${title} ${msg}`);
  showOverlay(title, msg);
}

function startAiTurn(): void {
  if (state !== 'AiTurn') return;
  const myGen = gen;
  setStatus('AI düşünüyor…');
  renderPits();
  window.setTimeout(() => {
    // Generation guard: a reset during the delay invalidates this callback.
    if (myGen !== gen) return;
    if (state !== 'AiTurn') return;
    const move = chooseAiMove(pits);
    if (move === null) {
      // AI has no legal move — pass. Check if player can move.
      const playerMoves = legalMoves(pits, 0);
      if (playerMoves.length === 0) {
        endGame();
        return;
      }
      state = 'PlayerTurn';
      setStatus('AI pas geçti — sıra sende.');
      renderPits();
      return;
    }
    const res = applyMove(pits, 1, move);
    if (res.gameOver) {
      endGame();
      return;
    }
    if (res.extraTurn) {
      // AI plays again.
      setStatus('AI ekstra tur!');
      renderPits();
      // Chain another AI turn (with new gen check inside).
      startAiTurn();
      return;
    }
    // Hand back to player; if they have no moves, AI keeps going.
    const playerMoves = legalMoves(pits, 0);
    if (playerMoves.length === 0) {
      const aiMoves = legalMoves(pits, 1);
      if (aiMoves.length === 0) {
        endGame();
        return;
      }
      state = 'AiTurn';
      setStatus('Sen pas geçtin — sıra yine AI\'da.');
      renderPits();
      startAiTurn();
      return;
    }
    state = 'PlayerTurn';
    setStatus('Sıra sende — bir çukura tıkla.');
    renderPits();
  }, AI_DELAY_MS);
}

function onPitClick(e: MouseEvent): void {
  // Overlay-input-leak guard.
  if (state !== 'PlayerTurn') return;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target) return;
  const i = Number(target.dataset.i);
  if (!Number.isInteger(i) || i < 0 || i > 5) return;
  if (pits[i]! <= 0) return;

  const res = applyMove(pits, 0, i);
  renderPits();

  if (res.gameOver) {
    endGame();
    return;
  }
  if (res.extraTurn) {
    setStatus('Ekstra tur! Yeni hamleni seç.');
    return;
  }
  // Hand to AI.
  state = 'AiTurn';
  startAiTurn();
}

// ----------------------------------------------------------------------
// Reset / boot.
// ----------------------------------------------------------------------
function reset(): void {
  gen++; // invalidate any pending AI/animation callbacks
  pits = makeInitialPits();
  state = 'PlayerTurn';
  hideOverlay();
  setStatus('Sıra sende — bir çukura tıkla.');
  renderHudWins();
  renderPits();
}

// ----------------------------------------------------------------------
// Wire up.
// ----------------------------------------------------------------------
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

// Expose tiny test hook so the headless playtest harness can drive the
// pure logic without DOM coupling. Not used at runtime by anything else.
// Guarded by typeof window check so SSR / non-browser eval doesn't crash.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__mangalaTestHooks = {
    makeInitialPits,
    legalMoves,
    applyMove,
    chooseAiMove,
    sumSide,
  };
}
