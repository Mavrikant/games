import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'guve.best';

const W = 480;
const H = 480;

const CANDLE_HIT_RADIUS = 30;
const MOTH_LAND_DIST = 18;

const BASE_MOTH_SPEED = 1.25;
const LEVEL_SPEED_STEP = 0.12;
const MOTH_TURN = 0.085;
const MOTH_WOBBLE = 0.32;

const LEVEL_BASE_CANDLES = 3;
const LEVEL_MAX_CANDLES = 8;

const ROUND_TIMEOUT_MS = 15000;
const NO_LIGHT_TIMEOUT_MS = 4000;

type State = 'ready' | 'playing' | 'won' | 'gameover';

interface Candle {
  x: number;
  y: number;
  lit: boolean;
  target: boolean;
  flicker: number;
  smokeUntil: number;
}

interface Moth {
  x: number;
  y: number;
  vx: number;
  vy: number;
  wing: number;
}

const gen = createGenToken();
let state: State = 'ready';
let level = 1;
let score = 0;
let best = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let levelEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

let candles: Candle[] = [];
let moth: Moth | null = null;
let lastTickAt = 0;
let roundStartedAt = 0;
let allDarkSince: number | null = null;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined && cached !== '') return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const v = val === '' ? fallback : val;
  cssCache.set(name, v);
  return v;
}

function showOverlayWith(title: string, msg: string, btnText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = btnText;
  showOverlayEl(overlay);
}

function candleCount(forLevel: number): number {
  return Math.min(LEVEL_MAX_CANDLES, LEVEL_BASE_CANDLES + (forLevel - 1));
}

function mothSpeed(forLevel: number): number {
  return BASE_MOTH_SPEED + LEVEL_SPEED_STEP * (forLevel - 1);
}

function placeCandles(forLevel: number): void {
  const count = candleCount(forLevel);
  candles = [];
  const cx = W / 2;
  const cy = H / 2 + 20;
  const baseR = 145;
  const padding = 60;

  for (let i = 0; i < count; i++) {
    const base = -Math.PI / 2 + (i / count) * Math.PI * 2;
    const a = base + (Math.random() - 0.5) * (Math.PI / count) * 0.55;
    const r = baseR + (Math.random() - 0.5) * 36;
    let x = cx + Math.cos(a) * r;
    let y = cy + Math.sin(a) * r * 0.85;
    x = Math.max(padding, Math.min(W - padding, x));
    y = Math.max(padding + 30, Math.min(H - 90, y));
    candles.push({
      x,
      y,
      lit: true,
      target: false,
      flicker: Math.random() * Math.PI * 2,
      smokeUntil: 0,
    });
  }
  const targetIdx = Math.floor(Math.random() * candles.length);
  candles[targetIdx]!.target = true;
}

function spawnMoth(): void {
  const target = candles.find((c) => c.target)!;
  const edge = Math.floor(Math.random() * 4);
  let x = 0;
  let y = 0;
  if (edge === 0) {
    x = Math.random() * W;
    y = -16;
  } else if (edge === 1) {
    x = W + 16;
    y = Math.random() * H * 0.7;
  } else if (edge === 2) {
    x = Math.random() * W;
    y = -16;
  } else {
    x = -16;
    y = Math.random() * H * 0.7;
  }
  const initialTarget = candles.find((c) => c.lit && !c.target) ?? target;
  const dx = initialTarget.x - x;
  const dy = initialTarget.y - y;
  const len = Math.hypot(dx, dy) || 1;
  const sp = mothSpeed(level);
  moth = {
    x,
    y,
    vx: (dx / len) * sp,
    vy: (dy / len) * sp,
    wing: 0,
  };
}

function startLevel(): void {
  if (state === 'playing') return;
  gen.bump();
  state = 'playing';
  placeCandles(level);
  spawnMoth();
  const now = performance.now();
  lastTickAt = now;
  roundStartedAt = now;
  allDarkSince = null;
  levelEl.textContent = String(level);
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  hideOverlayEl(overlay);
  draw();
  loop(gen.current());
}

function reset(): void {
  gen.bump();
  state = 'ready';
  level = 1;
  score = 0;
  placeCandles(level);
  moth = null;
  allDarkSince = null;
  scoreEl.textContent = '0';
  levelEl.textContent = '1';
  bestEl.textContent = String(best);
  draw();
  showOverlayWith(
    'Güve',
    'Karanlık sahnede mavi mum hedeftir. Güve en yakın yanan muma uçar — diğer mumları söndür ki rotayı düzeltsin.',
    'Başla',
  );
}

