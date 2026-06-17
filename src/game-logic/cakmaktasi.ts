import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'cakmaktasi.best';

type State = 'ready' | 'playing' | 'won' | 'failed';

// Geometry — single source of truth for both draw() and collide(),
// per PITFALLS#visual-vs-hitbox.
const CANVAS_W = 560;
const CANVAS_H = 520;

// Flint slab — large, ridged rock in the upper middle of the canvas.
const FLINT_X = 110;
const FLINT_Y = 80;
const FLINT_W = 340;
const FLINT_H = 230;

// Tinder pile — sits below the flint.
const TINDER_X = 130;
const TINDER_Y = 380;
const TINDER_W = 300;
const TINDER_H = 90;

// Speed gauge — vertical bar on the right edge.
const GAUGE_X = 502;
const GAUGE_Y = 80;
const GAUGE_W = 38;
const GAUGE_H = 390;

// Drag-speed window (pixels/sec measured on the downward component).
const SPEED_MIN = 220;
const SPEED_MAX = 1800;
const SPEED_OPT_LOW = 450;
const SPEED_OPT_HIGH = 1100;

const ROUND_SECONDS = 30;
const HEAT_MAX = 100;
const HEAT_DECAY_PER_SEC = 2.5; // tinder loses heat slowly if you stop striking

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let heatEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;

// Pointer / steel state
let pointerX = CANVAS_W / 2;
let pointerY = FLINT_Y - 20;
let prevPointerX = pointerX;
let prevPointerY = pointerY;
let pointerDown = false;
let pointerOverFlint = false;
let lastMoveTime = 0;
let dragSpeedY = 0; // downward px/s for gauge & spark generation

let heat = 0;
let timeLeft = ROUND_SECONDS;
let lastFrame = 0;
let rafId = 0;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // 0..1, fades
  size: number;
}
const sparks: Spark[] = [];
const SPARK_GRAVITY = 800; // px/s²
const MAX_SPARKS = 220;

