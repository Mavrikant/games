import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'coban.best';
const SCORE_DESC = { gameId: 'coban', storageKey: STORAGE_BEST, direction: 'higher' as const };

type State = 'ready' | 'playing' | 'won' | 'gameover';

const WIDTH = 640;
const HEIGHT = 400;
const DOG_SPEED = 200;
const DOG_RADIUS = 9;
const SHEEP_RADIUS = 8;
const SCARE_RADIUS = 80;
const SHEEP_BASE_SPEED = 60;
const SHEEP_FLEE_SPEED = 130;
const COHESION_RADIUS = 50;
const SEPARATION_RADIUS = 18;
const PEN_W = 110;
const PEN_H = 150;

const PEN = {
  x: WIDTH - PEN_W - 8,
  y: (HEIGHT - PEN_H) / 2,
  w: PEN_W,
  h: PEN_H,
};
const GATE_Y0 = PEN.y + 24;
const GATE_Y1 = PEN.y + PEN.h - 24;

type Sheep = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  penned: boolean;
};

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let remainingEl!: HTMLElement;
let timerEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let level = 1;
let best = 1;
let dogX = 60;
let dogY = HEIGHT / 2;
const keys = new Set<string>();
let touchDir: { dx: number; dy: number } | null = null;
let sheep: Sheep[] = [];
let lastFrame = 0;
let rafHandle: number | null = null;
let timeRemaining = 0;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sheepCountForLevel(lv: number): number {
  return Math.min(3 + lv, 12);
}

function timeForLevel(lv: number): number {
  return Math.max(60 - (lv - 1) * 4, 25);
}

function setupLevel(lv: number): void {
  const count = sheepCountForLevel(lv);
  sheep = [];
  for (let i = 0; i < count; i++) {
    sheep.push({
      x: rand(80, PEN.x - 60),
      y: rand(40, HEIGHT - 40),
      vx: 0,
      vy: 0,
      penned: false,
    });
  }
  dogX = 40;
  dogY = HEIGHT / 2;
  timeRemaining = timeForLevel(lv);
}

