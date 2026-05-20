// Amiral Battı — classic 10x10 Battleship vs AI.
// Standard fleet: 1×5 (Taşıyıcı), 1×4 (Savaş gemisi), 2×3 (Kruvazör + Denizaltı),
// 1×2 (Destroyer). 5 ships, 17 cells per side.
//
// State machine: 'PlayerTurn' | 'AiTurn' | 'GameOver'. Click events on the
// enemy grid only fire during PlayerTurn (overlay-input-leak guard). The AI
// move is scheduled via setTimeout and protected by a generation token so a
// restart mid-think doesn't apply a stale move to a fresh game.

const SIZE = 10;
const TOTAL = SIZE * SIZE;

// Ship spec: [length, label]. Order does not affect placement correctness.
const FLEET: ReadonlyArray<readonly [number, string]> = [
  [5, 'Taşıyıcı'],
  [4, 'Savaş gemisi'],
  [3, 'Kruvazör'],
  [3, 'Denizaltı'],
  [2, 'Destroyer'],
];
const FLEET_CELLS = FLEET.reduce((sum, [n]) => sum + n, 0); // 17

const STORAGE_WINS = 'amiral-batti.wins';
const STORAGE_LOSSES = 'amiral-batti.losses';

const AI_DELAY_MS = 540;

type Cell = {
  ship: number; // -1 = empty, otherwise index in ships[]
  shot: boolean;
};

type Ship = {
  length: number;
  label: string;
  cells: number[]; // board indices
  hits: number;
};

type Side = {
  cells: Cell[];
  ships: Ship[];
};

type State = 'PlayerTurn' | 'AiTurn' | 'GameOver';

type AiMode =
  | { kind: 'hunt' }
  | { kind: 'target'; origin: number; queue: number[]; line: 'h' | 'v' | null };

// ---------- DOM ----------

const enemyGridEl = document.querySelector<HTMLElement>('#ab-enemy-grid')!;
const youGridEl = document.querySelector<HTMLElement>('#ab-you-grid')!;
const statusEl = document.querySelector<HTMLElement>('#ab-status')!;
const winsEl = document.querySelector<HTMLElement>('#ab-wins')!;
const lossesEl = document.querySelector<HTMLElement>('#ab-losses')!;
const enemyLeftEl = document.querySelector<HTMLElement>('#ab-enemy-left')!;
const youLeftEl = document.querySelector<HTMLElement>('#ab-you-left')!;
const shuffleBtn = document.querySelector<HTMLButtonElement>('#ab-shuffle')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#ab-restart')!;
const overlay = document.querySelector<HTMLElement>('#ab-overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#ab-overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#ab-overlay-msg')!;
const overlayRestart =
  document.querySelector<HTMLButtonElement>('#ab-overlay-restart')!;

// ---------- module-level state ----------

let enemy: Side = makeEmptySide();
let you: Side = makeEmptySide();
let state: State = 'PlayerTurn';
let wins = 0;
let losses = 0;
// Generation token: bumped on reset; any pending AI setTimeout bails if its
// token no longer matches. Prevents stale-async-callback bugs.
let gen = 0;
let aiMode: AiMode = { kind: 'hunt' };
let enemyCellEls: HTMLButtonElement[] = [];
let youCellEls: HTMLButtonElement[] = [];

// ---------- helpers ----------

function makeEmptySide(): Side {
  const cells: Cell[] = [];
  for (let i = 0; i < TOTAL; i++) cells.push({ ship: -1, shot: false });
  return { cells, ships: [] };
}

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
    /* ignore */
  }
}

function idx(r: number, c: number): number {
  return r * SIZE + c;
}

function rcOf(i: number): [number, number] {
  return [Math.floor(i / SIZE), i % SIZE];
}

function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// ---------- placement ----------

// Try to randomly place all ships on a side. Overlap forbidden. Adjacency
// is allowed (classic rule). Returns true on success. Caller should keep
// retrying with a fresh empty side until success — with SIZE=10 success
// almost always lands on the first attempt.
function tryPlaceAll(side: Side, rng: () => number = Math.random): boolean {
  for (const [len, label] of FLEET) {
    const placed = tryPlaceShip(side, len, label, rng);
    if (!placed) return false;
  }
  return true;
}

