import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Kuşatma — a trebuchet siege. Drag the catapult back and release to lob a
// boulder in a gravity arc (Angry-Birds aiming) at a Crusader stronghold
// (Stronghold: Crusader theme). The mechanical twist is an ammo economy:
// every shot costs a boulder, but smashing supply barrels refunds two — so
// each shot is a resource decision, not just a damage check.
//
// PITFALLS notes:
// - All physics + animation are driven by a single requestAnimationFrame loop
//   that reads the current `state`/globals every frame. There is no setTimeout,
//   so a reset can never be clobbered by a stale callback (stale-async-callback).
// - Block hitboxes are derived from one blockRect() used by BOTH draw and
//   collide (visual-vs-hitbox). The ball only becomes aimable again once the
//   collapse animation has fully settled, so what you see is what you hit.
// - Input is routed through one keydown switch keyed on `state`; overlay states
//   ignore gameplay keys (overlay-input-leak).
// - All DOM/storage access is inside init() (module-level-dom-access).

const W = 640;
const H = 400;
const GROUND_Y = 340;
const BLOCK = 32;
const CASTLE_X = 372;

const P0X = 80; // launch origin (catapult bucket)
const P0Y = GROUND_Y - 66;

const GRAVITY = 1000; // px/s^2
const MIN_SPEED = 300;
const MAX_SPEED = 880;
const BALL_R = 8;
const RESTITUTION = 0.42;
const TANGENT = 0.78; // tangential velocity kept after a bounce (friction)
const HIT_MIN_SPEED = 90; // below this an impact only nudges, no damage
const DMG_STEP = 300;
const REST_EPS = 36; // px/s; under this for a moment the shot is spent
const REST_TIME = 0.45;
const MAX_SHOT_TIME = 7;

const MAX_PULL = 150; // drag distance (px) for full power
const ANGLE_MIN = -1.45; // steepest lob (~83°)
const ANGLE_MAX = -0.08; // flattest (~5°)

const FIXED_DT = 1 / 120;
const MAX_FRAME_TIME = 0.1;

const STORAGE_BEST = 'kusatma.best';

type Kind = 'wood' | 'stone' | 'supply' | 'target';

const HP: Record<Kind, number> = { wood: 2, stone: 5, supply: 1, target: 1 };
const SCORE: Record<Kind, number> = { wood: 30, stone: 50, supply: 60, target: 200 };
const AMMO_BONUS = 150;
const SUPPLY_REFUND = 2;

interface Block {
  col: number;
  row: number;
  kind: Kind;
  hp: number;
  drawY: number;
  alive: boolean;
}

interface ColSpec {
  col: number;
  stack: Kind[]; // bottom -> top
}

interface Level {
  name: string;
  ammo: number;
  cols: ColSpec[];
}