function endRound(outcome: 'success' | 'wrong-candle' | 'lost'): void {
  if (state !== 'playing') return;
  if (outcome === 'success') {
    state = 'won';
    score++;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
    scoreEl.textContent = String(score);
    bestEl.textContent = String(best);
    showOverlayWith(
      `Seviye ${level} tamam`,
      'Güve doğru muma kondu. Sonraki seviyeye geç.',
      'Sonraki seviye',
    );
  } else {
    state = 'gameover';
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
      bestEl.textContent = String(best);
    }
    const reason =
      outcome === 'wrong-candle'
        ? 'Güve yanlış muma kondu.'
        : 'Yanan mum kalmadı, güve gece kayboldu.';
    showOverlayWith(
      'Bitti!',
      `${reason} Toplam skor: ${score}.`,
      'Tekrar dene',
    );
  }
  draw();
}

function advanceToNextLevel(): void {
  if (state !== 'won') return;
  level++;
  startLevel();
}

function clickCandle(cx: number, cy: number): void {
  if (state !== 'playing') return;
  let hit: Candle | null = null;
  let hitDist2 = CANDLE_HIT_RADIUS * CANDLE_HIT_RADIUS;
  for (const c of candles) {
    if (!c.lit) continue;
    const dx = c.x - cx;
    const dy = c.y - (cy + 6);
    const d2 = dx * dx + dy * dy;
    if (d2 < hitDist2) {
      hit = c;
      hitDist2 = d2;
    }
  }
  if (!hit) return;
  hit.lit = false;
  hit.smokeUntil = performance.now() + 700;
}

function findBrightestLit(mx: number, my: number): Candle | null {
  let bestC: Candle | null = null;
  let bestScore = -Infinity;
  for (const c of candles) {
    if (!c.lit) continue;
    const dx = c.x - mx;
    const dy = c.y - my;
    const d = Math.hypot(dx, dy) || 0.01;
    const s = 1 / (1 + d * 0.014);
    if (s > bestScore) {
      bestScore = s;
      bestC = c;
    }
  }
  return bestC;
}

function updateMoth(now: number, dt: number): void {
  if (!moth) return;
  moth.wing += dt * 0.45;

  const target = findBrightestLit(moth.x, moth.y);
  const sp = mothSpeed(level);

  if (!target) {
    if (allDarkSince === null) allDarkSince = now;
    moth.vx += (Math.random() - 0.5) * MOTH_WOBBLE * dt * 1.6;
    moth.vy += (Math.random() - 0.5) * MOTH_WOBBLE * dt * 1.6;
    moth.x += moth.vx * dt;
    moth.y += moth.vy * dt;
    if (now - allDarkSince > NO_LIGHT_TIMEOUT_MS) {
      endRound('lost');
    }
    return;
  } else {
    allDarkSince = null;
  }

  const dx = target.x - moth.x;
  const dy = target.y - moth.y;
  const len = Math.hypot(dx, dy) || 0.01;

  const desiredVx = (dx / len) * sp;
  const desiredVy = (dy / len) * sp;

  moth.vx += (desiredVx - moth.vx) * MOTH_TURN * dt;
  moth.vy += (desiredVy - moth.vy) * MOTH_TURN * dt;

  moth.vx += (Math.random() - 0.5) * MOTH_WOBBLE * dt;
  moth.vy += (Math.random() - 0.5) * MOTH_WOBBLE * dt;

  const curSp = Math.hypot(moth.vx, moth.vy);
  const cap = sp * 1.25;
  if (curSp > cap) {
    moth.vx = (moth.vx / curSp) * cap;
    moth.vy = (moth.vy / curSp) * cap;
  }

  moth.x += moth.vx * dt;
  moth.y += moth.vy * dt;

  for (const c of candles) {
    if (!c.lit) continue;
    const ddx = c.x - moth.x;
    const ddy = c.y - 6 - moth.y;
    if (ddx * ddx + ddy * ddy < MOTH_LAND_DIST * MOTH_LAND_DIST) {
      moth.x = c.x;
      moth.y = c.y - 8;
      endRound(c.target ? 'success' : 'wrong-candle');
      return;
    }
  }

  if (now - roundStartedAt > ROUND_TIMEOUT_MS) {
    endRound('lost');
  }
}

function drawNightSky(): void {
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, getCss('--guve-sky-top', '#0a0a18'));
  grd.addColorStop(1, getCss('--guve-sky-bot', '#1b1538'));
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  for (let i = 0; i < 36; i++) {
    const sx = (i * 97 + 13) % W;
    const sy = (i * 53 + 7) % (H * 0.55);
    const r = 0.6 + ((i * 31) % 13) / 24;
    ctx.fillRect(sx, sy, r, r);
  }

  const moonR = 28;
  const mx = W - 70;
  const my = 64;
  ctx.beginPath();
  ctx.fillStyle = 'rgba(245, 240, 220, 0.16)';
  ctx.arc(mx, my, moonR + 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.fillStyle = 'rgba(245, 240, 220, 0.82)';
  ctx.arc(mx, my, moonR, 0, Math.PI * 2);
  ctx.fill();
}

function drawTable(): void {
  ctx.fillStyle = getCss('--guve-table', '#2a1b12');
  ctx.fillRect(0, H - 60, W, 60);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(0, H - 60, W, 2);
}

