// First-person local input: keyboard + mouse-look (pointer lock, with a
// drag-look fallback) + touch (left-half joystick to move, right-half drag to
// look, on-screen button to act). Produces a facing-relative InputState
// (fwd/strafe/yaw) plus a look pitch for the camera.
//
// Keyboard has NO deadzone — a pressed key is a full unit (pitfall:
// deadzone-blocks-keyboard-steering). Key/typing handlers ignore INPUT/TEXTAREA
// focus so typing a name never moves the player.

import { DRAG_SENS, LOOK_SENS, PITCH_LIMIT } from './constants';
import type { InputState } from './types';

export interface LocalInput {
  attach(): void;
  read(into: InputState): void;
  /** Current look pitch (radians, + = up) for the FPV camera. */
  lookPitch(): number;
  lookYaw(): number;
  /** Seed yaw/pitch (e.g. from the player's spawn facing) at match start. */
  setLook(yaw: number, pitch?: number): void;
  /** True while the pointer is locked (used to hide the cursor / show hints). */
  isLocked(): boolean;
  readonly isCoarse: boolean;
}

export function createLocalInput(opts: {
  canvas: HTMLCanvasElement;
  stick: HTMLElement;
  nub: HTMLElement;
  actionBtn: HTMLButtonElement;
}): LocalInput {
  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let fireEdge = false;
  let locked = false;
  let stickId = -1;
  let stickOrigin = { x: 0, y: 0 };
  let stick = { fwd: 0, strafe: 0 };
  let dragId = -1;
  let dragX = 0;
  let dragY = 0;
  let dragMoved = false;
  let dragStart = 0;

  const isCoarse =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

  function rotate(dx: number, dy: number, sens: number): void {
    yaw -= dx * sens;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - dy * sens));
  }

  function keyAxis(): { fwd: number; strafe: number } {
    let fwd = 0;
    let strafe = 0;
    if (keys.has('w') || keys.has('arrowup')) fwd += 1;
    if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
    if (keys.has('d') || keys.has('arrowright')) strafe += 1;
    if (keys.has('a') || keys.has('arrowleft')) strafe -= 1;
    return { fwd, strafe };
  }

  function placeNub(dx: number, dy: number): void {
    opts.nub.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function attach(): void {
    const { canvas, stick: stickEl, actionBtn } = opts;

    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      const k = e.key.toLowerCase();
      if (
        k === 'w' || k === 'a' || k === 's' || k === 'd' ||
        k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright'
      ) {
        keys.add(k);
        e.preventDefault();
      } else if (k === ' ' || k === 'enter') {
        fireEdge = true;
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => keys.clear());

    // Pointer lock (desktop): a click locks; movement events then drive the look.
    document.addEventListener('pointerlockchange', () => {
      locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (locked) rotate(e.movementX, e.movementY, LOOK_SENS);
    });
    canvas.addEventListener('click', () => {
      if (!locked && !isCoarse) canvas.requestPointerLock?.();
    });

    canvas.addEventListener('pointerdown', (e) => {
      if (locked) {
        fireEdge = true; // locked click = act
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const leftHalf = e.clientX - rect.left < rect.width * 0.45;
      if (isCoarse && e.pointerType !== 'mouse' && leftHalf && stickId === -1) {
        stickId = e.pointerId;
        stickOrigin = { x: e.clientX, y: e.clientY };
        stick = { fwd: 0, strafe: 0 };
        stickEl.style.left = `${e.clientX - rect.left - 50}px`;
        stickEl.style.top = `${e.clientY - rect.top - 50}px`;
        stickEl.classList.add('km-stick--live');
        placeNub(0, 0);
      } else {
        dragId = e.pointerId;
        dragX = e.clientX;
        dragY = e.clientY;
        dragMoved = false;
        dragStart = performance.now();
        canvas.setPointerCapture?.(e.pointerId);
      }
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId === stickId) {
        const dx = e.clientX - stickOrigin.x;
        const dy = e.clientY - stickOrigin.y;
        const len = Math.hypot(dx, dy);
        const cap = 42;
        const s = len > cap ? cap / len : 1;
        stick = { strafe: (dx * s) / cap, fwd: -(dy * s) / cap };
        placeNub(dx * s, dy * s);
      } else if (e.pointerId === dragId) {
        const dx = e.clientX - dragX;
        const dy = e.clientY - dragY;
        dragX = e.clientX;
        dragY = e.clientY;
        rotate(dx, dy, DRAG_SENS);
        if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
      }
    });
    const endPointer = (e: PointerEvent): void => {
      if (e.pointerId === stickId) {
        stickId = -1;
        stick = { fwd: 0, strafe: 0 };
        opts.stick.classList.remove('km-stick--live');
        placeNub(0, 0);
      } else if (e.pointerId === dragId) {
        dragId = -1;
        // A quick tap that didn't drag = act (look is done by dragging).
        if (!dragMoved && performance.now() - dragStart < 250) fireEdge = true;
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    actionBtn.addEventListener('pointerdown', (e) => {
      fireEdge = true;
      e.preventDefault();
    });
  }

  function read(into: InputState): void {
    const k = keyAxis();
    const using = k.fwd !== 0 || k.strafe !== 0;
    into.fwd = using ? k.fwd : stick.fwd;
    into.strafe = using ? k.strafe : stick.strafe;
    into.yaw = yaw;
    if (fireEdge) into.fire = true;
    fireEdge = false;
  }

  return {
    attach,
    read,
    lookPitch: () => pitch,
    lookYaw: () => yaw,
    setLook: (y, p = 0) => {
      yaw = y;
      pitch = p;
    },
    isLocked: () => locked,
    isCoarse,
  };
}