const LEVELS: Level[] = [
  {
    name: 'Sınır Kulesi',
    ammo: 4,
    cols: [
      { col: 2, stack: ['wood', 'wood'] },
      { col: 5, stack: ['stone', 'stone', 'stone', 'target'] },
    ],
  },
  {
    name: 'Çift Burç',
    ammo: 5,
    cols: [
      { col: 2, stack: ['stone', 'stone', 'stone', 'stone'] },
      { col: 4, stack: ['stone', 'stone', 'target'] },
      { col: 5, stack: ['stone', 'supply'] },
      { col: 6, stack: ['stone', 'stone', 'stone', 'stone', 'target'] },
    ],
  },
  {
    name: 'Haçlı Kalesi',
    ammo: 6,
    cols: [
      { col: 1, stack: ['stone', 'stone', 'wood', 'supply'] },
      { col: 3, stack: ['stone', 'stone', 'stone', 'stone', 'stone'] },
      { col: 4, stack: ['stone', 'stone', 'stone', 'target'] },
      { col: 5, stack: ['stone', 'stone', 'stone', 'stone', 'stone', 'target'] },
      { col: 6, stack: ['stone', 'stone', 'stone', 'target'] },
      { col: 7, stack: ['stone', 'wood', 'supply'] },
    ],
  },
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

type State = 'intro' | 'aiming' | 'firing' | 'settling' | 'levelclear' | 'gameover' | 'won';

const OVERLAY_STATES = new Set<State>(['intro', 'levelclear', 'gameover', 'won']);

let state: State = 'intro';
let blocks: Block[] = [];
let particles: Particle[] = [];
let levelIndex = 0;
let ammo = 0;
let score = 0;
let best = 0;
let scoreAtLevelStart = 0;
let targetsLeft = 0;

let aimAngle = -0.78;
let power = 0.62;
let dragging = false;
let aimedByDrag = false;

const ball = { x: P0X, y: P0Y, vx: 0, vy: 0, active: false };
let shotTime = 0;
let restTimer = 0;

let lastTime = 0;
let acc = 0;
let rafHandle = 0;
let dpr = 1;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let ammoEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const COL = {
  skyTop: '#0e1c33',
  skyBot: '#41506b',
  hillFar: '#1a2740',
  hillNear: '#243450',
  groundTop: '#46663f',
  groundBot: '#243a22',
  dirt: '#2c2118',
  stone: '#79828f',
  stoneTop: '#98a1ae',
  stoneEdge: '#454c57',
  wood: '#9a6a3c',
  woodTop: '#b6884f',
  woodEdge: '#5d3d21',
  supply: '#d2982f',
  supplyTop: '#e8b658',
  supplyHoop: '#6f5018',
  keep: '#3b3442',
  keepEdge: '#241f2a',
  banner: '#d23b3b',
  pole: '#caa45a',
  ball: '#ccd1d9',
  ballEdge: '#7b8290',
  frame: '#6a4525',
  frameDark: '#412a14',
  traj: 'rgba(245, 246, 248, 0.55)',
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function speed(): number {
  return Math.hypot(ball.vx, ball.vy);
}

function launchSpeed(): number {
  return MIN_SPEED + power * (MAX_SPEED - MIN_SPEED);
}

function blockRect(b: Block, visual = false): { x: number; y: number; w: number; h: number } {
  const y = visual ? b.drawY : GROUND_Y - (b.row + 1) * BLOCK;
  return { x: CASTLE_X + b.col * BLOCK, y, w: BLOCK, h: BLOCK };
}

function targetTop(row: number): number {
  return GROUND_Y - (row + 1) * BLOCK;
}

function resizeCanvas(): void {
  const next = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  if (next === dpr && canvas.width === W * dpr) return;
  dpr = next;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function showOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  ammoEl.textContent = String(ammo);
  bestEl.textContent = String(Math.max(best, score));
}

function buildLevel(i: number): void {
  const lvl = LEVELS[i] ?? LEVELS[0]!;
  blocks = [];
  for (const c of lvl.cols) {
    for (let r = 0; r < c.stack.length; r++) {
      const kind = c.stack[r]!;
      blocks.push({
        col: c.col,
        row: r,
        kind,
        hp: HP[kind],
        drawY: targetTop(r),
        alive: true,
      });
    }
  }
  ammo = lvl.ammo;
  targetsLeft = blocks.filter((b) => b.kind === 'target').length;
  particles = [];
  ball.active = false;
  shotTime = 0;
  restTimer = 0;
}

function loadLevel(i: number, showIntro: boolean, retry: boolean): void {
  levelIndex = i;
  if (retry) score = scoreAtLevelStart;
  else scoreAtLevelStart = score;
  buildLevel(i);
  updateHud();
  const lvl = LEVELS[i]!;
  if (showIntro) {
    state = 'intro';
    showOverlay(
      'Kuşatma',
      `Mancınığı geri çekip bırak (ya da ↑/↓ açı · ←/→ güç · Boşluk). Surları yıkıp tüm sancakları devir.\nSeviye ${i + 1}: ${lvl.name}`,
      'Başla',
    );
  } else {
    state = 'aiming';
    hideOverlay();
  }
  draw();
}

function fullReset(): void {
  score = 0;
  scoreAtLevelStart = 0;
  loadLevel(0, true, false);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
}

function fire(): void {
  if (state !== 'aiming') return;
  const s = launchSpeed();
  ball.x = P0X;
  ball.y = P0Y;
  ball.vx = Math.cos(aimAngle) * s;
  ball.vy = Math.sin(aimAngle) * s;
  ball.active = true;
  ammo -= 1;
  updateHud();
  state = 'firing';
  shotTime = 0;
  restTimer = 0;
  acc = 0;
  dragging = false;
  aimedByDrag = false;
}

function spawnDust(x: number, y: number, color: string, n: number, spread = 130): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = Math.random() * spread;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 40,
      life: 0.4 + Math.random() * 0.4,
      max: 0.8,
      color,
      size: 2 + Math.random() * 3,
    });
  }
  if (particles.length > 160) particles.splice(0, particles.length - 160);
}

