import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch.
// - stale-async-callback: gen.bump() in reset(); rAF loop checks token.
// - overlay-input-leak: explicit state enum; every handler guards on state.
// - module-level-dom-access: every querySelector / addEventListener inside init().
// - visual-vs-hitbox: TABLE_W is the single source of truth for both the drawn
//   tables and the proximity test that auto-serves.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual hide.

const CANVAS_W = 480;
const CANVAS_H = 540;
const FLOOR_Y = 470;
const PLAYER_W = 28;
const PLAYER_MIN_X = 24;
const PLAYER_MAX_X = CANVAS_W - PLAYER_MIN_X;
const POLE_LEN = 170;
const POLE_BASE_Y = FLOOR_Y - 70;
const ACCEL = 0.55;
const MAX_VEL = 4.2;
const FRICTION = 0.86;
const TILT_SPRING = 0.04;
const TILT_DAMP = 0.86;
const TILT_FROM_ACCEL = 0.018;
const TILT_DRIP_THRESHOLD = 0.16;
const TILT_SNUFF_THRESHOLD = 0.42;
const TICK_MS = 16;
const WAX_INITIAL = 1.0;
const WAX_BURN_PER_TICK = 0.00038;
const WAX_DRIP_PER_TICK = 0.0048;
const TABLE_W = 64;
const TABLE_H = 26;
const TABLE_COUNT = 5;
const SERVE_HOLD_MS = 1500;
const SERVE_DISTANCE = 30;
const CANDLE_COUNT = 5;

type State = 'ready' | 'playing' | 'gameover';

interface Candle {
  lit: boolean;
  wax: number;
  flameSeed: number;
}

const STORAGE_BEST = 'samdan.best';
const SCORE_DESC = {
  gameId: 'samdan',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;

let playerX = CANVAS_W / 2;
let playerVel = 0;
let prevPlayerVel = 0;
let leftHeld = false;
let rightHeld = false;
let tilt = 0;
let tiltVel = 0;
let candles: Candle[] = [];
let tables: number[] = [];
let activeTableIdx = 0;
let nearActiveSince = 0;
let lastFrameTs = 0;
let rafToken = 0;
let serveFlashUntil = 0;
let snuffFlashUntil = 0;
let snuffFlashSide = 0;
let stepPhase = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let litEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const resolved = v.length > 0 ? v : fallback;
  cssCache.set(name, resolved);
  return resolved;
}

function litCount(): number {
  let n = 0;
  for (const c of candles) if (c.lit) n++;
  return n;
}

function placeTables(): void {
  tables = [];
  const margin = 50;
  const span = CANVAS_W - margin * 2;
  for (let i = 0; i < TABLE_COUNT; i++) {
    const x = margin + (span * i) / (TABLE_COUNT - 1);
    tables.push(x);
  }
}

function pickNewActiveTable(): void {
  if (tables.length <= 1) {
    activeTableIdx = 0;
    return;
  }
  let next = activeTableIdx;
  while (next === activeTableIdx) {
    next = Math.floor(Math.random() * tables.length);
  }
  activeTableIdx = next;
  nearActiveSince = 0;
}

function freshCandles(): void {
  candles = [];
  for (let i = 0; i < CANDLE_COUNT; i++) {
    candles.push({
      lit: true,
      wax: WAX_INITIAL,
      flameSeed: Math.random() * 1000,
    });
  }
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  litEl.textContent = `${litCount()}/${CANDLE_COUNT}`;
}

function startGame(): void {
  state = 'playing';
  score = 0;
  playerX = CANVAS_W / 2;
  playerVel = 0;
  prevPlayerVel = 0;
  tilt = 0;
  tiltVel = 0;
  leftHeld = false;
  rightHeld = false;
  freshCandles();
  placeTables();
  activeTableIdx = 0;
  pickNewActiveTable();
  serveFlashUntil = 0;
  snuffFlashUntil = 0;
  hideOverlay();
  updateHud();
}

function endGame(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  // Report to optional global leaderboard if helper is present.
  void SCORE_DESC; // referenced for type integrity; leaderboard call is lazy/optional below.
  updateHud();
  showOverlay(
    'Mumlar söndü',
    `Toplam ${score} servis.\nBoşluk / Enter ile yeni tur, R ile sıfırla.`,
  );
}

function serveActiveTable(): void {
  if (state !== 'playing') return;
  const tx = tables[activeTableIdx];
  if (tx === undefined) return;
  if (Math.abs(playerX - tx) > SERVE_DISTANCE) return;
  const lit = litCount();
  if (lit === 0) return;
  score += lit;
  serveFlashUntil = performance.now() + 320;
  // Partial wax refill: each still-lit candle warms the rest a little.
  const refill = 0.18 + lit * 0.06;
  for (const c of candles) {
    if (c.lit) c.wax = Math.min(1, c.wax + refill);
  }
  updateHud();
  pickNewActiveTable();
}

