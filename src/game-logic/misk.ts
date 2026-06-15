import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded here (read docs/PITFALLS.md before editing):
// - unguarded-storage: progress goes through safeRead/safeWrite.
// - module-level-dom-access: all querySelector / listeners live in init().
// - stale-dom-from-prev-state: loadLevel() rebuilds axes + ingredient DOM
//   from scratch (innerHTML = '') BEFORE rendering new values.
// - overlay-input-leak: every input path checks `gameState === 'playing'`.
// - missing-overlay-css: .overlay--hidden is defined in the per-game CSS.
// - hud-counter-synced-only-at-lifecycle-edges: drop/cap and stars-hud are
//   written by render(); render() is called on EVERY state change.
// - cap-counts-dead-entities: drops[] is the live source of truth — it is
//   pushed-to/popped-from atomically with axis updates.
// - designed-lose-condition-not-wired: exceeding cap with axes off-target
//   triggers explicit gameover state + lose overlay (not silent skip).

const AXIS_NAMES = ['Çiçek', 'Odun', 'Narenciye'] as const;
const AXIS_LETTERS = ['F', 'O', 'N'] as const;
const AXIS_COLORS = ['#ec4899', '#a16207', '#fbbf24'] as const;

interface Ingredient {
  name: string;
  vec: [number, number, number];
}

interface Level {
  target: [number, number, number];
  tol: number;
  cap: number;
  ingredients: Ingredient[];
}

// Six levels of escalating difficulty. Par is computed by brute-force search
// at load time, so star thresholds remain accurate if a level is tweaked.
const LEVELS: Level[] = [
  {
    target: [24, 18, 22],
    tol: 2,
    cap: 10,
    ingredients: [
      { name: 'Gül', vec: [12, 0, 0] },
      { name: 'Sandal', vec: [0, 9, 0] },
      { name: 'Limon', vec: [0, 0, 11] },
    ],
  },
  {
    target: [30, 24, 20],
    tol: 2,
    cap: 12,
    ingredients: [
      { name: 'Gül', vec: [10, 2, 0] },
      { name: 'Oud', vec: [0, 12, 0] },
      { name: 'Limon', vec: [0, 0, 10] },
      { name: 'Lavanta', vec: [3, 1, 0] },
    ],
  },
  {
    target: [34, 30, 28],
    tol: 2,
    cap: 12,
    ingredients: [
      { name: 'Yasemin', vec: [11, 0, 3] },
      { name: 'Oud', vec: [2, 14, 0] },
      { name: 'Bergamot', vec: [0, 0, 13] },
      { name: 'Lavanta', vec: [4, 2, 0] },
    ],
  },
  {
    target: [38, 36, 26],
    tol: 2,
    cap: 14,
    ingredients: [
      { name: 'Gül', vec: [12, 2, 0] },
      { name: 'Sedir', vec: [0, 12, 0] },
      { name: 'Limon', vec: [3, 0, 13] },
      { name: 'Yasemin', vec: [9, 0, 4] },
      { name: 'Vanilya', vec: [2, 4, 0] },
    ],
  },
  {
    target: [46, 32, 38],
    tol: 3,
    cap: 16,
    ingredients: [
      { name: 'Gül', vec: [13, 3, 0] },
      { name: 'Oud', vec: [4, 15, 2] },
      { name: 'Bergamot', vec: [2, 0, 14] },
      { name: 'Yasemin', vec: [10, 0, 5] },
      { name: 'Lavanta', vec: [3, 2, 1] },
    ],
  },
  {
    target: [52, 44, 36],
    tol: 3,
    cap: 18,
    ingredients: [
      { name: 'Gül', vec: [14, 2, 0] },
      { name: 'Sedir', vec: [3, 13, 0] },
      { name: 'Misk', vec: [5, 8, 2] },
      { name: 'Bergamot', vec: [0, 2, 14] },
      { name: 'Vanilya', vec: [4, 5, 1] },
      { name: 'Lavanta', vec: [3, 1, 2] },
    ],
  },
];

const PROGRESS_KEY = 'misk.progress';
const SCORE_DESC = {
  gameId: 'misk',
  storageKey: 'misk.lb',
  direction: 'higher' as const,
};

