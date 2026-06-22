import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOv, hideOverlay as hideOv } from '@shared/overlay';

const STORAGE_BEST = 'tilsim.best';

type State = 'ready' | 'playing' | 'solved' | 'finished';

type LevelSpec = { rings: number; sectors: number };

const LEVELS: LevelSpec[] = [
  { rings: 3, sectors: 6 },
  { rings: 3, sectors: 8 },
  { rings: 4, sectors: 8 },
  { rings: 4, sectors: 10 },
  { rings: 5, sectors: 12 },
];

const PALETTE = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#f43f5e',
  '#84cc16',
  '#0ea5e9',
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let movesEl!: HTMLElement;
let levelEl!: HTMLElement;
let totalEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let ringLabel!: HTMLElement;

let state: State = 'ready';
let levelIdx = 0;
let offsets: number[] = [];
let selectedRing = 0;
let moves = 0;
let totalMoves = 0;
let best = Number.POSITIVE_INFINITY;
let undoStack: Array<{ ring: number; dir: 1 | -1 }> = [];

function spec(): LevelSpec {
  return LEVELS[levelIdx]!;
}

function shuffleOffsets(): void {
  const { rings, sectors } = spec();
  offsets = new Array<number>(rings).fill(0);
  let attempts = 0;
  do {
    for (let i = 0; i < rings; i++) {
      offsets[i] = Math.floor(Math.random() * sectors);
    }
    attempts++;
  } while (isAligned() && attempts < 12);
  if (isAligned()) offsets[0] = (offsets[0]! + 1) % sectors;
}

function isAligned(): boolean {
  const first = offsets[0]!;
  return offsets.every((o) => o === first);
}

function newLevel(): void {
  selectedRing = 0;
  moves = 0;
  undoStack = [];
  state = 'playing';
  shuffleOffsets();
  updateHud();
  draw();
  hideOv(overlay);
}

function fullReset(): void {
  levelIdx = 0;
  totalMoves = 0;
  selectedRing = 0;
  moves = 0;
  undoStack = [];
  state = 'ready';
  shuffleOffsets();
  updateHud();
  draw();
  showOverlayMsg(
    'Tılsım',
    'Halkalar farklı dönmüş. Aynı renkler tepedeki ok altında dik bir kol oluşturana kadar her halkayı sırasıyla döndür.',
    'Başla',
  );
}

function updateHud(): void {
  movesEl.textContent = String(moves);
  levelEl.textContent = String(levelIdx + 1);
  totalEl.textContent = String(totalMoves + moves);
  bestEl.textContent = Number.isFinite(best) ? String(best) : '—';
  ringLabel.textContent = `Halka ${selectedRing + 1}/${spec().rings}`;
}

function rotate(ring: number, dir: 1 | -1): void {
  if (state !== 'playing') return;
  const s = spec().sectors;
  offsets[ring] = (((offsets[ring]! + dir) % s) + s) % s;
  moves++;
  undoStack.push({ ring, dir });
  updateHud();
  draw();
  if (isAligned()) onSolved();
}

function undo(): void {
  if (state !== 'playing') return;
  const last = undoStack.pop();
  if (!last) return;
  const s = spec().sectors;
  offsets[last.ring] =
    (((offsets[last.ring]! - last.dir) % s) + s) % s;
  moves++;
  updateHud();
  draw();
}

function onSolved(): void {
  totalMoves += moves;
  const finished = levelIdx >= LEVELS.length - 1;
  if (finished) {
    state = 'finished';
    if (totalMoves < best) {
      best = totalMoves;
      safeWrite(STORAGE_BEST, best);
    }
    updateHud();
    draw();
    showOverlayMsg(
      'Tılsım hizalandı!',
      `Tüm ${LEVELS.length} seviye tamamlandı. Toplam hamle: ${totalMoves}.` +
        (Number.isFinite(best) && totalMoves === best ? '\n\nYeni rekor!' : ''),
      'Yeniden',
    );
  } else {
    state = 'solved';
    draw();
    showOverlayMsg(
      `Seviye ${levelIdx + 1} tamam`,
      `Hamle: ${moves} · Toplam: ${totalMoves}\nSıradaki: Seviye ${levelIdx + 2} (${LEVELS[levelIdx + 1]!.rings} halka, ${LEVELS[levelIdx + 1]!.sectors} dilim)`,
      'Devam et',
    );
  }
}

function advance(): void {
  if (state === 'finished') {
    fullReset();
    return;
  }
  if (state === 'solved') {
    levelIdx++;
    newLevel();
    return;
  }
  if (state === 'ready') {
    newLevel();
    return;
  }
}

function showOverlayMsg(title: string, msg: string, btnText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnText;
  showOv(overlay);
}

function selectRing(idx: number): void {
  const rings = spec().rings;
  selectedRing = ((idx % rings) + rings) % rings;
  updateHud();
  draw();
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined && cached !== '') return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const out = val !== '' ? val : fallback;
  cssCache.set(name, out);
  return out;
}

function ringRadii(): { inner: number; outer: number; gap: number; center: number } {
  const pixelSize = canvas.width;
  const cx = pixelSize / 2;
  const r = spec().rings;
  const outer = pixelSize * 0.46;
  const inner = pixelSize * 0.14;
  const ringWidth = (outer - inner) / r;
  const gap = Math.min(2, ringWidth * 0.05);
  return { inner, outer, gap, center: cx };
}