function dustColor(kind: Kind): string {
  if (kind === 'wood') return COL.wood;
  if (kind === 'supply') return COL.supplyTop;
  if (kind === 'target') return COL.banner;
  return COL.stone;
}

function destroyBlock(b: Block): void {
  b.alive = false;
  score += SCORE[b.kind];
  if (b.kind === 'supply') ammo += SUPPLY_REFUND;
  if (b.kind === 'target') targetsLeft = Math.max(0, targetsLeft - 1);
  const r = blockRect(b, true);
  spawnDust(r.x + BLOCK / 2, r.y + BLOCK / 2, dustColor(b.kind), 12, 180);
  updateHud();
}

function damageBlock(b: Block, dmg: number): void {
  if (dmg <= 0) return;
  b.hp -= dmg;
  const r = blockRect(b, true);
  spawnDust(r.x + BLOCK / 2, r.y + BLOCK / 2, dustColor(b.kind), 4, 90);
  if (b.hp <= 0) destroyBlock(b);
}

function collideBall(b: Block): boolean {
  const r = blockRect(b);
  const cx = clamp(ball.x, r.x, r.x + r.w);
  const cy = clamp(ball.y, r.y, r.y + r.h);
  const dx = ball.x - cx;
  const dy = ball.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > BALL_R * BALL_R) return false;

  const impact = speed();
  const dmg = impact < HIT_MIN_SPEED ? 0 : clamp(1 + Math.floor((impact - HIT_MIN_SPEED) / DMG_STEP), 1, 4);

  let nx: number;
  let ny: number;
  let pen: number;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    nx = dx / d;
    ny = dy / d;
    pen = BALL_R - d;
  } else {
    const left = ball.x - r.x;
    const right = r.x + r.w - ball.x;
    const top = ball.y - r.y;
    const bot = r.y + r.h - ball.y;
    const m = Math.min(left, right, top, bot);
    if (m === left) {
      nx = -1;
      ny = 0;
      pen = left + BALL_R;
    } else if (m === right) {
      nx = 1;
      ny = 0;
      pen = right + BALL_R;
    } else if (m === top) {
      nx = 0;
      ny = -1;
      pen = top + BALL_R;
    } else {
      nx = 0;
      ny = 1;
      pen = bot + BALL_R;
    }
  }

  ball.x += nx * pen;
  ball.y += ny * pen;

  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < 0) {
    const vtx = ball.vx - vn * nx;
    const vty = ball.vy - vn * ny;
    ball.vx = vtx * TANGENT - RESTITUTION * vn * nx;
    ball.vy = vty * TANGENT - RESTITUTION * vn * ny;
  }

  damageBlock(b, dmg);
  return true;
}

function stepBall(dt: number): void {
  ball.vy += GRAVITY * dt;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  for (const b of blocks) {
    if (!b.alive) continue;
    if (collideBall(b)) break;
  }

  if (ball.y + BALL_R > GROUND_Y) {
    ball.y = GROUND_Y - BALL_R;
    if (ball.vy > 0) {
      ball.vy = -ball.vy * RESTITUTION;
      if (Math.abs(ball.vy) > 60) spawnDust(ball.x, GROUND_Y, COL.dirt, 3, 70);
    }
    ball.vx *= 0.86;
  }

  if (speed() < REST_EPS) restTimer += dt;
  else restTimer = 0;
}

function shotSpent(): boolean {
  if (ball.x < -40 || ball.x > W + 40 || ball.y > H + 80) return true;
  if (shotTime > MAX_SHOT_TIME) return true;
  return restTimer > REST_TIME;
}

function settle(): void {
  const byCol = new Map<number, Block[]>();
  for (const b of blocks) {
    const arr = byCol.get(b.col);
    if (arr) arr.push(b);
    else byCol.set(b.col, [b]);
  }
  for (const arr of byCol.values()) {
    arr.sort((a, b) => a.row - b.row);
    for (let i = 0; i < arr.length; i++) arr[i]!.row = i;
  }
}

function onShotEnd(): void {
  ball.active = false;
  blocks = blocks.filter((b) => b.alive);
  settle();
  state = 'settling';
}

function allSettled(): boolean {
  for (const b of blocks) {
    if (Math.abs(b.drawY - targetTop(b.row)) > 0.6) return false;
  }
  return true;
}