interface Progress {
  unlocked: number;
  stars: number[];
}

type GameState = 'playing' | 'won' | 'lost';

let levelIdx = 0;
let level!: Level;
let par = 0;
let cur: [number, number, number] = [0, 0, 0];
let drops: number[] = []; // ingredient idx history
let gameState: GameState = 'playing';
let progress: Progress = { unlocked: 0, stars: [] };

let levelEl!: HTMLElement;
let dropsEl!: HTMLElement;
let starsHudEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let axesEl!: HTMLElement;
let ingsEl!: HTMLElement;
let bottleLiquidEl!: HTMLElement;
let bottleCapEl!: HTMLElement;
let undoBtn!: HTMLButtonElement;
let statusEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayStars!: HTMLElement;
let nextBtn!: HTMLButtonElement;
let replayBtn!: HTMLButtonElement;

interface AxisNodes {
  bar: HTMLElement;
  fill: HTMLElement;
  band: HTMLElement;
  marker: HTMLElement;
  value: HTMLElement;
}
let axisNodes: AxisNodes[] = [];

interface IngNodes {
  card: HTMLButtonElement;
  count: HTMLElement;
}
let ingNodes: IngNodes[] = [];

// Maximum axis value used to scale the bars. Pick a friendly round number
// above the largest target so all targets sit comfortably below 100%.
const AXIS_MAX = 80;

function inTol(v: number, t: number): boolean {
  return Math.abs(v - t) <= level.tol;
}

function isWin(vec: [number, number, number]): boolean {
  return (
    inTol(vec[0], level.target[0]) &&
    inTol(vec[1], level.target[1]) &&
    inTol(vec[2], level.target[2])
  );
}

// Brute-force minimum drops to reach a winning vector. Cap'd by level.cap so
// the search space stays finite (sum of counts <= cap). DFS with depth prune.
function solvePar(lv: Level): number {
  const n = lv.ingredients.length;
  let bestSum = Number.POSITIVE_INFINITY;
  const xs = new Array(n).fill(0);
  function recurse(idx: number, sumSoFar: number): void {
    if (sumSoFar >= bestSum) return;
    if (sumSoFar > lv.cap) return;
    if (idx === n) {
      let f = 0,
        w = 0,
        c = 0;
      for (let i = 0; i < n; i++) {
        const v = lv.ingredients[i]!.vec;
        const xi = xs[i]!;
        f += xi * v[0];
        w += xi * v[1];
        c += xi * v[2];
      }
      if (
        Math.abs(f - lv.target[0]) <= lv.tol &&
        Math.abs(w - lv.target[1]) <= lv.tol &&
        Math.abs(c - lv.target[2]) <= lv.tol
      ) {
        bestSum = sumSoFar;
      }
      return;
    }
    const remaining = lv.cap - sumSoFar;
    for (let k = 0; k <= remaining; k++) {
      xs[idx] = k;
      recurse(idx + 1, sumSoFar + k);
    }
    xs[idx] = 0;
  }
  recurse(0, 0);
  return bestSum;
}

function starsFor(mv: number): number {
  if (mv <= par) return 3;
  if (mv <= par + 2) return 2;
  return 1;
}

function starString(s: number): string {
  return '★'.repeat(s) + '☆'.repeat(3 - s);
}

function loadProgress(): void {
  const raw = safeRead<Progress>(PROGRESS_KEY, { unlocked: 0, stars: [] });
  progress = {
    unlocked: typeof raw.unlocked === 'number' ? raw.unlocked : 0,
    stars: Array.isArray(raw.stars) ? raw.stars : [],
  };
}

function recordStars(idx: number, s: number): void {
  const prev = progress.stars[idx] ?? 0;
  progress.stars[idx] = Math.max(prev, s);
  progress.unlocked = Math.max(progress.unlocked, idx + 1);
  safeWrite(PROGRESS_KEY, progress);
}

