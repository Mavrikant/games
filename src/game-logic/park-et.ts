import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded here (see docs/PITFALLS.md):
// - unguarded-storage:           safeRead/safeWrite wrap localStorage.
// - module-level-dom-access:     all DOM/event binding lives in init().
// - overlay-input-leak:          explicit `state` enum guards each handler.
// - unreachable-start-state:     any movement key from ready/crashed starts play.

type State = 'ready' | 'playing' | 'crashed' | 'complete';
type KeyName = 'up' | 'down' | 'left' | 'right';

interface Pose { x: number; y: number; angle: number }
interface Rect { x: number; y: number; w: number; h: number; angle: number }
interface Obstacle extends Rect { color: string }
interface Level {
  car: Pose;
  target: Rect;
  obstacles: Obstacle[];
  hint: string;
}

const W = 480;
const H = 480;
const CAR_L = 46;
const CAR_W = 26;
const WHEELBASE = 30;
const MAX_STEER = 0.55;
const STEER_RATE = 4.5;
const STEER_RETURN = 5;
const MAX_FWD = 115;
const MAX_REV = 75;
const ACCEL = 140;
const BRAKE = 230;
const FRICTION = 65;
const PARK_SPEED_THRESHOLD = 7;
const PARK_DWELL = 0.30;
const STORAGE_KEY = 'park-et.bestLevel';

const COLOR_CAR_BODY = '#e94e3a';
const COLOR_CAR_DARK = '#7a1a10';
const COLOR_TARGET_FILL = 'rgba(52, 211, 153, 0.18)';
const COLOR_TARGET_STROKE = '#34d399';
const COLOR_TARGET_FILL_PARKED = 'rgba(52, 211, 153, 0.32)';