interface Ember {
  x: number;
  y: number;
  life: number;
  size: number;
}
const embers: Ember[] = [];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function pointInRect(
  px: number,
  py: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): boolean {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

function setHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  timeEl.textContent = timeLeft.toFixed(1);
  heatEl.textContent = `${Math.floor(heat)}%`;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function spawnSparks(strength: number, vxBias: number): void {
  // strength ∈ [0, 1] — proportional to how well-centered the drag speed was.
  const count = 1 + Math.floor(strength * 3);
  for (let i = 0; i < count; i++) {
    if (sparks.length >= MAX_SPARKS) break;
    const ang = (Math.random() * 1.2 - 0.6) + Math.PI / 2; // mostly downward
    const speed = 120 + Math.random() * 260 * strength;
    sparks.push({
      x: pointerX + (Math.random() - 0.5) * 14,
      y: pointerY + 8 + Math.random() * 4,
      vx: Math.cos(ang) * speed + vxBias * 0.45,
      vy: Math.sin(ang) * speed,
      life: 1,
      size: 1.4 + Math.random() * 1.6,
    });
  }
}

function strikeWindowStrength(speedY: number): number {
  // Returns 0..1 strength based on how well the drag fits the green window.
  if (speedY < SPEED_MIN || speedY > SPEED_MAX) return 0;
  if (speedY >= SPEED_OPT_LOW && speedY <= SPEED_OPT_HIGH) return 1;
  if (speedY < SPEED_OPT_LOW) {
    return (speedY - SPEED_MIN) / (SPEED_OPT_LOW - SPEED_MIN);
  }
  return 1 - (speedY - SPEED_OPT_HIGH) / (SPEED_MAX - SPEED_OPT_HIGH);
}

function endRound(won: boolean): void {
  if (state !== 'playing') return;
  state = won ? 'won' : 'failed';
  if (won) {
    score = Math.max(0, Math.floor(timeLeft * 10));
  } else {
    score = Math.floor(heat);
  }
  commitBest();
  setHud();
  overlayTitleEl.textContent = won ? 'Yandı!' : 'Kav yanmadı';
  overlayMsgEl.textContent = won
    ? `${(ROUND_SECONDS - timeLeft).toFixed(1)} sn'de tutuşturdun.\nSkor: ${score}  ·  Rekor: ${best}\n\nTekrar denemek için R'ye bas veya çakmaktaşına tıkla.`
    : `Kav %${Math.floor(heat)} ısındı ama tutuşmadı.\nSkor: ${score}  ·  Rekor: ${best}\n\nTekrar denemek için R'ye bas veya çakmaktaşına tıkla.`;
  showOverlay(overlayEl);
}

function tick(now: number): void {
  if (!gen.isCurrent(myGen)) return;
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // Speed decays toward 0 if the pointer isn't moving fresh frames.
  if (now - lastMoveTime > 80) dragSpeedY *= 0.85;

  if (state === 'playing') {
    timeLeft = Math.max(0, timeLeft - dt);
    heat = Math.max(0, heat - HEAT_DECAY_PER_SEC * dt);

    // Continuous striking while dragging: emit sparks proportional to
    // current drag speed window strength, capped to keep the loop steady.
    if (pointerDown && pointerOverFlint) {
      const s = strikeWindowStrength(dragSpeedY);
      if (s > 0 && Math.random() < 0.18 + 0.22 * s) {
        spawnSparks(s, pointerX - prevPointerX);
      }
    }
  }

  // Physics on sparks (runs in all states so the canvas always feels alive)
  for (let i = sparks.length - 1; i >= 0; i--) {
    const sp = sparks[i]!;
    sp.vy += SPARK_GRAVITY * dt;
    sp.x += sp.vx * dt;
    sp.y += sp.vy * dt;
    sp.life -= dt * 1.6;

    if (state === 'playing') {
      if (
        pointInRect(sp.x, sp.y, TINDER_X, TINDER_Y, TINDER_W, TINDER_H)
      ) {
        // Spark consumed by tinder — bump heat, leave a glowing ember.
        heat = Math.min(HEAT_MAX, heat + 1.8);
        embers.push({
          x: sp.x,
          y: clamp(sp.y, TINDER_Y, TINDER_Y + TINDER_H - 2),
          life: 1,
          size: 2 + Math.random() * 2,
        });
        sparks.splice(i, 1);
        continue;
      }
    }

    if (sp.life <= 0 || sp.y > CANVAS_H + 20 || sp.x < -20 || sp.x > CANVAS_W + 20) {
      sparks.splice(i, 1);
    }
  }

  for (let i = embers.length - 1; i >= 0; i--) {
    const em = embers[i]!;
    em.life -= dt * 0.6;
    if (em.life <= 0) embers.splice(i, 1);
  }

  // Win / lose checks
  if (state === 'playing') {
    if (heat >= HEAT_MAX) endRound(true);
    else if (timeLeft <= 0) endRound(false);
  }

  setHud();
  draw();
  rafId = requestAnimationFrame(tick);
}

// Drawing -----------------------------------------------------------------

function draw(): void {
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawFlint();
  drawTinderBase();
  drawEmbers();
  drawFire();
  drawSparks();
  drawSteel();
  drawGauge();
}

function drawFlint(): void {
  const x = FLINT_X;
  const y = FLINT_Y;
  const w = FLINT_W;
  const h = FLINT_H;

  // Drop shadow on canvas
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x + 6, y + 8, w, h);

  // Body
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, '#6e6f78');
  grad.addColorStop(0.55, '#4d4e56');
  grad.addColorStop(1, '#33343b');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // Top-edge highlight (the striking face)
  ctx.fillStyle = '#8a8b95';
  ctx.fillRect(x, y, w, 6);

  // Chiseled diagonal ridges across the face
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = 'rgba(20,20,26,0.55)';
  ctx.lineWidth = 1;
  for (let i = -h; i < w; i += 12) {
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + h, y + h);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(180,182,190,0.18)';
  for (let i = -h + 4; i < w; i += 12) {
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + h, y + h);
    ctx.stroke();
  }
  ctx.restore();

  // Border
  ctx.strokeStyle = '#1a1b20';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // Subtle label
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('çakmaktaşı', x + w - 8, y + h - 8);
}

function drawTinderBase(): void {
  const x = TINDER_X;
  const y = TINDER_Y;
  const w = TINDER_W;
  const h = TINDER_H;

  // Pile silhouette (lump)
  ctx.fillStyle = '#3a2618';
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + 14, y + 10);
  ctx.lineTo(x + 40, y);
  ctx.lineTo(x + w - 36, y);
  ctx.lineTo(x + w - 12, y + 14);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();

  // Straw strands
  ctx.strokeStyle = '#6e4a2d';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 22; i++) {
    const sx = x + 14 + ((i * 37) % (w - 28));
    const sy = y + 10 + ((i * 13) % (h - 28));
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 10 + (i % 5) * 2, sy - 6 - (i % 4));
    ctx.stroke();
  }

  // Heat tint — tinder glows red as it warms up
  const t = clamp(heat / HEAT_MAX, 0, 1);
  if (t > 0) {
    ctx.fillStyle = `rgba(255, ${Math.floor(80 + (1 - t) * 60)}, 30, ${0.25 + t * 0.5})`;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + 14, y + 10);
    ctx.lineTo(x + 40, y);
    ctx.lineTo(x + w - 36, y);
    ctx.lineTo(x + w - 12, y + 14);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  // Border
  ctx.strokeStyle = '#1a0e07';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + 14, y + 10);
  ctx.lineTo(x + 40, y);
  ctx.lineTo(x + w - 36, y);
  ctx.lineTo(x + w - 12, y + 14);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.stroke();
}