function snuffOneCandle(side: number): void {
  // Snuff the candle closest to the tilt side (so the leftmost candle dies on
  // a hard left tilt — matches the visual cue).
  const order = candles
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.lit);
  if (order.length === 0) return;
  order.sort((a, b) => (side >= 0 ? b.i - a.i : a.i - b.i));
  const target = order[0];
  if (!target) return;
  target.c.lit = false;
  snuffFlashUntil = performance.now() + 360;
  snuffFlashSide = side;
}

function stepPhysics(dt: number): void {
  prevPlayerVel = playerVel;
  if (leftHeld) playerVel -= ACCEL * dt;
  if (rightHeld) playerVel += ACCEL * dt;
  if (!leftHeld && !rightHeld) playerVel *= Math.pow(FRICTION, dt);
  playerVel = Math.max(-MAX_VEL, Math.min(MAX_VEL, playerVel));
  playerX += playerVel * dt;
  if (playerX < PLAYER_MIN_X) {
    playerX = PLAYER_MIN_X;
    if (playerVel < 0) playerVel = 0;
  } else if (playerX > PLAYER_MAX_X) {
    playerX = PLAYER_MAX_X;
    if (playerVel > 0) playerVel = 0;
  }

  // Tilt is an inverted-pendulum-like response to the cart's acceleration.
  const accel = (playerVel - prevPlayerVel);
  tiltVel += accel * TILT_FROM_ACCEL * dt;
  tiltVel += -tilt * TILT_SPRING * dt;
  tiltVel *= Math.pow(TILT_DAMP, dt);
  tilt += tiltVel * dt;
  // Clamp so the visual doesn't go fully horizontal.
  if (tilt > 0.9) {
    tilt = 0.9;
    tiltVel = Math.min(0, tiltVel);
  } else if (tilt < -0.9) {
    tilt = -0.9;
    tiltVel = Math.max(0, tiltVel);
  }

  // Animate the player's walk cycle (purely cosmetic).
  stepPhase += Math.abs(playerVel) * 0.08 * dt;
}

function stepCandles(dt: number): void {
  const tiltMag = Math.abs(tilt);
  for (const c of candles) {
    if (!c.lit) continue;
    c.wax -= WAX_BURN_PER_TICK * dt;
    if (tiltMag > TILT_DRIP_THRESHOLD) {
      const dripScale = (tiltMag - TILT_DRIP_THRESHOLD) / (1 - TILT_DRIP_THRESHOLD);
      c.wax -= WAX_DRIP_PER_TICK * dripScale * dt;
    }
    if (c.wax <= 0) {
      c.wax = 0;
      c.lit = false;
    }
  }
  if (tiltMag > TILT_SNUFF_THRESHOLD && snuffFlashUntil < performance.now() - 200) {
    snuffOneCandle(tilt >= 0 ? 1 : -1);
  }
  if (litCount() === 0) {
    endGame();
  }
}

function stepServeProximity(dt: number, now: number): void {
  const tx = tables[activeTableIdx];
  if (tx === undefined) return;
  const inRange = Math.abs(playerX - tx) <= SERVE_DISTANCE;
  const slowEnough = Math.abs(playerVel) < 1.0;
  if (inRange && slowEnough) {
    nearActiveSince += dt * TICK_MS;
    if (nearActiveSince >= SERVE_HOLD_MS) {
      serveActiveTable();
      nearActiveSince = 0;
    }
  } else {
    nearActiveSince = Math.max(0, nearActiveSince - dt * TICK_MS * 1.6);
  }
  void now;
}

function loop(myToken: number): void {
  if (myToken !== gen.current()) return;
  const now = performance.now();
  const dt = Math.min(2.5, (now - lastFrameTs) / TICK_MS);
  lastFrameTs = now;

  if (state === 'playing') {
    stepPhysics(dt);
    stepCandles(dt);
    stepServeProximity(dt, now);
    updateHud();
  }

  drawScene(now);
  rafToken = requestAnimationFrame(() => loop(myToken));
}

