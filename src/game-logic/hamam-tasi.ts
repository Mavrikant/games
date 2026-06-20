// ---------------------------------------------------------------------------
// Hamam Tası — you are a tellak in a traditional Turkish bath. Three customers
// sit at marble basins waiting for warm water. The original mechanic: two
// taps (cold + hot) feed a single brass bowl whose temperature is the
// weighted blend of every drop that fell into it. You must pulse the taps to
// land within the customer's desired hararet band before patience runs out,
// then pour. Pouring empties the bowl, so each customer is a fresh mix.
//
// State machine: ready | playing | gameover  (PITFALLS#overlay-input-leak)
// PITFALLS guarded:
//   - unguarded-storage: safeRead / safeWrite via @shared/storage
//   - module-level-dom-access: all DOM/listeners live in init()
//   - stale-async-callback: gen-token bumps cancel the RAF loop on reset
//   - missing-overlay-css: hamam-tasi.css ships .overlay + .overlay--hidden
//   - visual-vs-hitbox: TAP_HIT_R, BOWL_R, STATION_W single-source constants
//     used by both draw() and hit-testing
//   - invisible-boot: ready overlay paints immediately; a seed customer is
//     already on the marble at ready, so the first frame after Başla shows
//     three customers and a tap press streams water inside 250ms
//   - designed-lose-condition-not-wired: patience timeout explicitly applies
//     a penalty + replaces the customer; pouring on an empty bowl explicitly
//     penalises instead of silently doing nothing
//   - hud-counter-synced-only-at-lifecycle-edges: setScore() helper writes
//     scoreEl every time the score mutates
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

type State = 'ready' | 'playing' | 'gameover';
type CustomerKind = 'normal' | 'vip';
type TapSide = 'cold' | 'hot';

interface Customer {
  station: number;
  desired: number;
  patience: number;
  maxPatience: number;
  kind: CustomerKind;
  bornAt: number;
  appearAnim: number;
  leaving: 'happy' | 'angry' | null;
  leaveTime: number;
  flashUntil: number;
  flashColor: string;
}

interface Splash {
  station: number;
  age: number;
  temp: number;
  volume: number;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
}

interface Drop {
  x: number;
  y: number;
  vy: number;
  temp: number;
}

// ── Constants ──
const W = 640;
const H = 480;

const STORAGE_KEY = 'hamam-tasi.best';
const ROUND_SECONDS = 60;

const TAP_COLD_TEMP = 18;
const TAP_HOT_TEMP = 92;
const TAP_FLOW = 78;

const BOWL_MAX = 100;
const BOWL_CENTER_X = W / 2;
const BOWL_CENTER_Y = 158;
const BOWL_R = 52;
const BOWL_RIM_Y = BOWL_CENTER_Y - BOWL_R * 0.65;

const TAP_LEFT_X = 84;
const TAP_LEFT_Y = 92;
const TAP_RIGHT_X = W - 84;
const TAP_RIGHT_Y = 92;
const TAP_HIT_R = 56;
const TAP_SPOUT_LEFT_X = 148;
const TAP_SPOUT_RIGHT_X = W - 148;
const TAP_SPOUT_Y = 108;

const STATION_Y = 360;
const STATION_W = W / 3;
const CUSTOMER_HEAD_R = 26;
const PATIENCE_BAR_W = 110;
const PATIENCE_BAR_H = 8;

const PERFECT_BAND_START = 10;
const PERFECT_BAND_END = 6;
const OK_BAND_START = 20;
const OK_BAND_END = 14;

const PATIENCE_START = 18;
const PATIENCE_END = 11;
const VIP_PATIENCE = 9;

const SCORE_PERFECT = 10;
const SCORE_OK = 5;
const SCORE_BAD = -5;
const SCORE_EMPTY_POUR = -2;
const SCORE_DUMP = -1;
const SCORE_TIMEOUT = -8;
const SCORE_VIP_PERFECT = 25;
const SCORE_VIP_OK = 10;
const SCORE_VIP_BAD = -12;
const SCORE_VIP_TIMEOUT = -15;

const NEW_CUSTOMER_DELAY = 0.55;

// ── DOM refs ──
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

