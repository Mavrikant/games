import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type State = 'ready' | 'playing' | 'gameover';

const STORAGE_BEST = 'yo-yo.best';
const SCORE_DESC = {
  gameId: 'yo-yo',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

// Canvas geometry — drawn at the canvas's intrinsic resolution; the css scales.
const HAND_Y = 64;
const TRAVEL_MIN = 240;       // shortest possible string at cycle 0
const TRAVEL_STEP = 14;       // each cycle increases max-string by this much
const TRAVEL_MAX = 420;       // hard cap so the disc stays on canvas
const DESCEND_ACCEL = 2200;   // px/s² while held
const ASCEND_ACCEL = 2400;    // px/s² when released (toward hand)
const MAX_DESCEND_SPEED = 820;
const MAX_ASCEND_SPEED = 1000;

// Spin (0..100) drain rates per second. Sleeper is the riskiest band.
const SPIN_DRAIN_DESCEND = 22;
const SPIN_DRAIN_SLEEP = 48;
const SPIN_DRAIN_ASCEND = 12;
const SPIN_RECOVERY_ASCEND = 16; // net while ascending = recovery - drain
const SPIN_CYCLE_RAMP = 0.09;    // +9% drain per completed cycle, capped
const SPIN_RAMP_CAP = 2.5;
const SLEEPER_REQUIRED = 0.12;   // s at the bottom before the bonus starts to bank
const SLEEPER_MAX_BANK = 0.55;   // s — bonus stops growing past this
const COMBO_MAX = 8;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let comboEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;

// Position along the string (px from hand). 0 = at hand, maxTravel = sleeping.
let y = 0;
let vy = 0;
let maxTravel = TRAVEL_MIN;
let spin = 100;
let cycles = 0;
let combo = 1;
let sleeperTime = 0;
let bestDepthThisRun = 0;
let lastTime = 0;
let rafHandle = 0;

// "held" = the player is pressing the throw input right now.
let held = false;

function showOverlay(title: string, msg: string): void {
  overlayTitleEl.textContent = title;
  overlayMsgEl.textContent = msg;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  comboEl.textContent = '×' + combo;
}

function spinDrainMult(): number {
  return Math.min(SPIN_RAMP_CAP, 1 + cycles * SPIN_CYCLE_RAMP);
}

function cancelLoop(): void {
  if (rafHandle !== 0) {
    cancelAnimationFrame(rafHandle);
    rafHandle = 0;
  }
}

function startLoop(): void {
  lastTime = performance.now();
  const myGen = gen.current();
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    step(now);
    if (state === 'playing') rafHandle = requestAnimationFrame(loop);
  };
  rafHandle = requestAnimationFrame(loop);
}

function step(now: number): void {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  const mult = spinDrainMult();
  const atBottom = y >= maxTravel - 0.5 && held;

  // Motion -------------------------------------------------------------------
  if (held) {
    if (atBottom) {
      // Sleeping — clamp position and accumulate the sleeper window.
      y = maxTravel;
      vy = 0;
      sleeperTime += dt;
    } else {
      vy = Math.min(MAX_DESCEND_SPEED, vy + DESCEND_ACCEL * dt);
      y = Math.min(maxTravel, y + vy * dt);
    }
  } else {
    // Recall toward the hand. Once vy is upward enough we coast at max recall.
    vy = Math.max(-MAX_ASCEND_SPEED, vy - ASCEND_ACCEL * dt);
    y = Math.max(0, y + vy * dt);
  }

  // Spin --------------------------------------------------------------------
  let netDrain: number;
  if (held && atBottom) {
    netDrain = SPIN_DRAIN_SLEEP * mult;
  } else if (held) {
    // Descending — drains faster the deeper the yo-yo currently is.
    const depthRatio = y / TRAVEL_MAX;
    netDrain = SPIN_DRAIN_DESCEND * mult * (0.6 + depthRatio * 1.1);
  } else {
    // Ascending — recovers a touch on the way up.
    netDrain = (SPIN_DRAIN_ASCEND - SPIN_RECOVERY_ASCEND) * mult;
  }
  spin = Math.max(0, Math.min(100, spin - netDrain * dt));

  // Track how deep the player has been on this throw for scoring.
  if (y > bestDepthThisRun) bestDepthThisRun = y;

  // Catch detection ---------------------------------------------------------
  if (!held && y <= 0.5 && bestDepthThisRun > 4) {
    landCatch();
  } else if (spin <= 0 && y > 4) {
    tangle();
  }

  draw();
}