function tryPlaceShip(
  side: Side,
  len: number,
  label: string,
  rng: () => number,
): boolean {
  // Try up to 200 random orientations; if none free, signal failure so the
  // caller can wipe and retry from scratch.
  for (let attempt = 0; attempt < 200; attempt++) {
    const horizontal = rng() < 0.5;
    const maxR = horizontal ? SIZE : SIZE - len + 1;
    const maxC = horizontal ? SIZE - len + 1 : SIZE;
    const r = Math.floor(rng() * maxR);
    const c = Math.floor(rng() * maxC);
    const cells: number[] = [];
    let ok = true;
    for (let k = 0; k < len; k++) {
      const rr = horizontal ? r : r + k;
      const cc = horizontal ? c + k : c;
      if (!inBounds(rr, cc)) {
        ok = false;
        break;
      }
      const ci = idx(rr, cc);
      if (side.cells[ci]!.ship !== -1) {
        ok = false;
        break;
      }
      cells.push(ci);
    }
    if (!ok) continue;
    const shipIdx = side.ships.length;
    for (const ci of cells) side.cells[ci]!.ship = shipIdx;
    side.ships.push({ length: len, label, cells, hits: 0 });
    return true;
  }
  return false;
}

// Wipes a side and (re)fills it with a fresh random fleet. Always succeeds
// in practice; the outer loop is just a safety net.
function regenerate(side: Side, rng: () => number = Math.random): void {
  for (let outer = 0; outer < 50; outer++) {
    const fresh = makeEmptySide();
    if (tryPlaceAll(fresh, rng)) {
      side.cells = fresh.cells;
      side.ships = fresh.ships;
      return;
    }
  }
  // Catastrophic fallback: should never hit with SIZE=10 + this fleet.
  throw new Error('amiral-batti: failed to place fleet');
}

// ---------- shot / hit detection ----------

type ShotResult =
  | { kind: 'miss' }
  | { kind: 'hit'; shipIdx: number }
  | { kind: 'sunk'; shipIdx: number };

function fireAt(side: Side, i: number): ShotResult | null {
  const cell = side.cells[i];
  if (!cell || cell.shot) return null; // already shot or out of range
  cell.shot = true;
  if (cell.ship === -1) return { kind: 'miss' };
  const ship = side.ships[cell.ship]!;
  ship.hits++;
  if (ship.hits >= ship.length) {
    return { kind: 'sunk', shipIdx: cell.ship };
  }
  return { kind: 'hit', shipIdx: cell.ship };
}

function cellsRemaining(side: Side): number {
  let rem = 0;
  for (const s of side.ships) rem += s.length - s.hits;
  return rem;
}

function allSunk(side: Side): boolean {
  for (const s of side.ships) {
    if (s.hits < s.length) return false;
  }
  return true;
}

// ---------- AI ----------

function neighborsOf(i: number): number[] {
  const [r, c] = rcOf(i);
  const out: number[] = [];
  if (inBounds(r - 1, c)) out.push(idx(r - 1, c));
  if (inBounds(r + 1, c)) out.push(idx(r + 1, c));
  if (inBounds(r, c - 1)) out.push(idx(r, c - 1));
  if (inBounds(r, c + 1)) out.push(idx(r, c + 1));
  return out;
}

function chooseAiTarget(side: Side): number {
  // Drain the queue if we are targeting a wounded ship.
  if (aiMode.kind === 'target') {
    while (aiMode.queue.length > 0) {
      const next = aiMode.queue.shift()!;
      if (!side.cells[next]!.shot) return next;
    }
    // Queue exhausted — fall through to hunt.
    aiMode = { kind: 'hunt' };
  }
  // Hunt: pick a random un-shot cell. Use a parity bias (checkerboard) to
  // cover more area on average. The shortest ship is length 2, so every
  // ship must cross at least one parity-0 cell — biasing toward those finds
  // ships ~2x faster on average than fully random.
  const eligible: number[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const [r, c] = rcOf(i);
    if (!side.cells[i]!.shot && (r + c) % 2 === 0) eligible.push(i);
  }
  if (eligible.length === 0) {
    // Fallback (rare): all parity-0 already shot.
    for (let i = 0; i < TOTAL; i++) {
      if (!side.cells[i]!.shot) eligible.push(i);
    }
  }
  if (eligible.length === 0) return -1; // shouldn't happen unless game over
  return eligible[Math.floor(Math.random() * eligible.length)]!;
}