// ── State ──
let state: State = 'ready';
let stations: (Customer | null)[] = [null, null, null];
let spawnDelays: number[] = [0, 0, 0];
let bowlVolume = 0;
let bowlTemp = 50;
let bowlSwing = 0;
let bowlSwingV = 0;
let tapHeld: { cold: boolean; hot: boolean } = { cold: false, hot: false };
let pointerTapHeld: TapSide | null = null;
let splashes: Splash[] = [];
let floats: FloatText[] = [];
let drops: Drop[] = [];
let score = 0;
let best = 0;
let elapsed = 0;
let remaining = ROUND_SECONDS;
let rafId = 0;
let lastTime = 0;
const gen = createGenToken();

// ── Helpers ──
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function difficultyT(): number {
  return Math.min(1, elapsed / ROUND_SECONDS);
}

function currentPerfectBand(kind: CustomerKind): number {
  const base = lerp(PERFECT_BAND_START, PERFECT_BAND_END, difficultyT());
  return kind === 'vip' ? base * 0.7 : base;
}

function currentOkBand(kind: CustomerKind): number {
  const base = lerp(OK_BAND_START, OK_BAND_END, difficultyT());
  return kind === 'vip' ? base * 0.75 : base;
}

function currentPatience(kind: CustomerKind): number {
  if (kind === 'vip') return VIP_PATIENCE;
  return lerp(PATIENCE_START, PATIENCE_END, difficultyT());
}

function stationCenter(i: number): { x: number; y: number } {
  return { x: STATION_W * (i + 0.5), y: STATION_Y };
}

function tempColor(t: number): string {
  const c = clamp(t, 0, 100);
  if (c < 50) {
    const k = c / 50;
    const r = Math.round(lerp(120, 250, k));
    const g = Math.round(lerp(180, 220, k));
    const b = Math.round(lerp(240, 160, k));
    return `rgb(${r}, ${g}, ${b})`;
  }
  const k = (c - 50) / 50;
  const r = Math.round(lerp(250, 235, k));
  const g = Math.round(lerp(220, 90, k));
  const b = Math.round(lerp(160, 70, k));
  return `rgb(${r}, ${g}, ${b})`;
}

function setScore(n: number): void {
  score = Math.max(0, n);
  scoreEl.textContent = String(score);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_KEY, best);
  }
}

function applyScore(delta: number): void {
  setScore(score + delta);
}

function floatText(x: number, y: number, text: string, color: string): void {
  floats.push({ x, y, text, color, life: 1.2 });
}

function pickDesiredTemp(kind: CustomerKind): number {
  if (kind === 'vip') {
    return Math.random() < 0.5 ? rand(25, 38) : rand(78, 90);
  }
  const r = Math.random();
  if (r < 0.55) return rand(45, 70);
  if (r < 0.8) return rand(30, 45);
  return rand(70, 85);
}

function spawnCustomerAt(i: number): void {
  const vipRoll = Math.random();
  const vipChance = 0.06 + difficultyT() * 0.12;
  const kind: CustomerKind = vipRoll < vipChance ? 'vip' : 'normal';
  const patience = currentPatience(kind);
  stations[i] = {
    station: i,
    desired: pickDesiredTemp(kind),
    patience,
    maxPatience: patience,
    kind,
    bornAt: elapsed,
    appearAnim: 0,
    leaving: null,
    leaveTime: 0,
    flashUntil: 0,
    flashColor: '#fff',
  };
}

function startSpawnDelay(i: number, delay = NEW_CUSTOMER_DELAY): void {
  spawnDelays[i] = delay;
}

// ── Bowl mechanics ──
function fillBowl(tapTemp: number, dt: number): void {
  if (bowlVolume >= BOWL_MAX) {
    bowlVolume = BOWL_MAX;
    return;
  }
  const delta = Math.min(TAP_FLOW * dt, BOWL_MAX - bowlVolume);
  if (delta <= 0) return;
  const newVol = bowlVolume + delta;
  bowlTemp = (bowlTemp * bowlVolume + tapTemp * delta) / newVol;
  bowlVolume = newVol;
  if (Math.random() < dt * 28) {
    spawnDrop(tapTemp);
  }
  bowlSwingV += (tapTemp > 50 ? 1 : -1) * 12 * dt;
}

function spawnDrop(tapTemp: number): void {
  const fromX = tapTemp > 50 ? TAP_SPOUT_RIGHT_X : TAP_SPOUT_LEFT_X;
  drops.push({
    x: fromX + rand(-3, 3),
    y: TAP_SPOUT_Y + 6,
    vy: rand(150, 230),
    temp: tapTemp,
  });
}

