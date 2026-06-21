import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay, isOverlayHidden } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Karga — Ezop'tan ilham bir hacim-yer değiştirme bulmacası. Tüpün şekli her
// bölümde değişir; oyuncu çakıl türlerini (küçük/orta/büyük) doğru kombinde
// atarak su seviyesini hedef bandının içine oturtmaya çalışır.
//
// PITFALLS izlendi:
// - unguarded-storage: tüm localStorage erişimi @shared/storage'tan.
// - overlay-input-leak: phase enum'u her handler'ın ilk satırında kontrol.
// - stale-async-callback: gen-token ile RAF zincirleri reset'te kesilir.
// - module-level-dom-access: tüm DOM/event bağlama init() içinde.
// - missing-overlay-css: per-game CSS .overlay--hidden ve .overlay tanımlı.
// - visual-vs-hitbox: hedef bandı ve cork pozisyonu aynı model y'sinden okunur.

const STORAGE_BEST = 'karga.best';

// Canvas / tube geometry.
const CANVAS_W = 480;
const CANVAS_H = 540;
const TUBE_TOP_Y = 40;
const TUBE_BOTTOM_Y = 480;
const TUBE_CX = 240;
const TUBE_PIXEL_H = TUBE_BOTTOM_Y - TUBE_TOP_Y;

// Volume model. Profile y'ları 0..MODEL_H (0 = tüp tabanı, MODEL_H = ağız).
const MODEL_H = 400;
const RENDER_SCALE = TUBE_PIXEL_H / MODEL_H;

// Çakıl hacimleri (model area unit). Tüp ortalama yarıçapı ~70 (genişlik 140)
// olduğunda küçük çakıl ~12 model birimi su yükseltir, büyük ~64 birim.
type PebbleSize = 'small' | 'medium' | 'large';
const PEBBLE_VOL: Record<PebbleSize, number> = {
  small: 1600,
  medium: 4800,
  large: 9600,
};
const PEBBLE_R: Record<PebbleSize, number> = {
  small: 7,
  medium: 11,
  large: 16,
};
const PEBBLE_TINT: Record<PebbleSize, string> = {
  small: '#b89a72',
  medium: '#8c7048',
  large: '#5e4628',
};

interface LevelDef {
  profile: Array<[number, number]>; // sorted ascending by y; (y, halfWidth)
  waterStart: number;
  targetLow: number;
  targetHigh: number;
  pebbles: Record<PebbleSize, number>;
  name: string;
  hint: string;
}

// Difficulty tuned so each level has at least two combinations that win, but
// the easy/lazy combo (all bigs, or all smalls) misses the band — player
// must think.
const LEVELS: LevelDef[] = [
  {
    profile: [
      [0, 80],
      [400, 80],
    ],
    waterStart: 60,
    targetLow: 210,
    targetHigh: 260,
    pebbles: { small: 4, medium: 3, large: 2 },
    name: 'Silindir',
    hint: 'Düz tüp. Hacim eşit dağılır — bir kombin dene.',
  },
  {
    profile: [
      [0, 50],
      [200, 60],
      [400, 120],
    ],
    waterStart: 40,
    targetLow: 280,
    targetHigh: 330,
    pebbles: { small: 3, medium: 4, large: 2 },
    name: 'Genişleyen ağız',
    hint: 'Üst kısım daha geniş — yukarı çıktıkça çakıl daha az su kaldırır.',
  },
  {
    profile: [
      [0, 110],
      [260, 100],
      [400, 40],
    ],
    waterStart: 60,
    targetLow: 290,
    targetHigh: 340,
    pebbles: { small: 4, medium: 2, large: 1 },
    name: 'Daralan boyun',
    hint: 'Boğaz daralıyor. Tepede küçük çakıl bile büyük yükseliş yapar.',
  },
  {
    profile: [
      [0, 90],
      [150, 35],
      [250, 35],
      [400, 90],
    ],
    waterStart: 40,
    targetLow: 290,
    targetHigh: 340,
    pebbles: { small: 4, medium: 3, large: 1 },
    name: 'Kum saati',
    hint: 'Belde tüp daralır. Geçişte tek bir küçük çakıl bile bandı atlatabilir.',
  },
  {
    profile: [
      [0, 55],
      [120, 110],
      [280, 110],
      [400, 50],
    ],
    waterStart: 50,
    targetLow: 320,
    targetHigh: 360,
    pebbles: { small: 4, medium: 3, large: 2 },
    name: 'Şişe karnı',
    hint: 'Karın geniş, boyun dar — boyna çıkarken hassaslaş.',
  },
  {
    profile: [
      [0, 110],
      [400, 36],
    ],
    waterStart: 50,
    targetLow: 290,
    targetHigh: 325,
    pebbles: { small: 3, medium: 2, large: 1 },
    name: 'Huni',
    hint: 'Her seviye daha dar. Hassas planlama gerekir.',
  },
  {
    profile: [
      [0, 100],
      [180, 100],
      [220, 50],
      [400, 50],
    ],
    waterStart: 40,
    targetLow: 290,
    targetHigh: 325,
    pebbles: { small: 3, medium: 3, large: 1 },
    name: 'Basamak',
    hint: 'Tüp ortada keskin bir basamakla daralır — basamağı bilerek geç.',
  },
  {
    profile: [
      [0, 70],
      [80, 38],
      [160, 95],
      [240, 50],
      [320, 95],
      [400, 50],
    ],
    waterStart: 30,
    targetLow: 335,
    targetHigh: 370,
    pebbles: { small: 4, medium: 3, large: 2 },
    name: 'Labirent',
    hint: 'Dalga dalga değişen kesit. Büyükle başla, küçükle ayarla.',
  },
];

