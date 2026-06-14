import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() cancels in-flight RAF chains;
//   each scheduled tick re-checks the current token before running.
// - overlay-input-leak: explicit state enum; canvas pointerdown and key handlers
//   guard on state at the top.
// - visual-vs-hitbox: WINDMILL_HIT_R is the click hitbox; the drawn blade
//   tip radius is BLADE_TIP_R. They are intentionally close so the hitbox is
//   slightly more generous than the visual.
// - module-level-dom-access: all DOM access lives in init().

const STORAGE_BEST = 'yel-degirmeni.best';
const ROUND_MS = 60_000;

type State = 'ready' | 'playing' | 'gameover';

interface Windmill {
  x: number;
  y: number;
  targetAngle: number; // logical heading, snapped to 45° steps
  displayAngle: number; // visual heading, smooth tween toward target
  spinAngle: number; // accumulated blade rotation around hub
}

const WIND_SHIFT_MIN_MS = 4500;
const WIND_SHIFT_MAX_MS = 6500;
const WIND_TWEEN_MS = 1200;
// Heading tween speed in rad/ms — 45° in ~250ms feels snappy but visible.
const HEADING_TWEEN_SPEED = 0.018;
const SCORE_RATE = 0.012; // score per (efficiency-unit × ms)

const BLADE_TIP_R = 42;
const HUB_R = 9;
const WINDMILL_HIT_R = 52;

const WINDMILL_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [120, 200],
  [360, 200],
  [240, 340],
  [120, 480],
  [360, 480],
];

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_MS;
let lastTs = 0;
let windmills: Windmill[] = [];
let windDir = 0;
let windStartDir = 0;
let windTargetDir = 0;
let windTransitionElapsedMs = 0;
let windTransitionDurationMs = 0;
let windNextShiftMs = 0;
let windFlowOffset = 0;
let rafHandle = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let powerFill!: HTMLElement;

const cssCache = new Map<string, string>();
function css(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v || '#fff');
  return cssCache.get(name)!;
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function pickNewWindTarget(current: number): number {
  // Pick from 8 cardinal directions, biased away from current direction so the
  // round always feels dynamic instead of nudging back to the same bearing.
  for (let i = 0; i < 12; i++) {
    const k = Math.floor(Math.random() * 8);
    const candidate = (k * Math.PI) / 4;
    if (Math.abs(angleDiff(candidate, current)) > Math.PI / 3) {
      return candidate;
    }
  }
  return current + Math.PI / 2;
}

function startWindShift(): void {
  windStartDir = windDir;
  windTargetDir = pickNewWindTarget(windDir);
  windTransitionElapsedMs = 0;
  windTransitionDurationMs = WIND_TWEEN_MS;
  windNextShiftMs = WIND_SHIFT_MIN_MS + Math.random() * (WIND_SHIFT_MAX_MS - WIND_SHIFT_MIN_MS);
}

function reset(): void {
  cancelAnimationFrame(rafHandle);
  gen.bump();
  state = 'ready';
  score = 0;
  timeLeftMs = ROUND_MS;
  lastTs = 0;
  windmills = WINDMILL_POSITIONS.map(([x, y], i) => {
    const a = (i * Math.PI) / 4;
    return { x, y, targetAngle: a, displayAngle: a, spinAngle: 0 };
  });
  windDir = 0;
  windStartDir = 0;
  windTargetDir = 0;
  windTransitionElapsedMs = 0;
  windTransitionDurationMs = 0;
  // First shift comes quickly so the player sees the wind move and learns
  // they must re-align — invisible-boot guard for feedback < 250ms.
  windNextShiftMs = 1500;
  windFlowOffset = 0;
  scoreEl.textContent = '0';
  timeEl.textContent = '60';
  bestEl.textContent = String(best);
  powerFill.style.width = '0%';
  draw();
  showOverlay(
    'Yel Değirmeni',
    'Değirmenlere tıkla, kanatlarını rüzgâra çevir. Doğru hizalama tam güç üretir.<br/>Boşluk ile başla.',
  );
}

function scheduleNext(): void {
  const token = gen.current();
  rafHandle = requestAnimationFrame((next) => {
    if (token !== gen.current()) return;
    loop(next);
  });
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  lastTs = performance.now();
  hideOverlay();
  scheduleNext();
}

