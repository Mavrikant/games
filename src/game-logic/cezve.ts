import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'cezve.best';
const START_LIVES = 3;

const FOAM_SPEED_BASE = 0.022;
const FOAM_SPEED_PER_LEVEL = 0.0014;
const FOAM_SPEED_MAX = 0.07;
const SWEET_CENTER = 80;
const SWEET_BAND_BASE = 18;
const SWEET_BAND_MIN = 8;
const SWEET_BAND_STEP = 0.6;
const DANGER = 100;
const RESULT_FLASH_MS = 900;

type State = 'ready' | 'playing' | 'gameover';
type Result = '' | 'good' | 'early' | 'over';

interface Bubble {
  x: number;
  yOffset: number;
  r: number;
  life: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let lives = START_LIVES;
let foam = 0;
let bubbles: Bubble[] = [];
let lastFrame = 0;
let timeAcc = 0;
let lastResult: Result = '';
let lastResultTime = 0;

const CZ_CENTER_X = 240;
const CZ_TOP = 130;
const CZ_NECK_W = 92;
const CZ_BODY_TOP_W = 132;
const CZ_BODY_BOTTOM_W = 108;
const CZ_NECK_H = 22;
const CZ_BODY_H = 220;

function foamSpeed(): number {
  return Math.min(FOAM_SPEED_MAX, FOAM_SPEED_BASE + score * FOAM_SPEED_PER_LEVEL);
}

function sweetBand(): { min: number; max: number } {
  const band = Math.max(SWEET_BAND_MIN, SWEET_BAND_BASE - score * SWEET_BAND_STEP);
  return { min: SWEET_CENTER - band / 2, max: SWEET_CENTER + band / 2 };
}

function updateBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  bestEl.textContent = String(best);
}

