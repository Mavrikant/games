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
// - stale-dom-from-prev-state: loadLevel() rebuilds the flask DOM from
//   scratch (innerHTML = '') BEFORE rendering new values.
// - overlay-input-leak: every input path checks `gameState === 'playing'`.
// - missing-overlay-css: .overlay--hidden is defined in the per-game CSS.

interface Level {
  caps: number[];
  init: number[];
  target: number;
}

// Decanting puzzles. Each is reachable; par (min moves) is computed by BFS
// at load time, so the star thresholds stay correct if a level is edited.
const LEVELS: Level[] = [
  { caps: [6, 4], init: [6, 0], target: 2 },
  { caps: [9, 7], init: [0, 0], target: 2 },
  { caps: [5, 3], init: [0, 0], target: 4 },
  { caps: [8, 5], init: [0, 0], target: 6 },
  { caps: [8, 5, 3], init: [8, 0, 0], target: 4 },
  { caps: [12, 7, 5], init: [12, 0, 0], target: 6 },
];

const PROGRESS_KEY = 'iksir-olcer.progress';
// Leaderboard: highest level reached (flat mirror; full progress stays in PROGRESS_KEY).
const SCORE_DESC = { gameId: 'iksir-olcer', storageKey: 'iksir-olcer.lb', direction: 'higher' as const };

interface Progress {
  unlocked: number;
  stars: number[];
}

type GameState = 'playing' | 'won';

let levelIdx = 0;
let caps: number[] = [];
let fills: number[] = [];
let target = 0;
let moves = 0;
let par = 0;
let selected: number | null = null;
let gameState: GameState = 'playing';
let history: number[][] = [];
let progress: Progress = { unlocked: 0, stars: [] };

let flasksEl!: HTMLElement;
let levelEl!: HTMLElement;
let movesEl!: HTMLElement;
let targetEl!: HTMLElement;
let statusEl!: HTMLElement;
let undoBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayStars!: HTMLElement;
let nextBtn!: HTMLButtonElement;
let replayBtn!: HTMLButtonElement;

interface FlaskNodes {
  glass: HTMLButtonElement;
  liquid: HTMLElement;
  amt: HTMLElement;
}
let nodes: FlaskNodes[] = [];

function solvePar(level: Level): number {
  const n = level.caps.length;
  const hit = (f: number[]): boolean => f.some((v) => v === level.target);
  if (hit(level.init)) return 0;

  const seen = new Set<string>([level.init.join(',')]);
  let frontier: number[][] = [level.init];
  let depth = 0;

  while (frontier.length > 0 && depth < 80) {
    depth++;
    const next: number[][] = [];
    for (const f of frontier) {
      for (let i = 0; i < n; i++) {
        const fi = f[i]!;
        const ci = level.caps[i]!;
        const candidates: number[][] = [];
        if (fi < ci) {
          const g = f.slice();
          g[i] = ci;
          candidates.push(g);
        }
        if (fi > 0) {
          const g = f.slice();
          g[i] = 0;
          candidates.push(g);
        }
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const fj = f[j]!;
          const amt = Math.min(fi, level.caps[j]! - fj);
          if (amt > 0) {
            const g = f.slice();
            g[i] = fi - amt;
            g[j] = fj + amt;
            candidates.push(g);
          }
        }
        for (const g of candidates) {
          if (hit(g)) return depth;
          const key = g.join(',');
          if (!seen.has(key)) {
            seen.add(key);
            next.push(g);
          }
        }
      }
    }
    frontier = next;
  }
  return Number.POSITIVE_INFINITY;
}

