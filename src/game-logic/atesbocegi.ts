import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'atesbocegi.best';

const CANVAS_W = 480;
const CANVAS_H = 600;
const SKY_H = 470;
const JAR_X1 = 168;
const JAR_X2 = 312;
const JAR_MOUTH_Y = 462;
const INITIAL_FIREFLIES = 6;
const MAX_FIREFLIES = 10;
const MIN_ACTIVE = 5;
const LANTERN_RADIUS = 150;
const LANTERN_LIFETIME_MS = 1200;
const COOLDOWN_MS = 380;
const TIME_LIMIT_MS = 60000;
const COMBO_WINDOW_MS = 1800;
const FIREFLY_RADIUS = 4.5;
const SPAWN_INTERVAL_MS = 1400;
const CATCH_ANIM_MS = 600;

type State = 'ready' | 'playing' | 'gameover';
type Firefly = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  hue: number;
  caught: boolean;
  caughtT: number;
  cx: number;
  cy: number;
};
type Lantern = { x: number; y: number; remaining: number };
type Star = { x: number; y: number; r: number };

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let caughtCount = 0;
let combo = 0;
let timeLeft = TIME_LIMIT_MS;
let lastCatchAt = -Infinity;
let cooldown = 0;
let cooldownShake = 0;
let spawnTimer = SPAWN_INTERVAL_MS;
let lastFrame = 0;
let fireflies: Firefly[] = [];
let lantern: Lantern | null = null;
let starField: Star[] = [];
let rafHandle: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timerEl!: HTMLElement;
let comboEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeFirefly(spawnFromEdge: boolean): Firefly {
  const x = spawnFromEdge
    ? Math.random() < 0.5
      ? rand(20, 120)
      : rand(CANVAS_W - 120, CANVAS_W - 20)
    : rand(40, CANVAS_W - 40);
  const y = rand(60, JAR_MOUTH_Y - 30);
  const ang = Math.random() * Math.PI * 2;
  const sp = rand(30, 55);
  return {
    x,
    y,
    vx: Math.cos(ang) * sp,
    vy: Math.sin(ang) * sp,
    phase: Math.random() * Math.PI * 2,
    hue: rand(40, 58),
    caught: false,
    caughtT: 0,
    cx: 0,
    cy: 0,
  };
}

function makeStars(): Star[] {
  const out: Star[] = [];
  for (let i = 0; i < 70; i++) {
    out.push({
      x: Math.random() * CANVAS_W,
      y: Math.random() * (SKY_H - 30),
      r: Math.random() < 0.85 ? 0.9 : 1.6,
    });
  }
  return out;
}

function activeFireflies(): number {
  let n = 0;
  for (const f of fireflies) if (!f.caught) n++;
  return n;
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  timerEl.textContent = String(Math.max(0, Math.ceil(timeLeft / 1000)));
  comboEl.textContent = combo > 0 ? `×${combo + 1}` : '–';
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Ateş Böceği';
  overlayMsg.textContent =
    'Ekrana dokun → kısa süreli ışık halkası çıkar.\nHalka menzilindeki böcekler ışığa doğru çekilir;\nalttaki kavanozun ağzına gelen yakalanır.\nArt arda yakaladıklarınla kombo bonusu kazan.\nSüre: 60 sn.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Süre Bitti';
  const fresh = score === best && best > 0;
  overlayMsg.textContent =
    `Yakalanan: ${caughtCount}\nSkor: ${score}` +
    (fresh ? '  ·  Yeni rekor!' : `\nRekor: ${best}`);
  overlayBtn.textContent = 'Tekrar dene';
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  stopRaf();
  state = 'ready';
  score = 0;
  caughtCount = 0;
  combo = 0;
  timeLeft = TIME_LIMIT_MS;
  lastCatchAt = -Infinity;
  cooldown = 0;
  cooldownShake = 0;
  spawnTimer = SPAWN_INTERVAL_MS;
  lantern = null;
  fireflies = [];
  for (let i = 0; i < INITIAL_FIREFLIES; i++) {
    fireflies.push(makeFirefly(false));
  }
  updateHud();
  draw();
  showReadyOverlay();
  startAmbientRaf();
}