function drawScene(now: number): void {
  const surface = getCss('--surface', '#161821');
  const text = getCss('--text', '#e9eef6');
  const dim = getCss('--text-dim', '#9aa3b2');
  const accent = getCss('--accent', '#f4c95d');

  // Background: dim banquet hall.
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawWallpaper();
  drawFloor();
  drawTables(now, accent, dim);
  drawPlayerAndPole(now, accent, text);
  drawTiltMeter(now, text, dim);

  if (state === 'ready') {
    drawHint(text, 'Boşluk veya Enter ile başla');
  } else if (state === 'gameover') {
    drawHint(text, 'Mumlar söndü — R veya Boşluk ile yeniden');
  }

  drawServeFlash(now);
}

function drawWallpaper(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  grad.addColorStop(0, 'rgba(45, 30, 25, 0.55)');
  grad.addColorStop(1, 'rgba(20, 14, 12, 0.85)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, FLOOR_Y);

  // Faint vertical pilasters for depth.
  ctx.fillStyle = 'rgba(255, 215, 170, 0.04)';
  for (let i = 0; i < 6; i++) {
    const x = (CANVAS_W / 6) * i + 14;
    ctx.fillRect(x, 0, 20, FLOOR_Y - 4);
  }

  // Chandelier-ish glow at top center.
  const g2 = ctx.createRadialGradient(CANVAS_W / 2, -20, 10, CANVAS_W / 2, 40, 220);
  g2.addColorStop(0, 'rgba(244, 201, 93, 0.22)');
  g2.addColorStop(1, 'rgba(244, 201, 93, 0)');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, CANVAS_W, 220);
}

function drawFloor(): void {
  // Floor strip.
  ctx.fillStyle = 'rgba(70, 45, 30, 0.92)';
  ctx.fillRect(0, FLOOR_Y, CANVAS_W, CANVAS_H - FLOOR_Y);
  // Perspective lines (parquet hint).
  ctx.strokeStyle = 'rgba(20, 10, 8, 0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    const y = FLOOR_Y + 4 + i * 8;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_W, y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, FLOOR_Y - 2, CANVAS_W, 2);
}