function aiUpdateAfterShot(side: Side, i: number, res: ShotResult): void {
  if (res.kind === 'miss') return;
  if (res.kind === 'sunk') {
    // Done with this ship — wipe target mode.
    aiMode = { kind: 'hunt' };
    return;
  }
  // Hit. Either we are still hunting (need to switch to target mode) or
  // we already have a target — refine the queue with directional inference.
  if (aiMode.kind === 'hunt') {
    aiMode = {
      kind: 'target',
      origin: i,
      queue: neighborsOf(i).filter((n) => !side.cells[n]!.shot),
      line: null,
    };
    return;
  }
  // We're in target mode. If the new hit is on the same row or column as
  // origin, we know the orientation; prefer continuing in that line.
  const [or, oc] = rcOf(aiMode.origin);
  const [hr, hc] = rcOf(i);
  let line: 'h' | 'v' | null = aiMode.line;
  if (line === null) {
    if (hr === or && hc !== oc) line = 'h';
    else if (hc === oc && hr !== or) line = 'v';
  }
  const queue: number[] = [];
  if (line === 'h') {
    // Add unshot horizontal neighbors of i.
    if (inBounds(hr, hc - 1) && !side.cells[idx(hr, hc - 1)]!.shot) queue.push(idx(hr, hc - 1));
    if (inBounds(hr, hc + 1) && !side.cells[idx(hr, hc + 1)]!.shot) queue.push(idx(hr, hc + 1));
  } else if (line === 'v') {
    if (inBounds(hr - 1, hc) && !side.cells[idx(hr - 1, hc)]!.shot) queue.push(idx(hr - 1, hc));
    if (inBounds(hr + 1, hc) && !side.cells[idx(hr + 1, hc)]!.shot) queue.push(idx(hr + 1, hc));
  } else {
    // No line locked yet — just add all unshot neighbors of i.
    for (const n of neighborsOf(i)) {
      if (!side.cells[n]!.shot) queue.push(n);
    }
  }
  // Merge with existing queue but drop already-shot entries; preserve
  // ordering (line-directed first).
  const merged: number[] = [];
  const seen = new Set<number>();
  for (const n of [...queue, ...aiMode.queue]) {
    if (seen.has(n)) continue;
    if (side.cells[n]!.shot) continue;
    seen.add(n);
    merged.push(n);
  }
  aiMode = { kind: 'target', origin: aiMode.origin, queue: merged, line };
}

// ---------- rendering ----------

function buildGrid(
  host: HTMLElement,
  store: HTMLButtonElement[],
  isEnemy: boolean,
): void {
  host.innerHTML = '';
  store.length = 0;
  for (let i = 0; i < TOTAL; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ab-cell';
    btn.setAttribute('role', 'gridcell');
    const [r, c] = rcOf(i);
    btn.setAttribute(
      'aria-label',
      `${r + 1}. satır, ${c + 1}. sütun`,
    );
    btn.dataset.i = String(i);
    if (isEnemy) {
      btn.addEventListener('click', onEnemyClick);
    } else {
      btn.disabled = true;
      btn.tabIndex = -1;
    }
    host.appendChild(btn);
    store.push(btn);
  }
}

function renderGrid(
  side: Side,
  store: HTMLButtonElement[],
  showShips: boolean,
): void {
  for (let i = 0; i < TOTAL; i++) {
    const cell = side.cells[i]!;
    const el = store[i]!;
    el.classList.remove(
      'ab-cell--ship',
      'ab-cell--hit',
      'ab-cell--miss',
      'ab-cell--sunk',
    );
    if (showShips && cell.ship !== -1 && !cell.shot) {
      el.classList.add('ab-cell--ship');
    }
    if (cell.shot) {
      if (cell.ship === -1) {
        el.classList.add('ab-cell--miss');
      } else {
        const ship = side.ships[cell.ship]!;
        if (ship.hits >= ship.length) {
          el.classList.add('ab-cell--sunk');
        } else {
          el.classList.add('ab-cell--hit');
        }
      }
    }
  }
}

function renderAll(): void {
  renderGrid(enemy, enemyCellEls, false);
  renderGrid(you, youCellEls, true);
  renderHud();
  // Disable enemy grid clicks when it isn't the player's turn.
  for (const el of enemyCellEls) {
    const i = Number(el.dataset.i);
    const cell = enemy.cells[i]!;
    el.disabled = cell.shot || state !== 'PlayerTurn';
  }
}

