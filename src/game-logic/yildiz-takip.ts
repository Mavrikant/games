import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'yildiz-takip.best';
const SCORE_DESC = { gameId: 'yildiz-takip', storageKey: STORAGE_BEST, direction: 'higher' as const };

type State = 'ready' | 'reveal' | 'playing' | 'gameover' | 'levelup';

const W = 480;
const H = 480;
const STAR_RADIUS = 18;
const HIT_RADIUS = STAR_RADIUS + 8;
const PADDING = STAR_RADIUS + 6;
const ROUND_TIME = 15;
const REVEAL_TIME = 1.6;
const PASS_THRESHOLD = 0.7;
const MIN_SEPARATION = STAR_RADIUS * 2 + 8;
const TWO_PI = Math.PI * 2;

interface Star {
  x: number;
  y: number;
  vx: number;
  vy: number;
  twinkle: number;
  twinkleSpeed: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let accEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let level = 1;
let best = 1;
let stars: Star[] = [];
let targetIndex = 0;
let cursorX = -1000;
let cursorY = -1000;
let cursorActive = false;
let roundTimer = 0;
let revealTimer = 0;
let onTargetTime = 0;
let totalActiveTime = 0;
let lastFrame = 0;
let rafId: number | null = null;

function starCountForLevel(lv: number): number {
  return Math.min(14, 3 + lv);
}

function speedForLevel(lv: number): number {
  return 60 + (lv - 1) * 12;
}

function setLevel(v: number): void {
  level = v;
  levelEl.textContent = String(level);
}

function setBest(v: number): void {
  best = v;
  bestEl.textContent = String(best);
}

function setAccDisplay(pct: number): void {
  accEl.textContent = `${Math.round(pct * 100)}%`;
}

function setTimeDisplay(v: number): void {
  timeEl.textContent = String(Math.max(0, Math.ceil(v)));
}

function setOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = btn;
  showOverlayEl(overlay);
}

function clearOverlay(): void {
  hideOverlayEl(overlay);
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function farEnough(x: number, y: number, list: Star[]): boolean {
  for (const s of list) {
    const dx = s.x - x;
    const dy = s.y - y;
    if (dx * dx + dy * dy < MIN_SEPARATION * MIN_SEPARATION) return false;
  }
  return true;
}

function spawnStars(): void {
  const n = starCountForLevel(level);
  const speed = speedForLevel(level);
  stars = [];
  let attempts = 0;
  while (stars.length < n && attempts < 400) {
    const x = randRange(PADDING, W - PADDING);
    const y = randRange(PADDING, H - PADDING);
    if (farEnough(x, y, stars)) {
      const dir = randRange(0, TWO_PI);
      stars.push({
        x,
        y,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        twinkle: Math.random(),
        twinkleSpeed: randRange(1.2, 2.4),
      });
    }
    attempts++;
  }
  targetIndex = Math.floor(Math.random() * stars.length);
}

function commitBest(reached: number): void {
  if (reached > best) {
    setBest(reached);
    safeWrite(STORAGE_BEST, reached);
  }
}

function startRound(): void {
  spawnStars();
  roundTimer = ROUND_TIME;
  revealTimer = REVEAL_TIME;
  onTargetTime = 0;
  totalActiveTime = 0;
  setAccDisplay(0);
  setTimeDisplay(ROUND_TIME);
  state = 'reveal';
  clearOverlay();
  ensureLoop();
}

function nextLevel(): void {
  setLevel(level + 1);
  startRound();
}

function startGame(): void {
  setLevel(1);
  startRound();
}

function endRound(success: boolean): void {
  if (success) {
    commitBest(level + 1);
    state = 'levelup';
    setOverlay(
      `Seviye ${level} geçti!`,
      `İsabet oranın yeterli. Seviye ${level + 1}'de yıldız sayısı ve hızı artıyor.`,
      'Sıradaki seviye',
    );
  } else {
    commitBest(level);
    reportGameOver(SCORE_DESC, level, { label: 'Seviye' });
    const pct = totalActiveTime > 0 ? onTargetTime / totalActiveTime : 0;
    state = 'gameover';
    setOverlay(
      `Seviye ${level}: %${Math.round(pct * 100)}`,
      `Hedef %70'di. Cursorun aktif olduğu sürenin bu kadarında doğru yıldızdaydın. Tekrar dene.`,
      'Yeniden başla',
    );
  }
}

function reset(): void {
  stopLoop();
  state = 'ready';
  setLevel(1);
  setAccDisplay(0);
  setTimeDisplay(ROUND_TIME);
  stars = [];
  cursorActive = false;
  setOverlay(
    'Yıldız Takibi',
    'Yeşil yanan yıldızı zihninde tut. Karıştıktan sonra fareyle (parmakla) üzerinde gez. 15 sn süresinin %70\'inde hedefte kalırsan sıradaki seviyeye geçersin.',
    'Başla',
  );
}

function stepStars(dt: number): void {
  for (const s of stars) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.x < PADDING) {
      s.x = PADDING;
      s.vx = Math.abs(s.vx);
    } else if (s.x > W - PADDING) {
      s.x = W - PADDING;
      s.vx = -Math.abs(s.vx);
    }
    if (s.y < PADDING) {
      s.y = PADDING;
      s.vy = Math.abs(s.vy);
    } else if (s.y > H - PADDING) {
      s.y = H - PADDING;
      s.vy = -Math.abs(s.vy);
    }
    s.twinkle += dt * s.twinkleSpeed;
  }
  if (state === 'playing') driftCourse(dt);
}

