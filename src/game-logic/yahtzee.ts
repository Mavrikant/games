// Yahtzee — classic 5 dice game (a.k.a. 5 Zar / Kniffel).
//
// Pitfalls actively guarded against:
// - visual-vs-hitbox: dice tiles are <button> elements, hit area = pip render area
//   (no pixel math), and pip layouts are derived from a single PIP_MAP const.
// - overlay-input-leak: explicit state enum (rolling | choosing | gameOver).
//   gameOver disables dice clicks, roll button, and category cells via guards in
//   every input handler. Spam clicking the dice after game over does nothing.
// - stale-async-callback: roll animation uses a generation token. reset() bumps
//   the token so any in-flight setTimeout sees `myGen !== gen` and bails out
//   without mutating fresh dice values or score.
// - invisible-boot: first frame paints 5 dice (face 1) and the empty scoresheet
//   with "Atmak için 'At' butonuna bas." status. No spinning, no spawn-in-hidden-buffer.
// - unguarded-storage: safeRead/safeWrite wrap localStorage; reads on init are
//   try/catch-protected, so Safari private mode can't crash the module.
// - duplicate-with-shared-layer: body has no <h1>/<p class="hint">; title and
//   controls come from GameLayout via JSON.
// - Category scoring written from scratch and unit-tested via the headless harness.

const SLUG = 'yahtzee';

type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
type GameState = 'rolling' | 'choosing' | 'gameOver';

interface DieState {
  face: DieFace;
  held: boolean;
  animating: boolean;
}

type UpperKey = 'ones' | 'twos' | 'threes' | 'fours' | 'fives' | 'sixes';
type LowerKey =
  | 'threeOfAKind'
  | 'fourOfAKind'
  | 'fullHouse'
  | 'smallStraight'
  | 'largeStraight'
  | 'yahtzee'
  | 'chance';
type CatKey = UpperKey | LowerKey;

interface Category {
  key: CatKey;
  label: string;
  hint: string;
  section: 'upper' | 'lower';
}

const UPPER_FACES: Record<UpperKey, DieFace> = {
  ones: 1,
  twos: 2,
  threes: 3,
  fours: 4,
  fives: 5,
  sixes: 6,
};

const CATEGORIES: ReadonlyArray<Category> = [
  { key: 'ones',   label: '1\'ler',           hint: '1 değerli zarların toplamı', section: 'upper' },
  { key: 'twos',   label: '2\'ler',           hint: '2 değerli zarların toplamı', section: 'upper' },
  { key: 'threes', label: '3\'ler',           hint: '3 değerli zarların toplamı', section: 'upper' },
  { key: 'fours',  label: '4\'ler',           hint: '4 değerli zarların toplamı', section: 'upper' },
  { key: 'fives',  label: '5\'ler',           hint: '5 değerli zarların toplamı', section: 'upper' },
  { key: 'sixes',  label: '6\'lar',           hint: '6 değerli zarların toplamı', section: 'upper' },
  { key: 'threeOfAKind',  label: 'Üçlü',         hint: '≥3 aynı → tüm zarların toplamı', section: 'lower' },
  { key: 'fourOfAKind',   label: 'Dörtlü',       hint: '≥4 aynı → tüm zarların toplamı', section: 'lower' },
  { key: 'fullHouse',     label: 'Full House',   hint: '3+2 → 25 puan',                  section: 'lower' },
  { key: 'smallStraight', label: 'Küçük Sıra',   hint: '4 ardışık → 30 puan',            section: 'lower' },
  { key: 'largeStraight', label: 'Büyük Sıra',   hint: '5 ardışık → 40 puan',            section: 'lower' },
  { key: 'yahtzee',       label: 'Yahtzee',      hint: '5 aynı → 50 puan',               section: 'lower' },
  { key: 'chance',        label: 'Şans',         hint: 'Tüm zarların toplamı',           section: 'lower' },
];

const STORAGE_BEST = `${SLUG}.best`;
const ROLL_ANIM_MS = 360;       // duration of dice "shake" CSS animation
const MAX_ROLLS = 3;
const UPPER_BONUS_THRESHOLD = 63;
const UPPER_BONUS = 35;