function startRound(): void {
  hideOverlayEl(overlay);
  state = 'playing';
  score = 0;
  caughtCount = 0;
  combo = 0;
  timeLeft = TIME_LIMIT_MS;
  lastCatchAt = -Infinity;
  cooldown = 0;
  cooldownShake = 0;
  spawnTimer = SPAWN_INTERVAL_MS;
  lantern = null;
  fireflies = [];
  for (let i = 0; i < INITIAL_FIREFLIES; i++) {
    fireflies.push(makeFirefly(false));
  }
  updateHud();
  lastFrame = performance.now();
  stopRaf();
  startRaf();
}

function startRaf(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastFrame = performance.now();
  const loop = (t: number): void => {
    if (!gen.isCurrent(myGen)) {
      rafHandle = null;
      return;
    }
    const dt = Math.min(40, t - lastFrame);
    lastFrame = t;
    update(dt);
    draw();
    if (state === 'playing') {
      rafHandle = requestAnimationFrame(loop);
    } else {
      rafHandle = null;
    }
  };
  rafHandle = requestAnimationFrame(loop);
}

function startAmbientRaf(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastFrame = performance.now();
  const loop = (t: number): void => {
    if (!gen.isCurrent(myGen)) {
      rafHandle = null;
      return;
    }
    const dt = Math.min(40, t - lastFrame);
    lastFrame = t;
    if (state === 'ready') {
      ambientUpdate(dt);
      draw();
      rafHandle = requestAnimationFrame(loop);
    } else {
      rafHandle = null;
    }
  };
  rafHandle = requestAnimationFrame(loop);
}

