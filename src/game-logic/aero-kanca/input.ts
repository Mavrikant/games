// Local player input: keyboard + mouse + touch (virtual joystick on the left
// half, tap-to-hook on the right, plus a dedicated hook button). Produces a
// normalized InputState; the entry applies it ONLY while status === 'playing'
// (pitfall: overlay-input-leak — the overlay also physically covers the
// canvas, so pointer events can't leak through while it is visible).
//
// Keyboard has NO deadzone — a pressed key is always a full unit vector
// (pitfall: deadzone-blocks-keyboard-steering). The keydown handler ignores
// events while an INPUT/TEXTAREA is focused so typing a name never steers
// (erime-arena smoke regression).

import type { InputState } from './types';

export interface LocalInput {
  attach(): void;
  /** Copy the current state into `into`, consuming one-shot edges. */
  read(into: InputState): void;
  /** True when the last aim came from a real pointer position. */
  hasAim(): boolean;
  readonly isCoarse: boolean;
}

export function createLocalInput(opts: {
  canvas: HTMLCanvasElement;
  stick: HTMLElement;
  nub: HTMLElement;
  hookBtn: HTMLButtonElement;
  /** Convert client coords to a world ground point (null when WebGL is off). */
  toWorld: (clientX: number, clientY: number) => { x: number; z: number } | null;
}): LocalInput {
  const keys = new Set<string>();
  let aimClient: { x: number; y: number } | null = null;
  let aimWorld: { x: number; z: number } | null = null;
  let held = false;
  let fireEdge = false;
  let releaseEdge = false;
  // Touch joystick state.
  let stickId = -1;
  let stickOrigin = { x: 0, y: 0 };
  let stickVec = { x: 0, y: 0 };
  let hookPointerId = -1;

  const isCoarse =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

  function press(): void {
    fireEdge = true;
    held = true;
  }

  function lift(): void {
    if (held) releaseEdge = true;
    held = false;
  }

  function keyToAxis(): { mx: number; mz: number } {
    let mx = 0;
    let mz = 0;
    if (keys.has('w') || keys.has('arrowup')) mz -= 1;
    if (keys.has('s') || keys.has('arrowdown')) mz += 1;
    if (keys.has('a') || keys.has('arrowleft')) mx -= 1;
    if (keys.has('d') || keys.has('arrowright')) mx += 1;
    return { mx, mz };
  }

  function placeNub(dx: number, dy: number): void {
    opts.nub.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function attach(): void {
    const { canvas, stick, hookBtn } = opts;

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
      } else if (k === 'escape') {
        lift();
      }
    });
    window.addEventListener('keyup', (e) => {
      keys.delete(e.key.toLowerCase());
    });
    window.addEventListener('blur', () => {
      keys.clear();
      lift();
    });

    // Pointer handling on the canvas. The overlay sits above the canvas, so
    // none of these fire while a menu is visible.
    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const leftHalf = e.clientX - rect.left < rect.width * 0.45;
      if (isCoarse && e.pointerType !== 'mouse' && leftHalf && stickId === -1) {
        // Virtual joystick anchors where the finger lands.
        stickId = e.pointerId;
        stickOrigin = { x: e.clientX, y: e.clientY };
        stickVec = { x: 0, y: 0 };
        stick.style.left = `${e.clientX - rect.left - 50}px`;
        stick.style.top = `${e.clientY - rect.top - 50}px`;
        stick.classList.add('ak-stick--live');
        placeNub(0, 0);
      } else {
        // Aim + hook (mouse anywhere; touch on the right side).
        hookPointerId = e.pointerId;
        aimClient = { x: e.clientX, y: e.clientY };
        press();
      }
      canvas.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId === stickId) {
        const dx = e.clientX - stickOrigin.x;
        const dy = e.clientY - stickOrigin.y;
        const len = Math.hypot(dx, dy);
        const cap = 40;
        const s = len > cap ? cap / len : 1;
        stickVec = { x: (dx * s) / cap, y: (dy * s) / cap };
        placeNub(dx * s, dy * s);
        return;
      }
      aimClient = { x: e.clientX, y: e.clientY };
    });
    const endPointer = (e: PointerEvent): void => {
      if (e.pointerId === stickId) {
        stickId = -1;
        stickVec = { x: 0, y: 0 };
        opts.stick.classList.remove('ak-stick--live');
        placeNub(0, 0);
        return;
      }
      if (e.pointerId === hookPointerId) {
        hookPointerId = -1;
        lift();
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Dedicated hook button (thumb players): fire toward the current aim.
    hookBtn.addEventListener('pointerdown', (e) => {
      press();
      e.preventDefault();
    });
    hookBtn.addEventListener('pointerup', () => lift());
    hookBtn.addEventListener('pointercancel', () => lift());
  }

  function read(into: InputState): void {
    const axis = keyToAxis();
    into.mx = axis.mx !== 0 || axis.mz !== 0 ? axis.mx : stickVec.x;
    into.mz = axis.mx !== 0 || axis.mz !== 0 ? axis.mz : stickVec.y;
    if (aimClient) {
      const w = opts.toWorld(aimClient.x, aimClient.y);
      if (w) aimWorld = w;
    }
    if (aimWorld) {
      into.aimX = aimWorld.x;
      into.aimZ = aimWorld.z;
    }
    into.held = held;
    if (fireEdge) into.fire = true;
    if (releaseEdge) into.release = true;
    fireEdge = false;
    releaseEdge = false;
  }

  return {
    attach,
    read,
    hasAim: () => aimWorld !== null,
    isCoarse,
  };
}
