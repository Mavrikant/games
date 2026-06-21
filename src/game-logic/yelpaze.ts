import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'yelpaze.best';
const W = 480;
const H = 520;
const MAX_LIVES = 3;

const SPARK_SPAWN_X = 60;
const SPARK_SPAWN_Y = 78;
const FAN_RADIUS = 78;
const FAN_FORCE_SCALE = 1.8;
const WICK_RADIUS = 14;
const SPARK_MAX_SPEED = 240;
const FLOOR_Y = H - 80;
const DEAD_Y = H - 64;
const MOUSE_VEL_CAP = 1600;

type State = 'ready' | 'playing' | 'level-clear' | 'gameover' | 'won';

interface LevelDef {
  candles: number;
  gravity: number;
  breezeAmp: number;
  breezeSpeed: number;
  label: string;
}

const LEVELS: ReadonlyArray<LevelDef> = [
  { candles: 3, gravity: 55, breezeAmp: 0, breezeSpeed: 0, label: 'Sakin gece' },
  { candles: 4, gravity: 65, breezeAmp: 18, breezeSpeed: 0.7, label: 'Hafif esinti' },
  { candles: 5, gravity: 75, breezeAmp: 28, breezeSpeed: 1.0, label: 'Esinti' },
  { candles: 6, gravity: 85, breezeAmp: 38, breezeSpeed: 1.3, label: 'Rüzgâr' },
  { candles: 7, gravity: 95, breezeAmp: 48, breezeSpeed: 1.6, label: 'Fırtına' },
];

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  target: number;
  bornAt: number;
}