function resolveAfterSettle(): void {
  targetsLeft = blocks.filter((b) => b.kind === 'target' && b.alive).length;
  if (targetsLeft === 0) onLevelClear();
  else if (ammo <= 0) onGameOver();
  else state = 'aiming';
}

function onLevelClear(): void {
  const leftover = ammo;
  score += leftover * AMMO_BONUS;
  commitBest();
  if (levelIndex >= LEVELS.length - 1) {
    onWon();
    return;
  }
  state = 'levelclear';
  showOverlay(
    'Sur düştü!',
    `Seviye ${levelIndex + 1} alındı.\nArtan mühimmat bonusu: +${leftover * AMMO_BONUS}`,
    'Sonraki kale',
  );
}

function onWon(): void {
  state = 'won';
  commitBest();
  showOverlay('Kale fethedildi!', `Tüm kaleler düştü.\nToplam skor: ${score} · Rekor: ${best}`, 'Tekrar oyna');
}

function onGameOver(): void {
  state = 'gameover';
  commitBest();
  showOverlay(
    'Mühimmat bitti',
    `Kale dayandı; ${targetsLeft} sancak hâlâ ayakta.\nSkor: ${score}`,
    'Tekrar dene',
  );
}

function overlayAction(): void {
  if (state === 'intro') {
    state = 'aiming';
    hideOverlay();
  } else if (state === 'levelclear') {
    loadLevel(levelIndex + 1, false, false);
  } else if (state === 'gameover') {
    loadLevel(levelIndex, false, true);
  } else if (state === 'won') {
    fullReset();
  }
}

// ---- rendering ----

function drawSky(): void {
  const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  g.addColorStop(0, COL.skyTop);
  g.addColorStop(1, COL.skyBot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, GROUND_Y);

  ctx.fillStyle = 'rgba(255,236,170,0.85)';
  ctx.beginPath();
  ctx.arc(540, 70, 26, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = COL.hillFar;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.quadraticCurveTo(160, 232, 330, GROUND_Y);
  ctx.fill();
  ctx.fillStyle = COL.hillNear;
  ctx.beginPath();
  ctx.moveTo(250, GROUND_Y);
  ctx.quadraticCurveTo(470, 250, 640, GROUND_Y);
  ctx.fill();
}

function drawGround(): void {
  ctx.fillStyle = COL.dirt;
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.fillStyle = COL.groundTop;
  ctx.fillRect(0, GROUND_Y, W, 8);
  ctx.fillStyle = COL.groundBot;
  ctx.fillRect(0, GROUND_Y + 8, W, 3);
}

function drawCatapult(): void {
  ctx.save();
  ctx.fillStyle = COL.frameDark;
  ctx.fillRect(P0X - 34, GROUND_Y - 16, 70, 12);
  ctx.fillStyle = COL.frame;
  ctx.fillRect(P0X - 30, GROUND_Y - 40, 8, 30);
  ctx.fillRect(P0X + 14, GROUND_Y - 40, 8, 30);
  // throwing arm toward the bucket at P0
  ctx.strokeStyle = COL.frame;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(P0X + 24, GROUND_Y - 34);
  ctx.lineTo(P0X - 4, P0Y + 4);
  ctx.stroke();
  // counterweight
  ctx.fillStyle = COL.frameDark;
  ctx.beginPath();
  ctx.arc(P0X + 27, GROUND_Y - 34, 7, 0, Math.PI * 2);
  ctx.fill();
  // wheels
  ctx.fillStyle = COL.frameDark;
  for (const wx of [P0X - 20, P0X + 18]) {
    ctx.beginPath();
    ctx.arc(wx, GROUND_Y - 4, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1c130a';
    ctx.beginPath();
    ctx.arc(wx, GROUND_Y - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COL.frameDark;
  }
  ctx.restore();
}

function shadeRect(x: number, y: number, fill: string, top: string, edge: string): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, BLOCK, BLOCK);
  ctx.fillStyle = top;
  ctx.fillRect(x, y, BLOCK, 4);
  ctx.fillStyle = edge;
  ctx.fillRect(x, y + BLOCK - 3, BLOCK, 3);
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BLOCK - 1, BLOCK - 1);
}