function ringBand(i: number): { rIn: number; rOut: number } {
  const { inner, outer, gap } = ringRadii();
  const r = spec().rings;
  const w = (outer - inner) / r;
  const rIn = inner + i * w + gap;
  const rOut = inner + (i + 1) * w - gap;
  return { rIn, rOut };
}

function colorFor(i: number): string {
  return PALETTE[i % PALETTE.length]!;
}

function sectorPath(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, rOut, a0, a1);
  ctx.arc(cx, cy, rIn, a1, a0, true);
  ctx.closePath();
}

function draw(): void {
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);

  const surface = getCss('--surface', '#15171b');
  const border = getCss('--border', '#2a2f36');
  const text = getCss('--text', '#e6e7eb');
  const accent = getCss('--accent', '#6366f1');

  // background panel
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, size, size);

  const { center, inner, outer } = ringRadii();
  const cx = center;
  const cy = center;
  const { rings, sectors } = spec();
  const sectorAngle = (Math.PI * 2) / sectors;

  // Top alignment indicator arrow (just outside the outermost ring)
  ctx.fillStyle = accent;
  const arrowR = outer + 18;
  ctx.beginPath();
  ctx.moveTo(cx, cy - arrowR + 14);
  ctx.lineTo(cx - 10, cy - arrowR);
  ctx.lineTo(cx + 10, cy - arrowR);
  ctx.closePath();
  ctx.fill();

  // Draw rings + sectors
  for (let i = 0; i < rings; i++) {
    const { rIn, rOut } = ringBand(i);
    const off = offsets[i]!;
    for (let s = 0; s < sectors; s++) {
      const colorIdx = (s + off) % sectors;
      const a0 = -Math.PI / 2 + s * sectorAngle - sectorAngle / 2;
      const a1 = a0 + sectorAngle;
      sectorPath(cx, cy, rIn, rOut, a0, a1);
      ctx.fillStyle = colorFor(colorIdx);
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (i === selectedRing) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = text;
      ctx.beginPath();
      ctx.arc(cx, cy, rOut + 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, rIn - 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Center disc
  ctx.beginPath();
  ctx.arc(cx, cy, inner - 4, 0, Math.PI * 2);
  ctx.fillStyle = surface;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Center text: aligned-or-not
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(inner * 0.45)}px system-ui, sans-serif`;
  ctx.fillText(isAligned() ? '✓' : `L${levelIdx + 1}`, cx, cy);
}

function hitTest(px: number, py: number): { ring: number } | null {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  const cx = px * scale;
  const cy = py * scale;
  const { center } = ringRadii();
  const dx = cx - center;
  const dy = cy - center;
  const dist = Math.hypot(dx, dy);
  const rings = spec().rings;
  for (let i = 0; i < rings; i++) {
    const { rIn, rOut } = ringBand(i);
    if (dist >= rIn && dist <= rOut) return { ring: i };
  }
  return null;
}

function onPointer(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hit = hitTest(x, y);
  if (hit) {
    selectedRing = hit.ring;
    updateHud();
    draw();
    e.preventDefault();
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (state === 'ready' || state === 'solved' || state === 'finished') {
    if (k === 'enter' || k === ' ') {
      advance();
      e.preventDefault();
      return;
    }
    if (k === 'r') {
      fullReset();
      e.preventDefault();
      return;
    }
    return;
  }
  if (k === 'arrowleft' || k === 'a') {
    rotate(selectedRing, -1);
    e.preventDefault();
  } else if (k === 'arrowright' || k === 'd') {
    rotate(selectedRing, 1);
    e.preventDefault();
  } else if (k === 'arrowup' || k === 'w') {
    selectRing(selectedRing - 1);
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    selectRing(selectedRing + 1);
    e.preventDefault();
  } else if (k >= '1' && k <= '9') {
    const idx = Number(k) - 1;
    if (idx < spec().rings) {
      selectRing(idx);
      e.preventDefault();
    }
  } else if (k === 'z') {
    undo();
    e.preventDefault();
  } else if (k === 'r') {
    fullReset();
    e.preventDefault();
  }
}

function bindControlBtn(act: string): void {
  document
    .querySelectorAll<HTMLButtonElement>(`.ti-btn[data-act="${act}"]`)
    .forEach((b) => {
      b.addEventListener('click', () => handleAct(act));
    });
}

function handleAct(act: string): void {
  if (act === 'ring-prev') {
    if (state !== 'playing') return;
    selectRing(selectedRing - 1);
  } else if (act === 'ring-next') {
    if (state !== 'playing') return;
    selectRing(selectedRing + 1);
  } else if (act === 'rotate-left') {
    rotate(selectedRing, -1);
  } else if (act === 'rotate-right') {
    rotate(selectedRing, 1);
  } else if (act === 'undo') {
    undo();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  totalEl = document.querySelector<HTMLElement>('#total')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  ringLabel = document.querySelector<HTMLElement>('#ring-label')!;

  best = safeRead<number>(STORAGE_BEST, Number.POSITIVE_INFINITY);
  if (typeof best !== 'number' || !Number.isFinite(best) || best <= 0) {
    best = Number.POSITIVE_INFINITY;
  }

  canvas.addEventListener('pointerdown', onPointer);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', fullReset);
  overlayBtn.addEventListener('click', advance);
  ['ring-prev', 'ring-next', 'rotate-left', 'rotate-right', 'undo'].forEach(
    bindControlBtn,
  );

  fullReset();
}

function reset(): void {
  fullReset();
}

export const game = defineGame({ init, reset });