type Phase =
  | 'intro'
  | 'ready'
  | 'playing'
  | 'animating'
  | 'won'
  | 'lost'
  | 'campaign-over';

const gen = createGenToken();

let phase: Phase = 'intro';
let levelIdx = 0;
let level: LevelDef = LEVELS[0]!;
let cumVol = new Float64Array(MODEL_H + 1);
let waterStartVol = 0;
let displacedVol = 0;
let waterLevel = 0; // model y, current (animated)
let waterTarget = 0; // model y, target after most recent pebble
let remaining: Record<PebbleSize, number> = { small: 0, medium: 0, large: 0 };
let droppedInLevel: Array<{ size: PebbleSize; x: number; y: number }> = [];
let fallingPebble:
  | { size: PebbleSize; x: number; y: number; vy: number; targetY: number }
  | null = null;
let runScore = 0;
let bestLevelStored = 0;
let rafId = 0;

// DOM
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayBody!: HTMLElement;
let pebbleBtn: Record<PebbleSize, HTMLButtonElement> = {} as never;
let countEl: Record<PebbleSize, HTMLElement> = {} as never;

// ---------- Numeric helpers (volume model) ----------

function halfWidthAt(y: number): number {
  const profile = level.profile;
  if (y <= profile[0]![0]) return profile[0]![1];
  const last = profile[profile.length - 1]!;
  if (y >= last[0]) return last[1];
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i]!;
    const b = profile[i + 1]!;
    if (y >= a[0] && y <= b[0]) {
      const dy = b[0] - a[0];
      if (dy === 0) return b[1];
      const t = (y - a[0]) / dy;
      return a[1] * (1 - t) + b[1] * t;
    }
  }
  return last[1];
}

function buildCumVol(): void {
  const N = MODEL_H + 1;
  cumVol = new Float64Array(N);
  let acc = 0;
  cumVol[0] = 0;
  let prevW = 2 * halfWidthAt(0);
  for (let y = 1; y < N; y++) {
    const w = 2 * halfWidthAt(y);
    acc += (prevW + w) / 2;
    cumVol[y] = acc;
    prevW = w;
  }
}

function levelAtVol(totalVol: number): number {
  // Returns model y for given cumulative water volume. May exceed MODEL_H
  // (overflow) — caller checks.
  const max = cumVol[MODEL_H]!;
  if (totalVol <= 0) return 0;
  if (totalVol >= max) {
    // Beyond tube: linear extrapolate with mouth width so cork visibly rises
    // out of the tube before we flag overflow.
    const wMouth = 2 * halfWidthAt(MODEL_H);
    return MODEL_H + (totalVol - max) / Math.max(1, wMouth);
  }
  let lo = 0;
  let hi = MODEL_H;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumVol[mid]! < totalVol) lo = mid;
    else hi = mid;
  }
  const v0 = cumVol[lo]!;
  const v1 = cumVol[hi]!;
  const dv = v1 - v0;
  const t = dv > 0 ? (totalVol - v0) / dv : 0;
  return lo + t;
}