function drawBlock(b: Block): void {
  const x = CASTLE_X + b.col * BLOCK;
  const y = b.drawY;
  if (b.kind === 'stone') {
    shadeRect(x, y, COL.stone, COL.stoneTop, COL.stoneEdge);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.moveTo(x + BLOCK / 2, y + 4);
    ctx.lineTo(x + BLOCK / 2, y + BLOCK - 3);
    ctx.stroke();
  } else if (b.kind === 'wood') {
    shadeRect(x, y, COL.wood, COL.woodTop, COL.woodEdge);
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.moveTo(x + 2, y + BLOCK / 2);
    ctx.lineTo(x + BLOCK - 2, y + BLOCK / 2);
    ctx.stroke();
  } else if (b.kind === 'supply') {
    ctx.fillStyle = COL.supply;
    ctx.fillRect(x + 3, y + 2, BLOCK - 6, BLOCK - 4);
    ctx.fillStyle = COL.supplyTop;
    ctx.fillRect(x + 3, y + 2, BLOCK - 6, 4);
    ctx.fillStyle = COL.supplyHoop;
    ctx.fillRect(x + 3, y + 9, BLOCK - 6, 3);
    ctx.fillRect(x + 3, y + BLOCK - 11, BLOCK - 6, 3);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.strokeRect(x + 3.5, y + 2.5, BLOCK - 7, BLOCK - 5);
  } else {
    shadeRect(x, y, COL.keep, COL.keep, COL.keepEdge);
    // battlement notch
    ctx.fillStyle = COL.keepEdge;
    ctx.fillRect(x + 4, y, 6, 6);
    ctx.fillRect(x + BLOCK - 10, y, 6, 6);
    // banner pole + flag rising above the block
    ctx.fillStyle = COL.pole;
    ctx.fillRect(x + BLOCK / 2 - 1, y - 18, 2, 22);
    ctx.fillStyle = COL.banner;
    ctx.beginPath();
    ctx.moveTo(x + BLOCK / 2 + 1, y - 18);
    ctx.lineTo(x + BLOCK / 2 + 15, y - 14);
    ctx.lineTo(x + BLOCK / 2 + 1, y - 10);
    ctx.closePath();
    ctx.fill();
  }
}

function previewPath(): Array<{ x: number; y: number }> {
  const s = launchSpeed();
  let x = P0X;
  let y = P0Y;
  let vx = Math.cos(aimAngle) * s;
  let vy = Math.sin(aimAngle) * s;
  const dt = 1 / 60;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 150; i++) {
    vy += GRAVITY * dt;
    x += vx * dt;
    y += vy * dt;
    if (y + BALL_R >= GROUND_Y || x > W + 20 || x < -20 || y < -40) break;
    let hit = false;
    for (const b of blocks) {
      if (!b.alive) continue;
      const r = blockRect(b);
      if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) {
        hit = true;
        break;
      }
    }
    if (hit) break;
    if (i % 5 === 0) pts.push({ x, y });
    if (pts.length >= 22) break;
  }
  return pts;
}

function drawAim(): void {
  for (const p of previewPath()) {
    ctx.fillStyle = COL.traj;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  // direction chevron
  const len = 26 + power * 26;
  const tx = P0X + Math.cos(aimAngle) * len;
  const ty = P0Y + Math.sin(aimAngle) * len;
  ctx.strokeStyle = 'rgba(245,246,248,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(P0X, P0Y);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  // power gauge
  const gx = 16;
  const gh = 96;
  const gy = GROUND_Y - 12 - gh;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(gx, gy, 8, gh);
  const ph = gh * power;
  const grad = ctx.createLinearGradient(0, gy + gh, 0, gy);
  grad.addColorStop(0, '#34d399');
  grad.addColorStop(0.6, '#f4b942');
  grad.addColorStop(1, '#ef4444');
  ctx.fillStyle = grad;
  ctx.fillRect(gx, gy + gh - ph, 8, ph);

  drawBall(P0X, P0Y);

  ctx.fillStyle = 'rgba(245,246,248,0.78)';
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`Açı ${Math.round(-aimAngle * (180 / Math.PI))}°`, gx + 16, gy + 12);
}