function endRound(): void {
  state = 'gameover';
  const finalScore = Math.floor(score);
  if (finalScore > best) {
    best = finalScore;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  showOverlay(
    'Süre doldu',
    `Skor: ${finalScore}<br/>R veya tıkla → yeniden başla.`,
  );
}

function loop(ts: number): void {
  if (state !== 'playing') return;
  const dtRaw = ts - lastTs;
  lastTs = ts;
  // Cap dt: if tab was backgrounded, don't simulate a multi-second jump.
  const dt = Math.min(dtRaw, 50);

  step(dt);
  draw();

  timeLeftMs -= dtRaw;
  if (timeLeftMs <= 0) {
    timeLeftMs = 0;
    timeEl.textContent = '0';
    endRound();
    return;
  }
  timeEl.textContent = String(Math.ceil(timeLeftMs / 1000));

  scheduleNext();
}

function step(dt: number): void {
  // Wind direction: smooth interpolation between successive snapped targets.
  if (windTransitionDurationMs > 0) {
    windTransitionElapsedMs += dt;
    const t = Math.min(1, windTransitionElapsedMs / windTransitionDurationMs);
    const eased = t * t * (3 - 2 * t);
    windDir = windStartDir + angleDiff(windTargetDir, windStartDir) * eased;
    if (t >= 1) {
      windDir = windTargetDir;
      windTransitionDurationMs = 0;
    }
  } else {
    windNextShiftMs -= dt;
    if (windNextShiftMs <= 0) startWindShift();
  }

  windFlowOffset += dt * 0.08;
  if (windFlowOffset > 1000) windFlowOffset -= 1000;

  let totalEfficiency = 0;
  for (const w of windmills) {
    const adiff = angleDiff(w.targetAngle, w.displayAngle);
    if (Math.abs(adiff) > 0.0005) {
      const stepDelta = Math.sign(adiff) * Math.min(Math.abs(adiff), HEADING_TWEEN_SPEED * dt);
      w.displayAngle += stepDelta;
    } else {
      w.displayAngle = w.targetAngle;
    }
    const eff = Math.max(0, Math.cos(angleDiff(w.displayAngle, windDir)));
    totalEfficiency += eff;
    // Blade spin proportional to efficiency — clear visual feedback for power.
    w.spinAngle += eff * dt * 0.014;
  }

  score += totalEfficiency * dt * SCORE_RATE;
  scoreEl.textContent = String(Math.floor(score));

  const pct = Math.min(1, totalEfficiency / windmills.length);
  powerFill.style.width = (pct * 100).toFixed(1) + '%';
  powerFill.style.background =
    pct > 0.7 ? css('--yel-good') : pct > 0.35 ? css('--yel-mid') : css('--yel-bad');
}

function efficiencyColor(eff: number): string {
  if (eff > 0.7) return css('--yel-good');
  if (eff > 0.35) return css('--yel-mid');
  return css('--yel-bad');
}

function drawStreamlines(): void {
  // Hatched parallel streamlines flowing in the wind direction. The wind
  // blows TOWARD windDir + π (wind comes from windDir). We draw streamlines
  // moving in the direction of flow so the wind feels alive.
  const flowDir = windDir + Math.PI;
  const cos = Math.cos(flowDir);
  const sin = Math.sin(flowDir);
  const W = canvas.width;
  const H = canvas.height;
  // Build a band of parallel lines perpendicular to flow.
  const spacing = 38;
  const segLen = 26;
  const gap = 50;
  const stride = segLen + gap;
  const perpX = -sin;
  const perpY = cos;
  // Cover the diagonal so the band fills the canvas regardless of angle.
  const diag = Math.hypot(W, H);
  const half = diag * 0.7;
  const cx = W / 2;
  const cy = H / 2;
  ctx.lineCap = 'round';
  for (let s = -half; s <= half; s += spacing) {
    const baseX = cx + perpX * s;
    const baseY = cy + perpY * s;
    // Phase along the line so segments scroll with windFlowOffset
    const phase = (windFlowOffset + s * 0.5) % stride;
    for (let t = -half - phase; t <= half; t += stride) {
      const x0 = baseX + cos * t;
      const y0 = baseY + sin * t;
      const x1 = baseX + cos * (t + segLen);
      const y1 = baseY + sin * (t + segLen);
      // Fade segments near the edge for softness
      const cxOff = (x0 + x1) / 2 - cx;
      const cyOff = (y0 + y1) / 2 - cy;
      const dist = Math.hypot(cxOff, cyOff) / (diag / 2);
      const alpha = Math.max(0, Math.min(1, 1 - dist * 0.6));
      ctx.strokeStyle = css('--yel-wind');
      ctx.globalAlpha = alpha * 0.85;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawWindmill(w: Windmill, index: number): void {
  const eff = Math.max(0, Math.cos(angleDiff(w.displayAngle, windDir)));
  const ringColor = efficiencyColor(eff);

  // Outer ring — efficiency indicator
  ctx.save();
  ctx.translate(w.x, w.y);
  ctx.strokeStyle = ringColor;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(0, 0, BLADE_TIP_R + 8, 0, Math.PI * 2);
  ctx.stroke();
  // Faint inner shadow / base disk
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = css('--yel-shadow');
  ctx.beginPath();
  ctx.arc(0, 0, BLADE_TIP_R + 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Heading indicator: a small triangle at the rim pointing the way the
  // windmill faces — gives the player a deterministic visual of bladeDir
  // even when the blades are spinning.
  const hx = Math.cos(w.displayAngle) * (BLADE_TIP_R + 4);
  const hy = Math.sin(w.displayAngle) * (BLADE_TIP_R + 4);
  ctx.fillStyle = ringColor;
  ctx.beginPath();
  ctx.arc(hx, hy, 5, 0, Math.PI * 2);
  ctx.fill();

  // Blades — 4 thin paddles. Rotate around the windmill heading axis: the
  // blade plane is perpendicular to bladeDir, and the blades spin around
  // bladeDir.
  ctx.rotate(w.displayAngle + Math.PI / 2);
  ctx.rotate(w.spinAngle);
  ctx.fillStyle = css('--yel-tower');
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 2);
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(BLADE_TIP_R - 2, -2);
    ctx.lineTo(BLADE_TIP_R - 2, 2);
    ctx.lineTo(0, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // Hub
  ctx.fillStyle = css('--yel-tower');
  ctx.beginPath();
  ctx.arc(w.x, w.y, HUB_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = css('--yel-shadow');
  ctx.lineWidth = 2;
  ctx.stroke();

  // Number label (1..5) for keyboard shortcut hint
  ctx.fillStyle = css('--text');
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index + 1), w.x, w.y);
}

function drawCompass(): void {
  // Small wind compass top-right
  const cx = canvas.width - 48;
  const cy = 48;
  const r = 26;
  ctx.fillStyle = css('--surface');
  ctx.strokeStyle = css('--border');
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Wind arrow points in the flow direction (from windDir toward opposite).
  const flowDir = windDir + Math.PI;
  ctx.strokeStyle = css('--yel-compass');
  ctx.fillStyle = css('--yel-compass');
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const tailX = cx - Math.cos(flowDir) * (r - 8);
  const tailY = cy - Math.sin(flowDir) * (r - 8);
  const tipX = cx + Math.cos(flowDir) * (r - 8);
  const tipY = cy + Math.sin(flowDir) * (r - 8);
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  // Arrowhead
  const ah = 6;
  const left = flowDir + Math.PI - 0.5;
  const right = flowDir + Math.PI + 0.5;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX + Math.cos(left) * ah, tipY + Math.sin(left) * ah);
  ctx.lineTo(tipX + Math.cos(right) * ah, tipY + Math.sin(right) * ah);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = css('--text-dim');
  ctx.font = '600 9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RÜZGÂR', cx, cy + r + 10);
}

function draw(): void {
  ctx.fillStyle = css('--surface');
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawStreamlines();

  for (let i = 0; i < windmills.length; i++) {
    drawWindmill(windmills[i]!, i);
  }

  drawCompass();
}

function rotateWindmill(idx: number): void {
  if (state !== 'playing') return;
  const w = windmills[idx];
  if (!w) return;
  w.targetAngle += Math.PI / 4;
  // Keep target within (-π, π] to avoid floating accumulation issues over a
  // long round (it doesn't change behavior but keeps numbers stable).
  if (w.targetAngle > Math.PI) w.targetAngle -= 2 * Math.PI;
}

function getCanvasCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function findWindmillAt(x: number, y: number): number {
  for (let i = 0; i < windmills.length; i++) {
    const w = windmills[i]!;
    const dx = x - w.x;
    const dy = y - w.y;
    if (dx * dx + dy * dy <= WINDMILL_HIT_R * WINDMILL_HIT_R) return i;
  }
  return -1;
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  powerFill = document.querySelector<HTMLElement>('#power-fill')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    const { x, y } = getCanvasCoords(e);
    const idx = findWindmillAt(x, y);
    if (idx >= 0) {
      rotateWindmill(idx);
      e.preventDefault();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') {
      if (state === 'ready') startPlaying();
      else if (state === 'gameover') reset();
      e.preventDefault();
      return;
    }
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'playing') {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 1 && n <= windmills.length) {
        rotateWindmill(n - 1);
        e.preventDefault();
      }
    }
  });

  overlayEl.addEventListener('click', () => {
    if (state === 'ready') startPlaying();
    else if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
