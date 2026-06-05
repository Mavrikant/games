// The single requestAnimationFrame loop. Reads globals only → reset-safe.

import { S } from './state';
import { FIXED_DT, MAX_FRAME_TIME } from './constants';
import { stepProjectiles, projectilesActive } from './physics';
import { easeBlocks, allSettled } from './blocks';
import { updateFx } from './fx';
import { onShotEnd, resolveAfterSettle } from './flow';
import { draw } from './render';

let lastTime = 0;
let acc = 0;
let raf = 0;

function frame(t: number): void {
  if (!lastTime) lastTime = t;
  const dt = Math.min(MAX_FRAME_TIME, (t - lastTime) / 1000);
  lastTime = t;

  if (S.state === 'firing') {
    acc += dt;
    while (acc >= FIXED_DT) {
      stepProjectiles(FIXED_DT);
      acc -= FIXED_DT;
      if (!projectilesActive()) {
        onShotEnd();
        break;
      }
    }
  } else {
    acc = 0;
  }

  easeBlocks(dt);
  updateFx(dt);

  if (S.state === 'settling' && allSettled()) {
    resolveAfterSettle();
  }

  draw();
  raf = requestAnimationFrame(frame);
}

export function startLoop(): void {
  cancelAnimationFrame(raf);
  lastTime = 0;
  acc = 0;
  raf = requestAnimationFrame(frame);
}
