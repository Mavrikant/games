import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Polarite Savunması — a tower-defense with a polarity twist.
// Enemies come in two poles (red ● / blue ◆). Towers fire ONLY at enemies of
// the currently ACTIVE pole; the other pole is shielded. The player flips the
// global pole (Space / button) to match the dominant incoming colour. That
// active timing layer is the whole game — placement alone is not enough.
//
// PITFALLS guarded here (see docs/PITFALLS.md):
// - module-level-dom-access / unguarded-storage: all DOM + storage in init().
// - stale-async-callback: single rAF loop keyed to a gen token; start/reset bump.
// - overlay-input-leak: explicit `state` enum; every handler guards on it. The
//   overlay covers the canvas while not playing, so placement can't leak.
// - visual-vs-hitbox: RANGE / ENEMY_R / CELL are the single source of truth for
//   BOTH draw() and the targeting maths (no separate hard-coded numbers).
// - invisible-boot: startGame() hides the overlay and immediately draws the
//   board + a prep banner that counts down within the first frame.
// - hud-counter-synced...: gold/lives/wave are written to the DOM at the exact
//   line they change, via setGold/setLives/setWave.
// - designed-lose-condition-not-wired: a leaked enemy costs a core point and
//   can end the run; surviving all waves wins.

const STORAGE_BEST = 'polarite-savunma.best';
const SCORE_DESC = { gameId: 'polarite-savunma', storageKey: STORAGE_BEST, direction: 'higher' as const };

const W = 480;
const H = 480;
const CELL = 48;
const COLS = W / CELL; // 10
const ROWS = H / CELL; // 10

const TOWER_COST = 50;
const START_GOLD = 130;
const START_LIVES = 16;
const KILL_GOLD = 7;
const RANGE = 2.15 * CELL; // px — used by targeting AND the drawn range ring
const FIRE_INTERVAL = 0.42; // s between shots
const DAMAGE = 1;
const BEAM_LIFE = 0.1; // s a beam stays drawn
const TOWER_R = 15; // px, visual
const ENEMY_R = 13; // px, visual + targeting radius

const TOTAL_WAVES = 10;
const PREP_FIRST = 6; // s before wave 1 (build time)
const PREP_BETWEEN = 4; // s between waves
const SPAWN_GAP = 0.78; // s between spawns within a wave
const BASE_SPEED = 58; // px/s at wave 1

const C_BG = '#0b0d12';
const C_GRID = 'rgba(129,140,248,0.07)';
const C_PATH = '#171b24';
const C_PATH_EDGE = 'rgba(129,140,248,0.22)';
const C_TOWER_BASE = '#2a3340';
const C_TOWER = '#cbd5e1';
const C_CORE = '#a78bfa';
const C_TEXT = '#f5f6f8';
const C_GOOD = '#34d399';
const C_WARN = '#fbbf24';
const C_BAD = '#f8717f';

interface Pole {
  name: string;
  color: string;
}
const POLE: Pole[] = [
  { name: 'Kırmızı', color: '#f8717f' },
  { name: 'Mavi', color: '#60a5fa' },
];

type State = 'ready' | 'playing' | 'won' | 'gameover';
type Phase = 'prep' | 'wave';

interface Enemy {
  id: number;
  t: number; // arc-length travelled along the path (px)
  color: number;
  hp: number;
  maxHp: number;
  speed: number;
  x: number;
  y: number;
}
interface Tower {
  c: number;
  r: number;
  cd: number;
  flash: number;
}
interface Beam {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  color: number;
}