function modelYtoCanvas(my: number): number {
  return TUBE_BOTTOM_Y - my * RENDER_SCALE;
}

// ---------- Rendering ----------

const cssCache = new Map<string, string>();
function readVar(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const val = v || fallback;
  cssCache.set(name, val);
  return val;
}

function tubePath(): Path2D {
  const path = new Path2D();
  const profile = level.profile;
  // Walk up the right side, down the left.
  const first = profile[0]!;
  path.moveTo(TUBE_CX + first[1], modelYtoCanvas(first[0]));
  for (let i = 1; i < profile.length; i++) {
    const p = profile[i]!;
    path.lineTo(TUBE_CX + p[1], modelYtoCanvas(p[0]));
  }
  for (let i = profile.length - 1; i >= 0; i--) {
    const p = profile[i]!;
    path.lineTo(TUBE_CX - p[1], modelYtoCanvas(p[0]));
  }
  path.closePath();
  return path;
}

function waterPath(level0: number): Path2D {
  const path = new Path2D();
  const profile = level.profile;
  const yCap = Math.min(level0, MODEL_H);
  const samples: number[] = [];
  // Profile y's at or below yCap.
  for (const p of profile) {
    if (p[0] < yCap) samples.push(p[0]);
  }
  samples.push(yCap);
  // Right side bottom→top.
  const yBase = 0;
  path.moveTo(TUBE_CX + halfWidthAt(yBase), modelYtoCanvas(yBase));
  for (const y of samples) {
    path.lineTo(TUBE_CX + halfWidthAt(y), modelYtoCanvas(y));
  }
  // Across surface left.
  path.lineTo(TUBE_CX - halfWidthAt(yCap), modelYtoCanvas(yCap));
  // Left side top→bottom.
  for (let i = samples.length - 2; i >= 0; i--) {
    const y = samples[i]!;
    path.lineTo(TUBE_CX - halfWidthAt(y), modelYtoCanvas(y));
  }
  path.lineTo(TUBE_CX - halfWidthAt(yBase), modelYtoCanvas(yBase));
  path.closePath();
  return path;
}

function bandPath(): Path2D {
  // Filled band: closed quad following tube walls between targetLow..targetHigh.
  const path = new Path2D();
  const profile = level.profile;
  const yLo = level.targetLow;
  const yHi = level.targetHigh;
  const samples: number[] = [yLo];
  for (const p of profile) {
    if (p[0] > yLo && p[0] < yHi) samples.push(p[0]);
  }
  samples.push(yHi);
  // Right side bottom→top.
  for (let i = 0; i < samples.length; i++) {
    const y = samples[i]!;
    const x = TUBE_CX + halfWidthAt(y);
    const cy = modelYtoCanvas(y);
    if (i === 0) path.moveTo(x, cy);
    else path.lineTo(x, cy);
  }
  // Left side top→bottom.
  for (let i = samples.length - 1; i >= 0; i--) {
    const y = samples[i]!;
    path.lineTo(TUBE_CX - halfWidthAt(y), modelYtoCanvas(y));
  }
  path.closePath();
  return path;
}

function drawBackground(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, readVar('--bg', '#0a0b0e'));
  grad.addColorStop(1, '#0f1116');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Subtle ground line (well rim) and faint texture dots.
  ctx.strokeStyle = 'rgba(80,72,55,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, TUBE_BOTTOM_Y + 24);
  ctx.lineTo(CANVAS_W, TUBE_BOTTOM_Y + 24);
  ctx.stroke();
}