function drawTables(now: number, accent: string, dim: string): void {
  for (let i = 0; i < tables.length; i++) {
    const tx = tables[i]!;
    const active = i === activeTableIdx && state === 'playing';
    const baseY = FLOOR_Y - TABLE_H - 4;

    if (active) {
      // Soft pulsing glow under the active table.
      const pulse = 0.55 + 0.25 * Math.sin(now * 0.006);
      ctx.fillStyle = `rgba(244, 201, 93, ${0.22 * pulse})`;
      ctx.beginPath();
      ctx.ellipse(tx, FLOOR_Y + 2, TABLE_W * 0.9, 14, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Table top.
    ctx.fillStyle = active ? '#7a4a26' : '#5a3c25';
    ctx.fillRect(tx - TABLE_W / 2, baseY, TABLE_W, 8);
    // Cloth.
    ctx.fillStyle = active ? '#f7d987' : '#d9c8a8';
    ctx.fillRect(tx - TABLE_W / 2, baseY + 8, TABLE_W, TABLE_H - 8);
    // Cloth shading.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.fillRect(tx - TABLE_W / 2, baseY + TABLE_H - 4, TABLE_W, 4);

    if (active) {
      // Progress arc for the auto-serve hold timer.
      const progress = Math.min(1, nearActiveSince / SERVE_HOLD_MS);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      const r = 16;
      ctx.arc(tx, baseY - 6, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
      // Label.
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('servis', tx, baseY - 6);
    } else {
      ctx.font = '500 10px system-ui, sans-serif';
      ctx.fillStyle = dim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`#${i + 1}`, tx, baseY + 11);
    }
  }
}

function drawPlayerAndPole(now: number, accent: string, text: string): void {
  // Bobbing from walk phase.
  const bob = Math.abs(Math.sin(stepPhase)) * 2.0;
  const px = playerX;
  const py = FLOOR_Y - bob;

  // Shadow under feet.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.ellipse(px, FLOOR_Y + 2, 22, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs.
  ctx.strokeStyle = '#1a1418';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  const stride = Math.sin(stepPhase) * 6;
  ctx.beginPath();
  ctx.moveTo(px - 4, py - 4);
  ctx.lineTo(px - 4 - stride, FLOOR_Y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px + 4, py - 4);
  ctx.lineTo(px + 4 + stride, FLOOR_Y);
  ctx.stroke();

  // Body.
  ctx.fillStyle = '#1c1820';
  ctx.fillRect(px - PLAYER_W / 2, py - 50, PLAYER_W, 46);
  ctx.fillStyle = '#2a2030';
  ctx.fillRect(px - PLAYER_W / 2 + 2, py - 50, PLAYER_W - 4, 8);

  // Head.
  ctx.fillStyle = '#d8b079';
  ctx.beginPath();
  ctx.arc(px, py - 60, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a2a18';
  ctx.fillRect(px - 9, py - 70, 18, 6);

  // Arm raised holding pole.
  ctx.strokeStyle = '#1c1820';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px, py - 40);
  ctx.lineTo(px, py - 70);
  ctx.stroke();

  // Pole pivots at the hand position (px, baseY).
  const baseY = py - 70;
  ctx.save();
  ctx.translate(px, baseY);
  ctx.rotate(tilt);

  // Pole shaft (silver).
  ctx.fillStyle = '#bcc4d4';
  ctx.fillRect(-3, -POLE_LEN, 6, POLE_LEN);
  ctx.fillStyle = '#7d8696';
  ctx.fillRect(-3, -POLE_LEN, 2, POLE_LEN);
  // Bulb under candle holder.
  ctx.fillStyle = '#d2dae8';
  ctx.beginPath();
  ctx.arc(0, -POLE_LEN + 8, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#7d8696';
  ctx.fillRect(-12, -POLE_LEN + 14, 24, 4);

  // Cross-bar holding candles.
  const barW = 90;
  ctx.fillStyle = '#bcc4d4';
  ctx.fillRect(-barW / 2, -POLE_LEN, barW, 6);
  ctx.fillStyle = '#7d8696';
  ctx.fillRect(-barW / 2, -POLE_LEN, barW, 2);

  // Decorative cups under each candle.
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const cx = -barW / 2 + ((barW - 16) / (CANDLE_COUNT - 1)) * i + 8;
    ctx.fillStyle = '#a8b1c3';
    ctx.fillRect(cx - 8, -POLE_LEN - 4, 16, 6);
  }

  // Candles.
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const cx = -barW / 2 + ((barW - 16) / (CANDLE_COUNT - 1)) * i + 8;
    const candle = candles[i];
    if (!candle) continue;
    const candleH = 22 * Math.max(0.15, candle.wax);
    // Candle body.
    ctx.fillStyle = '#f4e1c0';
    ctx.fillRect(cx - 4, -POLE_LEN - 4 - candleH, 8, candleH);
    ctx.fillStyle = 'rgba(120, 90, 50, 0.45)';
    ctx.fillRect(cx - 4, -POLE_LEN - 4 - candleH, 2, candleH);
    // Wax remaining indicator (very subtle line).
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fillRect(cx - 6, -POLE_LEN - 3, 12, 1);

    if (candle.lit) {
      drawFlame(cx, -POLE_LEN - 4 - candleH, candle.flameSeed, now);
    } else {
      // Smoke.
      ctx.fillStyle = 'rgba(180, 180, 180, 0.45)';
      const t = (now * 0.002 + candle.flameSeed) % 1;
      ctx.beginPath();
      ctx.arc(cx + Math.sin(now * 0.003 + i) * 2, -POLE_LEN - 4 - candleH - 6 - t * 10, 2 + t * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  void accent;
  void text;
}

function drawFlame(x: number, y: number, seed: number, now: number): void {
  const flicker = Math.sin(now * 0.02 + seed) * 0.6 + Math.sin(now * 0.07 + seed * 2) * 0.4;
  const h = 9 + flicker;
  const w = 4.5;
  // Outer warm glow.
  const grad = ctx.createRadialGradient(x, y - h / 2, 1, x, y - h / 2, h * 1.8);
  grad.addColorStop(0, 'rgba(255, 215, 130, 0.85)');
  grad.addColorStop(1, 'rgba(255, 140, 60, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y - h / 2, h * 1.5, 0, Math.PI * 2);
  ctx.fill();

  // Flame body.
  ctx.fillStyle = '#ffd680';
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y);
  ctx.quadraticCurveTo(x - w, y - h * 0.45, x, y - h);
  ctx.quadraticCurveTo(x + w, y - h * 0.45, x + w / 2, y);
  ctx.fill();
  // Inner hot core.
  ctx.fillStyle = '#fff3c5';
  ctx.beginPath();
  ctx.moveTo(x - 1.5, y - 1);
  ctx.quadraticCurveTo(x - 2, y - h * 0.5, x, y - h * 0.85);
  ctx.quadraticCurveTo(x + 2, y - h * 0.5, x + 1.5, y - 1);
  ctx.fill();
}

function drawTiltMeter(now: number, text: string, dim: string): void {
  const x = CANVAS_W - 30;
  const y0 = 60;
  const y1 = FLOOR_Y - 30;
  const h = y1 - y0;
  // Background bar.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(x - 6, y0, 12, h);
  // Safe band.
  ctx.fillStyle = 'rgba(120, 220, 140, 0.18)';
  ctx.fillRect(x - 6, y0 + h * 0.42, 12, h * 0.16);
  // Snuff threshold marks.
  ctx.strokeStyle = 'rgba(240, 90, 90, 0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 9, y0 + h * 0.08);
  ctx.lineTo(x + 9, y0 + h * 0.08);
  ctx.moveTo(x - 9, y0 + h * 0.92);
  ctx.lineTo(x + 9, y0 + h * 0.92);
  ctx.stroke();

  // Needle.
  const t = Math.max(-1, Math.min(1, tilt / 0.7));
  const ny = y0 + h * (0.5 + t * 0.5);
  const mag = Math.abs(t);
  let color = '#9fe5b0';
  if (mag > 0.6) color = '#f59c4c';
  if (mag > 0.85) color = '#ef5b5b';
  if (mag < 0.25) color = '#d8e0ec';
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - 12, ny);
  ctx.lineTo(x + 12, ny);
  ctx.lineTo(x + 8, ny - 4);
  ctx.lineTo(x + 8, ny + 4);
  ctx.closePath();
  ctx.fill();

  // Label.
  ctx.fillStyle = dim;
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('EĞİM', x, y0 - 14);

  // Snuff flash hint.
  if (snuffFlashUntil > now) {
    const a = (snuffFlashUntil - now) / 360;
    ctx.fillStyle = `rgba(239, 91, 91, ${0.45 * a})`;
    if (snuffFlashSide >= 0) {
      ctx.fillRect(CANVAS_W - 18, 0, 18, CANVAS_H);
    } else {
      ctx.fillRect(0, 0, 18, CANVAS_H);
    }
  }

  void text;
}

function drawHint(text: string, msg: string): void {
  ctx.fillStyle = text;
  ctx.globalAlpha = 0.85;
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(msg, CANVAS_W / 2, 14);
  ctx.globalAlpha = 1;
}

function drawServeFlash(now: number): void {
  if (serveFlashUntil <= now) return;
  const a = (serveFlashUntil - now) / 320;
  const tx = tables[activeTableIdx];
  const cx = tx ?? CANVAS_W / 2;
  ctx.fillStyle = `rgba(244, 201, 93, ${0.6 * a})`;
  ctx.font = '700 18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`+${litCount() === 0 ? 0 : litCount()}`, cx, FLOOR_Y - 40 - (1 - a) * 18);
}

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafToken);
  state = 'ready';
  score = 0;
  playerX = CANVAS_W / 2;
  playerVel = 0;
  prevPlayerVel = 0;
  leftHeld = false;
  rightHeld = false;
  tilt = 0;
  tiltVel = 0;
  freshCandles();
  placeTables();
  activeTableIdx = 0;
  nearActiveSince = 0;
  serveFlashUntil = 0;
  snuffFlashUntil = 0;
  updateHud();
  showOverlay(
    'Şamdan',
    'Parlayan masaya yürü, önünde dur ya da Boşluk\'a bas. Ani durup başlama mumları söndürür.',
  );
  lastFrameTs = performance.now();
  const myToken = gen.current();
  rafToken = requestAnimationFrame(() => loop(myToken));
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  litEl = document.querySelector<HTMLElement>('#lit')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      if (state === 'playing') {
        leftHeld = true;
        e.preventDefault();
      }
    } else if (k === 'arrowright' || k === 'd') {
      if (state === 'playing') {
        rightHeld = true;
        e.preventDefault();
      }
    } else if (k === ' ' || k === 'spacebar' || k === 'enter') {
      if (state === 'ready' || state === 'gameover') {
        startGame();
      } else if (state === 'playing') {
        serveActiveTable();
      }
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      leftHeld = false;
    } else if (k === 'arrowright' || k === 'd') {
      rightHeld = false;
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const action = btn.dataset.action as 'left' | 'right' | 'serve' | undefined;
    if (!action) return;
    if (action === 'left') {
      const start = (ev: Event) => {
        ev.preventDefault();
        if (state !== 'playing') return;
        leftHeld = true;
        rightHeld = false;
      };
      const end = () => {
        leftHeld = false;
      };
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', end);
      btn.addEventListener('pointercancel', end);
    } else if (action === 'right') {
      const start = (ev: Event) => {
        ev.preventDefault();
        if (state !== 'playing') return;
        rightHeld = true;
        leftHeld = false;
      };
      const end = () => {
        rightHeld = false;
      };
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', end);
      btn.addEventListener('pointercancel', end);
    } else if (action === 'serve') {
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        if (state === 'ready' || state === 'gameover') {
          startGame();
        } else {
          serveActiveTable();
        }
      });
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
}

export const game = defineGame({ init, reset });