function pourOn(i: number): void {
  const c = stations[i];
  if (!c || c.leaving) return;
  if (bowlVolume < 10) {
    applyScore(SCORE_EMPTY_POUR);
    const cc = stationCenter(i);
    floatText(cc.x, cc.y - 70, 'tas boş!', '#fda4af');
    c.flashUntil = elapsed + 0.4;
    c.flashColor = '#f87171';
    return;
  }
  const delta = Math.abs(bowlTemp - c.desired);
  const perfect = currentPerfectBand(c.kind);
  const ok = currentOkBand(c.kind);
  let bonus = 0;
  let leaving: 'happy' | 'angry';
  let label = '';
  let color = '#86efac';

  if (delta <= perfect) {
    bonus = c.kind === 'vip' ? SCORE_VIP_PERFECT : SCORE_PERFECT;
    label = c.kind === 'vip' ? `+${bonus} VIP!` : `+${bonus} kıvamında`;
    color = c.kind === 'vip' ? '#fde68a' : '#86efac';
    leaving = 'happy';
  } else if (delta <= ok) {
    bonus = c.kind === 'vip' ? SCORE_VIP_OK : SCORE_OK;
    label = `+${bonus} idare eder`;
    color = '#fcd34d';
    leaving = 'happy';
  } else {
    bonus = c.kind === 'vip' ? SCORE_VIP_BAD : SCORE_BAD;
    const tooHot = bowlTemp > c.desired;
    label = `${bonus} ${tooHot ? 'haşladın' : 'buz gibi'}`;
    color = '#f87171';
    leaving = 'angry';
  }

  splashes.push({
    station: i,
    age: 0,
    temp: bowlTemp,
    volume: bowlVolume,
  });
  const cc = stationCenter(i);
  floatText(cc.x, cc.y - 90, label, color);

  applyScore(bonus);
  c.leaving = leaving;
  c.leaveTime = elapsed;
  c.flashUntil = elapsed + 0.5;
  c.flashColor = leaving === 'happy' ? '#86efac' : '#fca5a5';

  bowlVolume = 0;
  bowlTemp = 50;
  bowlSwingV += (leaving === 'happy' ? -1 : 1) * 60;
}

function dumpBowl(): void {
  if (bowlVolume < 5) return;
  applyScore(SCORE_DUMP);
  floatText(BOWL_CENTER_X, BOWL_CENTER_Y + BOWL_R + 30, '−1 göbek taşına', '#cbd5e1');
  bowlVolume = 0;
  bowlTemp = 50;
  bowlSwingV += rand(-40, 40);
}

// ── Update ──
function update(dt: number): void {
  if (state !== 'playing') return;

  elapsed += dt;
  remaining -= dt;
  if (remaining <= 0) {
    remaining = 0;
    timeEl.textContent = '0';
    endGame();
    return;
  }
  timeEl.textContent = String(Math.max(0, Math.ceil(remaining)));

  const coldOn = tapHeld.cold || pointerTapHeld === 'cold';
  const hotOn = tapHeld.hot || pointerTapHeld === 'hot';
  if (coldOn) fillBowl(TAP_COLD_TEMP, dt);
  if (hotOn) fillBowl(TAP_HOT_TEMP, dt);

  for (const d of drops) {
    d.y += d.vy * dt;
    d.vy += 540 * dt;
  }
  drops = drops.filter((d) => d.y < BOWL_RIM_Y + BOWL_R * 1.1);

  const k = 22;
  const damp = 4.2;
  const ax = -k * bowlSwing - damp * bowlSwingV;
  bowlSwingV += ax * dt;
  bowlSwing += bowlSwingV * dt;

  for (let i = 0; i < 3; i++) {
    const c = stations[i];
    if (!c) {
      spawnDelays[i] -= dt;
      if (spawnDelays[i] <= 0) {
        spawnCustomerAt(i);
      }
      continue;
    }

    c.appearAnim = Math.min(1, c.appearAnim + dt * 3.5);

    if (c.leaving) {
      if (elapsed - c.leaveTime > 0.7) {
        stations[i] = null;
        startSpawnDelay(i);
      }
      continue;
    }

    c.patience -= dt;
    if (c.patience <= 0) {
      applyScore(c.kind === 'vip' ? SCORE_VIP_TIMEOUT : SCORE_TIMEOUT);
      const cc = stationCenter(i);
      floatText(
        cc.x,
        cc.y - 90,
        c.kind === 'vip' ? `${SCORE_VIP_TIMEOUT} havlu fırlattı!` : `${SCORE_TIMEOUT} bekledi`,
        '#f87171',
      );
      c.leaving = 'angry';
      c.leaveTime = elapsed;
      c.flashUntil = elapsed + 0.5;
      c.flashColor = '#f87171';
    }
  }

  for (const s of splashes) s.age += dt;
  splashes = splashes.filter((s) => s.age < 0.8);

  for (const f of floats) {
    f.life -= dt;
    f.y -= 26 * dt;
  }
  floats = floats.filter((f) => f.life > 0);
}