function stopRaf(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function ambientUpdate(dt: number): void {
  for (const f of fireflies) {
    f.phase += dt * 0.005;
    f.vx += (Math.random() - 0.5) * 8;
    f.vy += (Math.random() - 0.5) * 8;
    const sp = Math.hypot(f.vx, f.vy);
    if (sp > 70) {
      f.vx = (f.vx / sp) * 70;
      f.vy = (f.vy / sp) * 70;
    }
    f.vx *= 0.985;
    f.vy *= 0.985;
    f.x += f.vx * (dt / 1000);
    f.y += f.vy * (dt / 1000);
    if (f.x < 12) {
      f.x = 12;
      f.vx = Math.abs(f.vx);
    }
    if (f.x > CANVAS_W - 12) {
      f.x = CANVAS_W - 12;
      f.vx = -Math.abs(f.vx);
    }
    if (f.y < 12) {
      f.y = 12;
      f.vy = Math.abs(f.vy);
    }
    if (f.y > SKY_H - 30) {
      f.y = SKY_H - 30;
      f.vy = -Math.abs(f.vy);
    }
  }
}

function update(dt: number): void {
  if (state !== 'playing') return;

  timeLeft -= dt;
  cooldown = Math.max(0, cooldown - dt);
  cooldownShake = Math.max(0, cooldownShake - dt);
  spawnTimer -= dt;

  if (lantern) {
    lantern.remaining -= dt;
    if (lantern.remaining <= 0) lantern = null;
  }

  if (combo > 0 && performance.now() - lastCatchAt > COMBO_WINDOW_MS) {
    combo = 0;
  }

  for (const f of fireflies) {
    if (f.caught) {
      f.caughtT = Math.min(1, f.caughtT + dt / CATCH_ANIM_MS);
      continue;
    }

    f.phase += dt * 0.005;
    let inRange = false;
    if (lantern && lantern.remaining > 0) {
      const dx = lantern.x - f.x;
      const dy = lantern.y - f.y;
      const dist = Math.hypot(dx, dy);
      const lanternInJar =
        lantern.x >= JAR_X1 &&
        lantern.x <= JAR_X2 &&
        lantern.y >= JAR_MOUTH_Y - 8;
      if (dist < LANTERN_RADIUS) {
        inRange = true;
        if (lanternInJar && dist < 28) {
          f.caught = true;
          f.caughtT = 0;
          f.cx = f.x;
          f.cy = f.y;
          catchFirefly();
          continue;
        }
        if (dist > 0.5) {
          const fade = lantern.remaining / LANTERN_LIFETIME_MS;
          const edgeBoost = 0.45 + 0.55 * (1 - dist / LANTERN_RADIUS);
          const pull = 1100 * fade * edgeBoost;
          f.vx += (dx / dist) * pull * (dt / 1000);
          f.vy += (dy / dist) * pull * (dt / 1000);
        }
      }
    }

    const wanderAmp = inRange ? 4 : 18;
    f.vx += (Math.random() - 0.5) * wanderAmp;
    f.vy += (Math.random() - 0.5) * wanderAmp;

    const sp = Math.hypot(f.vx, f.vy);
    const maxSpeed = inRange ? 220 : 130;
    if (sp > maxSpeed) {
      f.vx = (f.vx / sp) * maxSpeed;
      f.vy = (f.vy / sp) * maxSpeed;
    }
    f.vx *= 0.985;
    f.vy *= 0.985;

    f.x += f.vx * (dt / 1000);
    f.y += f.vy * (dt / 1000);

    if (f.x < FIREFLY_RADIUS) {
      f.x = FIREFLY_RADIUS;
      f.vx = Math.abs(f.vx);
    }
    if (f.x > CANVAS_W - FIREFLY_RADIUS) {
      f.x = CANVAS_W - FIREFLY_RADIUS;
      f.vx = -Math.abs(f.vx);
    }
    if (f.y < FIREFLY_RADIUS) {
      f.y = FIREFLY_RADIUS;
      f.vy = Math.abs(f.vy);
    }

    if (f.y >= JAR_MOUTH_Y) {
      if (f.x >= JAR_X1 && f.x <= JAR_X2) {
        f.caught = true;
        f.caughtT = 0;
        f.cx = f.x;
        f.cy = f.y;
        catchFirefly();
      } else {
        f.y = JAR_MOUTH_Y - 0.5;
        f.vy = -Math.abs(f.vy) - 10;
      }
    }
  }

  fireflies = fireflies.filter((f) => !(f.caught && f.caughtT >= 1));

  if (
    spawnTimer <= 0 &&
    activeFireflies() < MAX_FIREFLIES
  ) {
    fireflies.push(makeFirefly(true));
    spawnTimer = SPAWN_INTERVAL_MS;
  }
  while (activeFireflies() < MIN_ACTIVE) {
    fireflies.push(makeFirefly(true));
  }

  updateHud();

  if (timeLeft <= 0) {
    timeLeft = 0;
    finishRound();
  }
}

function catchFirefly(): void {
  const now = performance.now();
  if (now - lastCatchAt < COMBO_WINDOW_MS) {
    combo += 1;
  } else {
    combo = 0;
  }
  lastCatchAt = now;
  caughtCount += 1;
  score += 1 + combo;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function finishRound(): void {
  state = 'gameover';
  stopRaf();
  updateHud();
  draw();
  showGameOverOverlay();
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  const grad = ctx.createLinearGradient(0, 0, 0, SKY_H);
  grad.addColorStop(0, '#0a1130');
  grad.addColorStop(1, '#1b134a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, SKY_H);

  ctx.fillStyle = '#070818';
  ctx.fillRect(0, SKY_H, w, h - SKY_H);

  for (const s of starField) {
    ctx.fillStyle = `rgba(255,255,255,${s.r > 1 ? 0.9 : 0.5})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let g = 0; g < 4; g++) {
    const gy = SKY_H - 4 - g * 8;
    ctx.strokeStyle = `rgba(120, 200, 140, ${0.18 - g * 0.04})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const yy = gy + Math.sin((x + g * 30) * 0.05) * 1.5;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }

  if (lantern && lantern.remaining > 0) {
    const fade = lantern.remaining / LANTERN_LIFETIME_MS;
    const lg = ctx.createRadialGradient(
      lantern.x,
      lantern.y,
      4,
      lantern.x,
      lantern.y,
      LANTERN_RADIUS,
    );
    lg.addColorStop(0, `rgba(255, 244, 170, ${0.55 * fade})`);
    lg.addColorStop(0.55, `rgba(255, 210, 90, ${0.2 * fade})`);
    lg.addColorStop(1, 'rgba(255, 180, 60, 0)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(lantern.x, lantern.y, LANTERN_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(255, 235, 150, ${0.45 * fade})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(
      lantern.x,
      lantern.y,
      LANTERN_RADIUS * (1 - fade * 0.25),
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }

  drawJar();

  for (const f of fireflies) drawFirefly(f);

  if (state === 'playing') {
    const cwBar = 64;
    const chBar = 4;
    const cxBar = w - 14 - cwBar;
    const cyBar = 12;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(cxBar, cyBar, cwBar, chBar);
    ctx.fillStyle = cooldown > 0 ? '#ffb84d' : '#7be3a6';
    ctx.fillRect(
      cxBar,
      cyBar,
      cwBar * (cooldown > 0 ? 1 - cooldown / COOLDOWN_MS : 1),
      chBar,
    );
  }

  if (cooldownShake > 0) {
    ctx.strokeStyle = `rgba(255,120,120,${cooldownShake / 200})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, w - 4, h - 4);
  }
}

function drawJar(): void {
  const baseY = CANVAS_H - 14;
  const topY = JAR_MOUTH_Y;
  const innerX1 = JAR_X1;
  const innerX2 = JAR_X2;
  const sideOut = 12;

  ctx.fillStyle = 'rgba(130, 195, 230, 0.16)';
  ctx.strokeStyle = 'rgba(180, 220, 245, 0.65)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(innerX1 - 4, topY);
  ctx.lineTo(innerX2 + 4, topY);
  ctx.lineTo(innerX2 + sideOut, topY + 22);
  ctx.lineTo(innerX2 + sideOut, baseY - 8);
  ctx.quadraticCurveTo(
    innerX2 + sideOut,
    baseY,
    innerX2 + sideOut - 6,
    baseY,
  );
  ctx.lineTo(innerX1 - sideOut + 6, baseY);
  ctx.quadraticCurveTo(
    innerX1 - sideOut,
    baseY,
    innerX1 - sideOut,
    baseY - 8,
  );
  ctx.lineTo(innerX1 - sideOut, topY + 22);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = 'rgba(230, 245, 255, 0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(innerX1 - 4, topY);
  ctx.lineTo(innerX2 + 4, topY);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 244, 180, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(innerX1, topY - 2);
  ctx.lineTo(innerX2, topY - 2);
  ctx.stroke();
  ctx.setLineDash([]);

  const visible = Math.min(caughtCount, 16);
  const now = performance.now();
  for (let i = 0; i < visible; i++) {
    const tNorm = i / 16;
    const fx =
      innerX1 +
      10 +
      ((Math.sin(now * 0.0011 + i * 1.7) + 1) * 0.5) *
        (innerX2 - innerX1 - 20);
    const fy =
      baseY - 14 - tNorm * 78 - Math.sin(now * 0.0017 + i * 1.4) * 4;
    ctx.fillStyle = 'rgba(255, 222, 130, 0.55)';
    ctx.beginPath();
    ctx.arc(fx, fy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 248, 200, 0.95)';
    ctx.beginPath();
    ctx.arc(fx, fy, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFirefly(f: Firefly): void {
  let x = f.x;
  let y = f.y;
  let alpha = 1;
  if (f.caught) {
    const t = f.caughtT;
    const tx = (JAR_X1 + JAR_X2) / 2;
    const ty = CANVAS_H - 40;
    const arc = Math.sin(t * Math.PI) * 28;
    x = f.cx + (tx - f.cx) * t;
    y = f.cy + (ty - f.cy) * t - arc;
    alpha = 1 - t * 0.65;
  }
  const blink = 0.6 + Math.sin(f.phase) * 0.4;

  const gr = ctx.createRadialGradient(x, y, 0, x, y, FIREFLY_RADIUS * 3.4);
  gr.addColorStop(0, `hsla(${f.hue}, 100%, 75%, ${0.75 * blink * alpha})`);
  gr.addColorStop(1, `hsla(${f.hue}, 100%, 60%, 0)`);
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(x, y, FIREFLY_RADIUS * 3.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = `hsla(${f.hue}, 100%, 82%, ${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

function canvasPointFromEvent(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startRound();
    return;
  }
  if (state !== 'playing') return;
  if (cooldown > 0) {
    cooldownShake = 200;
    return;
  }
  const pt = canvasPointFromEvent(e);
  const ly = Math.max(20, Math.min(pt.y, CANVAS_H - 30));
  const lx = Math.max(20, Math.min(pt.x, CANVAS_W - 20));
  lantern = { x: lx, y: ly, remaining: LANTERN_LIFETIME_MS };
  cooldown = COOLDOWN_MS;
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === ' ' || k === 'enter') {
      startRound();
      e.preventDefault();
    }
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timerEl = document.querySelector<HTMLElement>('#timer')!;
  comboEl = document.querySelector<HTMLElement>('#combo')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  starField = makeStars();

  canvas.addEventListener('pointerdown', onPointerDown);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => startRound());
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
