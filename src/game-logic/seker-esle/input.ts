// Pointer-based input: click-to-swap on desktop, drag-to-swap on touch.
// Threshold-based direction lock; haptic on swap intent.

import { state, setPhase } from './state';
import {
  cellAtPoint,
  isAdjacent,
  setSelectedCell,
  getBoardEl,
} from './board';
import { startSwap } from './cascade';
import { ensureAudio, isEnabled as isAudioEnabled } from './audio';

const DRAG_THRESHOLD = 12;

interface PointerSession {
  pointerId: number;
  startX: number;
  startY: number;
  startCell: { row: number; col: number };
  fired: boolean;
}

let session: PointerSession | null = null;
let boosterClickHandler: ((row: number, col: number) => boolean) | null = null;

export function setBoosterClickHandler(fn: ((row: number, col: number) => boolean) | null): void {
  boosterClickHandler = fn;
}

export function bindInput(): void {
  const board = getBoardEl();
  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('pointermove', onPointerMove);
  board.addEventListener('pointerup', onPointerUp);
  board.addEventListener('pointercancel', onPointerCancel);
}

function onPointerDown(e: PointerEvent): void {
  if (state.phase !== 'idle' && state.phase !== 'boosterSelect') return;
  ensureAudio();
  const cell = cellAtPoint(e.clientX, e.clientY);
  if (!cell) return;
  const t = state.grid[cell.row]?.[cell.col];
  if (!t) return;
  if (boosterClickHandler) {
    const consumed = boosterClickHandler(cell.row, cell.col);
    if (consumed) return;
  }
  if (state.boosterMode !== 'idle') return;
  try { getBoardEl().setPointerCapture(e.pointerId); } catch {}
  session = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    startCell: cell,
    fired: false,
  };
}

function onPointerMove(e: PointerEvent): void {
  if (!session || e.pointerId !== session.pointerId) return;
  if (session.fired) return;
  const dx = e.clientX - session.startX;
  const dy = e.clientY - session.startY;
  const dist = Math.hypot(dx, dy);
  if (dist < DRAG_THRESHOLD) return;
  let drow = 0, dcol = 0;
  if (Math.abs(dx) > Math.abs(dy)) dcol = dx > 0 ? 1 : -1;
  else drow = dy > 0 ? 1 : -1;
  const tr = session.startCell.row + drow;
  const tc = session.startCell.col + dcol;
  const here = state.grid[session.startCell.row]?.[session.startCell.col];
  const other = state.grid[tr]?.[tc];
  if (here && other) {
    session.fired = true;
    hapticTap();
    startSwap(session.startCell.row, session.startCell.col, tr, tc);
  } else {
    session.fired = true;
  }
}

function onPointerUp(e: PointerEvent): void {
  if (!session || e.pointerId !== session.pointerId) return;
  const wasFired = session.fired;
  const start = session.startCell;
  const dx = e.clientX - session.startX;
  const dy = e.clientY - session.startY;
  const dist = Math.hypot(dx, dy);
  session = null;
  if (wasFired) return;
  // No drag — treat as tap (click-to-swap fallback)
  if (dist >= DRAG_THRESHOLD) return;
  handleTap(start.row, start.col);
}

function onPointerCancel(): void {
  session = null;
}

function handleTap(row: number, col: number): void {
  const t = state.grid[row]?.[col];
  if (!t) return;
  if (!state.selected) {
    setSelectedCell(row, col);
    return;
  }
  if (state.selected.row === row && state.selected.col === col) {
    setSelectedCell(null, null);
    return;
  }
  if (isAdjacent(state.selected.row, state.selected.col, row, col)) {
    const from = state.selected;
    hapticTap();
    startSwap(from.row, from.col, row, col);
    return;
  }
  setSelectedCell(row, col);
}

function hapticTap(): void {
  if (!state.profile.settings.vibrate) return;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(15); } catch {}
  }
}

export function hapticHit(): void {
  if (!state.profile.settings.vibrate) return;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(40); } catch {}
  }
}

export function hapticBig(): void {
  if (!state.profile.settings.vibrate) return;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(80); } catch {}
  }
}

void isAudioEnabled;
void setPhase;