function buildAxes(): void {
  axesEl.innerHTML = '';
  axisNodes = [];
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'axis';

    const label = document.createElement('span');
    label.className = 'axis__label';
    label.textContent = AXIS_NAMES[i]!;
    label.style.setProperty('--axis-color', AXIS_COLORS[i]!);

    const bar = document.createElement('div');
    bar.className = 'axis__bar';

    const fill = document.createElement('span');
    fill.className = 'axis__fill';
    fill.style.background = AXIS_COLORS[i]!;

    const band = document.createElement('span');
    band.className = 'axis__band';

    const marker = document.createElement('span');
    marker.className = 'axis__marker';

    bar.append(fill, band, marker);

    const value = document.createElement('span');
    value.className = 'axis__value';

    row.append(label, bar, value);
    axesEl.append(row);

    axisNodes.push({ bar, fill, band, marker, value });
  }
}

function buildIngredients(): void {
  ingsEl.innerHTML = '';
  ingNodes = [];
  level.ingredients.forEach((ing, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ing';
    card.setAttribute('aria-label', `${ing.name} damlası ekle`);
    card.addEventListener('click', () => addDrop(i));

    const key = document.createElement('span');
    key.className = 'ing__key';
    key.textContent = String(i + 1);

    const name = document.createElement('span');
    name.className = 'ing__name';
    name.textContent = ing.name;

    const vec = document.createElement('span');
    vec.className = 'ing__vec';
    const parts: string[] = [];
    for (let a = 0; a < 3; a++) {
      const v = ing.vec[a]!;
      if (v > 0) parts.push(`${AXIS_LETTERS[a]}+${v}`);
    }
    vec.textContent = parts.join(' / ');

    const count = document.createElement('span');
    count.className = 'ing__count';
    count.textContent = '×0';

    card.append(key, name, vec, count);
    ingsEl.append(card);
    ingNodes.push({ card, count });
  });
}

function render(): void {
  levelEl.textContent = `${levelIdx + 1}/${LEVELS.length}`;
  dropsEl.textContent = `${drops.length}/${level.cap}`;
  bottleCapEl.textContent = `${drops.length}/${level.cap}`;
  bottleLiquidEl.style.height = `${(drops.length / level.cap) * 100}%`;

  const prevStars = progress.stars[levelIdx] ?? 0;
  starsHudEl.textContent = prevStars > 0 ? starString(prevStars) : '—';

  for (let i = 0; i < 3; i++) {
    const node = axisNodes[i]!;
    const t = level.target[i]!;
    const tol = level.tol;
    const v = cur[i]!;
    node.fill.style.width = `${Math.min(100, (v / AXIS_MAX) * 100)}%`;
    const lo = Math.max(0, t - tol);
    const hi = Math.min(AXIS_MAX, t + tol);
    node.band.style.left = `${(lo / AXIS_MAX) * 100}%`;
    node.band.style.width = `${((hi - lo) / AXIS_MAX) * 100}%`;
    node.marker.style.left = `${(t / AXIS_MAX) * 100}%`;
    const ok = inTol(v, t);
    node.value.textContent = `${v} / ${t}±${tol}`;
    node.value.classList.toggle('axis__value--ok', ok);
    node.bar.classList.toggle('axis__bar--ok', ok);
  }

  // ingredient counts
  const counts = new Array(level.ingredients.length).fill(0);
  for (const d of drops) counts[d]++;
  ingNodes.forEach((n, i) => {
    n.count.textContent = `×${counts[i]}`;
    n.card.classList.toggle('ing--used', counts[i] > 0);
    n.card.disabled = gameState !== 'playing' || drops.length >= level.cap;
  });

  undoBtn.disabled = drops.length === 0 || gameState !== 'playing';

  if (gameState === 'won') {
    statusEl.textContent = 'Misk hazır! Sıradaki bölüme geç.';
  } else if (gameState === 'lost') {
    statusEl.textContent = 'Şişe doldu ama profil tutmadı. Sıfırla ve tekrar dene.';
  } else if (drops.length === 0) {
    statusEl.textContent = 'Bir içeriğe tıkla, ilk damlayı düşür.';
  } else {
    const remaining = level.cap - drops.length;
    statusEl.textContent = `Şişede ${remaining} damla kapasite kaldı.`;
  }
}

