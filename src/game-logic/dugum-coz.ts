import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Untangle / planarity puzzle. The graph is built from an arrangement of
// straight lines: every pairwise line intersection is a node, and each line's
// consecutive intersections form edges. A line arrangement is planar by
// construction, so the intersection coordinates are always a crossing-free
// solution — the puzzle is guaranteed solvable. Node positions are then
// scrambled and the player drags them back to a layout with zero crossings.

const STORAGE_BEST = 'dugum-coz.best'; // best (fewest) moves per level
// Leaderboard: highest level reached (per-level bests stay in STORAGE_BEST as a
// map; this flat key is just the leaderboard mirror).
const SCORE_DESC = { gameId: 'dugum-coz', storageKey: 'dugum-coz.lb', direction: 'higher' as const };

const NODE_R = 11; // visual + hit radius
const MARGIN = 28; // keep nodes away from canvas edge
const CROSS_RED = '#f87171';

type Node = { x: number; y: number };
type Edge = { a: number; b: number };

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let crossingsEl!: HTMLElement;
let movesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let nextBtn!: HTMLButtonElement;

let level = 1;
let nodes: Node[] = [];
let edges: Edge[] = [];
let crossingEdges = new Set<number>();
let crossingCount = 0;
let moves = 0;
let won = false;

let dragIndex = -1;
let dragMoved = false;
let bests: Record<number, number> = {};

// --- geometry helpers ---

function lineIntersection(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { x: number; y: number } | null {
  const r1x = bx - ax;
  const r1y = by - ay;
  const r2x = dx - cx;
  const r2y = dy - cy;
  const denom = r1x * r2y - r1y * r2x;
  if (Math.abs(denom) < 1e-9) return null; // parallel
  const t = ((cx - ax) * r2y - (cy - ay) * r2x) / denom;
  return { x: ax + t * r1x, y: ay + t * r1y };
}

function ccw(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (cy - ay) * (bx - ax) - (by - ay) * (cx - ax);
}

// Proper segment intersection (endpoints touching does not count).
function segmentsCross(p: Edge, q: Edge): boolean {
  const a = nodes[p.a]!;
  const b = nodes[p.b]!;
  const c = nodes[q.a]!;
  const d = nodes[q.b]!;
  const d1 = ccw(c.x, c.y, d.x, d.y, a.x, a.y);
  const d2 = ccw(c.x, c.y, d.x, d.y, b.x, b.y);
  const d3 = ccw(a.x, a.y, b.x, b.y, c.x, c.y);
  const d4 = ccw(a.x, a.y, b.x, b.y, d.x, d.y);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  return false;
}

// --- level generation (line arrangement) ---

function buildGraph(lineCount: number): { nodes: Node[]; edges: Edge[] } {
  const size = canvas.width;
  const lo = MARGIN;
  const hi = size - MARGIN;
  const span = hi - lo;

  // Each line is two points inside an inner box so intersections land on-board.
  const lines: { ax: number; ay: number; bx: number; by: number }[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push({
      ax: lo + Math.random() * span,
      ay: lo + Math.random() * span,
      bx: lo + Math.random() * span,
      by: lo + Math.random() * span,
    });
  }

  // intersection points, parametrized along each owning line for ordering.
  type Inter = { x: number; y: number; line: number; t: number };
  const inters: Inter[] = [];
  for (let i = 0; i < lineCount; i++) {
    for (let j = i + 1; j < lineCount; j++) {
      const li = lines[i]!;
      const lj = lines[j]!;
      const p = lineIntersection(
        li.ax,
        li.ay,
        li.bx,
        li.by,
        lj.ax,
        lj.ay,
        lj.bx,
        lj.by,
      );
      if (!p) continue;
      if (p.x < lo || p.x > hi || p.y < lo || p.y > hi) continue;
      const ti =
        Math.abs(li.bx - li.ax) > Math.abs(li.by - li.ay)
          ? (p.x - li.ax) / (li.bx - li.ax)
          : (p.y - li.ay) / (li.by - li.ay);
      const tj =
        Math.abs(lj.bx - lj.ax) > Math.abs(lj.by - lj.ay)
          ? (p.x - lj.ax) / (lj.bx - lj.ax)
          : (p.y - lj.ay) / (lj.by - lj.ay);
      inters.push({ x: p.x, y: p.y, line: i, t: ti });
      inters.push({ x: p.x, y: p.y, line: j, t: tj });
    }
  }

  // Merge near-duplicate points into shared nodes.
  const builtNodes: Node[] = [];
  function nodeIndex(x: number, y: number): number {
    for (let k = 0; k < builtNodes.length; k++) {
      const n = builtNodes[k]!;
      if (Math.abs(n.x - x) < 4 && Math.abs(n.y - y) < 4) return k;
    }
    builtNodes.push({ x, y });
    return builtNodes.length - 1;
  }

  const edgeSet = new Set<string>();
  const builtEdges: Edge[] = [];
  function addEdge(a: number, b: number): void {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    builtEdges.push({ a, b });
  }

  // group intersections per line, sort along it, connect neighbours.
  for (let i = 0; i < lineCount; i++) {
    const pts = inters.filter((p) => p.line === i).sort((p, q) => p.t - q.t);
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = nodeIndex(pts[k]!.x, pts[k]!.y);
      const b = nodeIndex(pts[k + 1]!.x, pts[k + 1]!.y);
      addEdge(a, b);
    }
  }

  // drop isolated nodes (no edge), reindexing.
  const used = new Set<number>();
  for (const e of builtEdges) {
    used.add(e.a);
    used.add(e.b);
  }
  const remap = new Map<number, number>();
  const finalNodes: Node[] = [];
  for (let k = 0; k < builtNodes.length; k++) {
    if (!used.has(k)) continue;
    remap.set(k, finalNodes.length);
    finalNodes.push({ x: builtNodes[k]!.x, y: builtNodes[k]!.y });
  }
  const finalEdges: Edge[] = builtEdges.map((e) => ({
    a: remap.get(e.a)!,
    b: remap.get(e.b)!,
  }));

  return { nodes: finalNodes, edges: finalEdges };
}

