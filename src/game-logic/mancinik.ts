import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'mancinik.best';
const SCORE_DESC = {
  gameId: 'mancinik',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

type State = 'aiming' | 'flying' | 'between' | 'gameover';

const W = 480;
const H = 320;
const GROUND_Y = 262;
const PIVOT_X = 64;
const PIVOT_Y = 230;
const ARM_LEN = 46;
const G = 460;

const POWERS = [240, 320, 410] as const;
const POWER_LABELS = ['Hafif', 'Orta', 'Ağır'] as const;

const SHOTS_PER_ROUND = 10;
const MIN_ANGLE = 14;
const MAX_ANGLE = 82;
const AIM_SPEED = 105;

const TARGET_MIN_DIST = 140;
const TARGET_MAX_DIST = 380;
const TARGET_HALF = 28;
const BULLS_HALF = 9;

const gen = createGenToken();

let state: State = 'aiming';
let score = 0;
let best = 0;
let shotsLeft = SHOTS_PER_ROUND;
let powerLevel = 1;
let currentAngle = MIN_ANGLE;
let aimDir = 1;
let wind = 0;
let target = { x: 280 };

let proj: { x: number; y: number; vx: number; vy: number } | null = null;
const trail: { x: number; y: number }[] = [];
let landMark: { x: number; result: 'bull' | 'hit' | 'miss'; addedAt: number } | null = null;
let betweenUntil = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let shotsEl!: HTMLElement;
let powerLabelEl!: HTMLElement;
let powerBtns!: HTMLButtonElement[];
let fireBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let rafId: number | null = null;
let lastT = 0;

function pickTarget(): void {
  target = {
    x: PIVOT_X + TARGET_MIN_DIST + Math.random() * (TARGET_MAX_DIST - TARGET_MIN_DIST),
  };
  wind = Math.round((Math.random() - 0.5) * 80);
}

function syncHUD(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  shotsEl.textContent = String(shotsLeft);
  powerLabelEl.textContent = POWER_LABELS[powerLevel]!;
  powerBtns.forEach((btn, i) => {
    btn.classList.toggle('is-active', i === powerLevel);
  });
  fireBtn.disabled = state !== 'aiming';
}

function reset(): void {
  gen.bump();
  state = 'aiming';
  score = 0;
  shotsLeft = SHOTS_PER_ROUND;
  powerLevel = 1;
  currentAngle = MIN_ANGLE + (MAX_ANGLE - MIN_ANGLE) * 0.5;
  aimDir = 1;
  proj = null;
  trail.length = 0;
  landMark = null;
  betweenUntil = 0;
  pickTarget();
  hideOverlayEl(overlay);
  syncHUD();
  draw();
  startLoop();
}

function startLoop(): void {
  if (rafId !== null) return;
  lastT = performance.now();
  const token = gen.current();
  const tick = (now: number): void => {
    if (!gen.isCurrent(token)) {
      rafId = null;
      return;
    }
    const dt = Math.min(0.04, (now - lastT) / 1000);
    lastT = now;
    update(dt);
    draw();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function update(dt: number): void {
  if (state === 'aiming') {
    currentAngle += aimDir * AIM_SPEED * dt;
    if (currentAngle >= MAX_ANGLE) {
      currentAngle = MAX_ANGLE;
      aimDir = -1;
    } else if (currentAngle <= MIN_ANGLE) {
      currentAngle = MIN_ANGLE;
      aimDir = 1;
    }
    return;
  }
  if (state === 'flying' && proj) {
    proj.vy += G * dt;
    proj.vx += wind * dt * 0.55;
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    trail.push({ x: proj.x, y: proj.y });
    if (trail.length > 60) trail.shift();
    if (proj.y >= GROUND_Y || proj.x < -20 || proj.x > W + 20) {
      const landX = proj.x;
      land(landX);
    }
    return;
  }
  if (state === 'between') {
    if (performance.now() >= betweenUntil) {
      shotsLeft -= 1;
      if (shotsLeft <= 0) {
        endGame();
        return;
      }
      proj = null;
      trail.length = 0;
      landMark = null;
      pickTarget();
      state = 'aiming';
      aimDir = 1;
      currentAngle = MIN_ANGLE;
      syncHUD();
    }
  }
}

function fire(): void {
  if (state !== 'aiming') return;
  const ang = (currentAngle * Math.PI) / 180;
  const speed = POWERS[powerLevel]!;
  const startX = PIVOT_X + ARM_LEN * Math.cos(ang);
  const startY = PIVOT_Y - ARM_LEN * Math.sin(ang);
  proj = {
    x: startX,
    y: startY,
    vx: speed * Math.cos(ang),
    vy: -speed * Math.sin(ang),
  };
  trail.length = 0;
  state = 'flying';
  syncHUD();
}

function land(x: number): void {
  const dx = Math.abs(x - target.x);
  let result: 'bull' | 'hit' | 'miss';
  let pts = 0;
  if (x < PIVOT_X || x > W) {
    result = 'miss';
  } else if (dx < BULLS_HALF) {
    result = 'bull';
    pts = 3;
  } else if (dx < TARGET_HALF) {
    result = 'hit';
    pts = 1;
  } else {
    result = 'miss';
  }
  score += pts;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  const clampedX = Math.max(8, Math.min(W - 8, x));
  landMark = { x: clampedX, result, addedAt: performance.now() };
  state = 'between';
  betweenUntil = performance.now() + 1100;
  syncHUD();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  reportGameOver(SCORE_DESC, score);
  overlayTitle.textContent = 'Tur bitti';
  const stars = '★'.repeat(Math.min(3, Math.floor(score / 10))) || '—';
  overlayMsg.textContent = `Skor: ${score} / ${SHOTS_PER_ROUND * 3}  ${stars}\nEn iyi: ${best}\nR veya Yeniden başla ile yeni tur`;
  showOverlayEl(overlay);
  syncHUD();
}

// ---------- Drawing ----------

function draw(): void {
  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, '#0c1424');
  sky.addColorStop(1, '#23344f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, GROUND_Y);

  // Stars (decorative, deterministic)
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  for (let i = 0; i < 14; i++) {
    const x = (i * 53) % W;
    const y = (i * 17) % 80;
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  // Mountains far
  ctx.fillStyle = '#1a2335';
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(60, 200);
  ctx.lineTo(140, 220);
  ctx.lineTo(220, 195);
  ctx.lineTo(310, 215);
  ctx.lineTo(390, 200);
  ctx.lineTo(W, 220);
  ctx.lineTo(W, GROUND_Y);
  ctx.closePath();
  ctx.fill();

  // Ground
  ctx.fillStyle = '#3c2a18';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.fillStyle = '#5b7a3e';
  ctx.fillRect(0, GROUND_Y, W, 3);

  // Wind banner
  drawWindBar();

  // Castle silhouette behind target (visual context)
  drawCastle();

  // Target band
  drawTarget();

  // Trebuchet
  drawTrebuchet();

  // Trail
  if (trail.length > 1) {
    ctx.strokeStyle = 'rgba(255,225,160,0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const first = trail[0]!;
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < trail.length; i++) {
      const p = trail[i]!;
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  // Projectile
  if (proj) {
    ctx.fillStyle = '#d9c290';
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Landing mark
  if (landMark) {
    drawLandMark();
  }
}

function drawWindBar(): void {
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fillRect(0, 0, W, 22);
  ctx.fillStyle = '#cfd6e2';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('RÜZGÂR', 10, 11);

  const cx = W / 2;
  const cy = 11;
  const mag = Math.min(60, Math.abs(wind));
  const len = mag * 0.9;
  const dir = wind === 0 ? 0 : wind > 0 ? 1 : -1;
  ctx.strokeStyle = dir === 0 ? '#6e7686' : wind > 0 ? '#f59e0b' : '#60a5fa';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 2;
  if (dir === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const startX = cx - dir * (len / 2);
    const endX = cx + dir * (len / 2);
    ctx.beginPath();
    ctx.moveTo(startX, cy);
    ctx.lineTo(endX, cy);
    ctx.stroke();
    // arrowhead
    ctx.beginPath();
    ctx.moveTo(endX, cy);
    ctx.lineTo(endX - dir * 6, cy - 4);
    ctx.lineTo(endX - dir * 6, cy + 4);
    ctx.closePath();
    ctx.fill();
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = '#cfd6e2';
  ctx.fillText(
    state === 'gameover'
      ? 'Tur bitti'
      : `Açı ${currentAngle.toFixed(0)}°  ·  ${POWER_LABELS[powerLevel]}`,
    W - 10,
    11,
  );
}

function drawCastle(): void {
  const cx = target.x;
  const baseY = GROUND_Y;
  // back wall
  ctx.fillStyle = '#2c2d35';
  ctx.fillRect(cx - 56, baseY - 38, 112, 38);
  // crenellations
  for (let i = 0; i < 7; i++) {
    const x = cx - 56 + i * 16;
    ctx.fillRect(x, baseY - 46, 10, 8);
  }
  // flag pole
  ctx.fillStyle = '#444';
  ctx.fillRect(cx - 1, baseY - 66, 2, 22);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(cx + 1, baseY - 66, 10, 6);
}

function drawTarget(): void {
  const y = GROUND_Y - 2;
  // outer band
  ctx.fillStyle = 'rgba(245, 158, 11, 0.85)';
  ctx.fillRect(target.x - TARGET_HALF, y - 4, TARGET_HALF * 2, 6);
  // inner bullseye
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(target.x - BULLS_HALF, y - 6, BULLS_HALF * 2, 8);
  // center pin
  ctx.fillStyle = '#fff';
  ctx.fillRect(target.x - 1, y - 10, 2, 12);
  // distance label
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const dist = Math.round(target.x - PIVOT_X);
  ctx.fillText(`${dist}m`, target.x, y - 14);
}

function drawTrebuchet(): void {
  // Base (A-frame)
  ctx.fillStyle = '#6b4a26';
  ctx.beginPath();
  ctx.moveTo(PIVOT_X - 20, GROUND_Y);
  ctx.lineTo(PIVOT_X, PIVOT_Y);
  ctx.lineTo(PIVOT_X + 20, GROUND_Y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#3a2614';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Cross beam
  ctx.strokeStyle = '#3a2614';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PIVOT_X - 24, GROUND_Y - 8);
  ctx.lineTo(PIVOT_X + 24, GROUND_Y - 8);
  ctx.stroke();

  // Arm (rotates with current angle)
  const ang = (currentAngle * Math.PI) / 180;
  const armTipX = PIVOT_X + ARM_LEN * Math.cos(ang);
  const armTipY = PIVOT_Y - ARM_LEN * Math.sin(ang);
  const armBackX = PIVOT_X - 18 * Math.cos(ang);
  const armBackY = PIVOT_Y + 18 * Math.sin(ang);
  ctx.strokeStyle = '#8a6233';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(armBackX, armBackY);
  ctx.lineTo(armTipX, armTipY);
  ctx.stroke();

  // Counterweight (back end) — sized by powerLevel
  const cwSize = 5 + powerLevel * 2.5;
  ctx.fillStyle = ['#7a7d85', '#5a5d65', '#3c3f47'][powerLevel] ?? '#5a5d65';
  ctx.fillRect(armBackX - cwSize, armBackY - 2, cwSize * 2, cwSize * 2);
  ctx.strokeStyle = '#1c1e24';
  ctx.lineWidth = 1;
  ctx.strokeRect(armBackX - cwSize, armBackY - 2, cwSize * 2, cwSize * 2);

  // Projectile cradle (only when not flying)
  if (state !== 'flying') {
    ctx.fillStyle = '#d9c290';
    ctx.beginPath();
    ctx.arc(armTipX, armTipY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Pivot dot
  ctx.fillStyle = '#d68845';
  ctx.beginPath();
  ctx.arc(PIVOT_X, PIVOT_Y, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawLandMark(): void {
  if (!landMark) return;
  const { x, result } = landMark;
  const color = result === 'bull' ? '#ef4444' : result === 'hit' ? '#f59e0b' : '#6e7686';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 6, GROUND_Y - 6);
  ctx.lineTo(x + 6, GROUND_Y + 4);
  ctx.moveTo(x + 6, GROUND_Y - 6);
  ctx.lineTo(x - 6, GROUND_Y + 4);
  ctx.stroke();
  // banner text
  const label = result === 'bull' ? '+3 BULLSEYE' : result === 'hit' ? '+1 İSABET' : 'IŞKA';
  ctx.fillStyle = color;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, x, GROUND_Y - 18);
}

// ---------- Init ----------

function setPower(p: number): void {
  if (p < 0 || p >= POWERS.length) return;
  if (state !== 'aiming') return;
  powerLevel = p;
  syncHUD();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  shotsEl = document.querySelector<HTMLElement>('#shots')!;
  powerLabelEl = document.querySelector<HTMLElement>('#power-label')!;
  powerBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.mn-power'));
  fireBtn = document.querySelector<HTMLButtonElement>('#fire')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  powerBtns.forEach((btn, i) => {
    btn.addEventListener('click', () => setPower(i));
  });

  fireBtn.addEventListener('click', () => {
    if (state === 'aiming') fire();
  });

  restartBtn.addEventListener('click', reset);

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'aiming') fire();
    else if (state === 'gameover') reset();
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'gameover') reset();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') {
      if (state === 'aiming') fire();
      else if (state === 'gameover') reset();
      e.preventDefault();
    } else if (k === '1' || k === '2' || k === '3') {
      setPower(Number(k) - 1);
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