const LEVELS: Level[] = [
  // 1: dosdoğru çekip park et — engelsiz, geniş yer
  {
    car: { x: 240, y: 410, angle: -Math.PI / 2 },
    target: { x: 240, y: 80, w: 60, h: 96, angle: 0 },
    obstacles: [],
    hint: 'Düz git ve yeşil alana park et.',
  },
  // 2: yana dönüp iki araç arasına park
  {
    car: { x: 70, y: 360, angle: 0 },
    target: { x: 400, y: 130, w: 60, h: 92, angle: 0 },
    obstacles: [
      { x: 400, y: 250, w: 56, h: 88, angle: 0, color: '#7d8aa0' },
      { x: 400, y: 380, w: 56, h: 88, angle: 0, color: '#5b6b80' },
    ],
    hint: 'Sağa dön, iki aracın arasına yerleş.',
  },
  // 3: klasik paralel park
  {
    car: { x: 100, y: 220, angle: 0 },
    target: { x: 240, y: 380, w: 100, h: 50, angle: 0 },
    obstacles: [
      { x: 120, y: 380, w: 88, h: 48, angle: 0, color: '#6f7e95' },
      { x: 360, y: 380, w: 88, h: 48, angle: 0, color: '#7d8aa0' },
      { x: 240, y: 440, w: 480, h: 30, angle: 0, color: '#2b3140' },
    ],
    hint: 'Paralel park: önce yana, sonra geriye yaklaş.',
  },
  // 4: dar geçit + sondaki yere park
  {
    car: { x: 60, y: 240, angle: 0 },
    target: { x: 430, y: 100, w: 56, h: 90, angle: 0 },
    obstacles: [
      { x: 260, y: 105, w: 220, h: 26, angle: 0, color: '#3b4253' },
      { x: 260, y: 335, w: 220, h: 26, angle: 0, color: '#3b4253' },
      { x: 430, y: 220, w: 56, h: 88, angle: 0, color: '#6f7e95' },
      { x: 430, y: 340, w: 56, h: 88, angle: 0, color: '#7d8aa0' },
    ],
    hint: 'Dar koridordan geç, sondaki yere sok.',
  },
  // 5: eğimli (açılı) park
  {
    car: { x: 100, y: 400, angle: 0 },
    target: { x: 360, y: 180, w: 60, h: 90, angle: -0.6 },
    obstacles: [
      { x: 270, y: 220, w: 56, h: 86, angle: -0.6, color: '#7d8aa0' },
      { x: 450, y: 140, w: 56, h: 86, angle: -0.6, color: '#5b6b80' },
      { x: 240, y: 460, w: 480, h: 40, angle: 0, color: '#2b3140' },
    ],
    hint: 'Açılı park. Önce hizalan, sonra ileri.',
  },
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'ready';
let levelIdx = 0;
let bestLevel = 0;
let elapsed = 0;
let car: Pose = { x: 0, y: 0, angle: 0 };
let speed = 0;
let steer = 0;
let parkedFor = 0;
let lastFrame = 0;
const keys = new Set<KeyName>();

function mapKey(k: string): KeyName | null {
  if (k === 'arrowup' || k === 'w') return 'up';
  if (k === 'arrowdown' || k === 's') return 'down';
  if (k === 'arrowleft' || k === 'a') return 'left';
  if (k === 'arrowright' || k === 'd') return 'right';
  return null;
}

function setBest(): void {
  bestEl.textContent = bestLevel > 0 ? `S${bestLevel}` : '—';
}

function currentLevel(): Level {
  return LEVELS[Math.min(levelIdx, LEVELS.length - 1)]!;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function loadLevel(idx: number): void {
  levelIdx = Math.max(0, Math.min(idx, LEVELS.length - 1));
  const L = currentLevel();
  car = { ...L.car };
  speed = 0;
  steer = 0;
  parkedFor = 0;
  elapsed = 0;
  state = 'ready';
  keys.clear();
  levelEl.textContent = String(levelIdx + 1);
  timeEl.textContent = '0.0';
  showOverlay(
    `Seviye ${levelIdx + 1}`,
    `${L.hint}\nBaşlamak için bir yön tuşuna bas.`,
  );
}

function startPlaying(): void {
  state = 'playing';
  elapsed = 0;
  parkedFor = 0;
  hideOverlayEl(overlay);
}

function reset(): void {
  loadLevel(0);
}

function nextLevel(): void {
  if (levelIdx >= LEVELS.length - 1) {
    // restart son seviyeden — ya da baştan?
    loadLevel(0);
  } else {
    loadLevel(levelIdx + 1);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  const mapped = mapKey(k);
  if (mapped !== null) {
    e.preventDefault();
    if (state === 'crashed') loadLevel(levelIdx);
    else if (state === 'complete') nextLevel();
    keys.add(mapped); // after load*, which clears the set
    if (state !== 'playing') startPlaying();
    return;
  }
  if (k === 'r') {
    e.preventDefault();
    loadLevel(levelIdx);
    return;
  }
  if (k === 'enter' || k === ' ') {
    e.preventDefault();
    if (state === 'ready') startPlaying();
    else if (state === 'crashed') {
      loadLevel(levelIdx);
      startPlaying();
    } else if (state === 'complete') {
      nextLevel();
      startPlaying();
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const mapped = mapKey(e.key.toLowerCase());
  if (mapped !== null) {
    e.preventDefault();
    keys.delete(mapped);
  }
}

function update(dt: number): void {
  if (state !== 'playing') return;

  elapsed += dt;
  timeEl.textContent = elapsed.toFixed(1);

  const fwd = keys.has('up') ? 1 : 0;
  const rev = keys.has('down') ? 1 : 0;
  const left = keys.has('left') ? 1 : 0;
  const right = keys.has('right') ? 1 : 0;

  // Acceleration / brake (separate accelerator from brake input)
  if (fwd && !rev) {
    if (speed < 0) {
      speed += BRAKE * dt;
      if (speed > 0) speed = 0;
    } else {
      speed += ACCEL * dt;
      if (speed > MAX_FWD) speed = MAX_FWD;
    }
  } else if (rev && !fwd) {
    if (speed > 0) {
      speed -= BRAKE * dt;
      if (speed < 0) speed = 0;
    } else {
      speed -= ACCEL * dt;
      if (speed < -MAX_REV) speed = -MAX_REV;
    }
  } else {
    if (Math.abs(speed) <= FRICTION * dt) speed = 0;
    else speed -= Math.sign(speed) * FRICTION * dt;
  }

  // Steering — front-wheel angle approaches input target, self-centers when no input.
  const steerInput = right - left;
  if (steerInput !== 0) {
    const target = steerInput * MAX_STEER;
    const diff = target - steer;
    const step = STEER_RATE * dt;
    if (Math.abs(diff) <= step) steer = target;
    else steer += Math.sign(diff) * step;
  } else if (steer !== 0) {
    const step = STEER_RETURN * dt;
    if (Math.abs(steer) <= step) steer = 0;
    else steer -= Math.sign(steer) * step;
  }

  // Bicycle-model integration around the car's center.
  const ds = speed * dt;
  if (ds !== 0) {
    car.x += Math.cos(car.angle) * ds;
    car.y += Math.sin(car.angle) * ds;
    car.angle += (ds / WHEELBASE) * Math.tan(steer);
  }

  if (offBoard() || hitsObstacle()) {
    state = 'crashed';
    showOverlay('Çarpıştın!', 'Tekrar denemek için R veya yön tuşu.');
    return;
  }

  if (carInsideTarget() && Math.abs(speed) < PARK_SPEED_THRESHOLD) {
    parkedFor += dt;
    if (parkedFor >= PARK_DWELL) {
      state = 'complete';
      const lvl = levelIdx + 1;
      if (lvl > bestLevel) {
        bestLevel = lvl;
        safeWrite(STORAGE_KEY, bestLevel);
        setBest();
      }
      const isLast = levelIdx >= LEVELS.length - 1;
      const title = isLast ? 'Tüm seviyeler tamam!' : `Seviye ${lvl} tamam`;
      const msg = isLast
        ? `Süre: ${elapsed.toFixed(1)} sn\nR ile baştan başla.`
        : `Süre: ${elapsed.toFixed(1)} sn\nSonraki için yön tuşu veya Enter.`;
      showOverlay(title, msg);
    }
  } else {
    parkedFor = 0;
  }
}

function offBoard(): boolean {
  const corners = rectCorners({
    x: car.x, y: car.y, w: CAR_L, h: CAR_W, angle: car.angle,
  });
  for (const p of corners) {
    if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) return true;
  }
  return false;
}

function hitsObstacle(): boolean {
  const carPts = rectCorners({
    x: car.x, y: car.y, w: CAR_L, h: CAR_W, angle: car.angle,
  });
  for (const o of currentLevel().obstacles) {
    const oPts = rectCorners(o);
    if (obbCollide(carPts, oPts)) return true;
  }
  return false;
}

function carInsideTarget(): boolean {
  const t = currentLevel().target;
  const tPts = rectCorners(t);
  const carPts = rectCorners({
    x: car.x, y: car.y, w: CAR_L, h: CAR_W, angle: car.angle,
  });
  for (const p of carPts) {
    if (!pointInConvex(p, tPts)) return false;
  }
  return true;
}

interface Pt { x: number; y: number }

function rectCorners(r: Rect): Pt[] {
  const c = Math.cos(r.angle);
  const s = Math.sin(r.angle);
  const hw = r.w / 2;
  const hh = r.h / 2;
  const local: Pt[] = [
    { x:  hw, y:  hh },
    { x:  hw, y: -hh },
    { x: -hw, y: -hh },
    { x: -hw, y:  hh },
  ];
  return local.map((p) => ({
    x: r.x + p.x * c - p.y * s,
    y: r.y + p.x * s + p.y * c,
  }));
}

function obbCollide(a: Pt[], b: Pt[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i]!;
      const p2 = poly[(i + 1) % poly.length]!;
      // Edge normal (outward), no need to normalize for SAT comparison.
      const nx = -(p2.y - p1.y);
      const ny = p2.x - p1.x;
      let aMin = Infinity, aMax = -Infinity;
      let bMin = Infinity, bMax = -Infinity;
      for (const p of a) {
        const d = p.x * nx + p.y * ny;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      for (const p of b) {
        const d = p.x * nx + p.y * ny;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      if (aMax < bMin || bMax < aMin) return false;
    }
  }
  return true;
}

function pointInConvex(p: Pt, poly: Pt[]): boolean {
  // Convex polygon containment via consistent cross-product sign.
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (sign !== s) return false;
    }
  }
  return true;
}

function draw(): void {
  // Asphalt
  ctx.fillStyle = '#2a2f3a';
  ctx.fillRect(0, 0, W, H);

  // Lot grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 40; i < W; i += 40) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(W, i);
    ctx.stroke();
  }

  // Target spot
  const t = currentLevel().target;
  const parked = state === 'playing' && carInsideTarget() && Math.abs(speed) < PARK_SPEED_THRESHOLD;
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.angle);
  ctx.fillStyle = parked ? COLOR_TARGET_FILL_PARKED : COLOR_TARGET_FILL;
  ctx.fillRect(-t.w / 2, -t.h / 2, t.w, t.h);
  ctx.setLineDash([8, 4]);
  ctx.strokeStyle = COLOR_TARGET_STROKE;
  ctx.lineWidth = 2;
  ctx.strokeRect(-t.w / 2, -t.h / 2, t.w, t.h);
  ctx.setLineDash([]);
  // small "P" mark
  ctx.fillStyle = COLOR_TARGET_STROKE;
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', 0, 0);
  ctx.restore();

  // Obstacles
  for (const o of currentLevel().obstacles) {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.angle);
    ctx.fillStyle = o.color;
    ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-o.w / 2, -o.h / 2, o.w, o.h);
    ctx.restore();
  }

  // Player car
  drawCar(car.x, car.y, car.angle, COLOR_CAR_BODY, COLOR_CAR_DARK);
}