function newCezve(): void {
  foam = 0;
  bubbles = [];
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Cezve';
  overlayMsg.textContent =
    'Köpük yeşil banda gelince ocaktan al.\nErken alma — çiğ kalır.\nGeç kalma — taşar.\nBaşlamak için tıkla / Boşluk.';
  showOverlay(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Ocak Kapandı';
  overlayMsg.textContent =
    `${score} kahve pişirdin.\nRekor: ${best}\nTekrar için tıkla / R.`;
  showOverlay(overlay);
}

function reset(): void {
  state = 'ready';
  score = 0;
  lives = START_LIVES;
  scoreEl.textContent = '0';
  livesEl.textContent = String(lives);
  bestEl.textContent = String(best);
  newCezve();
  lastResult = '';
  showReadyOverlay();
  draw();
}

function startGame(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay(overlay);
  newCezve();
  lastFrame = performance.now();
}

function endGame(): void {
  state = 'gameover';
  updateBest();
  showGameOverOverlay();
}

function recordResult(kind: Result): void {
  lastResult = kind;
  lastResultTime = performance.now();
}

function attemptServe(): void {
  if (state !== 'playing') return;
  const { min, max } = sweetBand();
  if (foam < min) {
    lives--;
    recordResult('early');
  } else if (foam > max) {
    lives--;
    recordResult('over');
  } else {
    score++;
    recordResult('good');
    updateBest();
  }
  scoreEl.textContent = String(score);
  livesEl.textContent = String(lives);
  if (lives <= 0) {
    endGame();
    return;
  }
  newCezve();
}

function update(dt: number): void {
  timeAcc += dt;
  foam += foamSpeed() * dt;

  if (foam > 4 && Math.random() < 0.09) {
    bubbles.push({
      x: 0.15 + Math.random() * 0.7,
      yOffset: Math.random() * 14,
      r: 1.5 + Math.random() * 2.5,
      life: 0,
    });
  }
  for (const b of bubbles) b.life += dt;
  if (bubbles.length > 60) bubbles.splice(0, bubbles.length - 60);
  bubbles = bubbles.filter((b) => b.life < 1100);

  if (foam >= DANGER) {
    lives--;
    recordResult('over');
    livesEl.textContent = String(lives);
    if (lives <= 0) {
      endGame();
      return;
    }
    newCezve();
  }
}

function loop(now: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;
  if (state === 'playing') update(dt);
  draw();
}

function draw(): void {
  ctx.fillStyle = '#100a07';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawStove();
  drawFlame();
  drawCezve();
  drawMarkers();
  drawResult();
}

function drawStove(): void {
  const y = CZ_TOP + CZ_NECK_H + CZ_BODY_H + 18;
  ctx.fillStyle = '#1d150f';
  ctx.fillRect(CZ_CENTER_X - 130, y, 260, 26);
  ctx.fillStyle = '#2b1f17';
  ctx.fillRect(CZ_CENTER_X - 130, y, 260, 5);
  ctx.fillStyle = '#0a0604';
  ctx.fillRect(CZ_CENTER_X - 116, y + 8, 232, 8);
}

function drawFlame(): void {
  const fy = CZ_TOP + CZ_NECK_H + CZ_BODY_H + 8;
  const wobble = Math.sin(timeAcc * 0.018) * 0.18 + 1;
  const g1 = ctx.createRadialGradient(
    CZ_CENTER_X,
    fy + 8,
    4,
    CZ_CENTER_X,
    fy + 8,
    110,
  );
  g1.addColorStop(0, 'rgba(255,210,80,0.95)');
  g1.addColorStop(0.35, 'rgba(245,120,40,0.7)');
  g1.addColorStop(0.75, 'rgba(180,40,20,0.35)');
  g1.addColorStop(1, 'rgba(20,8,4,0)');
  ctx.fillStyle = g1;
  ctx.beginPath();
  ctx.ellipse(CZ_CENTER_X, fy + 4, 78, 48 * wobble, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,240,160,0.55)';
  for (let i = -2; i <= 2; i++) {
    const t = timeAcc * 0.01 + i * 0.7;
    const fx = CZ_CENTER_X + i * 18;
    const fh = 14 + Math.sin(t) * 6;
    ctx.beginPath();
    ctx.ellipse(fx, fy - fh / 2, 6, fh, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function cezvePath(): void {
  const cx = CZ_CENTER_X;
  const neckTop = CZ_TOP;
  const bodyTop = CZ_TOP + CZ_NECK_H;
  const bodyBottom = bodyTop + CZ_BODY_H;
  ctx.beginPath();
  ctx.moveTo(cx - CZ_NECK_W / 2, neckTop);
  ctx.lineTo(cx + CZ_NECK_W / 2, neckTop);
  ctx.lineTo(cx + CZ_BODY_TOP_W / 2, bodyTop);
  ctx.lineTo(cx + CZ_BODY_BOTTOM_W / 2, bodyBottom);
  ctx.lineTo(cx - CZ_BODY_BOTTOM_W / 2, bodyBottom);
  ctx.lineTo(cx - CZ_BODY_TOP_W / 2, bodyTop);
  ctx.closePath();
}

function drawCezve(): void {
  const cx = CZ_CENTER_X;
  const bodyTop = CZ_TOP + CZ_NECK_H;
  const bodyBottom = bodyTop + CZ_BODY_H;

  ctx.strokeStyle = '#6a3d20';
  ctx.lineWidth = 11;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + CZ_BODY_TOP_W / 2 - 6, bodyTop + 28);
  ctx.quadraticCurveTo(
    cx + CZ_BODY_TOP_W / 2 + 60,
    bodyTop + 6,
    cx + CZ_BODY_TOP_W / 2 + 96,
    bodyTop - 4,
  );
  ctx.stroke();
  ctx.strokeStyle = '#a26737';
  ctx.lineWidth = 5;
  ctx.stroke();

  const grad = ctx.createLinearGradient(
    cx - CZ_BODY_TOP_W / 2,
    0,
    cx + CZ_BODY_TOP_W / 2,
    0,
  );
  grad.addColorStop(0, '#3e2818');
  grad.addColorStop(0.45, '#9b6a3a');
  grad.addColorStop(0.55, '#b07e44');
  grad.addColorStop(1, '#2f1d10');
  ctx.fillStyle = grad;
  cezvePath();
  ctx.fill();

  ctx.save();
  cezvePath();
  ctx.clip();

  ctx.fillStyle = '#1e0d05';
  ctx.fillRect(cx - 120, bodyTop, 240, bodyBottom - bodyTop);

  const fullInside = bodyBottom - CZ_TOP - 6;
  const foamH = (foam / 100) * (fullInside * 0.82);
  const foamTop = bodyBottom - foamH;
  const fgrad = ctx.createLinearGradient(0, foamTop - 10, 0, bodyBottom);
  fgrad.addColorStop(0, '#f6dba8');
  fgrad.addColorStop(0.35, '#d8a560');
  fgrad.addColorStop(0.75, '#7e4523');
  fgrad.addColorStop(1, '#3d1e0c');
  ctx.fillStyle = fgrad;
  ctx.beginPath();
  ctx.moveTo(cx - 120, bodyBottom);
  ctx.lineTo(cx - 120, foamTop);
  for (let x = -120; x <= 120; x += 5) {
    const y = foamTop + Math.sin(x * 0.07 + timeAcc * 0.012) * 1.6;
    ctx.lineTo(cx + x, y);
  }
  ctx.lineTo(cx + 120, foamTop);
  ctx.lineTo(cx + 120, bodyBottom);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(255,236,200,0.78)';
  for (const b of bubbles) {
    const px = cx - 110 + b.x * 220;
    const py = foamTop + b.yOffset;
    if (py > bodyBottom) continue;
    const fade = 1 - b.life / 1100;
    ctx.globalAlpha = Math.max(0, fade);
    ctx.beginPath();
    ctx.arc(px, py, b.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  ctx.strokeStyle = '#d3a06d';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - CZ_NECK_W / 2, CZ_TOP);
  ctx.lineTo(cx + CZ_NECK_W / 2, CZ_TOP);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,235,200,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - CZ_BODY_TOP_W / 2 + 8, CZ_TOP + 4);
  ctx.lineTo(cx - CZ_BODY_BOTTOM_W / 2 + 10, bodyBottom - 8);
  ctx.stroke();
}

function drawMarkers(): void {
  const cx = CZ_CENTER_X;
  const bodyTop = CZ_TOP + CZ_NECK_H;
  const bodyBottom = bodyTop + CZ_BODY_H;
  const fullInside = bodyBottom - CZ_TOP - 6;
  const { min, max } = sweetBand();
  const yFor = (lvl: number) => bodyBottom - (lvl / 100) * (fullInside * 0.82);

  const minY = yFor(min);
  const maxY = yFor(max);
  const dangerY = yFor(DANGER);
  const markerX = cx + CZ_BODY_TOP_W / 2 + 32;

  ctx.strokeStyle = 'rgba(150,140,130,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(markerX, dangerY - 10);
  ctx.lineTo(markerX, bodyBottom);
  ctx.stroke();

  ctx.fillStyle = 'rgba(120,220,130,0.22)';
  ctx.fillRect(markerX - 7, maxY, 14, minY - maxY);
  ctx.strokeStyle = 'rgba(140,230,150,0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(markerX - 16, minY);
  ctx.lineTo(markerX + 16, minY);
  ctx.moveTo(markerX - 16, maxY);
  ctx.lineTo(markerX + 16, maxY);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(245,90,70,0.9)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(markerX - 20, dangerY);
  ctx.lineTo(markerX + 20, dangerY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(140,230,150,0.95)';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('PİŞTİ', markerX + 22, (minY + maxY) / 2);
  ctx.fillStyle = 'rgba(245,90,70,0.95)';
  ctx.fillText('TAŞAR', markerX + 22, dangerY);
}

function drawResult(): void {
  if (!lastResult) return;
  const elapsed = performance.now() - lastResultTime;
  if (elapsed > RESULT_FLASH_MS) {
    lastResult = '';
    return;
  }
  const alpha = 1 - elapsed / RESULT_FLASH_MS;
  let text = '';
  let color = '';
  if (lastResult === 'good') {
    text = '+1 PİŞTİ';
    color = '120,220,130';
  } else if (lastResult === 'early') {
    text = 'ÇİĞ!';
    color = '245,170,70';
  } else {
    text = 'TAŞTI!';
    color = '245,90,70';
  }
  ctx.fillStyle = `rgba(${color},${alpha.toFixed(3)})`;
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, CZ_CENTER_X, 70);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') startGame();
    else if (state === 'gameover') reset();
    else attemptServe();
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') startGame();
    else if (state === 'gameover') reset();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      e.preventDefault();
      reset();
      return;
    }
    if (k === ' ' || k === 'enter') {
      e.preventDefault();
      if (state === 'ready') startGame();
      else if (state === 'gameover') reset();
      else attemptServe();
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
  lastFrame = performance.now();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