function starsFor(mv: number): number {
  if (mv <= par) return 3;
  if (mv <= par + 3) return 2;
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

function buildFlasks(): void {
  flasksEl.innerHTML = '';
  nodes = [];
  flasksEl.dataset.count = String(caps.length);

  caps.forEach((cap, i) => {
    const flask = document.createElement('div');
    flask.className = 'flask';

    const glass = document.createElement('button');
    glass.type = 'button';
    glass.className = 'flask__glass';
    glass.addEventListener('click', () => select(i));

    const liquid = document.createElement('span');
    liquid.className = 'flask__liquid';

    const targetLine = document.createElement('span');
    targetLine.className = 'flask__target';
    if (target <= cap) {
      targetLine.style.bottom = `${(target / cap) * 100}%`;
    } else {
      targetLine.style.display = 'none';
    }

    const amt = document.createElement('span');
    amt.className = 'flask__amt';

    glass.append(liquid, targetLine, amt);

    const ctl = document.createElement('div');
    ctl.className = 'flask__ctl';

    const fillBtn = document.createElement('button');
    fillBtn.type = 'button';
    fillBtn.className = 'flask__op';
    fillBtn.textContent = 'Doldur';
    fillBtn.addEventListener('click', () => doFill(i));

    const emptyBtn = document.createElement('button');
    emptyBtn.type = 'button';
    emptyBtn.className = 'flask__op';
    emptyBtn.textContent = 'Boşalt';
    emptyBtn.addEventListener('click', () => doEmpty(i));

    ctl.append(fillBtn, emptyBtn);
    flask.append(glass, ctl);
    flasksEl.append(flask);

    nodes.push({ glass, liquid, amt });
  });
}

function render(): void {
  levelEl.textContent = `${levelIdx + 1}/${LEVELS.length}`;
  movesEl.textContent = String(moves);
  targetEl.textContent = `${target}`;

  nodes.forEach((node, i) => {
    const cap = caps[i]!;
    const v = fills[i]!;
    node.liquid.style.height = `${(v / cap) * 100}%`;
    node.amt.innerHTML = `<b>${v}</b>/${cap}`;
    node.glass.classList.toggle('flask__glass--sel', selected === i);
    node.glass.classList.toggle('flask__glass--hit', v === target);
    node.glass.setAttribute(
      'aria-label',
      `Şişe ${i + 1}: ${v} bölü ${cap} birim${selected === i ? ', seçili' : ''}`,
    );
  });

  undoBtn.disabled = history.length === 0 || gameState !== 'playing';

  if (gameState === 'won') {
    statusEl.textContent = 'Bölüm tamamlandı!';
  } else if (selected !== null) {
    statusEl.textContent = `Şişe ${selected + 1} seçili — dökmek için başka şişeye dokun.`;
  } else {
    statusEl.textContent =
      'Bir şişe seç, sonra başka şişeye dök; ya da Doldur/Boşalt.';
  }
}

function pushHistory(): void {
  history.push(fills.slice());
}

function afterMove(): void {
  if (gameState === 'playing' && fills.some((v) => v === target)) {
    gameState = 'won';
    selected = null;
    const s = starsFor(moves);
    recordStars(levelIdx, s);
    reportGameOver(SCORE_DESC, levelIdx + 1, { label: 'Seviye' });
    showWin(s);
  }
  render();
}

function doFill(i: number): void {
  if (gameState !== 'playing') return;
  if (fills[i]! >= caps[i]!) return;
  pushHistory();
  fills[i] = caps[i]!;
  moves++;
  afterMove();
}

function doEmpty(i: number): void {
  if (gameState !== 'playing') return;
  if (fills[i]! <= 0) return;
  pushHistory();
  fills[i] = 0;
  moves++;
  afterMove();
}

function pour(from: number, to: number): void {
  if (gameState !== 'playing') return;
  const amt = Math.min(fills[from]!, caps[to]! - fills[to]!);
  if (amt <= 0) return;
  pushHistory();
  fills[from] = fills[from]! - amt;
  fills[to] = fills[to]! + amt;
  moves++;
  afterMove();
}

function select(i: number): void {
  if (gameState !== 'playing') return;
  if (selected === null) {
    selected = i;
    render();
    return;
  }
  if (selected === i) {
    selected = null;
    render();
    return;
  }
  const from = selected;
  selected = null;
  pour(from, i);
}

function undo(): void {
  if (gameState !== 'playing' || history.length === 0) return;
  fills = history.pop()!;
  moves = Math.max(0, moves - 1);
  selected = null;
  render();
}

function showWin(s: number): void {
  overlayStars.textContent = starString(s);
  overlayStars.setAttribute('aria-label', `${s} yıldız`);
  const parText = Number.isFinite(par) ? `En az: ${par} hamle` : '';
  overlayTitle.textContent = s === 3 ? 'Kusursuz ölçüm!' : 'Hedef tutturuldu!';
  overlayMsg.textContent =
    `${target} birimi ${moves} hamlede ölçtün.` + (parText ? `\n${parText}` : '');
  const last = levelIdx >= LEVELS.length - 1;
  nextBtn.textContent = last ? 'Baştan oyna' : 'Sonraki bölüm';
  showOverlayEl(overlay);
}

function loadLevel(idx: number): void {
  levelIdx = ((idx % LEVELS.length) + LEVELS.length) % LEVELS.length;
  const level = LEVELS[levelIdx]!;
  caps = level.caps.slice();
  fills = level.init.slice();
  target = level.target;
  moves = 0;
  selected = null;
  history = [];
  gameState = 'playing';
  par = solvePar(level);
  hideOverlayEl(overlay);
  buildFlasks();
  render();
}

function init(): void {
  flasksEl = document.querySelector<HTMLElement>('#flasks')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayStars = document.querySelector<HTMLElement>('#overlay-stars')!;
  nextBtn = document.querySelector<HTMLButtonElement>('#next-btn')!;
  replayBtn = document.querySelector<HTMLButtonElement>('#replay-btn')!;

  loadProgress();

  undoBtn.addEventListener('click', undo);
  restartBtn.addEventListener('click', () => loadLevel(levelIdx));
  nextBtn.addEventListener('click', () => loadLevel(levelIdx + 1));
  replayBtn.addEventListener('click', () => loadLevel(levelIdx));

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '9') {
      const idx = Number(k) - 1;
      if (idx < caps.length) {
        select(idx);
        e.preventDefault();
      }
    } else if (k === 'f') {
      if (selected !== null) doFill(selected);
      e.preventDefault();
    } else if (k === 'e') {
      if (selected !== null) doEmpty(selected);
      e.preventDefault();
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
      }
    }
  });

  const startIdx = Math.min(progress.unlocked, LEVELS.length - 1);
  loadLevel(startIdx);
}

export const game = defineGame({ init });
