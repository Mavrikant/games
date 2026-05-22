import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

interface GraphNode {
  id: number;
  x: number;
  y: number;
}
type Edge = readonly [number, number];
interface Level {
  name: string;
  nodes: GraphNode[];
  edges: Edge[];
}

const STORAGE_BEST = 'tek-cizgi.best';

function octagonNodes(): GraphNode[] {
  const out: GraphNode[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    out.push({ id: i, x: 0.5 + 0.4 * Math.cos(a), y: 0.5 + 0.4 * Math.sin(a) });
  }
  return out;
}

const LEVELS: Level[] = [
  {
    name: 'Üçgen',
    nodes: [
      { id: 0, x: 0.5, y: 0.2 },
      { id: 1, x: 0.2, y: 0.78 },
      { id: 2, x: 0.8, y: 0.78 },
    ],
    edges: [[0, 1], [1, 2], [0, 2]],
  },
  {
    name: 'Elmas',
    nodes: [
      { id: 0, x: 0.5, y: 0.15 },
      { id: 1, x: 0.15, y: 0.5 },
      { id: 2, x: 0.85, y: 0.5 },
      { id: 3, x: 0.5, y: 0.85 },
    ],
    edges: [[0, 1], [0, 2], [1, 2], [1, 3], [2, 3]],
  },
  {
    name: 'Yıldız',
    nodes: [
      { id: 0, x: 0.5, y: 0.12 },
      { id: 1, x: 0.93, y: 0.42 },
      { id: 2, x: 0.78, y: 0.88 },
      { id: 3, x: 0.22, y: 0.88 },
      { id: 4, x: 0.07, y: 0.42 },
    ],
    edges: [[0, 2], [2, 4], [4, 1], [1, 3], [3, 0]],
  },
  {
    name: 'Papyon',
    nodes: [
      { id: 0, x: 0.13, y: 0.2 },
      { id: 1, x: 0.13, y: 0.8 },
      { id: 2, x: 0.5, y: 0.5 },
      { id: 3, x: 0.87, y: 0.2 },
      { id: 4, x: 0.87, y: 0.8 },
    ],
    edges: [[0, 1], [0, 2], [1, 2], [2, 3], [2, 4], [3, 4]],
  },
  {
    name: 'İkiz Kareler',
    nodes: [
      { id: 0, x: 0.1, y: 0.25 },
      { id: 1, x: 0.1, y: 0.75 },
      { id: 2, x: 0.5, y: 0.25 },
      { id: 3, x: 0.5, y: 0.75 },
      { id: 4, x: 0.9, y: 0.25 },
      { id: 5, x: 0.9, y: 0.75 },
    ],
    edges: [
      [0, 1], [0, 2], [1, 3], [2, 3],
      [2, 4], [3, 5], [4, 5],
    ],
  },
  {
    name: 'Ev',
    nodes: [
      { id: 0, x: 0.15, y: 0.82 },
      { id: 1, x: 0.85, y: 0.82 },
      { id: 2, x: 0.15, y: 0.5 },
      { id: 3, x: 0.85, y: 0.5 },
      { id: 4, x: 0.5, y: 0.18 },
    ],
    edges: [
      [0, 1], [0, 2], [1, 3], [2, 3],
      [2, 4], [3, 4], [0, 3], [1, 2],
    ],
  },
  {
    name: 'Tam Beşli (K5)',
    nodes: [
      { id: 0, x: 0.5, y: 0.1 },
      { id: 1, x: 0.93, y: 0.4 },
      { id: 2, x: 0.78, y: 0.9 },
      { id: 3, x: 0.22, y: 0.9 },
      { id: 4, x: 0.07, y: 0.4 },
    ],
    edges: [
      [0, 1], [0, 2], [0, 3], [0, 4],
      [1, 2], [1, 3], [1, 4],
      [2, 3], [2, 4],
      [3, 4],
    ],
  },
  {
    name: 'Üçlü Papyon',
    nodes: [
      { id: 0, x: 0.5, y: 0.5 },
      { id: 1, x: 0.5, y: 0.1 },
      { id: 2, x: 0.88, y: 0.32 },
      { id: 3, x: 0.88, y: 0.7 },
      { id: 4, x: 0.5, y: 0.92 },
      { id: 5, x: 0.12, y: 0.7 },
      { id: 6, x: 0.12, y: 0.32 },
    ],
    edges: [
      [0, 1], [0, 2], [1, 2],
      [0, 3], [0, 4], [3, 4],
      [0, 5], [0, 6], [5, 6],
    ],
  },
  {
    name: 'Sekizgen',
    nodes: octagonNodes(),
    edges: [
      [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0],
      [0, 2], [2, 4], [4, 6], [6, 0],
    ],
  },
  {
    name: 'Dört Yapraklı',
    nodes: [
      { id: 0, x: 0.5, y: 0.5 },
      { id: 1, x: 0.18, y: 0.32 },
      { id: 2, x: 0.32, y: 0.18 },
      { id: 3, x: 0.68, y: 0.18 },
      { id: 4, x: 0.82, y: 0.32 },
      { id: 5, x: 0.82, y: 0.68 },
      { id: 6, x: 0.68, y: 0.82 },
      { id: 7, x: 0.32, y: 0.82 },
      { id: 8, x: 0.18, y: 0.68 },
    ],
    edges: [
      [0, 1], [0, 2], [1, 2],
      [0, 3], [0, 4], [3, 4],
      [0, 5], [0, 6], [5, 6],
      [0, 7], [0, 8], [7, 8],
    ],
  },
];