// ── Drawing ──
function drawBackground(): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#28181c');
  g.addColorStop(0.55, '#3a2126');
  g.addColorStop(1, '#1b1014');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(220, 200, 180, 0.05)';
  ctx.lineWidth = 1;
  for (let y = 40; y < H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let x = 40; x < W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  const rg = ctx.createRadialGradient(W / 2, -60, 40, W / 2, -60, 360);
  rg.addColorStop(0, 'rgba(255, 220, 170, 0.18)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, 240);

  ctx.fillStyle = 'rgba(245, 232, 215, 0.06)';
  ctx.beginPath();
  ctx.ellipse(W / 2, H - 30, W * 0.42, 38, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawTap(x: number, y: number, side: TapSide, active: boolean): void {
  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = '#7a5a2c';
  ctx.fillRect(side === 'cold' ? 0 : -22, -12, 22, 18);

  const dir = side === 'cold' ? 1 : -1;
  ctx.fillStyle = active ? '#fbbf24' : '#b8862e';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(dir * 60, 0);
  ctx.lineTo(dir * 60, 16);
  ctx.lineTo(0, 16);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#5e3f12';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = side === 'cold' ? '#7dd3fc' : '#fb7185';
  ctx.beginPath();
  ctx.arc(dir * 18, -22, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1014';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#1a1014';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(side === 'cold' ? 'S' : 'H', dir * 18, -22);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'start';

  if (active) {
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(dir * 18, -22, 18, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (active) {
    const streamX = dir * 60;
    ctx.fillStyle = side === 'cold' ? 'rgba(125, 211, 252, 0.75)' : 'rgba(254, 215, 170, 0.75)';
    const targetX = BOWL_CENTER_X - x;
    const targetY = BOWL_RIM_Y - y;
    const steps = 14;
    for (let s = 0; s < steps; s++) {
      const t = s / (steps - 1);
      const sx = lerp(streamX, targetX, t);
      const sy = lerp(8, targetY, t) + Math.sin((elapsed * 16 + s) * Math.PI) * 1.4;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.6 - t * 1.0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawBowl(): void {
  ctx.save();

  ctx.strokeStyle = '#9aa3ad';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 8; i++) {
    const t = i / 8;
    const y = lerp(0, BOWL_CENTER_Y - BOWL_R, t);
    const x = BOWL_CENTER_X + bowlSwing * 0.25 * t;
    ctx.beginPath();
    ctx.arc(x, y, 2.4, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.translate(BOWL_CENTER_X + bowlSwing * 0.25, BOWL_CENTER_Y);
  ctx.rotate(bowlSwing * 0.004);

  ctx.fillStyle = '#c89a3d';
  ctx.beginPath();
  ctx.ellipse(0, -BOWL_R * 0.65, BOWL_R, BOWL_R * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#8a6420';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#b8862e';
  ctx.beginPath();
  ctx.moveTo(-BOWL_R, -BOWL_R * 0.65);
  ctx.quadraticCurveTo(-BOWL_R * 0.9, BOWL_R * 0.6, 0, BOWL_R * 0.7);
  ctx.quadraticCurveTo(BOWL_R * 0.9, BOWL_R * 0.6, BOWL_R, -BOWL_R * 0.65);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#6b4a10';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(70, 45, 8, 0.5)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = -BOWL_R * 0.4 + i * BOWL_R * 0.18;
    ctx.beginPath();
    ctx.ellipse(0, y, BOWL_R * (0.95 - i * 0.07), 6, 0, 0, Math.PI);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(245, 215, 130, 0.6)';
  ctx.beginPath();
  ctx.arc(0, BOWL_R * 0.35, 6, 0, Math.PI * 2);
  ctx.fill();

  if (bowlVolume > 0.5) {
    const fillFrac = bowlVolume / BOWL_MAX;
    const waterTopY = -BOWL_R * 0.65 + (BOWL_R * 1.3) * (1 - fillFrac) - 2;
    const halfWidth = BOWL_R * (0.95 - (1 - fillFrac) * 0.6);
    const waterColor = tempColor(bowlTemp);
    ctx.fillStyle = waterColor;
    ctx.beginPath();
    ctx.moveTo(-halfWidth, waterTopY);
    ctx.lineTo(halfWidth, waterTopY);
    ctx.quadraticCurveTo(halfWidth * 0.95, BOWL_R * 0.55, 0, BOWL_R * 0.65);
    ctx.quadraticCurveTo(-halfWidth * 0.95, BOWL_R * 0.55, -halfWidth, waterTopY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.ellipse(0, waterTopY, halfWidth, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    if (bowlTemp > 65) {
      const intensity = (bowlTemp - 65) / 30;
      ctx.fillStyle = `rgba(255, 235, 220, ${0.06 + intensity * 0.18})`;
      for (let i = 0; i < 4; i++) {
        const sx = (i - 1.5) * 14 + Math.sin(elapsed * 2 + i) * 6;
        const sy = waterTopY - 14 - Math.sin(elapsed * 1.4 + i * 0.7) * 8 - i * 4;
        ctx.beginPath();
        ctx.arc(sx, sy, 8 + intensity * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

function drawBowlReadout(): void {
  const cx = BOWL_CENTER_X;
  const cy = BOWL_CENTER_Y + BOWL_R + 18;

  const tbW = 180;
  const tbH = 10;
  ctx.fillStyle = 'rgba(20, 12, 14, 0.7)';
  ctx.fillRect(cx - tbW / 2 - 4, cy - 4, tbW + 8, tbH + 8);
  const grad = ctx.createLinearGradient(cx - tbW / 2, 0, cx + tbW / 2, 0);
  grad.addColorStop(0, tempColor(0));
  grad.addColorStop(0.5, tempColor(50));
  grad.addColorStop(1, tempColor(100));
  ctx.fillStyle = grad;
  ctx.fillRect(cx - tbW / 2, cy, tbW, tbH);
  const tx = cx - tbW / 2 + (bowlTemp / 100) * tbW;
  ctx.fillStyle = '#fff';
  ctx.fillRect(tx - 2, cy - 2, 4, tbH + 4);
  ctx.strokeStyle = '#1a1014';
  ctx.lineWidth = 1;
  ctx.strokeRect(tx - 2, cy - 2, 4, tbH + 4);

  ctx.fillStyle = 'rgba(220, 210, 195, 0.85)';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `${Math.round(bowlTemp)}°  ·  ${Math.round(bowlVolume)}%`,
    cx,
    cy + tbH + 14,
  );
  ctx.textAlign = 'start';

  const vbX = cx + tbW / 2 + 18;
  const vbW = 12;
  const vbH = 38;
  const vbY = cy - 14;
  ctx.fillStyle = 'rgba(20, 12, 14, 0.7)';
  ctx.fillRect(vbX - 2, vbY - 2, vbW + 4, vbH + 4);
  ctx.fillStyle = '#3a2126';
  ctx.fillRect(vbX, vbY, vbW, vbH);
  ctx.fillStyle = tempColor(bowlTemp);
  const vh = (bowlVolume / BOWL_MAX) * vbH;
  ctx.fillRect(vbX, vbY + vbH - vh, vbW, vh);
}

function drawDrops(): void {
  for (const d of drops) {
    ctx.fillStyle = tempColor(d.temp);
    ctx.beginPath();
    ctx.arc(d.x, d.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCustomer(c: Customer): void {
  const cc = stationCenter(c.station);
  const ax = cc.x;
  const ay = cc.y;
  const grow = c.appearAnim;

  ctx.save();
  ctx.translate(ax, ay);

  const basinW = STATION_W * 0.78;
  const basinH = 60;
  ctx.fillStyle = '#f3e3c4';
  ctx.beginPath();
  ctx.ellipse(0, 50, basinW * 0.5, basinH * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#a98856';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(125, 211, 252, 0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 50, basinW * 0.42, basinH * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  const bob = Math.sin((elapsed + c.bornAt) * 2.4) * 1.2;

  const bodyColor =
    c.kind === 'vip'
      ? '#fbbf24'
      : ['#94a3b8', '#a78bfa', '#fda4af', '#86efac'][c.station % 4]!;
  ctx.fillStyle = bodyColor;
  const bodyH = 40 * grow;
  ctx.beginPath();
  ctx.moveTo(-22, 36 + bob);
  ctx.lineTo(-18, 36 - bodyH + bob);
  ctx.lineTo(18, 36 - bodyH + bob);
  ctx.lineTo(22, 36 + bob);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.5;
  for (let i = 1; i <= 3; i++) {
    const y = 36 - bodyH + i * (bodyH / 4) + bob;
    ctx.beginPath();
    ctx.moveTo(-20, y);
    ctx.lineTo(20, y);
    ctx.stroke();
  }

  const headY = 36 - bodyH - CUSTOMER_HEAD_R + 4 + bob;
  let headFill = '#e8c79a';
  if (c.flashUntil > elapsed) headFill = c.flashColor;
  if (c.leaving === 'happy') {
    headFill = '#bbf7d0';
  } else if (c.leaving === 'angry') {
    headFill = '#fecaca';
  }
  ctx.fillStyle = headFill;
  ctx.beginPath();
  ctx.arc(0, headY, CUSTOMER_HEAD_R * grow, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120, 70, 30, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (c.kind === 'vip') {
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.moveTo(-18, headY - CUSTOMER_HEAD_R + 4);
    ctx.lineTo(-14, headY - CUSTOMER_HEAD_R - 18);
    ctx.lineTo(14, headY - CUSTOMER_HEAD_R - 18);
    ctx.lineTo(18, headY - CUSTOMER_HEAD_R + 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#7f1d1d';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(-2, headY - CUSTOMER_HEAD_R - 24, 4, 8);
  }

  if (c.leaving === 'happy') {
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#1a1014';
    ctx.beginPath();
    ctx.moveTo(-7, headY - 4);
    ctx.quadraticCurveTo(-10, headY - 8, -13, headY - 4);
    ctx.moveTo(7, headY - 4);
    ctx.quadraticCurveTo(10, headY - 8, 13, headY - 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, headY + 6, 6, 0, Math.PI);
    ctx.stroke();
  } else if (c.leaving === 'angry') {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1a1014';
    ctx.beginPath();
    ctx.moveTo(-12, headY - 8);
    ctx.lineTo(-4, headY - 4);
    ctx.moveTo(12, headY - 8);
    ctx.lineTo(4, headY - 4);
    ctx.stroke();
    ctx.fillStyle = '#1a1014';
    ctx.beginPath();
    ctx.arc(-7, headY - 1, 1.5, 0, Math.PI * 2);
    ctx.arc(7, headY - 1, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, headY + 10, 6, Math.PI, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.fillStyle = '#1a1014';
    ctx.beginPath();
    ctx.arc(-7, headY - 2, 2, 0, Math.PI * 2);
    ctx.arc(7, headY - 2, 2, 0, Math.PI * 2);
    ctx.fill();
    const tense = 1 - c.patience / c.maxPatience;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#1a1014';
    ctx.beginPath();
    ctx.moveTo(-5, headY + 8);
    ctx.quadraticCurveTo(0, headY + 8 + (tense > 0.5 ? -2 : 2), 5, headY + 8);
    ctx.stroke();
  }

  const tbY = -86;
  const tbW = 130;
  const tbH = 28;
  ctx.fillStyle = 'rgba(15, 8, 12, 0.82)';
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1.5;
  roundRect(ctx, -tbW / 2, tbY, tbW, tbH, 8);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-6, tbY + tbH);
  ctx.lineTo(0, tbY + tbH + 8);
  ctx.lineTo(6, tbY + tbH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(15, 8, 12, 0.82)';
  ctx.fill();

  const tBarW = tbW - 14;
  const tBarX = -tBarW / 2;
  const tBarY = tbY + 9;
  const tBarH = 10;
  const grad = ctx.createLinearGradient(tBarX, 0, tBarX + tBarW, 0);
  grad.addColorStop(0, tempColor(0));
  grad.addColorStop(0.5, tempColor(50));
  grad.addColorStop(1, tempColor(100));
  ctx.fillStyle = grad;
  ctx.fillRect(tBarX, tBarY, tBarW, tBarH);
  const perfect = currentPerfectBand(c.kind);
  const ok = currentOkBand(c.kind);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1;
  const okLeft = tBarX + ((c.desired - ok) / 100) * tBarW;
  const okRight = tBarX + ((c.desired + ok) / 100) * tBarW;
  ctx.strokeRect(okLeft, tBarY - 1, okRight - okLeft, tBarH + 2);
  const tx = tBarX + (c.desired / 100) * tBarW;
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(tx - 1.5, tBarY - 3, 3, tBarH + 6);
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 2;
  const pLeft = tBarX + ((c.desired - perfect) / 100) * tBarW;
  const pRight = tBarX + ((c.desired + perfect) / 100) * tBarW;
  ctx.beginPath();
  ctx.moveTo(pLeft, tBarY + tBarH + 1);
  ctx.lineTo(pRight, tBarY + tBarH + 1);
  ctx.stroke();

  const pbY = tbY - 14;
  ctx.fillStyle = 'rgba(20, 12, 14, 0.6)';
  ctx.fillRect(-PATIENCE_BAR_W / 2 - 2, pbY - 2, PATIENCE_BAR_W + 4, PATIENCE_BAR_H + 4);
  ctx.fillStyle = '#3a2126';
  ctx.fillRect(-PATIENCE_BAR_W / 2, pbY, PATIENCE_BAR_W, PATIENCE_BAR_H);
  const ratio = clamp(c.patience / c.maxPatience, 0, 1);
  const pColor = ratio > 0.5 ? '#86efac' : ratio > 0.25 ? '#fcd34d' : '#f87171';
  ctx.fillStyle = pColor;
  ctx.fillRect(-PATIENCE_BAR_W / 2, pbY, PATIENCE_BAR_W * ratio, PATIENCE_BAR_H);

  ctx.fillStyle = 'rgba(220, 210, 195, 0.65)';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`[${c.station + 1}]`, 0, 76);
  ctx.textAlign = 'start';

  ctx.restore();
}

function drawSplash(s: Splash): void {
  const cc = stationCenter(s.station);
  const t = s.age / 0.8;
  const headY = cc.y - 60;
  if (t < 0.35) {
    const tt = t / 0.35;
    const sx = lerp(BOWL_CENTER_X, cc.x, tt);
    const sy = lerp(BOWL_CENTER_Y + BOWL_R * 0.4, headY, tt);
    ctx.strokeStyle = tempColor(s.temp);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 1 - tt * 0.4;
    ctx.beginPath();
    ctx.moveTo(BOWL_CENTER_X, BOWL_CENTER_Y + BOWL_R * 0.4);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (t > 0.3) {
    const splashT = (t - 0.3) / 0.5;
    const alpha = 1 - splashT;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tempColor(s.temp);
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI + (i / (n - 1)) * Math.PI;
      const r = 24 + splashT * (s.volume * 0.55);
      const dx = Math.cos(a) * r;
      const dy = Math.sin(a) * r * 0.9 - splashT * 6;
      ctx.beginPath();
      ctx.arc(cc.x + dx, headY + dy, 3 + (1 - splashT) * 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawFloats(): void {
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const f of floats) {
    const a = clamp(f.life, 0, 1);
    ctx.globalAlpha = a;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    ctx.fillStyle = f.color;
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillText(f.text, f.x, f.y);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'start';
}

function drawHelpBar(): void {
  ctx.fillStyle = 'rgba(220, 210, 195, 0.55)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    'Sol [H] soğuk · Sağ [J] sıcak · Müşteriye [1/2/3] tıkla · [B] boşalt',
    W / 2,
    H - 6,
  );
  ctx.textAlign = 'start';
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function draw(): void {
  drawBackground();

  const coldOn = tapHeld.cold || pointerTapHeld === 'cold';
  const hotOn = tapHeld.hot || pointerTapHeld === 'hot';
  drawTap(TAP_LEFT_X, TAP_LEFT_Y, 'cold', coldOn);
  drawTap(TAP_RIGHT_X, TAP_RIGHT_Y, 'hot', hotOn);

  drawDrops();
  drawBowl();
  drawBowlReadout();

  for (let i = 0; i < 3; i++) {
    const c = stations[i];
    if (c) drawCustomer(c);
  }

  for (const s of splashes) drawSplash(s);

  drawFloats();
  drawHelpBar();
}

// ── Loop ──
function loop(now: number, token: number): void {
  if (!gen.isCurrent(token)) return;
  if (state !== 'playing') return;
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  draw();
  rafId = requestAnimationFrame((t) => loop(t, token));
}

// ── Flow ──
function fullReset(): void {
  cancelAnimationFrame(rafId);
  gen.bump();
  stations = [null, null, null];
  spawnDelays = [0, 0, 0];
  splashes = [];
  floats = [];
  drops = [];
  bowlVolume = 0;
  bowlTemp = 50;
  bowlSwing = 0;
  bowlSwingV = 0;
  tapHeld = { cold: false, hot: false };
  pointerTapHeld = null;
  score = 0;
  elapsed = 0;
  remaining = ROUND_SECONDS;
  scoreEl.textContent = '0';
  timeEl.textContent = String(ROUND_SECONDS);
}

function startGame(): void {
  fullReset();
  state = 'playing';
  hideOverlayEl(overlay);
  spawnCustomerAt(0);
  spawnCustomerAt(1);
  spawnCustomerAt(2);
  lastTime = performance.now();
  draw();
  const token = gen.current();
  rafId = requestAnimationFrame((t) => loop(t, token));
}

function endGame(): void {
  state = 'gameover';
  cancelAnimationFrame(rafId);
  gen.bump();
  draw();
  const isBest = score > 0 && score >= best;
  overlayTitle.textContent = isBest ? 'Hamamın efendisi!' : 'Süre doldu';
  overlayMsg.innerHTML =
    `Bahşiş: <strong>${score}</strong><br>` +
    `Rekor: ${best}<br>` +
    '<small>R, Boşluk veya Enter ile tekrar dene</small>';
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  overlayBtn.focus({ preventScroll: true });
}

function resetToReady(): void {
  fullReset();
  state = 'ready';
  overlayTitle.textContent = 'Hamam Tası';
  overlayMsg.innerHTML =
    'Hamam tellakı sensin. ' +
    'Sol musluk <strong style="color:#7dd3fc">soğuk</strong>, ' +
    'sağ musluk <strong style="color:#fb7185">sıcak</strong> akıtır. ' +
    'Tası karıştırıp müşterinin termometresine yakın hararete getir; ' +
    'ardından numarasına bas ya da üzerine tıkla. ' +
    '<strong style="color:#fbbf24">Kırmızı fes</strong>li VIP\'ler özel rica eder. ' +
    '<br><small>60 saniyede en yüksek bahşişi topla.</small>';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  spawnCustomerAt(1);
  draw();
}

// ── Input ──
function canvasToWorld(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return { x: 0, y: 0 };
  const sx = W / rect.width;
  const sy = H / rect.height;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

function tapAt(x: number, y: number): TapSide | null {
  const dxL = x - TAP_LEFT_X;
  const dyL = y - TAP_LEFT_Y;
  if (dxL * dxL + dyL * dyL <= TAP_HIT_R * TAP_HIT_R) return 'cold';
  const dxR = x - TAP_RIGHT_X;
  const dyR = y - TAP_RIGHT_Y;
  if (dxR * dxR + dyR * dyR <= TAP_HIT_R * TAP_HIT_R) return 'hot';
  return null;
}

function stationAt(x: number, y: number): number {
  if (y < STATION_Y - 110 || y > H - 4) return -1;
  if (x < 0 || x >= W) return -1;
  return Math.floor(x / STATION_W);
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  canvas.setPointerCapture?.(e.pointerId);
  const p = canvasToWorld(e.clientX, e.clientY);

  const tap = tapAt(p.x, p.y);
  if (tap) {
    pointerTapHeld = tap;
    return;
  }

  const i = stationAt(p.x, p.y);
  if (i >= 0 && i < 3) {
    pourOn(i);
  }
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  if (pointerTapHeld === null) return;
  const p = canvasToWorld(e.clientX, e.clientY);
  const tap = tapAt(p.x, p.y);
  if (tap !== pointerTapHeld) {
    pointerTapHeld = null;
  }
}

function onPointerUp(e: PointerEvent): void {
  pointerTapHeld = null;
  try {
    canvas.releasePointerCapture?.(e.pointerId);
  } catch {
    // pointerId may not be captured; ignore
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    startGame();
    return;
  }
  if (state !== 'playing') {
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }
  if (e.repeat) return;
  if (k === 'h' || k === 'H' || k === 'ArrowLeft') {
    e.preventDefault();
    tapHeld.cold = true;
  } else if (k === 'j' || k === 'J' || k === 'ArrowRight') {
    e.preventDefault();
    tapHeld.hot = true;
  } else if (k === '1') {
    e.preventDefault();
    pourOn(0);
  } else if (k === '2') {
    e.preventDefault();
    pourOn(1);
  } else if (k === '3') {
    e.preventDefault();
    pourOn(2);
  } else if (k === 'b' || k === 'B') {
    e.preventDefault();
    dumpBowl();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'h' || k === 'H' || k === 'ArrowLeft') {
    tapHeld.cold = false;
  } else if (k === 'j' || k === 'J' || k === 'ArrowRight') {
    tapHeld.hot = false;
  }
}

// ── Init ──
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;
  bestEl.textContent = String(best);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  resetToReady();
}

export const game = defineGame({ init, reset: resetToReady });