function drawTube(): void {
  const tube = tubePath();
  // Inner glass tint.
  ctx.fillStyle = 'rgba(110, 140, 170, 0.05)';
  ctx.fill(tube);

  // Hedef bandı — su yokken bile görünür, water'ın üstünde de görünecek.
  const band = bandPath();
  ctx.fillStyle = 'rgba(125, 216, 122, 0.16)';
  ctx.fill(band);
  ctx.strokeStyle = 'rgba(125, 216, 122, 0.65)';
  ctx.setLineDash([4, 5]);
  ctx.lineWidth = 1.5;
  // Tek tek band kenarlarını çiz (üst+alt çizgi).
  for (const y of [level.targetLow, level.targetHigh]) {
    ctx.beginPath();
    ctx.moveTo(TUBE_CX - halfWidthAt(y), modelYtoCanvas(y));
    ctx.lineTo(TUBE_CX + halfWidthAt(y), modelYtoCanvas(y));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Tube outline (drawn AFTER band/water so glass edge stays crisp).
  ctx.strokeStyle = readVar('--border', '#2a2d33');
  ctx.lineWidth = 2.5;
  ctx.stroke(tube);

  // Glossy highlight stripe on left.
  ctx.save();
  ctx.clip(tube);
  const profile = level.profile;
  const topY = modelYtoCanvas(profile[profile.length - 1]![0]);
  const botY = modelYtoCanvas(profile[0]![0]);
  const glossGrad = ctx.createLinearGradient(0, topY, 0, botY);
  glossGrad.addColorStop(0, 'rgba(255,255,255,0.06)');
  glossGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glossGrad;
  ctx.fillRect(TUBE_CX - 120, topY, 16, botY - topY);
  ctx.restore();
}

function drawWaterAndContents(): void {
  if (waterLevel <= 0 && droppedInLevel.length === 0) return;
  const tube = tubePath();
  ctx.save();
  ctx.clip(tube);

  if (waterLevel > 0) {
    const water = waterPath(waterLevel);
    const surfaceY = modelYtoCanvas(Math.min(waterLevel, MODEL_H));
    const grad = ctx.createLinearGradient(0, surfaceY, 0, TUBE_BOTTOM_Y);
    grad.addColorStop(0, 'rgba(94, 168, 224, 0.85)');
    grad.addColorStop(1, 'rgba(38, 92, 150, 0.95)');
    ctx.fillStyle = grad;
    ctx.fill(water);

    // Surface highlight line.
    ctx.strokeStyle = 'rgba(180, 220, 245, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(TUBE_CX - halfWidthAt(waterLevel) + 2, surfaceY);
    ctx.lineTo(TUBE_CX + halfWidthAt(waterLevel) - 2, surfaceY);
    ctx.stroke();
  }

  // Settled pebbles.
  for (const p of droppedInLevel) {
    const r = PEBBLE_R[p.size];
    const cx = p.x;
    const cy = p.y;
    const grad = ctx.createRadialGradient(
      cx - r * 0.3,
      cy - r * 0.3,
      r * 0.15,
      cx,
      cy,
      r,
    );
    grad.addColorStop(0, '#dcc4a0');
    grad.addColorStop(0.6, PEBBLE_TINT[p.size]);
    grad.addColorStop(1, '#2a1d0d');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCork(): void {
  // Cork floats AT water surface.
  const yc = Math.min(waterLevel, MODEL_H);
  const surfaceY = modelYtoCanvas(yc);
  // Cork width: ~70% of tube interior, clamped.
  const innerHalf = halfWidthAt(yc);
  if (innerHalf <= 8) return;
  const corkHalf = Math.max(10, Math.min(innerHalf - 4, 36));
  const corkH = 14;
  const inBand = yc >= level.targetLow && yc <= level.targetHigh;
  // Body
  ctx.save();
  ctx.fillStyle = '#c98c3a';
  ctx.strokeStyle = inBand ? '#7dd87a' : '#3b2a14';
  ctx.lineWidth = inBand ? 2.5 : 1.6;
  ctx.beginPath();
  const x0 = TUBE_CX - corkHalf;
  const x1 = TUBE_CX + corkHalf;
  const y0 = surfaceY - corkH;
  const y1 = surfaceY;
  const r = 5;
  ctx.moveTo(x0 + r, y0);
  ctx.lineTo(x1 - r, y0);
  ctx.quadraticCurveTo(x1, y0, x1, y0 + r);
  ctx.lineTo(x1, y1 - r);
  ctx.quadraticCurveTo(x1, y1, x1 - r, y1);
  ctx.lineTo(x0 + r, y1);
  ctx.quadraticCurveTo(x0, y1, x0, y1 - r);
  ctx.lineTo(x0, y0 + r);
  ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Cork band lines.
  ctx.strokeStyle = 'rgba(58, 36, 14, 0.55)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    const y = y0 + (corkH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(x0 + 3, y);
    ctx.lineTo(x1 - 3, y);
    ctx.stroke();
  }
  ctx.restore();

  // Crow perched above the cork on the tube rim — visual flavor only.
  drawCrow();
}

function drawCrow(): void {
  const profile = level.profile;
  const topY = profile[profile.length - 1]![0];
  const topHw = profile[profile.length - 1]![1];
  const px = TUBE_CX + topHw + 14;
  const py = modelYtoCanvas(topY) - 10;
  ctx.save();
  ctx.fillStyle = '#0c0d12';
  // Body
  ctx.beginPath();
  ctx.ellipse(px, py, 14, 9, -0.18, 0, Math.PI * 2);
  ctx.fill();
  // Head
  ctx.beginPath();
  ctx.arc(px - 11, py - 6, 6, 0, Math.PI * 2);
  ctx.fill();
  // Beak
  ctx.fillStyle = '#d3a64b';
  ctx.beginPath();
  ctx.moveTo(px - 17, py - 5);
  ctx.lineTo(px - 24, py - 4);
  ctx.lineTo(px - 17, py - 2);
  ctx.closePath();
  ctx.fill();
  // Eye
  ctx.fillStyle = '#f4f4f6';
  ctx.beginPath();
  ctx.arc(px - 12, py - 7, 1.3, 0, Math.PI * 2);
  ctx.fill();
  // Tail
  ctx.fillStyle = '#0c0d12';
  ctx.beginPath();
  ctx.moveTo(px + 12, py - 1);
  ctx.lineTo(px + 22, py - 6);
  ctx.lineTo(px + 22, py + 4);
  ctx.closePath();
  ctx.fill();
  // Foot
  ctx.strokeStyle = '#d3a64b';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(px - 2, py + 8);
  ctx.lineTo(px - 2, py + 14);
  ctx.moveTo(px + 4, py + 8);
  ctx.lineTo(px + 4, py + 14);
  ctx.stroke();
  ctx.restore();
}

function drawFallingPebble(): void {
  if (!fallingPebble) return;
  const r = PEBBLE_R[fallingPebble.size];
  const cx = fallingPebble.x;
  const cy = fallingPebble.y;
  const grad = ctx.createRadialGradient(
    cx - r * 0.3,
    cy - r * 0.3,
    r * 0.15,
    cx,
    cy,
    r,
  );
  grad.addColorStop(0, '#e6d2ad');
  grad.addColorStop(0.65, PEBBLE_TINT[fallingPebble.size]);
  grad.addColorStop(1, '#1d1308');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function draw(): void {
  drawBackground();
  drawTube();
  drawWaterAndContents();
  drawCork();
  drawFallingPebble();
  drawLevelLabel();
}

function drawLevelLabel(): void {
  ctx.save();
  ctx.fillStyle = readVar('--text-dim', '#7d8290');
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(level.name, 16, 24);
  ctx.fillStyle = 'rgba(125, 216, 122, 0.85)';
  ctx.textAlign = 'right';
  ctx.fillText('Hedef', CANVAS_W - 16, 24);
  ctx.restore();
}

// ---------- HUD ----------

function updateHud(): void {
  levelEl.textContent = `${levelIdx + 1}/${LEVELS.length}`;
  bestEl.textContent = String(bestLevelStored);
  for (const size of ['small', 'medium', 'large'] as PebbleSize[]) {
    countEl[size].textContent = String(remaining[size]);
    const disabled =
      remaining[size] <= 0 ||
      phase !== 'playing' ||
      !isOverlayHidden(overlay);
    pebbleBtn[size].disabled = disabled;
  }
}

function setOverlay(title: string, body: string): void {
  overlayTitle.textContent = title;
  overlayBody.innerHTML = body;
  showOverlay(overlay);
  updateHud();
}

function hideOverlayUi(): void {
  hideOverlay(overlay);
  updateHud();
}

// ---------- Level lifecycle ----------

function loadLevel(idx: number): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  fallingPebble = null;
  droppedInLevel = [];
  levelIdx = idx;
  level = LEVELS[idx]!;
  buildCumVol();
  waterStartVol = cumVol[level.waterStart]!;
  displacedVol = 0;
  waterLevel = level.waterStart;
  waterTarget = waterLevel;
  remaining = { ...level.pebbles };
  phase = 'ready';
  setOverlay(
    `Bölüm ${idx + 1} · ${level.name}`,
    `${level.hint}<br/><br/>
    <strong>Envanter:</strong> ${level.pebbles.small} küçük · ${level.pebbles.medium} orta · ${level.pebbles.large} büyük.<br/>
    Boşluk veya tıkla: başla.`,
  );
  draw();
}

function startLevel(): void {
  phase = 'playing';
  hideOverlayUi();
  draw();
}

function awardLevel(): void {
  const left = remaining.small + remaining.medium + remaining.large;
  const gain = 100 + 12 * left;
  runScore += gain;
  if (levelIdx + 1 > bestLevelStored) {
    bestLevelStored = levelIdx + 1;
    safeWrite(STORAGE_BEST, bestLevelStored);
  }
}

function winLevel(): void {
  awardLevel();
  if (levelIdx + 1 >= LEVELS.length) {
    phase = 'campaign-over';
    setOverlay(
      'Karga doydu!',
      `Tüm 8 bölümü tamamladın · toplam <strong>${runScore}</strong> puan.<br/>
      Boşluk: tekrar oyna.`,
    );
  } else {
    phase = 'won';
    const left = remaining.small + remaining.medium + remaining.large;
    setOverlay(
      `+${100 + 12 * left} · Bölüm bitti`,
      `Mantar tam bandın içine oturdu — kalan çakıl: <strong>${left}</strong>.<br/>
      Boşluk: sonraki bölüm.`,
    );
  }
  draw();
}

function loseLevel(reason: 'overflow' | 'short'): void {
  phase = 'lost';
  const msg =
    reason === 'overflow'
      ? 'Mantar bandı geçti — karga boğuldu.'
      : 'Çakıl bitti, mantar hâlâ yeşil bandın altında — karga susuz kaldı.';
  setOverlay(
    'Tekrar dene',
    `${msg}<br/>
    Boşluk: bölümü tekrar dene · "Yeniden başla": baştan al.`,
  );
  draw();
}

// ---------- Pebble drop animation ----------

function tryDrop(size: PebbleSize): void {
  if (phase !== 'playing') return;
  if (remaining[size] <= 0) return;
  remaining[size]--;
  phase = 'animating';

  // Determine spawn x with small jitter for visual interest.
  const mouthHw = halfWidthAt(MODEL_H);
  const jitter = (Math.random() - 0.5) * Math.max(8, mouthHw - 14);
  const startY = TUBE_TOP_Y - 30;
  // Compute target volume / new water level.
  const newDisplaced = displacedVol + PEBBLE_VOL[size];
  const newWaterLevel = levelAtVol(waterStartVol + newDisplaced);
  // Target canvas y: water surface AFTER pebble lands. Pebble disappears into
  // water at the current surface, then water rises to new level.
  const currentSurfaceY = modelYtoCanvas(Math.min(waterLevel, MODEL_H));
  fallingPebble = {
    size,
    x: TUBE_CX + jitter,
    y: startY,
    vy: 0,
    targetY: currentSurfaceY,
  };
  displacedVol = newDisplaced;
  waterTarget = newWaterLevel;
  updateHud();
  animateDrop();
}

function animateDrop(): void {
  const myGen = gen.current();
  let lastT = performance.now();
  let waterRising = false;
  let riseStartLevel = waterLevel;
  let riseStartT = 0;
  const RISE_MS = 380;

  const step = (now: number) => {
    if (!gen.isCurrent(myGen)) return;
    const dt = Math.min(48, now - lastT);
    lastT = now;

    if (!waterRising && fallingPebble) {
      // Gravity. Tuned so a fall takes ~0.5s feel.
      fallingPebble.vy += 0.0028 * dt * 60;
      fallingPebble.y += fallingPebble.vy * dt;
      if (fallingPebble.y >= fallingPebble.targetY) {
        fallingPebble.y = fallingPebble.targetY;
        // Record a settled pebble in the water column near the bottom.
        const size = fallingPebble.size;
        const tubeBaseHw = halfWidthAt(0);
        const jitterX = (Math.random() - 0.5) * Math.max(8, tubeBaseHw - 12);
        const stackY =
          TUBE_BOTTOM_Y -
          PEBBLE_R[size] -
          Math.random() * 6 -
          droppedInLevel.length * 1.4;
        droppedInLevel.push({
          size,
          x: TUBE_CX + jitterX,
          y: stackY,
        });
        fallingPebble = null;
        waterRising = true;
        riseStartLevel = waterLevel;
        riseStartT = now;
      }
    } else if (waterRising) {
      const t = Math.min(1, (now - riseStartT) / RISE_MS);
      // Ease-out cubic.
      const k = 1 - Math.pow(1 - t, 3);
      waterLevel = riseStartLevel + (waterTarget - riseStartLevel) * k;
      if (t >= 1) {
        waterLevel = waterTarget;
        finishDrop();
        return;
      }
    }
    draw();
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function finishDrop(): void {
  draw();
  // Decide outcome.
  if (waterLevel > level.targetHigh) {
    loseLevel('overflow');
    return;
  }
  if (waterLevel >= level.targetLow && waterLevel <= level.targetHigh) {
    winLevel();
    return;
  }
  // Below band — continue.
  const totalLeft =
    remaining.small + remaining.medium + remaining.large;
  if (totalLeft <= 0) {
    loseLevel('short');
    return;
  }
  phase = 'playing';
  updateHud();
}

// ---------- Input handlers ----------

function advanceOverlay(): void {
  if (phase === 'ready') {
    startLevel();
    return;
  }
  if (phase === 'won') {
    loadLevel(levelIdx + 1);
    return;
  }
  if (phase === 'lost') {
    loadLevel(levelIdx);
    return;
  }
  if (phase === 'campaign-over') {
    runScore = 0;
    loadLevel(0);
    return;
  }
  if (phase === 'intro') {
    runScore = 0;
    loadLevel(0);
    return;
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    fullRestart();
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    if (
      phase === 'ready' ||
      phase === 'won' ||
      phase === 'lost' ||
      phase === 'campaign-over' ||
      phase === 'intro'
    ) {
      advanceOverlay();
      e.preventDefault();
      return;
    }
  }
  if (phase !== 'playing') return;
  if (e.key === '1') {
    tryDrop('small');
    e.preventDefault();
  } else if (e.key === '2') {
    tryDrop('medium');
    e.preventDefault();
  } else if (e.key === '3') {
    tryDrop('large');
    e.preventDefault();
  }
}

function onOverlayPointer(e: PointerEvent): void {
  if (
    phase === 'ready' ||
    phase === 'won' ||
    phase === 'lost' ||
    phase === 'campaign-over' ||
    phase === 'intro'
  ) {
    advanceOverlay();
    e.preventDefault();
  }
}

function fullRestart(): void {
  runScore = 0;
  loadLevel(0);
}

function reset(): void {
  fullRestart();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayBody = document.querySelector<HTMLElement>('#overlay-body')!;
  pebbleBtn = {
    small: document.querySelector<HTMLButtonElement>('#pebble-small')!,
    medium: document.querySelector<HTMLButtonElement>('#pebble-medium')!,
    large: document.querySelector<HTMLButtonElement>('#pebble-large')!,
  };
  countEl = {
    small: document.querySelector<HTMLElement>('#count-small')!,
    medium: document.querySelector<HTMLElement>('#count-medium')!,
    large: document.querySelector<HTMLElement>('#count-large')!,
  };

  bestLevelStored = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', fullRestart);
  pebbleBtn.small.addEventListener('click', () => tryDrop('small'));
  pebbleBtn.medium.addEventListener('click', () => tryDrop('medium'));
  pebbleBtn.large.addEventListener('click', () => tryDrop('large'));
  overlay.addEventListener('pointerdown', onOverlayPointer);
  window.addEventListener('keydown', onKey);

  // Initial intro state.
  phase = 'intro';
  level = LEVELS[0]!;
  buildCumVol();
  waterLevel = level.waterStart;
  waterTarget = waterLevel;
  remaining = { ...level.pebbles };
  setOverlay(
    'Karga',
    `Ezop'tan ilham bir hacim bulmacası. Çakıl atarak suyu yükselt, mantar yeşil banda otursun.<br/>
    Eksikse karga susuz kalır, fazlası mantarı boğar.<br/><br/>
    Boşluk veya tıkla: 1. bölüm.`,
  );
  draw();
}

export const game = defineGame({ init, reset });