type State = 'ready' | 'playing' | 'won';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let remainingEl!: HTMLElement;
let undoBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

let levelIdx = 0;
let best = 0;
let state: State = 'ready';
let level!: Level;
let path: number[] = [];
const traversed = new Set<string>();

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function hasEdge(a: number, b: number): boolean {
  for (const e of level.edges) {
    if ((e[0] === a && e[1] === b) || (e[0] === b && e[1] === a)) return true;
  }
  return false;
}

const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const c = cssCache.get(name);
  if (c !== undefined) return c;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  cssCache.set(name, v);
  return v;
}

function nodeRadius(): number {
  return Math.max(12, canvas.width * 0.035);
}

function findNode(id: number): GraphNode {
  const n = level.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`Node ${id} not in level ${level.name}`);
  return n;
}

function showOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateRemaining(): void {
  remainingEl.textContent = String(level.edges.length - traversed.size);
}

function loadLevel(idx: number): void {
  levelIdx = ((idx % LEVELS.length) + LEVELS.length) % LEVELS.length;
  level = LEVELS[levelIdx]!;
  path = [];
  traversed.clear();
  state = 'ready';
  scoreEl.textContent = String(levelIdx + 1);
  updateRemaining();
  hideOverlay();
  render();
}

function nextLevel(): void {
  loadLevel(levelIdx + 1);
}

function resetLevel(): void {
  path = [];
  traversed.clear();
  state = 'ready';
  updateRemaining();
  hideOverlay();
  render();
}

function undo(): void {
  if (path.length === 0) return;
  if (path.length === 1) {
    path.pop();
    state = 'ready';
    render();
    return;
  }
  const last = path[path.length - 1]!;
  const prev = path[path.length - 2]!;
  traversed.delete(edgeKey(last, prev));
  path.pop();
  if (state === 'won') {
    state = 'playing';
    hideOverlay();
  }
  updateRemaining();
  render();
}

function pickNode(cx: number, cy: number): GraphNode | null {
  const r = nodeRadius() + 18;
  let chosen: GraphNode | null = null;
  let bestDist = r;
  for (const n of level.nodes) {
    const dx = n.x * canvas.width - cx;
    const dy = n.y * canvas.height - cy;
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      chosen = n;
      bestDist = d;
    }
  }
  return chosen;
}

function tryStep(nodeId: number): void {
  if (state === 'won') return;
  if (path.length === 0) {
    path.push(nodeId);
    state = 'playing';
    render();
    return;
  }
  const current = path[path.length - 1]!;
  if (current === nodeId) return;
  if (!hasEdge(current, nodeId)) return;
  const key = edgeKey(current, nodeId);
  if (traversed.has(key)) return;
  traversed.add(key);
  path.push(nodeId);
  updateRemaining();
  if (traversed.size === level.edges.length) {
    state = 'won';
    const reached = levelIdx + 1;
    if (reached > best) {
      best = reached;
      bestEl.textContent = String(best);
      safeWrite(STORAGE_BEST, best);
    }
    const nextName = LEVELS[(levelIdx + 1) % LEVELS.length]!.name;
    showOverlay(
      'Bölüm tamamlandı!',
      `${level.name} bitti.\nSıradaki: ${nextName}`,
      'Sonraki bölüm',
    );
  }
  render();
}

function render(): void {
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, w, h);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const e of level.edges) {
    const a = findNode(e[0]);
    const b = findNode(e[1]);
    const used = traversed.has(edgeKey(e[0], e[1]));
    ctx.lineWidth = used ? 8 : 3;
    ctx.strokeStyle = used ? getCss('--accent') : getCss('--border-strong');
    ctx.beginPath();
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }

  const r = nodeRadius();
  const current = path.length > 0 ? path[path.length - 1]! : -1;
  const start = path.length > 0 ? path[0]! : -1;

  for (const n of level.nodes) {
    const nx = n.x * w;
    const ny = n.y * h;
    const isCurrent = n.id === current;
    const isStart = n.id === start && !isCurrent;
    const reachable =
      current !== -1 &&
      n.id !== current &&
      hasEdge(current, n.id) &&
      !traversed.has(edgeKey(current, n.id));

    if (reachable) {
      ctx.fillStyle = getCss('--accent-soft');
      ctx.beginPath();
      ctx.arc(nx, ny, r + 10, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = isCurrent
      ? getCss('--accent')
      : isStart
        ? getCss('--success')
        : getCss('--surface-3');
    ctx.strokeStyle = isCurrent
      ? getCss('--accent-strong')
      : getCss('--border-strong');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(nx, ny, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function onPointer(e: PointerEvent): void {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);
  const node = pickNode(x, y);
  if (node === null) return;
  tryStep(node.id);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'u') {
    undo();
    e.preventDefault();
  } else if (k === 'r') {
    resetLevel();
    e.preventDefault();
  } else if (k === 'n') {
    nextLevel();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  remainingEl = document.querySelector<HTMLElement>('#remaining')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointer);
  undoBtn.addEventListener('click', undo);
  restartBtn.addEventListener('click', resetLevel);
  overlayBtn.addEventListener('click', () => {
    if (state === 'won') nextLevel();
    else hideOverlay();
  });
  window.addEventListener('keydown', onKey);

  loadLevel(0);
}

export const game = defineGame({ init, reset: resetLevel });