function driftCourse(dt: number): void {
  const base = speedForLevel(level);
  for (const s of stars) {
    const turn = randRange(-1.2, 1.2) * dt;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const nx = s.vx * cos - s.vy * sin;
    const ny = s.vx * sin + s.vy * cos;
    s.vx = nx;
    s.vy = ny;
    const mag = Math.hypot(s.vx, s.vy);
    if (mag > 0) {
      const k = base / mag;
      s.vx *= k;
      s.vy *= k;
    }
  }
}

function onCursorTarget(): boolean {
  if (!cursorActive) return false;
  const t = stars[targetIndex];
  if (!t) return false;
  const dx = t.x - cursorX;
  const dy = t.y - cursorY;
  return dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS;
}

function loop(now: number): void {
  rafId = requestAnimationFrame(loop);
  if (lastFrame === 0) lastFrame = now;
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (state === 'reveal') {
    stepStars(dt);
    revealTimer -= dt;
    if (revealTimer <= 0) {
      state = 'playing';
      lastFrame = now;
    }
  } else if (state === 'playing') {
    stepStars(dt);
    if (cursorActive) {
      totalActiveTime += dt;
      if (onCursorTarget()) onTargetTime += dt;
    }
    roundTimer -= dt;
    setTimeDisplay(roundTimer);
    const acc = totalActiveTime > 0 ? onTargetTime / totalActiveTime : 0;
    setAccDisplay(acc);
    if (roundTimer <= 0) {
      const finalAcc = totalActiveTime > 0 ? onTargetTime / totalActiveTime : 0;
      const success = totalActiveTime >= ROUND_TIME * 0.5 && finalAcc >= PASS_THRESHOLD;
      endRound(success);
      draw();
      return;
    }
  } else if (state === 'ready' || state === 'gameover' || state === 'levelup') {
    stepStars(dt);
  }

  draw();
}

function ensureLoop(): void {
  if (rafId !== null) return;
  lastFrame = 0;
  rafId = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  lastFrame = 0;
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val || fallback;
}

function drawBackground(): void {
  const bg = getCss('--yt-bg', '#05060d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(140, 160, 220, 0.18)';
  for (let i = 0; i < 60; i++) {
    const x = (i * 73 + 17) % W;
    const y = (i * 137 + 41) % H;
    ctx.fillRect(x, y, 1, 1);
  }
}

function drawTargetCursor(): void {
  if (!cursorActive) return;
  if (state !== 'playing' && state !== 'reveal') return;
  const onTarget = state === 'playing' && onCursorTarget();
  ctx.strokeStyle = onTarget ? 'rgba(110, 231, 183, 0.95)' : 'rgba(245,246,248,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cursorX, cursorY, HIT_RADIUS + 4, 0, TWO_PI);
  ctx.stroke();
}

function drawStar(s: Star, highlight: boolean, dim: boolean): void {
  const tw = 0.85 + 0.15 * Math.sin(s.twinkle * 2);
  let core: string;
  let glow: string;
  if (highlight) {
    core = '#bbf7d0';
    glow = '#22c55e';
  } else if (dim) {
    core = 'rgba(241, 245, 249, 0.55)';
    glow = 'rgba(148, 163, 184, 0.45)';
  } else {
    core = '#f1f5f9';
    glow = 'rgba(226, 232, 240, 0.7)';
  }

  ctx.shadowBlur = highlight ? 28 : 14;
  ctx.shadowColor = glow;
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(s.x, s.y, STAR_RADIUS * tw, 0, TWO_PI);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(s.x, s.y, STAR_RADIUS, 0, TWO_PI);
  ctx.stroke();
}

function drawCenterMessage(text: string, sub: string): void {
  ctx.fillStyle = 'rgba(241, 245, 249, 0.88)';
  ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, W / 2, H / 2 - 12);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(sub, W / 2, H / 2 + 14);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function draw(): void {
  drawBackground();
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]!;
    const highlight = state === 'reveal' && i === targetIndex;
    const dim = false;
    drawStar(s, highlight, dim);
  }
  drawTargetCursor();

  if (state === 'reveal') {
    drawCenterMessage('Hedefini gözle', `Karışmadan ${Math.max(0, Math.ceil(revealTimer))} sn`);
  }
}

function pointerToCanvas(evt: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((evt.clientX - rect.left) / rect.width) * W;
  const y = ((evt.clientY - rect.top) / rect.height) * H;
  return { x, y };
}

function onPointerMove(evt: PointerEvent): void {
  const p = pointerToCanvas(evt);
  cursorX = p.x;
  cursorY = p.y;
  cursorActive = true;
}

function onPointerDown(evt: PointerEvent): void {
  const p = pointerToCanvas(evt);
  cursorX = p.x;
  cursorY = p.y;
  cursorActive = true;
  if (evt.pointerType === 'touch') {
    canvas.setPointerCapture(evt.pointerId);
  }
}

function onPointerLeave(): void {
  cursorActive = false;
}

function onPointerUp(evt: PointerEvent): void {
  if (evt.pointerType === 'touch') cursorActive = false;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    handlePrimaryAction();
    e.preventDefault();
  }
}

function handlePrimaryAction(): void {
  if (state === 'ready' || state === 'gameover') {
    if (state === 'gameover') {
      setLevel(1);
    }
    startRound();
  } else if (state === 'levelup') {
    nextLevel();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  accEl = document.querySelector<HTMLElement>('#acc')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  setBest(safeRead<number>(STORAGE_BEST, 1));

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerLeave);

  startBtn.addEventListener('click', (e) => {
    e.preventDefault();
    handlePrimaryAction();
  });
  restartBtn.addEventListener('click', () => reset());
  window.addEventListener('keydown', onKey);

  reset();
  ensureLoop();
}

export const game = defineGame({ init, reset });