function addDrop(i: number): void {
  if (gameState !== 'playing') return;
  if (drops.length >= level.cap) return;
  drops.push(i);
  const v = level.ingredients[i]!.vec;
  cur = [cur[0] + v[0], cur[1] + v[1], cur[2] + v[2]];

  if (isWin(cur)) {
    gameState = 'won';
    const s = starsFor(drops.length);
    recordStars(levelIdx, s);
    reportGameOver(SCORE_DESC, levelIdx + 1, { label: 'Seviye' });
    showWin(s);
  } else if (drops.length >= level.cap) {
    gameState = 'lost';
    showLose();
  }
  render();
}

function undo(): void {
  if (gameState !== 'playing' || drops.length === 0) return;
  const i = drops.pop()!;
  const v = level.ingredients[i]!.vec;
  cur = [cur[0] - v[0], cur[1] - v[1], cur[2] - v[2]];
  render();
}

function showWin(s: number): void {
  overlayStars.textContent = starString(s);
  overlayStars.setAttribute('aria-label', `${s} yıldız`);
  const parText = Number.isFinite(par) ? `En az: ${par} damla` : '';
  overlayTitle.textContent = s === 3 ? 'Kusursuz misk!' : 'Misk hazır!';
  overlayMsg.textContent =
    `Profili ${drops.length} damlada tutturdun.` +
    (parText ? `\n${parText}` : '');
  const last = levelIdx >= LEVELS.length - 1;
  nextBtn.textContent = last ? 'Baştan oyna' : 'Sonraki bölüm';
  nextBtn.style.display = '';
  showOverlayEl(overlay);
}

function showLose(): void {
  overlayStars.textContent = '☆☆☆';
  overlayStars.setAttribute('aria-label', '0 yıldız');
  overlayTitle.textContent = 'Şişe doldu';
  overlayMsg.textContent =
    'Kapasite bitti ama profil bandın dışında kaldı.\nGeri al veya sıfırla; daha az damlayla dene.';
  nextBtn.style.display = 'none';
  showOverlayEl(overlay);
}

function loadLevel(idx: number): void {
  levelIdx = ((idx % LEVELS.length) + LEVELS.length) % LEVELS.length;
  level = LEVELS[levelIdx]!;
  cur = [0, 0, 0];
  drops = [];
  gameState = 'playing';
  par = solvePar(level);
  hideOverlayEl(overlay);
  buildAxes();
  buildIngredients();
  render();
}

function init(): void {
  levelEl = document.querySelector<HTMLElement>('#level')!;
  dropsEl = document.querySelector<HTMLElement>('#drops')!;
  starsHudEl = document.querySelector<HTMLElement>('#stars-hud')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  axesEl = document.querySelector<HTMLElement>('#axes')!;
  ingsEl = document.querySelector<HTMLElement>('#ings')!;
  bottleLiquidEl = document.querySelector<HTMLElement>('#bottle-liquid')!;
  bottleCapEl = document.querySelector<HTMLElement>('#bottle-cap')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayStars = document.querySelector<HTMLElement>('#overlay-stars')!;
  nextBtn = document.querySelector<HTMLButtonElement>('#next-btn')!;
  replayBtn = document.querySelector<HTMLButtonElement>('#replay-btn')!;

  loadProgress();

  restartBtn.addEventListener('click', () => loadLevel(levelIdx));
  undoBtn.addEventListener('click', undo);
  nextBtn.addEventListener('click', () => loadLevel(levelIdx + 1));
  replayBtn.addEventListener('click', () => loadLevel(levelIdx));

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '9') {
      const i = Number(k) - 1;
      if (gameState === 'playing' && i < level.ingredients.length) {
        addDrop(i);
        e.preventDefault();
      }
    } else if (k === 'u') {
      undo();
      e.preventDefault();
    } else if (k === 'r') {
      loadLevel(levelIdx);
      e.preventDefault();
    } else if (k === 'enter') {
      if (gameState === 'won') {
        loadLevel(levelIdx + 1);
        e.preventDefault();
      } else if (gameState === 'lost') {
        loadLevel(levelIdx);
        e.preventDefault();
      }
    }
  });

  const startIdx = Math.min(progress.unlocked, LEVELS.length - 1);
  loadLevel(startIdx);
}

export const game = defineGame({ init });