function renderHud(): void {
  winsEl.textContent = String(wins);
  lossesEl.textContent = String(losses);
  enemyLeftEl.textContent = String(cellsRemaining(enemy));
  youLeftEl.textContent = String(cellsRemaining(you));
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('ab-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
  overlayRestart.focus({ preventScroll: true });
}

function hideOverlay(): void {
  overlay.classList.add('ab-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// ---------- turn flow ----------

function onEnemyClick(e: MouseEvent): void {
  // Overlay-input-leak guard: bail if it isn't the player's turn.
  if (state !== 'PlayerTurn') return;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (!target) return;
  const i = Number(target.dataset.i);
  if (!Number.isInteger(i) || i < 0 || i >= TOTAL) return;
  const cell = enemy.cells[i];
  if (!cell || cell.shot) return; // double-click same cell → no-op
  const res = fireAt(enemy, i);
  if (!res) return;
  if (res.kind === 'sunk') {
    const ship = enemy.ships[res.shipIdx]!;
    setStatus(`${ship.label} batırıldı!`);
  } else if (res.kind === 'hit') {
    setStatus('Vuruş!');
  } else {
    setStatus('Iska.');
  }
  if (allSunk(enemy)) {
    state = 'GameOver';
    wins++;
    safeWriteNumber(STORAGE_WINS, wins);
    renderAll();
    showOverlay('Kazandın!', 'Düşmanın tüm filosunu batırdın.');
    return;
  }
  state = 'AiTurn';
  renderAll();
  startAiTurn();
}

function startAiTurn(): void {
  const myGen = gen;
  setStatus('Düşman düşünüyor…');
  window.setTimeout(() => {
    // Stale-async-callback guard: if reset bumped gen during the delay, bail.
    if (myGen !== gen) return;
    if (state !== 'AiTurn') return;
    const i = chooseAiTarget(you);
    if (i < 0) return;
    const res = fireAt(you, i);
    if (!res) return;
    aiUpdateAfterShot(you, i, res);
    if (res.kind === 'sunk') {
      const ship = you.ships[res.shipIdx]!;
      setStatus(`Düşman ${ship.label}'ı batırdı.`);
    } else if (res.kind === 'hit') {
      setStatus('Düşman vurdu!');
    } else {
      setStatus('Düşman ıska geçti — sıra sende.');
    }
    if (allSunk(you)) {
      state = 'GameOver';
      losses++;
      safeWriteNumber(STORAGE_LOSSES, losses);
      renderAll();
      showOverlay('Kaybettin.', 'Filon battı.');
      return;
    }
    state = 'PlayerTurn';
    renderAll();
  }, AI_DELAY_MS);
}

// ---------- reset / shuffle ----------

function reset(): void {
  // Bump generation: any pending AI setTimeout from the previous game bails.
  gen++;
  enemy = makeEmptySide();
  you = makeEmptySide();
  regenerate(enemy);
  regenerate(you);
  aiMode = { kind: 'hunt' };
  state = 'PlayerTurn';
  hideOverlay();
  setStatus('Sıra sende — düşman gridine ateş et.');
  renderAll();
}

function shuffleOwn(): void {
  // Player can re-roll their own fleet only while in PlayerTurn and before
  // any shots have been fired on their side. (After they take damage, a
  // shuffle would be cheating.) For safety also block when game is over.
  if (state !== 'PlayerTurn') return;
  if (cellsRemaining(you) < FLEET_CELLS) return;
  // Also block if AI has already fired even one miss on the player. Check by
  // looking for any shot cell on `you`.
  for (const c of you.cells) {
    if (c.shot) return;
  }
  regenerate(you);
  setStatus('Filon yeniden dizildi.');
  renderAll();
}

// ---------- wire up ----------

wins = safeReadNumber(STORAGE_WINS);
losses = safeReadNumber(STORAGE_LOSSES);

buildGrid(enemyGridEl, enemyCellEls, true);
buildGrid(youGridEl, youCellEls, false);

restartBtn.addEventListener('click', reset);
overlayRestart.addEventListener('click', reset);
shuffleBtn.addEventListener('click', shuffleOwn);

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    reset();
    e.preventDefault();
  } else if (e.key === 'Enter' && state === 'GameOver') {
    reset();
    e.preventDefault();
  }
});

reset();

// ---------- test hooks (exposed for headless playtest harness) ----------
// Not used by the page; harness can attach to window via dynamic import.
// Kept as a tiny opt-in surface so tests can poke internals without altering
// production behaviour.
declare global {
  interface Window {
    __amiralBatti?: {
      getState: () => State;
      getEnemy: () => Side;
      getYou: () => Side;
      shootEnemy: (i: number) => ShotResult | null;
      fireOnYou: (i: number) => ShotResult | null;
      reset: () => void;
      shuffleOwn: () => void;
      cellsRemainingEnemy: () => number;
      cellsRemainingYou: () => number;
    };
  }
}
window.__amiralBatti = {
  getState: () => state,
  getEnemy: () => enemy,
  getYou: () => you,
  shootEnemy: (i) => fireAt(enemy, i),
  fireOnYou: (i) => fireAt(you, i),
  reset,
  shuffleOwn,
  cellsRemainingEnemy: () => cellsRemaining(enemy),
  cellsRemainingYou: () => cellsRemaining(you),
};