function drawCar(x: number, y: number, angle: number, body: string, dark: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  // body
  ctx.fillStyle = body;
  ctx.fillRect(-CAR_L / 2, -CAR_W / 2, CAR_L, CAR_W);
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-CAR_L / 2, -CAR_W / 2, CAR_L, CAR_W);
  // windshield near the front (+x)
  ctx.fillStyle = 'rgba(190, 220, 255, 0.85)';
  ctx.fillRect(CAR_L / 2 - 14, -CAR_W / 2 + 3, 6, CAR_W - 6);
  // headlights
  ctx.fillStyle = '#fff7c2';
  ctx.fillRect(CAR_L / 2 - 3, -CAR_W / 2 + 1, 3, 4);
  ctx.fillRect(CAR_L / 2 - 3,  CAR_W / 2 - 5, 3, 4);
  // rear lights
  ctx.fillStyle = '#ffb6a8';
  ctx.fillRect(-CAR_L / 2, -CAR_W / 2 + 2, 2, 4);
  ctx.fillRect(-CAR_L / 2,  CAR_W / 2 - 6, 2, 4);
  ctx.restore();
}

function loop(t: number): void {
  if (lastFrame === 0) lastFrame = t;
  let dt = (t - lastFrame) / 1000;
  if (dt > 0.05) dt = 0.05;
  lastFrame = t;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

function attachTouchButton(btn: HTMLButtonElement): void {
  const k = btn.dataset.key as KeyName | undefined;
  if (!k) return;
  const press = (e: Event) => {
    e.preventDefault();
    if (state === 'crashed') loadLevel(levelIdx);
    else if (state === 'complete') nextLevel();
    keys.add(k); // after load*, which clears the set
    if (state !== 'playing') startPlaying();
  };
  const release = () => keys.delete(k);
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('lostpointercapture', release);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  bestLevel = safeRead<number>(STORAGE_KEY, 0);
  setBest();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  restartBtn.addEventListener('click', () => loadLevel(levelIdx));

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach(attachTouchButton);

  loadLevel(0);
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