// Pip layout per face. Coordinates 1..3 on a 3x3 grid (col,row); 2 = center.
const PIP_MAP: Record<DieFace, ReadonlyArray<readonly [number, number]>> = {
  1: [[2, 2]],
  2: [[1, 1], [3, 3]],
  3: [[1, 1], [2, 2], [3, 3]],
  4: [[1, 1], [3, 1], [1, 3], [3, 3]],
  5: [[1, 1], [3, 1], [2, 2], [1, 3], [3, 3]],
  6: [[1, 1], [3, 1], [1, 2], [3, 2], [1, 3], [3, 3]],
};

// --- DOM ---
import { defineGame } from '@shared/game-module';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const SCORE_DESC = { gameId: SLUG, storageKey: STORAGE_BEST, direction: 'higher' as const };

let root!: HTMLElement;
let dieEls: HTMLButtonElement[] = [];
let rollBtn!: HTMLButtonElement;
let rollsLeftEl!: HTMLElement;
let statusEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let upperListEl!: HTMLUListElement;
let lowerListEl!: HTMLUListElement;
let upperSumEl!: HTMLElement;
let upperBonusEl!: HTMLElement;
let lowerSumEl!: HTMLElement;
let grandSumEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNewBtn!: HTMLButtonElement;

// --- State ---
let dice: DieState[] = [];
let scores: Partial<Record<CatKey, number>> = {};
let rollsLeft = MAX_ROLLS;
let turn = 1;          // 1..13
let state: GameState = 'choosing';  // before first roll of turn 1, user must press At
let best = 0;
const genToken = createGenToken();
let catCells: Partial<Record<CatKey, HTMLLIElement>> = {};

