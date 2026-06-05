// Input: one state-guarded keydown switch + pointer drag aiming + ammo keys.

import { S } from './state';
import { MAX_PULL, P0X, P0Y, W, H, clamp } from './constants';
import { ENGINES } from './engines';
import { fire, retryLevel, toMap } from './flow';
import { selectAmmo } from './ui';
import { getCanvas } from './render';
import * as audio from './audio';

const OVERLAY_STATES = new Set([
  'intro',
  'map',
  'prelevel',
  'levelclear',
  'gameover',
  'settings',
  'achievements',
]);

function toCanvas(e: PointerEvent): { x: number; y: number } {
  const c = getCanvas();
  const rect = c.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * W,
    y: ((e.clientY - rect.top) / rect.height) * H,
  };
}

function updateAimFromPointer(e: PointerEvent): void {
  const p = toCanvas(e);
  const eng = ENGINES[S.engineId];
  const dx = P0X - p.x;
  const dy = P0Y - p.y;
  S.aimAngle = clamp(Math.atan2(dy, dx), eng.angleMin, eng.angleMax);
  S.power = clamp(Math.hypot(dx, dy) / MAX_PULL, 0.05, 1);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    if (S.state === 'aiming' || S.state === 'firing' || S.state === 'settling' || S.state === 'gameover' || S.state === 'levelclear') {
      retryLevel();
      e.preventDefault();
    }
    return;
  }
  if (OVERLAY_STATES.has(S.state)) return;
  if (S.state !== 'aiming') return;

  const eng = ENGINES[S.engineId];
  if (k === 'ArrowUp') {
    S.aimAngle = clamp(S.aimAngle - eng.aimStep, eng.angleMin, eng.angleMax);
    e.preventDefault();
  } else if (k === 'ArrowDown') {
    S.aimAngle = clamp(S.aimAngle + eng.aimStep, eng.angleMin, eng.angleMax);
    e.preventDefault();
  } else if (k === 'ArrowLeft') {
    S.power = clamp(S.power - 0.03, 0.05, 1);
    e.preventDefault();
  } else if (k === 'ArrowRight') {
    S.power = clamp(S.power + 0.03, 0.05, 1);
    e.preventDefault();
  } else if (k === ' ' || k === 'Enter') {
    fire();
    e.preventDefault();
  } else if (k === 'm' || k === 'M' || k === 'Escape') {
    toMap();
    e.preventDefault();
  } else if (k >= '1' && k <= '9') {
    const idx = Number(k) - 1;
    const id = S.loadout[idx];
    if (id) selectAmmo(id);
    e.preventDefault();
  }
}

function onPointerDown(e: PointerEvent): void {
  audio.ensureAudio();
  if (S.state !== 'aiming') return;
  S.dragging = true;
  S.aimedByDrag = false;
  try {
    getCanvas().setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!S.dragging || S.state !== 'aiming') return;
  S.aimedByDrag = true;
  updateAimFromPointer(e);
  e.preventDefault();
}

function onPointerUp(e: PointerEvent): void {
  if (!S.dragging) return;
  S.dragging = false;
  try {
    getCanvas().releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  if (S.aimedByDrag && S.state === 'aiming') fire();
  e.preventDefault();
}

export function bindInput(): void {
  const c = getCanvas();
  window.addEventListener('keydown', onKey);
  c.addEventListener('pointerdown', onPointerDown);
  c.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}