function drawBall(x: number, y: number): void {
  ctx.fillStyle = COL.ball;
  ctx.beginPath();
  ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.arc(x - 2.5, y - 2.5, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COL.ballEdge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
  ctx.stroke();
}

function drawParticles(): void {
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

function drawCanvasHud(): void {
  ctx.textBaseline = 'top';
  // ammo cannonballs, top-left
  ctx.fillStyle = 'rgba(245,246,248,0.9)';
  ctx.font = '700 14px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Mühimmat', 14, 12);
  for (let i = 0; i < ammo; i++) {
    ctx.fillStyle = COL.ball;
    ctx.beginPath();
    ctx.arc(20 + i * 16, 40, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COL.ballEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // level + targets, top-right
  const lvl = LEVELS[levelIndex]!;
  ctx.fillStyle = 'rgba(245,246,248,0.9)';
  ctx.textAlign = 'right';
  ctx.fillText(`Seviye ${levelIndex + 1} · ${lvl.name}`, W - 14, 12);
  ctx.fillStyle = '#f3b0b0';
  ctx.fillText(`Sancak: ${targetsLeft}`, W - 14, 32);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function draw(): void {
  ctx.clearRect(0, 0, W, H);
  drawSky();
  drawGround();
  drawCatapult();
  for (const b of blocks) {
    if (b.alive) drawBlock(b);
  }
  drawParticles();
  if (state === 'aiming' || state === 'intro') drawAim();
  if (state === 'firing' && ball.active) drawBall(ball.x, ball.y);
  drawCanvasHud();
}

function updateParticles(dt: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.vy += 600 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

function easeBlocks(dt: number): void {
  const k = Math.min(1, dt * 14);
  for (const b of blocks) {
    const t = targetTop(b.row);
    const d = t - b.drawY;
    if (Math.abs(d) < 0.5) b.drawY = t;
    else b.drawY += d * k;
  }
}

function loop(t: number): void {
  if (!lastTime) lastTime = t;
  const frame = Math.min(MAX_FRAME_TIME, (t - lastTime) / 1000);
  lastTime = t;

  if (state === 'firing') {
    acc += frame;
    while (acc >= FIXED_DT) {
      stepBall(FIXED_DT);
      shotTime += FIXED_DT;
      acc -= FIXED_DT;
      if (shotSpent()) {
        onShotEnd();
        break;
      }
    }
  }

  easeBlocks(frame);
  updateParticles(frame);

  if (state === 'settling' && allSettled()) {
    resolveAfterSettle();
  }

  draw();
  rafHandle = requestAnimationFrame(loop);
}

// ---- input ----

function toCanvas(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * W,
    y: ((e.clientY - rect.top) / rect.height) * H,
  };
}

function updateAimFromPointer(e: PointerEvent): void {
  const p = toCanvas(e);
  const dx = P0X - p.x;
  const dy = P0Y - p.y;
  aimAngle = clamp(Math.atan2(dy, dx), ANGLE_MIN, ANGLE_MAX);
  power = clamp(Math.hypot(dx, dy) / MAX_PULL, 0.05, 1);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    fullReset();
    e.preventDefault();
    return;
  }
  if (OVERLAY_STATES.has(state)) {
    if ((k === 'Enter' || k === ' ') && document.activeElement !== overlayBtn) {
      overlayAction();
      e.preventDefault();
    }
    return;
  }
  if (state !== 'aiming') return;
  if (k === 'ArrowUp') {
    aimAngle = clamp(aimAngle - 0.025, ANGLE_MIN, ANGLE_MAX);
    e.preventDefault();
  } else if (k === 'ArrowDown') {
    aimAngle = clamp(aimAngle + 0.025, ANGLE_MIN, ANGLE_MAX);
    e.preventDefault();
  } else if (k === 'ArrowLeft') {
    power = clamp(power - 0.03, 0.05, 1);
    e.preventDefault();
  } else if (k === 'ArrowRight') {
    power = clamp(power + 0.03, 0.05, 1);
    e.preventDefault();
  } else if (k === ' ' || k === 'Enter') {
    fire();
    e.preventDefault();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'aiming') return;
  dragging = true;
  aimedByDrag = false;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // capture not supported; dragging still works via window-level events
  }
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || state !== 'aiming') return;
  aimedByDrag = true;
  updateAimFromPointer(e);
  e.preventDefault();
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }
  if (aimedByDrag && state === 'aiming') fire();
  e.preventDefault();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  ammoEl = document.querySelector<HTMLElement>('#ammo')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  overlayBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    overlayAction();
  });
  overlay.addEventListener('click', () => overlayAction());
  restartBtn.addEventListener('click', fullReset);
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);

  resizeCanvas();
  fullReset();
  cancelAnimationFrame(rafHandle);
  lastTime = 0;
  rafHandle = requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset: fullReset });