// --- Storage helpers ---
function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function loadBest(): number {
  const raw = safeRead(STORAGE_BEST);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// --- Random face ---
function rollFace(): DieFace {
  return ((Math.floor(Math.random() * 6) + 1) as DieFace);
}

// --- Scoring (pure) ---
// All scoring functions take a 5-length array of DieFace and return points.
function counts(d: ReadonlyArray<DieFace>): Map<DieFace, number> {
  const m = new Map<DieFace, number>();
  for (const f of d) m.set(f, (m.get(f) ?? 0) + 1);
  return m;
}

function sumAll(d: ReadonlyArray<DieFace>): number {
  let s = 0;
  for (const f of d) s += f;
  return s;
}

function scoreUpper(d: ReadonlyArray<DieFace>, target: DieFace): number {
  let s = 0;
  for (const f of d) if (f === target) s += f;
  return s;
}

function scoreNOfAKind(d: ReadonlyArray<DieFace>, n: number): number {
  const c = counts(d);
  for (const v of c.values()) {
    if (v >= n) return sumAll(d);
  }
  return 0;
}

function scoreFullHouse(d: ReadonlyArray<DieFace>): number {
  const c = counts(d);
  const vals = Array.from(c.values()).sort((a, b) => a - b);
  // [2,3] is classic full house. [5] (yahtzee) is NOT a standard full house in
  // strict rules; only [2,3] qualifies. (Joker yahtzee rule deliberately out.)
  if (vals.length === 2 && vals[0] === 2 && vals[1] === 3) return 25;
  return 0;
}

function hasStraightOfLength(d: ReadonlyArray<DieFace>, len: number): boolean {
  const set = new Set<DieFace>(d);
  const sorted = Array.from(set).sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! === sorted[i - 1]! + 1) {
      run++;
      if (run >= len) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

function scoreSmallStraight(d: ReadonlyArray<DieFace>): number {
  return hasStraightOfLength(d, 4) ? 30 : 0;
}

function scoreLargeStraight(d: ReadonlyArray<DieFace>): number {
  return hasStraightOfLength(d, 5) ? 40 : 0;
}

function scoreYahtzee(d: ReadonlyArray<DieFace>): number {
  const c = counts(d);
  for (const v of c.values()) {
    if (v === 5) return 50;
  }
  return 0;
}

function scoreChance(d: ReadonlyArray<DieFace>): number {
  return sumAll(d);
}

function scoreFor(cat: CatKey, d: ReadonlyArray<DieFace>): number {
  if (cat === 'ones' || cat === 'twos' || cat === 'threes' ||
      cat === 'fours' || cat === 'fives' || cat === 'sixes') {
    return scoreUpper(d, UPPER_FACES[cat]);
  }
  if (cat === 'threeOfAKind') return scoreNOfAKind(d, 3);
  if (cat === 'fourOfAKind')  return scoreNOfAKind(d, 4);
  if (cat === 'fullHouse')    return scoreFullHouse(d);
  if (cat === 'smallStraight') return scoreSmallStraight(d);
  if (cat === 'largeStraight') return scoreLargeStraight(d);
  if (cat === 'yahtzee')      return scoreYahtzee(d);
  return scoreChance(d);
}

// --- Aggregate sums ---
function upperSum(): number {
  let s = 0;
  for (const k of Object.keys(UPPER_FACES) as UpperKey[]) {
    s += scores[k] ?? 0;
  }
  return s;
}

function upperBonus(): number {
  return upperSum() >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
}

function lowerSum(): number {
  const keys: LowerKey[] = [
    'threeOfAKind', 'fourOfAKind', 'fullHouse',
    'smallStraight', 'largeStraight', 'yahtzee', 'chance',
  ];
  let s = 0;
  for (const k of keys) s += scores[k] ?? 0;
  return s;
}

function grandTotal(): number {
  return upperSum() + upperBonus() + lowerSum();
}

// --- Render ---
function renderDie(i: number): void {
  const el = dieEls[i];
  const d = dice[i];
  if (!el || !d) return;
  const faceEl = el.querySelector<HTMLElement>('.yz-die__face');
  if (!faceEl) return;
  faceEl.setAttribute('data-face', String(d.face));
  // Build pip grid for this face.
  faceEl.innerHTML = '';
  const pips = PIP_MAP[d.face];
  for (const [c, r] of pips) {
    const pip = document.createElement('span');
    pip.className = 'yz-pip';
    pip.style.gridColumn = String(c);
    pip.style.gridRow = String(r);
    faceEl.appendChild(pip);
  }
  el.classList.toggle('yz-die--held', d.held);
  el.classList.toggle('yz-die--animating', d.animating);
  // Disable dice interaction in disallowed states.
  // Holding is meaningful only after at least one roll, and not during gameOver.
  const holdable = state === 'choosing' && rollsLeft < MAX_ROLLS;
  el.disabled = state === 'gameOver' || state === 'rolling' || !holdable;
  el.setAttribute('aria-pressed', d.held ? 'true' : 'false');
  el.setAttribute(
    'aria-label',
    `Zar ${i + 1}, ${d.face} ${d.held ? '(tutuldu)' : ''}`,
  );
}

function renderDice(): void {
  for (let i = 0; i < 5; i++) renderDie(i);
}

function currentFaces(): DieFace[] {
  return dice.map((d) => d.face);
}

function renderSheet(): void {
  const faces = currentFaces();
  const canScore = state === 'choosing' && rollsLeft < MAX_ROLLS;
  // For each category cell update text + state classes.
  for (const cat of CATEGORIES) {
    const li = catCells[cat.key];
    if (!li) continue;
    const valEl = li.querySelector<HTMLElement>('.yz-cat__val');
    if (!valEl) continue;
    const scored = scores[cat.key];
    const isScored = scored !== undefined;
    if (isScored) {
      valEl.textContent = String(scored);
      li.classList.add('yz-cat--scored');
      li.classList.remove('yz-cat--available', 'yz-cat--zero');
    } else if (canScore) {
      const provisional = scoreFor(cat.key, faces);
      valEl.textContent = String(provisional);
      li.classList.add('yz-cat--available');
      li.classList.toggle('yz-cat--zero', provisional === 0);
      li.classList.remove('yz-cat--scored');
    } else {
      valEl.textContent = '—';
      li.classList.remove('yz-cat--available', 'yz-cat--zero', 'yz-cat--scored');
    }
    const btn = li.querySelector<HTMLButtonElement>('.yz-cat__btn');
    if (btn) {
      btn.disabled = isScored || state === 'gameOver' || !canScore;
      btn.setAttribute(
        'aria-label',
        `${cat.label}: ${isScored ? `${scored} (kaydedildi)` : `tıkla → ${valEl.textContent} puan`}`,
      );
    }
  }
  upperSumEl.textContent = String(upperSum());
  upperBonusEl.textContent = String(upperBonus());
  lowerSumEl.textContent = String(lowerSum());
  grandSumEl.textContent = String(grandTotal());
  scoreEl.textContent = String(grandTotal());
  bestEl.textContent = String(best);
  roundEl.textContent = `${Math.min(turn, 13)}/13`;
}

function renderControls(): void {
  rollsLeftEl.textContent = `Atış: ${rollsLeft}/${MAX_ROLLS}`;
  rollBtn.disabled = state !== 'choosing' || rollsLeft <= 0;
}

function renderAll(): void {
  renderDice();
  renderSheet();
  renderControls();
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

// --- Game actions ---
function buildSheet(): void {
  upperListEl.innerHTML = '';
  lowerListEl.innerHTML = '';
  catCells = {};
  for (const cat of CATEGORIES) {
    const li = document.createElement('li');
    li.className = 'yz-cat';
    li.dataset.cat = cat.key;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'yz-cat__btn';
    btn.title = cat.hint;
    btn.innerHTML =
      `<span class="yz-cat__label">${cat.label}</span>` +
      `<span class="yz-cat__val">—</span>`;
    btn.addEventListener('click', () => onCategoryClick(cat.key));
    li.appendChild(btn);
    (cat.section === 'upper' ? upperListEl : lowerListEl).appendChild(li);
    catCells[cat.key] = li;
  }
}

function onDieClick(i: number): void {
  if (state !== 'choosing') return;
  if (rollsLeft >= MAX_ROLLS) return; // can't hold before any roll
  const d = dice[i];
  if (!d) return;
  d.held = !d.held;
  renderDice();
}

function onRoll(): void {
  if (state !== 'choosing') return;
  if (rollsLeft <= 0) return;
  // Transition to rolling. Commit the final dice values *immediately* so the
  // game logic is deterministic even if the animation is cancelled — that way
  // finishRoll() in tests + spam-restart in production never lose dice state.
  // The animation is purely cosmetic via the .yz-die--animating CSS class.
  // All scheduled callbacks are keyed to a generation token; reset() bumps it
  // so any pending tick bails out → no stale-async-callback.
  rollsLeft--;
  state = 'rolling';
  genToken.bump();
  const myGen = genToken.current();
  // Commit final faces NOW (only unheld dice are randomized).
  for (let i = 0; i < dice.length; i++) {
    const d = dice[i];
    if (!d) continue;
    if (!d.held) {
      d.face = rollFace();
      d.animating = true;
    }
  }
  renderDice();
  renderControls();
  setStatus('Zarlar atılıyor…');

  function finish(): void {
    if (!genToken.isCurrent(myGen)) return; // cancelled
    for (let i = 0; i < dice.length; i++) {
      const d = dice[i];
      if (!d) continue;
      d.animating = false;
    }
    state = 'choosing';
    renderAll();
    if (rollsLeft > 0) {
      setStatus(`Tut/bırak için zara tıkla, "At" ile tekrar at veya bir kategori seç. ${rollsLeft} atış kaldı.`);
    } else {
      setStatus('Atışın bitti — bir kategori seçerek skoru kaydet.');
    }
  }
  window.setTimeout(finish, ROLL_ANIM_MS);
}

function onCategoryClick(cat: CatKey): void {
  if (state !== 'choosing') return;
  if (rollsLeft >= MAX_ROLLS) return; // can't score before any roll this turn
  if (scores[cat] !== undefined) return;
  const faces = currentFaces();
  const pts = scoreFor(cat, faces);
  scores[cat] = pts;
  // Save best only if we beat it.
  const total = grandTotal();
  if (total > best) {
    best = total;
    safeWrite(STORAGE_BEST, String(best));
  }
  if (turn >= 13) {
    state = 'gameOver';
    reportGameOver(SCORE_DESC, total);
    renderAll();
    showOverlay();
    setStatus(`Oyun bitti! Toplam: ${total}`);
    return;
  }
  // Advance to next turn.
  turn++;
  rollsLeft = MAX_ROLLS;
  for (const d of dice) {
    d.held = false;
    d.animating = false;
  }
  renderAll();
  setStatus(`Tur ${turn}/13 — "At" ile zarları at.`);
}

function showOverlay(): void {
  const total = grandTotal();
  overlayTitle.textContent = best === total && total > 0 ? 'Yeni rekor!' : 'Oyun bitti';
  overlayMsg.textContent = `Toplam: ${total} · En iyi: ${best}`;
  overlay.classList.remove('yz-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideOverlay(): void {
  overlay.classList.add('yz-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

function reset(): void {
  genToken.bump(); // cancel any in-flight roll animation
  dice = [];
  for (let i = 0; i < 5; i++) {
    // Start with faces 1..5 so cold boot is deterministic (invisible-boot guard).
    dice.push({ face: ((i + 1) as DieFace), held: false, animating: false });
  }
  scores = {};
  rollsLeft = MAX_ROLLS;
  turn = 1;
  state = 'choosing';
  hideOverlay();
  renderAll();
  setStatus('Atmak için "At" butonuna bas.');
}

// --- Wire up events ---
function attachListeners(): void {
  for (let i = 0; i < dieEls.length; i++) {
    const el = dieEls[i]!;
    el.addEventListener('click', () => onDieClick(i));
  }
  rollBtn.addEventListener('click', onRoll);
  restartBtn.addEventListener('click', reset);
  overlayNewBtn.addEventListener('click', reset);
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'r' || e.key === 'R') {
      reset();
      e.preventDefault();
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      // Space/Enter triggers roll only if it's enabled; otherwise no-op.
      if (state === 'choosing' && rollsLeft > 0) {
        onRoll();
        e.preventDefault();
      }
      return;
    }
  });
}

// --- Boot ---
function init(): void {
  root = document.querySelector<HTMLElement>('#dice-row')!;
  dieEls = Array.from(root.querySelectorAll<HTMLButtonElement>('.yz-die'));
  rollBtn = document.querySelector<HTMLButtonElement>('#roll')!;
  rollsLeftEl = document.querySelector<HTMLElement>('#rolls-left')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  upperListEl = document.querySelector<HTMLUListElement>('#upper')!;
  lowerListEl = document.querySelector<HTMLUListElement>('#lower')!;
  upperSumEl = document.querySelector<HTMLElement>('#upper-sum')!;
  upperBonusEl = document.querySelector<HTMLElement>('#upper-bonus')!;
  lowerSumEl = document.querySelector<HTMLElement>('#lower-sum')!;
  grandSumEl = document.querySelector<HTMLElement>('#grand-sum')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNewBtn = document.querySelector<HTMLButtonElement>('#overlay-new')!;

  buildSheet();
  attachListeners();
  best = loadBest();
  reset();
}

export const game = defineGame({ init, reset });

// --- Test hook (headless harness only) ---
declare global {
  interface Window {
    __yahtzeeTest?: {
      getState: () => GameState;
      getDice: () => ReadonlyArray<DieState>;
      setDice: (faces: ReadonlyArray<DieFace>) => void;
      setHeld: (i: number, held: boolean) => void;
      getRollsLeft: () => number;
      getTurn: () => number;
      getScores: () => Readonly<Partial<Record<CatKey, number>>>;
      getBest: () => number;
      getUpperSum: () => number;
      getUpperBonus: () => number;
      getLowerSum: () => number;
      getGrandTotal: () => number;
      reset: () => void;
      roll: () => void;
      finishRoll: () => void;
      clickDie: (i: number) => void;
      pickCategory: (cat: CatKey) => void;
      scoreOf: (cat: CatKey, faces: ReadonlyArray<DieFace>) => number;
      categories: () => ReadonlyArray<CatKey>;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__yahtzeeTest = {
    getState: () => state,
    getDice: () => dice.map((d) => ({ ...d })),
    setDice: (faces) => {
      for (let i = 0; i < Math.min(5, faces.length); i++) {
        const f = faces[i];
        const d = dice[i];
        if (f && d) d.face = f;
      }
      renderAll();
    },
    setHeld: (i, held) => {
      const d = dice[i];
      if (d) d.held = held;
      renderDice();
    },
    getRollsLeft: () => rollsLeft,
    getTurn: () => turn,
    getScores: () => ({ ...scores }),
    getBest: () => best,
    getUpperSum: () => upperSum(),
    getUpperBonus: () => upperBonus(),
    getLowerSum: () => lowerSum(),
    getGrandTotal: () => grandTotal(),
    reset,
    roll: onRoll,
    finishRoll: () => {
      // Force-resolve any pending roll animation synchronously.
      for (const d of dice) {
        if (d.animating) d.animating = false;
      }
      if (state === 'rolling') {
        state = 'choosing';
        renderAll();
      }
    },
    clickDie: (i) => onDieClick(i),
    pickCategory: (cat) => onCategoryClick(cat),
    scoreOf: (cat, faces) => scoreFor(cat, faces),
    categories: () => CATEGORIES.map((c) => c.key),
  };
}