function landCatch(): void {
  // Score: depth + sleeper bonus, with a combo multiplier.
  const depth = Math.round((bestDepthThisRun / TRAVEL_MAX) * 100);
  const sleeperBonus =
    sleeperTime > SLEEPER_REQUIRED
      ? Math.round(
          (Math.min(sleeperTime, SLEEPER_MAX_BANK) - SLEEPER_REQUIRED) * 240,
        )
      : 0;
  const gained = Math.max(1, depth + sleeperBonus) * combo;
  score += gained;
  scoreEl.textContent = String(score);

  cycles += 1;
  combo = Math.min(COMBO_MAX, combo + 1);
  comboEl.textContent = '×' + combo;
  // Each successful cycle stretches the maximum string a little — the hand
  // (depth at next throw) grows on its own without UI input.
  maxTravel = Math.min(TRAVEL_MAX, TRAVEL_MIN + cycles * TRAVEL_STEP);
  spin = 100; // a fresh throw refills spin
  bestDepthThisRun = 0;
  sleeperTime = 0;
  vy = 0;
  y = 0;
}

function tangle(): void {
  state = 'gameover';
  cancelLoop();
  spin = 0;
  combo = 1;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  bestEl.textContent = String(best);
  comboEl.textContent = '×' + combo;
  reportGameOver(SCORE_DESC, score);
  draw();
  showOverlay(
    'Sicim dolandı',
    `Skor ${score} · ${cycles} tur · Yeniden için R veya Boşluk.`,
  );
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  // Background — soft vertical gradient that hints at "deeper = darker".
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#101620');
  bg.addColorStop(0.55, '#0c1018');
  bg.addColorStop(1, '#070910');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  drawDepthBands(w, h);
  drawHand(w);
  drawString(w);
  drawYoyo(w);
  drawSpinMeter(w);
  drawComboHint(w, h);
}