function scramble(): void {
  const size = canvas.width;
  const lo = MARGIN;
  const hi = size - MARGIN;
  const span = hi - lo;
  for (const n of nodes) {
    n.x = lo + Math.random() * span;
    n.y = lo + Math.random() * span;
  }
}

function generateLevel(): void {
  const lineCount = Math.min(4 + (level - 1), 8);
  // Accept only a graph whose intersection-coordinate layout is crossing-free,
  // so a solution provably exists (rejects rare near-concurrent degeneracies).
  let attempts = 0;
  do {
    const built = buildGraph(lineCount);
    nodes = built.nodes;
    edges = built.edges;
    recountCrossings(); // evaluated at the solution coordinates
    attempts++;
  } while (
    (nodes.length < 5 || edges.length < 5 || crossingCount !== 0) &&
    attempts < 60
  );

  // Scramble until the start layout actually has crossings to solve.
  let tries = 0;
  do {
    scramble();
    recountCrossings();
    tries++;
  } while (crossingCount === 0 && tries < 30);
}

// --- crossing state ---

function recountCrossings(): void {
  crossingEdges = new Set<number>();
  let count = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i]!;
      const e2 = edges[j]!;
      if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) {
        continue; // shared endpoint
      }
      if (segmentsCross(e1, e2)) {
        count++;
        crossingEdges.add(i);
        crossingEdges.add(j);
      }
    }
  }
  crossingCount = count;
}

// --- rendering ---

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, w, h);

  const clean = getCss('--border-strong') || '#2f3540';
  const accent = getCss('--accent');

  ctx.lineWidth = 2.5;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const a = nodes[e.a]!;
    const b = nodes[e.b]!;
    ctx.strokeStyle = crossingEdges.has(i) ? CROSS_RED : clean;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    ctx.beginPath();
    ctx.arc(n.x, n.y, NODE_R, 0, Math.PI * 2);
    ctx.fillStyle = i === dragIndex ? getCss('--text') : accent;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = getCss('--surface');
    ctx.stroke();
  }
}

function render(): void {
  levelEl.textContent = String(level);
  crossingsEl.textContent = String(crossingCount);
  movesEl.textContent = String(moves);
  draw();
}

// --- win handling ---

function checkWin(): void {
  if (won || crossingCount !== 0) return;
  won = true;
  const prev = bests[level];
  let msg = `Bu bölümü ${moves} hamlede çözdün.`;
  if (prev === undefined || moves < prev) {
    bests[level] = moves;
    safeWrite(STORAGE_BEST, bests);
    if (prev !== undefined) msg += `\nYeni rekor! (önceki ${prev})`;
  } else {
    msg += `\nRekor: ${prev} hamle`;
  }
  overlayTitle.textContent = 'Bölüm tamam!';
  overlayMsg.textContent = msg;
  reportGameOver(SCORE_DESC, level, { label: 'Seviye' });
  showOverlayEl(overlay);
}

// --- input ---

function canvasPoint(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) * (canvas.width / rect.width),
    y: (ev.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function nodeAt(x: number, y: number): number {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    const dx = n.x - x;
    const dy = n.y - y;
    if (dx * dx + dy * dy <= (NODE_R + 6) * (NODE_R + 6)) return i;
  }
  return -1;
}

function onPointerDown(ev: PointerEvent): void {
  if (won) return;
  const p = canvasPoint(ev);
  const i = nodeAt(p.x, p.y);
  if (i === -1) return;
  dragIndex = i;
  dragMoved = false;
  canvas.setPointerCapture(ev.pointerId);
  ev.preventDefault();
  render();
}

function onPointerMove(ev: PointerEvent): void {
  if (dragIndex === -1) return;
  const p = canvasPoint(ev);
  const lo = NODE_R;
  const hi = canvas.width - NODE_R;
  const node = nodes[dragIndex]!;
  node.x = Math.max(lo, Math.min(hi, p.x));
  node.y = Math.max(lo, Math.min(hi, p.y));
  dragMoved = true;
  recountCrossings();
  render();
  ev.preventDefault();
}

function onPointerUp(ev: PointerEvent): void {
  if (dragIndex === -1) return;
  if (canvas.hasPointerCapture(ev.pointerId)) {
    canvas.releasePointerCapture(ev.pointerId);
  }
  if (dragMoved) moves++;
  dragIndex = -1;
  recountCrossings();
  render();
  checkWin();
}

// --- lifecycle ---

function reset(): void {
  // "Karıştır": same level, fresh scramble.
  won = false;
  moves = 0;
  dragIndex = -1;
  hideOverlayEl(overlay);
  generateLevel();
  render();
}

function nextLevel(): void {
  level++;
  reset();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  crossingsEl = document.querySelector<HTMLElement>('#crossings')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  nextBtn = document.querySelector<HTMLButtonElement>('#next')!;

  bests = safeRead<Record<number, number>>(STORAGE_BEST, {});

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  restartBtn.addEventListener('click', reset);
  nextBtn.addEventListener('click', nextLevel);

  generateLevel();
  render();
}

export const game = defineGame({ init, reset });