function drawEmbers(): void {
  for (const em of embers) {
    const a = clamp(em.life, 0, 1);
    ctx.fillStyle = `rgba(255, 140, 40, ${0.7 * a})`;
    ctx.beginPath();
    ctx.arc(em.x, em.y, em.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFire(): void {
  if (state !== 'won') return;
  const cx = TINDER_X + TINDER_W / 2;
  const baseY = TINDER_Y + 6;
  const t = (performance.now() / 120) % 1000;
  for (let i = 0; i < 18; i++) {
    const ph = (i * 0.37 + t * 0.01) % 1;
    const h = 70 + Math.sin(t * 0.03 + i) * 18;
    const w = 28 - i * 1.0;
    const xo = Math.sin(t * 0.02 + i * 1.1) * 12;
    const col = ph < 0.4 ? '#fff2a8' : ph < 0.75 ? '#ff9a2b' : '#c43a14';
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.ellipse(cx + xo, baseY - h * (1 - ph * 0.5), w, h * 0.5 + 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawSparks(): void {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const sp of sparks) {
    const a = clamp(sp.life, 0, 1);
    ctx.fillStyle = `rgba(255, ${180 + Math.floor(75 * a)}, 60, ${a})`;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, sp.size, 0, Math.PI * 2);
    ctx.fill();
    // streak
    ctx.strokeStyle = `rgba(255,220,120,${a * 0.5})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(sp.x - sp.vx * 0.02, sp.y - sp.vy * 0.02);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSteel(): void {
  const x = pointerX;
  const y = pointerY;
  // Steel striker — a short blade with a wooden grip
  ctx.save();
  ctx.translate(x, y);
  // grip
  ctx.fillStyle = '#6b3f1f';
  ctx.fillRect(-9, -34, 18, 18);
  ctx.strokeStyle = '#3a2310';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-9, -34, 18, 18);
  // blade
  const grad = ctx.createLinearGradient(-9, -16, 9, 14);
  grad.addColorStop(0, '#dfe2e7');
  grad.addColorStop(0.5, '#9aa0aa');
  grad.addColorStop(1, '#5d626c');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-9, -16);
  ctx.lineTo(9, -16);
  ctx.lineTo(7, 12);
  ctx.lineTo(-7, 12);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#1e2025';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // edge highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.moveTo(-6, -14);
  ctx.lineTo(6, -14);
  ctx.stroke();
  ctx.restore();

  // Down-arrow hint when over flint and not pressing
  if (pointerOverFlint && !pointerDown && state === 'playing') {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('basılı tut → aşağı sürükle', x, y + 30);
  }
}

function drawGauge(): void {
  const x = GAUGE_X;
  const y = GAUGE_Y;
  const w = GAUGE_W;
  const h = GAUGE_H;

  // Frame
  ctx.fillStyle = '#13141a';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#2a2c34';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // Bands (low/optimal/high windows)
  const lowY = y + h - (SPEED_OPT_LOW / SPEED_MAX) * h;
  const highY = y + h - (SPEED_OPT_HIGH / SPEED_MAX) * h;
  const minY = y + h - (SPEED_MIN / SPEED_MAX) * h;
  ctx.fillStyle = 'rgba(120,120,120,0.15)';
  ctx.fillRect(x + 4, y + 4, w - 8, minY - (y + 4)); // too slow zone
  ctx.fillStyle = 'rgba(60,160,80,0.35)';
  ctx.fillRect(x + 4, highY, w - 8, lowY - highY); // optimal green
  ctx.fillStyle = 'rgba(200,120,40,0.25)';
  ctx.fillRect(x + 4, lowY, w - 8, (minY) - lowY); // low warm
  ctx.fillStyle = 'rgba(200,60,60,0.25)';
  ctx.fillRect(x + 4, y + 4, w - 8, highY - (y + 4)); // too fast zone

  // Current speed bar
  const sn = clamp(dragSpeedY, 0, SPEED_MAX);
  const barH = (sn / SPEED_MAX) * (h - 8);
  ctx.fillStyle = '#ffd76b';
  ctx.fillRect(x + 6, y + h - 4 - barH, w - 12, barH);

  // Heat meter on the LEFT of the gauge (slim bar)
  const hx = GAUGE_X - 18;
  const hh = h;
  ctx.fillStyle = '#13141a';
  ctx.fillRect(hx, y, 10, hh);
  ctx.strokeStyle = '#2a2c34';
  ctx.strokeRect(hx + 0.5, y + 0.5, 9, hh - 1);
  const hPct = heat / HEAT_MAX;
  const hBar = hPct * (hh - 4);
  const hColor = hPct < 0.5 ? '#aa6b2b' : hPct < 0.9 ? '#ff7a2b' : '#ffd76b';
  ctx.fillStyle = hColor;
  ctx.fillRect(hx + 2, y + hh - 2 - hBar, 6, hBar);

  // Labels
  ctx.fillStyle = '#aab';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('hız', x + w / 2, y - 6);
  ctx.fillText('kav', hx + 5, y - 6);
}

// Input -------------------------------------------------------------------

function canvasPos(ev: PointerEvent | MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const cx = ((ev.clientX - r.left) / r.width) * CANVAS_W;
  const cy = ((ev.clientY - r.top) / r.height) * CANVAS_H;
  return { x: clamp(cx, 0, CANVAS_W), y: clamp(cy, 0, CANVAS_H) };
}

function startPlay(): void {
  if (state === 'playing') return;
  state = 'playing';
  score = 0;
  heat = 0;
  timeLeft = ROUND_SECONDS;
  sparks.length = 0;
  embers.length = 0;
  dragSpeedY = 0;
  hideOverlay(overlayEl);
  setHud();
}

function onPointerDown(ev: PointerEvent): void {
  ev.preventDefault();
  const { x, y } = canvasPos(ev);
  pointerX = x;
  pointerY = y;
  prevPointerX = x;
  prevPointerY = y;
  lastMoveTime = performance.now();
  canvas.setPointerCapture?.(ev.pointerId);

  if (state === 'ready' || state === 'won' || state === 'failed') {
    startPlay();
    return;
  }
  if (state === 'playing') {
    pointerDown = true;
    pointerOverFlint = pointInRect(x, y, FLINT_X, FLINT_Y, FLINT_W, FLINT_H);
  }
}

function onPointerMove(ev: PointerEvent): void {
  const { x, y } = canvasPos(ev);
  const now = performance.now();
  const dt = Math.max(0.001, (now - lastMoveTime) / 1000);
  // Smooth speed estimate (downward component only).
  const instVy = (y - pointerY) / dt;
  // Low-pass blend so a brief halt doesn't immediately drop to 0.
  dragSpeedY = dragSpeedY * 0.55 + Math.max(0, instVy) * 0.45;
  prevPointerX = pointerX;
  prevPointerY = pointerY;
  pointerX = x;
  pointerY = y;
  lastMoveTime = now;

  if (pointerDown) {
    pointerOverFlint = pointInRect(x, y, FLINT_X, FLINT_Y, FLINT_W, FLINT_H);
  }
}

function onPointerUp(ev: PointerEvent): void {
  pointerDown = false;
  pointerOverFlint = false;
  dragSpeedY = 0;
  canvas.releasePointerCapture?.(ev.pointerId);
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'r' || ev.key === 'R') {
    ev.preventDefault();
    reset();
  } else if ((ev.key === ' ' || ev.key === 'Enter') && state !== 'playing') {
    ev.preventDefault();
    startPlay();
  }
}

// Module wiring -----------------------------------------------------------

let myGen = 0;

function reset(): void {
  gen.bump();
  myGen = gen.current();
  state = 'ready';
  score = 0;
  heat = 0;
  timeLeft = ROUND_SECONDS;
  sparks.length = 0;
  embers.length = 0;
  dragSpeedY = 0;
  pointerDown = false;
  pointerOverFlint = false;
  overlayTitleEl.textContent = 'Çakmaktaşı';
  overlayMsgEl.textContent =
    "Çelik bıçak fareyi takip eder. Çakmaktaşının çizgili yüzeyinin üzerinde fareyi basılı tut ve aşağı sürükle — sürükleme hızını sağdaki göstergede yeşil aralıkta tut. Çıkan kıvılcımlar kavın üzerine düşerse kav ısınır; %100'e ulaşınca tutuşur.\n\nBaşlamak için çakmaktaşına tıkla.";
  showOverlay(overlayEl);
  setHud();
  cancelAnimationFrame(rafId);
  lastFrame = performance.now();
  rafId = requestAnimationFrame(tick);
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  heatEl = document.querySelector<HTMLElement>('#heat')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  overlayEl.addEventListener('pointerdown', (ev) => {
    if (state === 'ready' || state === 'won' || state === 'failed') {
      ev.preventDefault();
      startPlay();
    }
  });
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