function commitBest(): void {
  if (level > best) {
    best = level;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function updateHud(): void {
  scoreEl.textContent = String(level);
  bestEl.textContent = String(best);
  const remaining = sheep.reduce((n, s) => n + (s.penned ? 0 : 1), 0);
  remainingEl.textContent = String(remaining);
  timerEl.textContent = String(Math.max(0, Math.ceil(timeRemaining)));
}

function reset(): void {
  state = 'ready';
  level = 1;
  setupLevel(level);
  updateHud();
  draw();
  showOverlay('Çoban', 'Köpeği yön tuşlarıyla sür. Koyunlar köpekten kaçar — sağdaki ağıla yönlendir.');
  stopLoop();
}

function startPlaying(): void {
  if (state === 'playing') return;
  state = 'playing';
  hideOverlay();
  lastFrame = performance.now();
  startLoop();
}

function nextLevel(): void {
  commitBest();
  level++;
  setupLevel(level);
  updateHud();
  state = 'ready';
  draw();
  showOverlay(
    `Seviye ${level}`,
    `Bir tuşa bas — ${sheepCountForLevel(level)} koyun, ${timeForLevel(level)} saniye.`,
  );
  stopLoop();
}

function gameOver(reason: string): void {
  state = 'gameover';
  commitBest();
  reportGameOver(SCORE_DESC, level, { label: 'Seviye' });
  stopLoop();
  draw();
  showOverlay(
    'Süre doldu',
    `${reason}\nSeviye ${level} · Rekor ${best}\nR veya tıkla — yeniden başla.`,
  );
}

function startLoop(): void {
  if (rafHandle !== null) return;
  const tick = (t: number) => {
    rafHandle = null;
    if (state !== 'playing') return;
    const dt = Math.min(0.05, (t - lastFrame) / 1000);
    lastFrame = t;
    step(dt);
    draw();
    if (state === 'playing') {
      rafHandle = requestAnimationFrame(tick);
    }
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function dogInputDir(): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  if (keys.has('arrowup') || keys.has('w')) dy -= 1;
  if (keys.has('arrowdown') || keys.has('s')) dy += 1;
  if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
  if (keys.has('arrowright') || keys.has('d')) dx += 1;
  if (dx === 0 && dy === 0 && touchDir) {
    dx = touchDir.dx;
    dy = touchDir.dy;
  }
  const m = Math.hypot(dx, dy);
  if (m > 0) {
    dx /= m;
    dy /= m;
  }
  return { dx, dy };
}

function step(dt: number): void {
  const { dx, dy } = dogInputDir();
  dogX += dx * DOG_SPEED * dt;
  dogY += dy * DOG_SPEED * dt;
  if (dogX < DOG_RADIUS) dogX = DOG_RADIUS;
  if (dogY < DOG_RADIUS) dogY = DOG_RADIUS;
  if (dogX > WIDTH - DOG_RADIUS) dogX = WIDTH - DOG_RADIUS;
  if (dogY > HEIGHT - DOG_RADIUS) dogY = HEIGHT - DOG_RADIUS;

  for (let i = 0; i < sheep.length; i++) {
    const s = sheep[i]!;
    if (s.penned) {
      s.vx *= 0.92;
      s.vy *= 0.92;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      clampInsidePen(s);
      continue;
    }

    const ddx = s.x - dogX;
    const ddy = s.y - dogY;
    const dist = Math.hypot(ddx, ddy);
    let ax = 0;
    let ay = 0;

    if (dist < SCARE_RADIUS && dist > 0.0001) {
      const force = (1 - dist / SCARE_RADIUS) * 600;
      ax += (ddx / dist) * force;
      ay += (ddy / dist) * force;
    }

    let cohX = 0;
    let cohY = 0;
    let cohN = 0;
    let sepX = 0;
    let sepY = 0;
    for (let j = 0; j < sheep.length; j++) {
      if (j === i) continue;
      const o = sheep[j]!;
      if (o.penned) continue;
      const odx = o.x - s.x;
      const ody = o.y - s.y;
      const od = Math.hypot(odx, ody);
      if (od < COHESION_RADIUS && od > 0.0001) {
        cohX += o.x;
        cohY += o.y;
        cohN++;
      }
      if (od < SEPARATION_RADIUS && od > 0.0001) {
        sepX -= odx / od;
        sepY -= ody / od;
      }
    }
    if (cohN > 0) {
      const tx = cohX / cohN - s.x;
      const ty = cohY / cohN - s.y;
      const tm = Math.hypot(tx, ty);
      if (tm > 0.0001) {
        ax += (tx / tm) * 60;
        ay += (ty / tm) * 60;
      }
    }
    ax += sepX * 200;
    ay += sepY * 200;

    if (dist > SCARE_RADIUS * 1.2 && s.x > PEN.x - 140) {
      const gx = PEN.x;
      const gy = (GATE_Y0 + GATE_Y1) / 2;
      const tx = gx - s.x;
      const ty = gy - s.y;
      const tm = Math.hypot(tx, ty);
      if (tm > 0.0001) {
        ax += (tx / tm) * 20;
        ay += (ty / tm) * 20;
      }
    }

    ax += (Math.random() - 0.5) * 40;
    ay += (Math.random() - 0.5) * 40;

    s.vx += ax * dt;
    s.vy += ay * dt;

    const speedCap = dist < SCARE_RADIUS ? SHEEP_FLEE_SPEED : SHEEP_BASE_SPEED;
    const sp = Math.hypot(s.vx, s.vy);
    if (sp > speedCap) {
      s.vx = (s.vx / sp) * speedCap;
      s.vy = (s.vy / sp) * speedCap;
    }

    s.vx *= 0.94;
    s.vy *= 0.94;

    s.x += s.vx * dt;
    s.y += s.vy * dt;

    if (s.x < SHEEP_RADIUS) {
      s.x = SHEEP_RADIUS;
      s.vx = Math.abs(s.vx);
    }
    if (s.y < SHEEP_RADIUS) {
      s.y = SHEEP_RADIUS;
      s.vy = Math.abs(s.vy);
    }
    if (s.x > WIDTH - SHEEP_RADIUS) {
      s.x = WIDTH - SHEEP_RADIUS;
      s.vx = -Math.abs(s.vx);
    }
    if (s.y > HEIGHT - SHEEP_RADIUS) {
      s.y = HEIGHT - SHEEP_RADIUS;
      s.vy = -Math.abs(s.vy);
    }

    collidePenWalls(s);

    if (
      s.x >= PEN.x + SHEEP_RADIUS &&
      s.x <= PEN.x + PEN.w - SHEEP_RADIUS &&
      s.y >= PEN.y + SHEEP_RADIUS &&
      s.y <= PEN.y + PEN.h - SHEEP_RADIUS
    ) {
      s.penned = true;
    }
  }

  timeRemaining -= dt;
  updateHud();

  if (sheep.every((s) => s.penned)) {
    state = 'won';
    stopLoop();
    draw();
    showOverlay(
      'Sürü ağılda!',
      `Seviye ${level} tamam. Bir tuşa bas veya tıkla — seviye ${level + 1}.`,
    );
    return;
  }
  if (timeRemaining <= 0) {
    const inside = sheep.filter((s) => s.penned).length;
    gameOver(`${inside}/${sheep.length} koyun ağıla girdi.`);
  }
}

function clampInsidePen(s: Sheep): void {
  if (s.x < PEN.x + SHEEP_RADIUS) {
    s.x = PEN.x + SHEEP_RADIUS;
    s.vx = Math.abs(s.vx) * 0.5;
  }
  if (s.x > PEN.x + PEN.w - SHEEP_RADIUS) {
    s.x = PEN.x + PEN.w - SHEEP_RADIUS;
    s.vx = -Math.abs(s.vx) * 0.5;
  }
  if (s.y < PEN.y + SHEEP_RADIUS) {
    s.y = PEN.y + SHEEP_RADIUS;
    s.vy = Math.abs(s.vy) * 0.5;
  }
  if (s.y > PEN.y + PEN.h - SHEEP_RADIUS) {
    s.y = PEN.y + PEN.h - SHEEP_RADIUS;
    s.vy = -Math.abs(s.vy) * 0.5;
  }
}

function collidePenWalls(s: Sheep): void {
  // top wall
  if (
    s.y + SHEEP_RADIUS > PEN.y &&
    s.y - SHEEP_RADIUS < PEN.y + 4 &&
    s.x > PEN.x - SHEEP_RADIUS &&
    s.x < PEN.x + PEN.w + SHEEP_RADIUS
  ) {
    if (s.vy > 0) {
      s.y = PEN.y - SHEEP_RADIUS;
      s.vy = -s.vy * 0.5;
    }
  }
  // bottom wall
  if (
    s.y - SHEEP_RADIUS < PEN.y + PEN.h &&
    s.y + SHEEP_RADIUS > PEN.y + PEN.h - 4 &&
    s.x > PEN.x - SHEEP_RADIUS &&
    s.x < PEN.x + PEN.w + SHEEP_RADIUS
  ) {
    if (s.vy < 0) {
      s.y = PEN.y + PEN.h + SHEEP_RADIUS;
      s.vy = -s.vy * 0.5;
    }
  }
  // right wall (closed)
  if (
    s.x - SHEEP_RADIUS < PEN.x + PEN.w &&
    s.x + SHEEP_RADIUS > PEN.x + PEN.w - 4 &&
    s.y > PEN.y - SHEEP_RADIUS &&
    s.y < PEN.y + PEN.h + SHEEP_RADIUS
  ) {
    if (s.vx > 0 && s.x > PEN.x + PEN.w / 2) {
      s.x = PEN.x + PEN.w - SHEEP_RADIUS;
      s.vx = -Math.abs(s.vx) * 0.5;
    }
  }
  // left wall — open only at gate
  if (
    s.x + SHEEP_RADIUS > PEN.x &&
    s.x - SHEEP_RADIUS < PEN.x + 4
  ) {
    const inGate = s.y > GATE_Y0 && s.y < GATE_Y1;
    if (!inGate) {
      if (s.vx > 0 && s.x < PEN.x) {
        s.x = PEN.x - SHEEP_RADIUS;
        s.vx = -Math.abs(s.vx) * 0.5;
      } else if (s.vx < 0 && s.x > PEN.x) {
        s.x = PEN.x + SHEEP_RADIUS;
        s.vx = Math.abs(s.vx) * 0.5;
      }
    }
  }
}

const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val =
    getComputedStyle(document.documentElement).getPropertyValue(varName).trim() ||
    fallback;
  cssCache.set(varName, val);
  return val;
}

function draw(): void {
  ctx.fillStyle = getCss('--coban-grass', '#1f2a1f');
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = getCss('--coban-tuft', '#2a3a2a');
  for (let i = 0; i < 40; i++) {
    const x = (i * 113) % WIDTH;
    const y = (i * 71) % HEIGHT;
    ctx.fillRect(x, y, 2, 2);
  }

  ctx.strokeStyle = getCss('--coban-fence', '#a87a3c');
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(PEN.x, PEN.y);
  ctx.lineTo(PEN.x + PEN.w, PEN.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(PEN.x, PEN.y + PEN.h);
  ctx.lineTo(PEN.x + PEN.w, PEN.y + PEN.h);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(PEN.x + PEN.w, PEN.y);
  ctx.lineTo(PEN.x + PEN.w, PEN.y + PEN.h);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(PEN.x, PEN.y);
  ctx.lineTo(PEN.x, GATE_Y0);
  ctx.moveTo(PEN.x, GATE_Y1);
  ctx.lineTo(PEN.x, PEN.y + PEN.h);
  ctx.stroke();

  ctx.fillStyle = getCss('--coban-gate', 'rgba(110, 231, 183, 0.18)');
  ctx.fillRect(PEN.x - 2, GATE_Y0, 4, GATE_Y1 - GATE_Y0);

  ctx.fillStyle = getCss('--coban-pen', 'rgba(168, 122, 60, 0.08)');
  ctx.fillRect(PEN.x, PEN.y, PEN.w, PEN.h);

  if (state === 'playing') {
    ctx.beginPath();
    ctx.arc(dogX, dogY, SCARE_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = getCss('--coban-scare', 'rgba(248, 113, 113, 0.18)');
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (const s of sheep) {
    drawSheep(s);
  }

  drawDog(dogX, dogY);
}

function drawSheep(s: Sheep): void {
  const body = s.penned
    ? getCss('--coban-sheep-pen', '#d4d4d8')
    : getCss('--coban-sheep', '#f4f4f5');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(s.x, s.y, SHEEP_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  const hx = s.x + (s.vx >= 0 ? 5 : -5);
  ctx.fillStyle = getCss('--coban-sheep-head', '#27272a');
  ctx.beginPath();
  ctx.arc(hx, s.y - 1, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawDog(x: number, y: number): void {
  ctx.fillStyle = getCss('--coban-dog', '#0f172a');
  ctx.beginPath();
  ctx.arc(x, y, DOG_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = getCss('--coban-dog-mark', '#f59e0b');
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  const movementKey =
    k === 'arrowup' ||
    k === 'arrowdown' ||
    k === 'arrowleft' ||
    k === 'arrowright' ||
    k === 'w' ||
    k === 'a' ||
    k === 's' ||
    k === 'd' ||
    k === ' ' ||
    k === 'enter';
  if (!movementKey) return;
  e.preventDefault();

  if (state === 'won') {
    nextLevel();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }

  const trackable =
    k === 'arrowup' ||
    k === 'arrowdown' ||
    k === 'arrowleft' ||
    k === 'arrowright' ||
    k === 'w' ||
    k === 'a' ||
    k === 's' ||
    k === 'd';
  if (trackable) keys.add(k);

  if (state === 'ready') startPlaying();
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  keys.delete(k);
}

function bindTouch(): void {
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const dir = btn.dataset.dir;
    const setDir = (active: boolean) => {
      if (!dir) return;
      if (active) {
        if (dir === 'up') touchDir = { dx: 0, dy: -1 };
        else if (dir === 'down') touchDir = { dx: 0, dy: 1 };
        else if (dir === 'left') touchDir = { dx: -1, dy: 0 };
        else if (dir === 'right') touchDir = { dx: 1, dy: 0 };
        if (state === 'won') nextLevel();
        else if (state === 'gameover') reset();
        else if (state === 'ready') startPlaying();
      } else {
        touchDir = null;
      }
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      setDir(true);
    });
    btn.addEventListener('pointerup', () => setDir(false));
    btn.addEventListener('pointerleave', () => setDir(false));
    btn.addEventListener('pointercancel', () => setDir(false));
  });
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  remainingEl = document.querySelector<HTMLElement>('#remaining')!;
  timerEl = document.querySelector<HTMLElement>('#timer')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 1);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  restartBtn.addEventListener('click', reset);
  overlay.addEventListener('click', () => {
    if (state === 'won') nextLevel();
    else if (state === 'ready') startPlaying();
    else if (state === 'gameover') reset();
  });

  bindTouch();
  reset();
}

export const game = defineGame({ init, reset });