interface Candle {
  x: number;
  baseY: number;
  wickY: number;
  lit: boolean;
  number: number;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let levelEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let startBtn!: HTMLButtonElement;

let state: State = 'ready';
let level = 0;
let score = 0;
let best = 0;
let lives = MAX_LIVES;
let nextCandle = 1;
let candles: Candle[] = [];
let spark: Spark | null = null;
let nextSparkAt = 0;
let breezePhase = 0;

let mouseX = W / 2;
let mouseY = H / 2;
let mouseVX = 0;
let mouseVY = 0;
let mouseInside = false;
let mouseLastMoveTime = 0;
let prevMouseX = W / 2;
let prevMouseY = H / 2;
let prevMouseTime = 0;

let rafId = 0;
let lastFrame = 0;
let flashCandle = 0;
let flashEnds = 0;

function buildCandles(n: number): Candle[] {
  const out: Candle[] = [];
  const margin = 56;
  const span = W - 2 * margin;
  const gap = n > 1 ? span / (n - 1) : 0;
  const baseY = FLOOR_Y;
  const wickY = baseY - 92;
  for (let i = 0; i < n; i++) {
    out.push({
      x: margin + gap * i,
      baseY,
      wickY,
      lit: false,
      number: i + 1,
    });
  }
  return out;
}

function spawnSpark(): void {
  spark = {
    x: SPARK_SPAWN_X,
    y: SPARK_SPAWN_Y,
    vx: 16,
    vy: 0,
    target: nextCandle,
    bornAt: performance.now(),
  };
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function renderHud(): void {
  scoreEl.textContent = String(score);
  levelEl.textContent = `${Math.min(level + 1, LEVELS.length)}/${LEVELS.length}`;
  livesEl.textContent = `${lives}/${MAX_LIVES}`;
  bestEl.textContent = String(best);
}

function showReady(): void {
  overlayTitleEl.textContent = 'Yelpaze';
  overlayMsgEl.textContent =
    'Mum fitilleri 1, 2, 3... sırayla yansın. Fareyi salla — kıvılcımı doğru muma yönlendir, yanlış muma değdirirsen veya yere düşürürsen can kaybedersin.';
  startBtn.textContent = 'Başla';
  showOverlay(overlayEl);
}

function showLevelClear(): void {
  const next = LEVELS[level + 1];
  overlayTitleEl.textContent = `Bölüm ${level + 1}/${LEVELS.length} ✓`;
  overlayMsgEl.textContent = next
    ? `${LEVELS[level]!.label} tamam. Sıradaki: ${next.label} (${next.candles} mum)`
    : 'Son bölüm hazır.';
  startBtn.textContent = 'Devam et';
  showOverlay(overlayEl);
}

function showGameOver(): void {
  overlayTitleEl.textContent = 'Mumlar yanmadı';
  overlayMsgEl.textContent = `Canın bitti. Skor: ${score}${score > 0 && score === best ? ' (yeni rekor!)' : ''}`;
  startBtn.textContent = 'Tekrar dene';
  showOverlay(overlayEl);
}

function showWon(): void {
  overlayTitleEl.textContent = 'Tören tamam';
  overlayMsgEl.textContent = `Beş bölümün hepsini bitirdin. Skor: ${score}${score > 0 && score === best ? ' (yeni rekor!)' : ''}`;
  startBtn.textContent = 'Yeniden başla';
  showOverlay(overlayEl);
}

function setupLevel(idx: number): void {
  const def = LEVELS[idx]!;
  candles = buildCandles(def.candles);
  nextCandle = 1;
  spark = null;
  breezePhase = 0;
}

function reset(): void {
  state = 'ready';
  level = 0;
  score = 0;
  lives = MAX_LIVES;
  setupLevel(0);
  renderHud();
  showReady();
  draw();
  ensureLoop();
}

function ensureLoop(): void {
  if (rafId === 0) {
    lastFrame = performance.now();
    rafId = requestAnimationFrame(loop);
  }
}

function startPlay(): void {
  if (state === 'gameover' || state === 'won') {
    reset();
  } else if (state === 'level-clear') {
    level++;
    setupLevel(level);
  }
  state = 'playing';
  hideOverlay(overlayEl);
  nextSparkAt = performance.now() + 420;
  renderHud();
  ensureLoop();
}

function loseLife(reason: 'wrong' | 'drop'): void {
  lives--;
  spark = null;
  renderHud();
  if (lives <= 0) {
    state = 'gameover';
    commitBest();
    renderHud();
    showGameOver();
    return;
  }
  nextSparkAt = performance.now() + (reason === 'wrong' ? 520 : 360);
}

function lightCandle(c: Candle): void {
  c.lit = true;
  score += 5;
  flashCandle = c.number;
  flashEnds = performance.now() + 220;
  renderHud();
  if (nextCandle >= candles.length) {
    score += 10 * (level + 1) + 5 * lives;
    commitBest();
    renderHud();
    spark = null;
    if (level + 1 >= LEVELS.length) {
      state = 'won';
      showWon();
    } else {
      state = 'level-clear';
      showLevelClear();
    }
    return;
  }
  nextCandle++;
  spark = null;
  nextSparkAt = performance.now() + 360;
}

function applyDrag(v: number, rate: number, dt: number): number {
  return v * Math.max(0, 1 - rate * dt);
}

function update(dt: number): void {
  if (state !== 'playing') return;
  const def = LEVELS[level]!;
  const now = performance.now();

  if (!spark && now >= nextSparkAt) {
    spawnSpark();
  }
  if (!spark) return;

  let windX = 0;
  let windY = 0;
  if (mouseInside && now - mouseLastMoveTime < 140) {
    const dx = spark.x - mouseX;
    const dy = spark.y - mouseY;
    const dist = Math.hypot(dx, dy);
    if (dist < FAN_RADIUS) {
      const falloff = 1 - dist / FAN_RADIUS;
      windX = mouseVX * FAN_FORCE_SCALE * falloff;
      windY = mouseVY * FAN_FORCE_SCALE * falloff;
    }
  }

  breezePhase += def.breezeSpeed * dt;
  const breezeX = def.breezeAmp * Math.sin(breezePhase);

  spark.vx += (windX + breezeX) * dt;
  spark.vy += (def.gravity + windY) * dt;

  spark.vx = applyDrag(spark.vx, 1.4, dt);
  spark.vy = applyDrag(spark.vy, 1.0, dt);

  const speed = Math.hypot(spark.vx, spark.vy);
  if (speed > SPARK_MAX_SPEED) {
    spark.vx = (spark.vx / speed) * SPARK_MAX_SPEED;
    spark.vy = (spark.vy / speed) * SPARK_MAX_SPEED;
  }

  spark.x += spark.vx * dt;
  spark.y += spark.vy * dt;

  if (spark.x < -12 || spark.x > W + 12 || spark.y > DEAD_Y) {
    loseLife('drop');
    return;
  }
  if (spark.y < -8) {
    spark.y = -8;
    spark.vy = Math.max(spark.vy, 10);
  }

  for (const c of candles) {
    if (c.lit) continue;
    const dx = spark.x - c.x;
    const dy = spark.y - c.wickY;
    if (dx * dx + dy * dy < WICK_RADIUS * WICK_RADIUS) {
      if (c.number === spark.target) {
        lightCandle(c);
      } else {
        flashCandle = -c.number;
        flashEnds = now + 220;
        loseLife('wrong');
      }
      return;
    }
  }
}

function drawBackground(): void {
  ctx.fillStyle = '#10131c';
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, 80, 20, W / 2, 80, 360);
  g.addColorStop(0, 'rgba(255, 200, 120, 0.07)');
  g.addColorStop(1, 'rgba(255, 200, 120, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(30, 26, 20, 0.6)';
  ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, FLOOR_Y);
  ctx.lineTo(W, FLOOR_Y);
  ctx.stroke();
}

function drawEmberPot(): void {
  const x = SPARK_SPAWN_X;
  const y = SPARK_SPAWN_Y;
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(x - 22, y + 2, 44, 16);
  ctx.strokeStyle = '#7a4a1a';
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 22, y + 2, 44, 16);
  const g = ctx.createRadialGradient(x, y, 2, x, y, 28);
  g.addColorStop(0, 'rgba(255, 180, 80, 0.55)');
  g.addColorStop(1, 'rgba(255, 180, 80, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, 28, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffb04a';
  ctx.beginPath();
  ctx.arc(x, y + 4, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawCandle(c: Candle, now: number): void {
  const bodyW = 22;
  const bodyTop = c.wickY + 4;
  const bodyH = c.baseY - bodyTop;
  ctx.fillStyle = c.lit ? '#f3e8c4' : '#c8bd9a';
  ctx.fillRect(c.x - bodyW / 2, bodyTop, bodyW, bodyH);
  ctx.strokeStyle = '#2a2018';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(c.x - bodyW / 2, bodyTop, bodyW, bodyH);
  ctx.strokeStyle = '#2a2018';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(c.x, bodyTop);
  ctx.lineTo(c.x, c.wickY - 4);
  ctx.stroke();
  if (c.lit) {
    const flicker = 0.85 + 0.15 * Math.sin(now / 90 + c.number);
    const flameH = 22 * flicker;
    const flameW = 6;
    ctx.fillStyle = '#ffa64a';
    ctx.beginPath();
    ctx.ellipse(c.x, c.wickY - 4 - flameH / 2, flameW, flameH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff4d6';
    ctx.beginPath();
    ctx.ellipse(c.x, c.wickY - 6 - flameH / 2, flameW * 0.45, flameH / 2 - 3, 0, 0, Math.PI * 2);
    ctx.fill();
    const gg = ctx.createRadialGradient(c.x, c.wickY - flameH / 2, 2, c.x, c.wickY - flameH / 2, 30);
    gg.addColorStop(0, 'rgba(255, 200, 120, 0.35)');
    gg.addColorStop(1, 'rgba(255, 200, 120, 0)');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.arc(c.x, c.wickY - flameH / 2, 30, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = c.lit ? '#fff4d6' : 'rgba(220, 220, 230, 0.6)';
  ctx.font = '700 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(c.number), c.x, c.baseY + 18);

  if (!c.lit && c.number === nextCandle) {
    const pulse = 0.45 + 0.35 * Math.sin(now / 200);
    ctx.strokeStyle = `rgba(140, 240, 200, ${pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c.x, c.wickY, WICK_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (flashCandle !== 0 && Math.abs(flashCandle) === c.number && now < flashEnds) {
    const a = (flashEnds - now) / 220;
    ctx.strokeStyle =
      flashCandle > 0 ? `rgba(255, 220, 120, ${a})` : `rgba(255, 90, 90, ${a})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c.x, c.wickY, WICK_RADIUS + 10 * (1 - a), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawSpark(s: Spark): void {
  const g = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, 26);
  g.addColorStop(0, 'rgba(255, 200, 120, 0.7)');
  g.addColorStop(1, 'rgba(255, 200, 120, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffe1a0';
  ctx.beginPath();
  ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0a0d14';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(s.target), s.x, s.y);
  ctx.textBaseline = 'alphabetic';
}

function drawFan(): void {
  if (!mouseInside) return;
  ctx.strokeStyle = 'rgba(140, 200, 240, 0.22)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(mouseX, mouseY, FAN_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  const speed = Math.hypot(mouseVX, mouseVY);
  if (speed > 40) {
    const len = Math.min(34, speed / 10);
    const ang = Math.atan2(mouseVY, mouseVX);
    ctx.strokeStyle = 'rgba(180, 220, 255, 0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mouseX, mouseY);
    const ex = mouseX + Math.cos(ang) * len;
    const ey = mouseY + Math.sin(ang) * len;
    ctx.lineTo(ex, ey);
    ctx.stroke();
    const ah = 7;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.45) * ah, ey - Math.sin(ang - 0.45) * ah);
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang + 0.45) * ah, ey - Math.sin(ang + 0.45) * ah);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(180, 220, 255, 0.55)';
  ctx.beginPath();
  ctx.arc(mouseX, mouseY, 5, 0, Math.PI * 2);
  ctx.fill();
}

function drawHeader(): void {
  const def = LEVELS[level] ?? LEVELS[LEVELS.length - 1]!;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${def.label}`, 16, 24);
  ctx.textAlign = 'right';
  ctx.fillText(`Sıradaki mum: ${nextCandle}`, W - 16, 24);
  ctx.textAlign = 'left';
}

function draw(): void {
  const now = performance.now();
  drawBackground();
  drawHeader();
  drawEmberPot();
  for (const c of candles) drawCandle(c, now);
  if (spark) drawSpark(spark);
  drawFan();
}

function loop(t: number): void {
  rafId = 0;
  const dt = Math.min(0.05, Math.max(0.001, (t - lastFrame) / 1000));
  lastFrame = t;

  if (t - mouseLastMoveTime > 90) {
    mouseVX *= 0.55;
    mouseVY *= 0.55;
    if (Math.hypot(mouseVX, mouseVY) < 6) {
      mouseVX = 0;
      mouseVY = 0;
    }
  }

  update(dt);
  draw();

  rafId = requestAnimationFrame(loop);
}

function handleStartInput(): void {
  if (state === 'playing') return;
  startPlay();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointermove', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * W) / r.width;
    const y = ((e.clientY - r.top) * H) / r.height;
    const now = performance.now();
    const dt = Math.max(1, now - prevMouseTime) / 1000;
    let vx = (x - prevMouseX) / dt;
    let vy = (y - prevMouseY) / dt;
    const sp = Math.hypot(vx, vy);
    if (sp > MOUSE_VEL_CAP) {
      vx = (vx / sp) * MOUSE_VEL_CAP;
      vy = (vy / sp) * MOUSE_VEL_CAP;
    }
    mouseVX = vx;
    mouseVY = vy;
    mouseX = x;
    mouseY = y;
    prevMouseX = x;
    prevMouseY = y;
    prevMouseTime = now;
    mouseInside = true;
    mouseLastMoveTime = now;
  });
  canvas.addEventListener('pointerenter', (e) => {
    const r = canvas.getBoundingClientRect();
    prevMouseX = ((e.clientX - r.left) * W) / r.width;
    prevMouseY = ((e.clientY - r.top) * H) / r.height;
    prevMouseTime = performance.now();
    mouseX = prevMouseX;
    mouseY = prevMouseY;
    mouseInside = true;
    mouseVX = 0;
    mouseVY = 0;
  });
  canvas.addEventListener('pointerleave', () => {
    mouseInside = false;
    mouseVX = 0;
    mouseVY = 0;
  });
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * W) / r.width;
    const y = ((e.clientY - r.top) * H) / r.height;
    mouseX = x;
    mouseY = y;
    prevMouseX = x;
    prevMouseY = y;
    prevMouseTime = performance.now();
    mouseInside = true;
    mouseLastMoveTime = performance.now();
    if (state !== 'playing') handleStartInput();
  });
  startBtn.addEventListener('click', (e) => {
    e.preventDefault();
    handleStartInput();
  });
  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      if (state !== 'playing') {
        e.preventDefault();
        handleStartInput();
      }
      return;
    }
    if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      reset();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