function drawDepthBands(w: number, h: number): void {
  // Two faint horizontal bands mark the "sleeper" and the current TRAVEL cap.
  const cx = w / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  const bandY = HAND_Y + maxTravel;
  ctx.beginPath();
  ctx.moveTo(cx - 60, bandY);
  ctx.lineTo(cx + 60, bandY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Sleeper zone marker — thin gold tick when the player is sleeping.
  if (held && y >= maxTravel - 0.5 && sleeperTime > SLEEPER_REQUIRED) {
    const t = Math.min(
      1,
      (Math.min(sleeperTime, SLEEPER_MAX_BANK) - SLEEPER_REQUIRED) /
        (SLEEPER_MAX_BANK - SLEEPER_REQUIRED),
    );
    ctx.fillStyle = `rgba(250, 204, 21, ${0.18 + 0.3 * t})`;
    ctx.fillRect(cx - 80, bandY - 2, 160, 4);
  }
}

function drawHand(w: number): void {
  const cx = w / 2;
  // Forearm
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(cx - 38, 0, 76, HAND_Y - 18);
  // Wrist band
  ctx.fillStyle = '#64748b';
  ctx.fillRect(cx - 38, HAND_Y - 22, 76, 6);
  // Palm
  ctx.fillStyle = '#e2c39a';
  ctx.beginPath();
  ctx.arc(cx, HAND_Y - 10, 22, 0, Math.PI * 2);
  ctx.fill();
  // Pinch fingers
  ctx.fillStyle = '#caa07a';
  ctx.beginPath();
  ctx.arc(cx, HAND_Y, 6, 0, Math.PI * 2);
  ctx.fill();
}

function drawString(w: number): void {
  const cx = w / 2;
  if (y <= 0.5) return;
  const taut = held || y > 1;
  ctx.strokeStyle = taut ? 'rgba(229, 231, 235, 0.85)' : 'rgba(229,231,235,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, HAND_Y);
  if (!held && y > 4) {
    // Slight slack curve when the yo-yo is being recalled — the string isn't
    // straight while it's gathering back into the hand.
    const midY = HAND_Y + y * 0.5;
    ctx.quadraticCurveTo(cx - 6, midY, cx, HAND_Y + y);
  } else {
    ctx.lineTo(cx, HAND_Y + y);
  }
  ctx.stroke();
}

function drawYoyo(w: number): void {
  const cx = w / 2;
  const yY = HAND_Y + y;
  const r = 22;
  const spinAngle = (performance.now() / 1000) * (spin > 0 ? 6 + spin * 0.06 : 0);

  // Halo when spin is healthy
  if (spin > 35) {
    const halo = ctx.createRadialGradient(cx, yY, r, cx, yY, r * 1.8);
    halo.addColorStop(0, 'rgba(94, 234, 212, 0.25)');
    halo.addColorStop(1, 'rgba(94, 234, 212, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, yY, r * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  // Spin ring — green → yellow → red as it drains.
  const ringColor = spinColor(spin);
  ctx.strokeStyle = ringColor;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, yY, r + 4, -Math.PI / 2, -Math.PI / 2 + (spin / 100) * Math.PI * 2);
  ctx.stroke();

  // Yo-yo body
  ctx.fillStyle = '#7c3aed';
  ctx.beginPath();
  ctx.arc(cx, yY, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#a78bfa';
  ctx.beginPath();
  ctx.arc(cx, yY, r * 0.62, 0, Math.PI * 2);
  ctx.fill();

  // Spin slits — three short lines rotating around the centre.
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const a = spinAngle + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 4, yY + Math.sin(a) * 4);
    ctx.lineTo(cx + Math.cos(a) * 13, yY + Math.sin(a) * 13);
    ctx.stroke();
  }

  // Axle dot
  ctx.fillStyle = '#fef3c7';
  ctx.beginPath();
  ctx.arc(cx, yY, 3, 0, Math.PI * 2);
  ctx.fill();
}

function spinColor(s: number): string {
  if (s > 60) return '#34d399';
  if (s > 30) return '#facc15';
  return '#f87171';
}

function drawSpinMeter(w: number): void {
  const mw = Math.min(220, w * 0.5);
  const mh = 6;
  const mx = (w - mw) / 2;
  const my = canvas.height - 22;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(mx, my, mw, mh);
  ctx.fillStyle = spinColor(spin);
  ctx.fillRect(mx, my, mw * (spin / 100), mh);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SPIN', w / 2, my - 4);
  ctx.textAlign = 'start';
}

function drawComboHint(w: number, h: number): void {
  if (state !== 'playing') return;
  if (cycles === 0) return;
  ctx.fillStyle = 'rgba(167, 139, 250, 0.85)';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Tur ${cycles}`, w / 2, h - 36);
  ctx.textAlign = 'start';
}

function startRun(): void {
  if (state === 'playing') return;
  state = 'playing';
  score = 0;
  cycles = 0;
  combo = 1;
  y = 0;
  vy = 0;
  spin = 100;
  bestDepthThisRun = 0;
  sleeperTime = 0;
  maxTravel = TRAVEL_MIN;
  updateHud();
  hideOverlay();
  startLoop();
}

function reset(): void {
  gen.bump();
  cancelLoop();
  state = 'ready';
  held = false;
  y = 0;
  vy = 0;
  spin = 100;
  cycles = 0;
  combo = 1;
  bestDepthThisRun = 0;
  sleeperTime = 0;
  maxTravel = TRAVEL_MIN;
  score = 0;
  updateHud();
  draw();
  showOverlay(
    'Yo-Yo',
    'Boşluk veya fareyi basılı tut → yo-yo iner. Bırak → geri çekilir. Spin tükenmeden eline döndür.',
  );
}

function holdOn(): void {
  if (state === 'gameover') reset();
  if (state === 'ready') startRun();
  // Whether the run started just now or was already in progress, the player
  // is currently pressing — translate that into a downward pull this frame.
  held = true;
}

function holdOff(): void {
  held = false;
}

function onKey(e: KeyboardEvent, down: boolean): void {
  const k = e.key;
  if (k === ' ' || k === 'Spacebar') {
    if (down) {
      if (!e.repeat) holdOn();
    } else {
      holdOff();
    }
    e.preventDefault();
    return;
  }
  if (down && (k === 'r' || k === 'R')) {
    reset();
    e.preventDefault();
  }
}

function setupPointer(): void {
  const onDown = (e: PointerEvent): void => {
    canvas.setPointerCapture?.(e.pointerId);
    holdOn();
    e.preventDefault();
  };
  const onUp = (e: PointerEvent): void => {
    if (canvas.hasPointerCapture?.(e.pointerId)) {
      canvas.releasePointerCapture?.(e.pointerId);
    }
    holdOff();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onUp);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  comboEl = document.querySelector<HTMLElement>('#combo')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  setupPointer();
  restartBtn.addEventListener('click', () => {
    reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