// --- Path geometry (pure, no DOM) ---------------------------------------
// Serpentine route in grid-corner coords; converted to pixel centres.
const WAYPOINTS: [number, number][] = [
  [-1, 1],
  [8, 1],
  [8, 3],
  [1, 3],
  [1, 5],
  [8, 5],
  [8, 7],
  [1, 7],
  [1, 9],
];
const PATH_PTS = WAYPOINTS.map(([c, r]) => ({
  x: (c + 0.5) * CELL,
  y: (r + 0.5) * CELL,
}));
interface Seg {
  x: number;
  y: number;
  len: number;
  ux: number;
  uy: number;
  acc: number;
}
const SEG: Seg[] = [];
{
  let total = 0;
  for (let i = 0; i < PATH_PTS.length - 1; i++) {
    const a = PATH_PTS[i]!;
    const b = PATH_PTS[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    SEG.push({ x: a.x, y: a.y, len, ux: dx / len, uy: dy / len, acc: total });
    total += len;
  }
}
const PATH_LEN = SEG.reduce((s, g) => s + g.len, 0);
const CORE = PATH_PTS[PATH_PTS.length - 1]!;

const PATH_CELLS = new Set<string>();
for (let t = 0; t <= PATH_LEN; t += CELL / 5) {
  const p = posAt(t);
  PATH_CELLS.add(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`);
}

function posAt(t: number): { x: number; y: number } {
  if (t <= 0) return { x: SEG[0]!.x, y: SEG[0]!.y };
  if (t >= PATH_LEN) return { x: CORE.x, y: CORE.y };
  for (const s of SEG) {
    if (t < s.acc + s.len) {
      const d = t - s.acc;
      return { x: s.x + s.ux * d, y: s.y + s.uy * d };
    }
  }
  return { x: CORE.x, y: CORE.y };
}

// --- Mutable game state -------------------------------------------------
const gen = createGenToken();
let state: State = 'ready';
let phase: Phase = 'prep';
let polarity = 0;
let gold = 0;
let lives = 0;
let wave = 0;
let best = 0;

let enemies: Enemy[] = [];
let towers: Tower[] = [];
let beams: Beam[] = [];
let queue: number[] = [];
let nextId = 0;
let spawnTimer = 0;
let prepTimer = 0;
let coreHurt = 0;
let hoverC = -1;
let hoverR = -1;

let rafId = 0;
let lastTs = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let livesEl!: HTMLElement;
let goldEl!: HTMLElement;
let waveEl!: HTMLElement;
let polarityBtn!: HTMLButtonElement;
let polarityLabel!: HTMLElement;
let restartBtn!: HTMLButtonElement;

// --- HUD writers (sync DOM at the mutation site) ------------------------
function setLives(n: number): void {
  lives = n;
  livesEl.textContent = String(Math.max(0, n));
}
function setGold(n: number): void {
  gold = n;
  goldEl.textContent = String(n);
}
function setWave(n: number): void {
  wave = n;
  waveEl.textContent = String(n);
}
function updatePolarityBtn(): void {
  polarityLabel.textContent = POLE[polarity]!.name;
  polarityBtn.classList.toggle('td-polarity--red', polarity === 0);
  polarityBtn.classList.toggle('td-polarity--blue', polarity === 1);
}

// --- Build / placement --------------------------------------------------
function isBuildable(c: number, r: number): boolean {
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
  if (PATH_CELLS.has(`${c},${r}`)) return false;
  return !towers.some((t) => t.c === c && t.r === r);
}

function placeTower(c: number, r: number): void {
  if (state !== 'playing') return;
  if (!isBuildable(c, r) || gold < TOWER_COST) return;
  towers.push({ c, r, cd: 0, flash: 0 });
  setGold(gold - TOWER_COST);
  draw();
}

// --- Waves --------------------------------------------------------------
function waveHp(w: number): number {
  return 3 + Math.round(w * 1.6);
}
function waveSpeed(w: number): number {
  return Math.min(96, BASE_SPEED + w * 3.4);
}
function waveCount(w: number): number {
  return 6 + w * 2;
}
function buildQueue(w: number): number[] {
  const n = waveCount(w);
  const q: number[] = [];
  let color = Math.random() < 0.5 ? 0 : 1;
  while (q.length < n) {
    const run = 2 + Math.floor(Math.random() * 3); // clusters of 2..4
    for (let i = 0; i < run && q.length < n; i++) q.push(color);
    color = 1 - color;
  }
  return q;
}

function beginPrep(n: number): void {
  phase = 'prep';
  setWave(n);
  prepTimer = n === 1 ? PREP_FIRST : PREP_BETWEEN;
  queue = [];
}
function startWave(): void {
  phase = 'wave';
  queue = buildQueue(wave);
  spawnTimer = 0;
}
function spawnNext(): void {
  const color = queue.shift();
  if (color === undefined) return;
  enemies.push({
    id: nextId++,
    t: 0,
    color,
    hp: waveHp(wave),
    maxHp: waveHp(wave),
    speed: waveSpeed(wave),
    x: PATH_PTS[0]!.x,
    y: PATH_PTS[0]!.y,
  });
}

// --- Simulation ---------------------------------------------------------
function moveEnemies(dt: number): void {
  for (const e of enemies) {
    e.t += e.speed * dt;
    const p = posAt(e.t);
    e.x = p.x;
    e.y = p.y;
  }
}

function handleLeaks(): boolean {
  const survivors: Enemy[] = [];
  let leaked = false;
  for (const e of enemies) {
    if (e.t >= PATH_LEN) {
      leaked = true;
      setLives(lives - 1);
      coreHurt = 0.35;
    } else {
      survivors.push(e);
    }
  }
  enemies = survivors;
  if (leaked && lives <= 0) {
    endGame(false);
    return true;
  }
  return false;
}

function fireTowers(dt: number): void {
  for (const tw of towers) {
    if (tw.cd > 0) tw.cd -= dt;
    if (tw.flash > 0) tw.flash -= dt;
    if (tw.cd > 0) continue;
    const tx = (tw.c + 0.5) * CELL;
    const ty = (tw.r + 0.5) * CELL;
    let target: Enemy | null = null;
    for (const e of enemies) {
      if (e.color !== polarity) continue;
      const dx = e.x - tx;
      const dy = e.y - ty;
      if (dx * dx + dy * dy > RANGE * RANGE) continue;
      if (!target || e.t > target.t) target = e; // most-progressed
    }
    if (!target) continue;
    target.hp -= DAMAGE;
    tw.cd = FIRE_INTERVAL;
    tw.flash = BEAM_LIFE;
    beams.push({ x1: tx, y1: ty, x2: target.x, y2: target.y, life: BEAM_LIFE, color: polarity });
    if (target.hp <= 0) {
      setGold(gold + KILL_GOLD);
      const dead = target;
      enemies = enemies.filter((e) => e !== dead);
    }
  }
}

function update(dt: number): void {
  if (phase === 'prep') {
    prepTimer -= dt;
    if (prepTimer <= 0) startWave();
  } else if (queue.length > 0) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnNext();
      spawnTimer = SPAWN_GAP;
    }
  }

  moveEnemies(dt);
  if (handleLeaks()) return;
  fireTowers(dt);

  for (const b of beams) b.life -= dt;
  beams = beams.filter((b) => b.life > 0);
  if (coreHurt > 0) coreHurt -= dt;

  if (phase === 'wave' && queue.length === 0 && enemies.length === 0) {
    best = Math.max(best, wave);
    safeWrite(STORAGE_BEST, best);
    if (wave >= TOTAL_WAVES) {
      endGame(true);
      return;
    }
    setGold(gold + 12 + wave * 3); // wave-clear bonus
    beginPrep(wave + 1);
  }
}

// --- Rendering ----------------------------------------------------------
function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pathPolyline(): void {
  ctx.beginPath();
  ctx.moveTo(PATH_PTS[0]!.x, PATH_PTS[0]!.y);
  for (let i = 1; i < PATH_PTS.length; i++) ctx.lineTo(PATH_PTS[i]!.x, PATH_PTS[i]!.y);
}

function drawBoard(): void {
  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C_GRID;
  ctx.lineWidth = 1;
  for (let i = 1; i < COLS; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL, 0);
    ctx.lineTo(i * CELL, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * CELL);
    ctx.lineTo(W, i * CELL);
    ctx.stroke();
  }
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = C_PATH;
  ctx.lineWidth = CELL * 0.82;
  pathPolyline();
  ctx.stroke();
  ctx.strokeStyle = C_PATH_EDGE;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 10]);
  pathPolyline();
  ctx.stroke();
  ctx.restore();
}

function drawCore(): void {
  const pulse = coreHurt > 0 ? 1 + coreHurt : 1;
  ctx.save();
  ctx.shadowColor = C_CORE;
  ctx.shadowBlur = 14;
  ctx.fillStyle = C_CORE;
  ctx.beginPath();
  ctx.arc(CORE.x, CORE.y, 13 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(CORE.x, CORE.y, 5, 0, Math.PI * 2);
  ctx.fill();
  if (coreHurt > 0) {
    ctx.strokeStyle = C_BAD;
    ctx.globalAlpha = Math.min(1, coreHurt * 2.5);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(CORE.x, CORE.y, 24, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHover(): void {
  if (state !== 'playing' || hoverC < 0 || hoverR < 0) return;
  const build = isBuildable(hoverC, hoverR);
  const afford = gold >= TOWER_COST;
  const color = !build ? C_BAD : afford ? C_GOOD : C_WARN;
  const x = hoverC * CELL;
  const y = hoverR * CELL;
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = color;
  ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
  if (build) {
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + CELL / 2, y + CELL / 2, RANGE, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTower(tw: Tower): void {
  const x = (tw.c + 0.5) * CELL;
  const y = (tw.r + 0.5) * CELL;
  ctx.save();
  ctx.fillStyle = C_TOWER_BASE;
  roundRect(x - TOWER_R, y - TOWER_R, TOWER_R * 2, TOWER_R * 2, 6);
  ctx.fill();
  ctx.fillStyle = tw.flash > 0 ? '#ffffff' : C_TOWER;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = POLE[polarity]!.color; // shows which pole it currently targets
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEnemy(e: Enemy): void {
  const col = POLE[e.color]!.color;
  ctx.save();
  ctx.fillStyle = col;
  ctx.strokeStyle = C_BG;
  ctx.lineWidth = 2;
  if (e.color === 0) {
    ctx.beginPath();
    ctx.arc(e.x, e.y, ENEMY_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(e.x, e.y - ENEMY_R);
    ctx.lineTo(e.x + ENEMY_R, e.y);
    ctx.lineTo(e.x, e.y + ENEMY_R);
    ctx.lineTo(e.x - ENEMY_R, e.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  if (e.color !== polarity) {
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(e.x, e.y, ENEMY_R + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const bw = ENEMY_R * 2;
  const frac = Math.max(0, e.hp / e.maxHp);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(e.x - bw / 2, e.y - ENEMY_R - 9, bw, 4);
  ctx.fillStyle = frac > 0.4 ? C_GOOD : C_WARN;
  ctx.fillRect(e.x - bw / 2, e.y - ENEMY_R - 9, bw * frac, 4);
  ctx.restore();
}

function drawBeams(): void {
  for (const b of beams) {
    const a = Math.max(0, b.life / BEAM_LIFE);
    ctx.save();
    ctx.strokeStyle = POLE[b.color]!.color;
    ctx.globalAlpha = 0.35 + a * 0.6;
    ctx.lineWidth = 2 + a * 2;
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
    ctx.restore();
  }
}

// Drawn BEHIND towers/enemies so it never hides a tower built near the
// entrance (top-left is prime build real estate).
function drawPoleBadge(): void {
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.font = '600 12px Inter, system-ui, sans-serif';
  const label = `KULELER: ${POLE[polarity]!.name.toUpperCase()}`;
  const lw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  roundRect(8, 8, lw + 34, 24, 7);
  ctx.fill();
  ctx.fillStyle = POLE[polarity]!.color;
  ctx.beginPath();
  ctx.arc(21, 20, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C_TEXT;
  ctx.fillText(label, 32, 12);
  ctx.restore();
}

function drawFrame(): void {
  ctx.save();
  ctx.strokeStyle = POLE[polarity]!.color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
  ctx.restore();
}

function drawPrepBanner(): void {
  if (!(state === 'playing' && phase === 'prep')) return;
  const secs = Math.ceil(Math.max(0, prepTimer));
  const msg =
    wave === 1 ? `Kuleleri yerleştir — Dalga 1: ${secs}s` : `Dalga ${wave} başlıyor: ${secs}s`;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.font = '600 15px Inter, system-ui, sans-serif';
  const mw = ctx.measureText(msg).width;
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  roundRect(W / 2 - mw / 2 - 14, 40, mw + 28, 30, 8);
  ctx.fill();
  ctx.fillStyle = C_TEXT;
  ctx.fillText(msg, W / 2, 47);
  ctx.font = '500 11px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#9aa3b2';
  ctx.fillText('Enter ile hemen başlat', W / 2, 74);
  ctx.restore();
}

function draw(): void {
  drawBoard();
  drawPoleBadge();
  drawCore();
  drawHover();
  for (const tw of towers) drawTower(tw);
  for (const e of enemies) drawEnemy(e);
  drawBeams();
  drawFrame();
  drawPrepBanner();
}

function loop(ts: number, myGen: number): void {
  if (!gen.isCurrent(myGen) || state !== 'playing') return;
  if (!lastTs) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.05) dt = 0.05; // clamp first frame / tab switch
  update(dt);
  if (state === 'playing') {
    draw();
    rafId = requestAnimationFrame((t) => loop(t, myGen));
  }
}

// --- Lifecycle ----------------------------------------------------------
function startGame(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  enemies = [];
  towers = [];
  beams = [];
  queue = [];
  nextId = 0;
  spawnTimer = 0;
  coreHurt = 0;
  polarity = 0;
  state = 'playing';
  setGold(START_GOLD);
  setLives(START_LIVES);
  updatePolarityBtn();
  hideOverlay(overlay);
  beginPrep(1);
  draw();
  lastTs = 0;
  const myGen = gen.current();
  rafId = requestAnimationFrame((t) => loop(t, myGen));
}

function endGame(won: boolean): void {
  state = won ? 'won' : 'gameover';
  gen.bump();
  cancelAnimationFrame(rafId);
  draw();
  reportGameOver(SCORE_DESC, best, { label: 'Dalga' });
  if (won) {
    overlayTitle.textContent = 'Çekirdek Güvende!';
    overlayMsg.textContent =
      `${TOTAL_WAVES} dalganın hepsini savuşturdun.\n` +
      `Kalan çekirdek: ${Math.max(0, lives)}\n\nEn iyi: Dalga ${best}`;
    overlayBtn.textContent = 'Tekrar oyna';
  } else {
    overlayTitle.textContent = 'Çekirdek Düştü';
    overlayMsg.textContent = `${wave}. dalgada düştün.\nEn iyi: Dalga ${best}\n\nTekrar dene.`;
    overlayBtn.textContent = 'Tekrar dene';
  }
  showOverlay(overlay);
}

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  state = 'ready';
  phase = 'prep';
  enemies = [];
  towers = [];
  beams = [];
  queue = [];
  polarity = 0;
  coreHurt = 0;
  hoverC = -1;
  hoverR = -1;
  setGold(START_GOLD);
  setLives(START_LIVES);
  setWave(0);
  updatePolarityBtn();
  draw();
  overlayTitle.textContent = 'Polarite Savunması';
  overlayMsg.textContent =
    'Çekirdeği koru. Düşmanlar iki kutupludur: kırmızı ● ve mavi ◆.\n' +
    'Kuleler YALNIZCA aktif kutuptaki düşmanı vurur; diğer kutup kalkanlıdır.\n\n' +
    `Boşluk: kutbu değiştir · Boş kareye tıkla: kule kur (${TOWER_COST} altın)` +
    (best > 0 ? `\n\nEn iyi: Dalga ${best}` : '');
  showOverlay(overlay);
}

function flipPolarity(): void {
  if (state !== 'playing') return;
  polarity = 1 - polarity;
  updatePolarityBtn();
  draw();
}

// --- Input --------------------------------------------------------------
function toCell(e: PointerEvent): { c: number; r: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  const y = ((e.clientY - rect.top) / rect.height) * H;
  return { c: Math.floor(x / CELL), r: Math.floor(y / CELL) };
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const { c, r } = toCell(e);
  placeTower(c, r);
}

function onPointerMove(e: PointerEvent): void {
  const { c, r } = toCell(e);
  hoverC = c;
  hoverR = r;
}

function onPointerLeave(): void {
  hoverC = -1;
  hoverR = -1;
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === ' ' || k === 'Spacebar') {
    e.preventDefault();
    if (state === 'playing') flipPolarity();
    else startGame();
  } else if (k === 'Enter') {
    e.preventDefault();
    if (state === 'playing' && phase === 'prep') prepTimer = 0;
    else if (state !== 'playing') startGame();
  } else if (k === 'r' || k === 'R') {
    e.preventDefault();
    startGame();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  goldEl = document.querySelector<HTMLElement>('#gold')!;
  waveEl = document.querySelector<HTMLElement>('#wave')!;
  polarityBtn = document.querySelector<HTMLButtonElement>('#polarity')!;
  polarityLabel = document.querySelector<HTMLElement>('#polarity-label')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  overlayBtn.addEventListener('click', startGame);
  polarityBtn.addEventListener('click', flipPolarity);
  restartBtn.addEventListener('click', startGame);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
