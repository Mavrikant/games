import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
type State = 'ready' | 'playing' | 'gameover';

const CANVAS_W = 480;
const CANVAS_H = 240;
const TRACK_Y = CANVAS_H / 2;
const TRACK_LEFT = 40;
const TRACK_RIGHT = CANVAS_W - 40;
const DOT_R = 14;
const ZONE_W = 80;                          // total width of target zone
const ZONE_LEFT = CANVAS_W / 2 - ZONE_W / 2;
const ZONE_RIGHT = CANVAS_W / 2 + ZONE_W / 2;
const BASE_SPEED = 2.5;
const SPEED_INC = 0.4;
const MAX_LIVES = 3;
const HITS_PER_LEVEL = 5;
const STORAGE_KEY = 'kor-tus.best';
const SCORE_DESC = { gameId: 'kor-tus', storageKey: STORAGE_KEY, direction: 'higher' as const };

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let life1!: HTMLElement;
let life2!: HTMLElement;
let life3!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

let state: State = 'ready';
let dotX = CANVAS_W / 2;
let dotDirX = 1;
let speed = BASE_SPEED;
let score = 0;
let best = 0;
let lives = MAX_LIVES;
let rafId = 0;
let flashFrames = 0;     // frames remaining for hit/miss flash
let flashHit = false;    // true=hit(green), false=miss(red)

const cssCache = new Map<string, string>();
function getCss(v: string): string {
  const c = cssCache.get(v);
  if (c !== undefined) return c;
  const val = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  cssCache.set(v, val);
  return val;
}

function updateLives(): void {
  [life1, life2, life3].forEach((el, i) => {
    el.style.opacity = i < lives ? '1' : '0.2';
  });
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  cancelAnimationFrame(rafId);
  state = 'ready';
  dotX = CANVAS_W / 2;
  dotDirX = 1;
  speed = BASE_SPEED;
  score = 0;
  lives = MAX_LIVES;
  flashFrames = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  updateLives();
  draw();
  showOverlay('Kör Tuş', 'Gösterge hedef bölgedeyken tıkla veya Boşluk\'a bas.\nBaşlamak için tıkla.');
}

function startGame(): void {
  state = 'playing';
  hideOverlay();
  rafId = requestAnimationFrame(loop);
}

function isInZone(): boolean {
  return dotX >= ZONE_LEFT + DOT_R && dotX <= ZONE_RIGHT - DOT_R;
}

function handleStrike(): void {
  if (state !== 'playing') return;
  if (isInZone()) {
    score++;
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      safeWrite(STORAGE_KEY, best);
    }
    if (score % HITS_PER_LEVEL === 0) {
      speed += SPEED_INC;
    }
    flashHit = true;
  } else {
    lives--;
    updateLives();
    flashHit = false;
    if (lives <= 0) {
      endGame();
      return;
    }
  }
  flashFrames = 18;
}

function endGame(): void {
  state = 'gameover';
  cancelAnimationFrame(rafId);
  draw();
  reportGameOver(SCORE_DESC, score);
  showOverlay('Bitti!', `Skor: ${score} · Tıkla veya R ile yeniden başla`);
}

function draw(): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Background
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Flash overlay
  if (flashFrames > 0) {
    const alpha = (flashFrames / 18) * 0.18;
    ctx.fillStyle = flashHit
      ? `rgba(80,200,100,${alpha})`
      : `rgba(220,60,60,${alpha})`;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  // Track
  const trackY = TRACK_Y;
  ctx.strokeStyle = getCss('--grid');
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(TRACK_LEFT, trackY);
  ctx.lineTo(TRACK_RIGHT, trackY);
  ctx.stroke();

  // Target zone
  const zoneAlpha = 0.18 + 0.06 * Math.sin(Date.now() / 200);
  ctx.fillStyle = `rgba(80,200,100,${zoneAlpha})`;
  ctx.fillRect(ZONE_LEFT, trackY - 24, ZONE_W, 48);
  ctx.strokeStyle = 'rgba(80,200,100,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(ZONE_LEFT, trackY - 24, ZONE_W, 48);

  // Zone label
  ctx.fillStyle = 'rgba(80,200,100,0.85)';
  ctx.font = 'bold 11px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('HEDEF', CANVAS_W / 2, trackY - 30);

  // Track end caps
  ctx.fillStyle = getCss('--grid');
  ctx.beginPath();
  ctx.arc(TRACK_LEFT, trackY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(TRACK_RIGHT, trackY, 5, 0, Math.PI * 2);
  ctx.fill();

  // Moving dot
  const dotColor = isInZone() ? '#50c864' : getCss('--food');
  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(dotX, trackY, DOT_R, 0, Math.PI * 2);
  ctx.fill();

  // Speed indicator (small text bottom right)
  ctx.fillStyle = getCss('--grid');
  ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(`Hız: ${speed.toFixed(1)}`, CANVAS_W - 8, CANVAS_H - 8);

  ctx.textAlign = 'left';
}

function loop(): void {
  if (state !== 'playing') return;
  dotX += dotDirX * speed;
  if (dotX >= TRACK_RIGHT - DOT_R) {
    dotX = TRACK_RIGHT - DOT_R;
    dotDirX = -1;
  } else if (dotX <= TRACK_LEFT + DOT_R) {
    dotX = TRACK_LEFT + DOT_R;
    dotDirX = 1;
  }
  if (flashFrames > 0) flashFrames--;
  draw();
  rafId = requestAnimationFrame(loop);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  life1 = document.querySelector<HTMLElement>('#life-1')!;
  life2 = document.querySelector<HTMLElement>('#life-2')!;
  life3 = document.querySelector<HTMLElement>('#life-3')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      if (state === 'ready') startGame();
      else if (state === 'playing') handleStrike();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      reset();
    }
  });

  // Mobile/touch input: tap on canvas or overlay acts as Space.
  const handleTap = (e: Event): void => {
    e.preventDefault();
    if (state === 'ready') startGame();
    else if (state === 'playing') handleStrike();
    else if (state === 'gameover') reset();
  };
  canvas.addEventListener('click', handleTap);
  overlay.addEventListener('click', handleTap);

  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