function drawCandle(c: Candle, now: number): void {
  const baseW = 14;
  const baseH = 38;
  const bx = c.x - baseW / 2;
  const by = c.y + 4;

  ctx.fillStyle = c.target ? getCss('--guve-target-wax', '#90a8d8') : getCss('--guve-wax', '#ead9b8');
  ctx.fillRect(bx, by, baseW, baseH);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(bx + baseW - 3, by, 3, baseH);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.fillRect(c.x - 1, by - 6, 2, 6);

  if (c.lit) {
    const flick = Math.sin(now / 90 + c.flicker) * 0.5 + 0.5;
    const r = 18 + flick * 6;
    const fx = c.x;
    const fy = c.y - 12;

    const glow = ctx.createRadialGradient(fx, fy, 0, fx, fy, r * 3.4);
    const inner = c.target ? 'rgba(120, 170, 255, 0.55)' : 'rgba(255, 190, 110, 0.55)';
    glow.addColorStop(0, inner);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(fx, fy, r * 3.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = c.target
      ? getCss('--guve-target-flame-outer', '#6e9dff')
      : getCss('--guve-flame-outer', '#ff9a3a');
    ctx.ellipse(fx, fy, 5 + flick * 1.4, 9 + flick * 1.6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = c.target
      ? getCss('--guve-target-flame-inner', '#cfe1ff')
      : getCss('--guve-flame-inner', '#ffe28a');
    ctx.ellipse(fx, fy + 1, 2.4, 5 + flick, 0, 0, Math.PI * 2);
    ctx.fill();

    if (c.target) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(135, 180, 255, ${0.32 + flick * 0.22})`;
      ctx.lineWidth = 1.6;
      ctx.arc(fx, c.y - 4, 22, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    if (now < c.smokeUntil) {
      const t = (c.smokeUntil - now) / 700;
      ctx.fillStyle = `rgba(220, 220, 230, ${0.35 * t})`;
      for (let i = 0; i < 4; i++) {
        const sy = c.y - 12 - (1 - t) * 30 - i * 6;
        const sx = c.x + Math.sin((1 - t) * 3 + i) * 6;
        ctx.beginPath();
        ctx.arc(sx, sy, 3 + i, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(c.x - 1, c.y - 7, 2, 4);
  }
}

function drawMoth(): void {
  if (!moth) return;
  const ang = Math.atan2(moth.vy, moth.vx);
  const wing = Math.sin(moth.wing) * 0.5 + 0.5;
  ctx.save();
  ctx.translate(moth.x, moth.y);
  ctx.rotate(ang);

  const body = getCss('--guve-moth', '#e6dcc1');
  const wingCol = getCss('--guve-moth-wing', '#bfb59a');

  ctx.fillStyle = wingCol;
  ctx.beginPath();
  ctx.ellipse(0, -3 - wing * 2, 7, 4 + wing * 2, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 3 + wing * 2, 7, 4 + wing * 2, 0.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, 0, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(4, -0.5, 1, 1);

  ctx.restore();
}

function draw(): void {
  drawNightSky();
  drawTable();
  const now = performance.now();
  for (const c of candles) drawCandle(c, now);
  if (state !== 'ready') drawMoth();

  if (state === 'won') {
    ctx.fillStyle = 'rgba(120, 200, 255, 0.16)';
    ctx.fillRect(0, 0, W, H);
  } else if (state === 'gameover') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
    ctx.fillRect(0, 0, W, H);
  }
}

function loop(myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (state !== 'playing') return;

  const now = performance.now();
  const dt = Math.min(2.5, (now - lastTickAt) / 16.6);
  lastTickAt = now;

  updateMoth(now, dt);
  draw();

  if (state === 'playing') {
    requestAnimationFrame(() => loop(myGen));
  }
}

function freshRun(): void {
  level = 1;
  score = 0;
  scoreEl.textContent = '0';
  levelEl.textContent = '1';
  startLevel();
}

function onCanvasPress(cx: number, cy: number): void {
  if (state === 'ready' || state === 'gameover') {
    freshRun();
    return;
  }
  if (state === 'won') {
    advanceToNextLevel();
    return;
  }
  clickCandle(cx, cy);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  function pointerToCanvas(ev: PointerEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * W,
      y: ((ev.clientY - r.top) / r.height) * H,
    };
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const p = pointerToCanvas(ev);
    onCanvasPress(p.x, p.y);
    ev.preventDefault();
  });

  startBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (state === 'ready' || state === 'gameover') {
      freshRun();
    } else if (state === 'won') {
      advanceToNextLevel();
    }
  });

  restartBtn.addEventListener('click', () => {
    reset();
  });

  window.addEventListener('keydown', (ev) => {
    const k = ev.key.toLowerCase();
    if (k === ' ' || k === 'enter' || ev.code === 'Space') {
      if (state === 'ready' || state === 'gameover') {
        freshRun();
      } else if (state === 'won') {
        advanceToNextLevel();
      }
      ev.preventDefault();
    } else if (k === 'r') {
      reset();
      ev.preventDefault();
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
