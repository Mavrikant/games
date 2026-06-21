import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'mengene.best';
const SCORE_DESC = {
  gameId: 'mengene',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

type State = 'intro' | 'clamp' | 'file' | 'result' | 'gameover';
type MaterialKind = 'oak' | 'brass' | 'tile' | 'steel';
type FailReason = 'slip' | 'crack' | 'timeout';

const W = 480;
const H = 360;

const TOTAL_PIECES = 12;
const STARTING_LIVES = 3;
const FILE_SECONDS = 9;
const RESULT_SECONDS = 1.1;

const PIECE_X = 130;
const PIECE_Y = 178;
const PIECE_W = 220;
const PIECE_H = 56;
const EDGE_PAD = 14;
const LEFT_MARK = PIECE_X + EDGE_PAD;
const RIGHT_MARK = PIECE_X + PIECE_W - EDGE_PAD;
const STROKE_MIN_SPAN = (RIGHT_MARK - LEFT_MARK) * 0.86;
const FILE_OVERSPEED_PX_PER_SEC = 1700;

const GAUGE_X = 40;
const GAUGE_Y = 300;
const GAUGE_W = 400;
const GAUGE_H = 30;

interface MaterialDef {
  label: string;
  bodyFill: string;
  bodyHi: string;
  bodyLo: string;
  baseStrokes: number;
  bandLow: number;
  bandHigh: number;
  difficultyMul: number;
  shavingColor: string;
}

const MATERIALS: Record<MaterialKind, MaterialDef> = {
  oak: {
    label: 'Çıralı Meşe',
    bodyFill: '#b88a4a',
    bodyHi: '#d4a565',
    bodyLo: '#7a5524',
    baseStrokes: 4,
    bandLow: 30,
    bandHigh: 46,
    difficultyMul: 1.0,
    shavingColor: '#d9a86a',
  },
  brass: {
    label: 'Sarı Pirinç',
    bodyFill: '#d3a83a',
    bodyHi: '#f0c958',
    bodyLo: '#7a5b18',
    baseStrokes: 6,
    bandLow: 48,
    bandHigh: 64,
    difficultyMul: 1.3,
    shavingColor: '#f3d063',
  },
  tile: {
    label: 'Fayans',
    bodyFill: '#5e90b8',
    bodyHi: '#90b7d5',
    bodyLo: '#33597a',
    baseStrokes: 5,
    bandLow: 38,
    bandHigh: 52,
    difficultyMul: 1.5,
    shavingColor: '#a8c8e2',
  },
  steel: {
    label: 'Sertleştirilmiş Çelik',
    bodyFill: '#9aa2ad',
    bodyHi: '#c7ccd4',
    bodyLo: '#5a6068',
    baseStrokes: 8,
    bandLow: 62,
    bandHigh: 80,
    difficultyMul: 2.0,
    shavingColor: '#e3e7ee',
  },
};

interface Piece {
  kind: MaterialKind;
  bandLow: number;
  bandHigh: number;
  requiredStrokes: number;
}

interface Shaving {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

const gen = createGenToken();

let state: State = 'intro';
let score = 0;
let best = 0;
let lives = STARTING_LIVES;
let roundIndex = 0;
let queue: Piece[] = [];
let current: Piece | null = null;
let streakHits = 0;
let lastBonus = 0;
let lastReleaseForce = 0;
let lastFailReason: FailReason | null = null;
let lastPieceScore = 0;
let resultGood = false;

let charging = false;
let chargeForce = 0;
let chargeRate = 70;

let strokes = 0;
let fileTimer = FILE_SECONDS;
let lastStrokeFlashT = -10;

let dragging = false;
let dragMinX = 0;
let dragMaxX = 0;
let dragDir: 1 | -1 | 0 = 0;
let dragLastX = 0;
let dragLastT = 0;
let shavings: Shaving[] = [];
let warningShakeT = -10;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let roundEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let rafId: number | null = null;
let lastT = 0;
let elapsed = 0;

function rand(): number {
  return Math.random();
}

function pickKind(roundOneBased: number): MaterialKind {
  const t = (roundOneBased - 1) / Math.max(1, TOTAL_PIECES - 1);
  const r = rand();
  if (t < 0.25) {
    if (r < 0.55) return 'oak';
    if (r < 0.85) return 'brass';
    return 'tile';
  }
  if (t < 0.6) {
    if (r < 0.3) return 'oak';
    if (r < 0.6) return 'brass';
    if (r < 0.85) return 'tile';
    return 'steel';
  }
  if (r < 0.15) return 'oak';
  if (r < 0.4) return 'brass';
  if (r < 0.7) return 'tile';
  return 'steel';
}

function buildPiece(roundOneBased: number): Piece {
  const kind = pickKind(roundOneBased);
  const def = MATERIALS[kind];
  const t = (roundOneBased - 1) / Math.max(1, TOTAL_PIECES - 1);
  const shrink = Math.min(5, Math.floor(t * 6));
  const center = (def.bandLow + def.bandHigh) / 2;
  const halfWidth = Math.max(4, (def.bandHigh - def.bandLow) / 2 - shrink / 2);
  const bandLow = Math.max(8, Math.round(center - halfWidth));
  const bandHigh = Math.min(95, Math.round(center + halfWidth));
  const strokes = def.baseStrokes + (t > 0.6 ? 1 : 0);
  return { kind, bandLow, bandHigh, requiredStrokes: strokes };
}

function generateQueue(): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < TOTAL_PIECES; i++) {
    out.push(buildPiece(i + 1));
  }
  return out;
}

function chargeRateForRound(roundOneBased: number): number {
  const t = (roundOneBased - 1) / Math.max(1, TOTAL_PIECES - 1);
  return 70 + t * 40;
}

function streakBonus(): number {
  if (streakHits >= 8) return 3;
  if (streakHits >= 5) return 2;
  if (streakHits >= 3) return 1;
  return 0;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'intro';
  score = 0;
  lives = STARTING_LIVES;
  roundIndex = 0;
  queue = generateQueue();
  current = null;
  streakHits = 0;
  lastBonus = 0;
  lastReleaseForce = 0;
  lastFailReason = null;
  lastPieceScore = 0;
  resultGood = false;
  charging = false;
  chargeForce = 0;
  chargeRate = 70;
  strokes = 0;
  fileTimer = FILE_SECONDS;
  lastStrokeFlashT = -10;
  warningShakeT = -10;
  dragging = false;
  dragDir = 0;
  shavings = [];
  elapsed = 0;
  overlayTitle.textContent = 'Mengene';
  overlayMsg.textContent =
    'Boşluk: sık, ibre yeşil banttayken bırak.\n' +
    'Sürükle: eğeyi parçanın bir kenarından diğerine çek.\n' +
    'Üç parça heba olursa vardiya kapanır.\n' +
    'Başlamak için tıkla veya Enter.';
  showOverlayEl(overlay);
  commitBest();
  syncHUD();
  draw();
  startLoop();
}

function startRound(): void {
  if (roundIndex >= queue.length) {
    endGame(true);
    return;
  }
  current = queue[roundIndex]!;
  state = 'clamp';
  charging = false;
  chargeForce = 0;
  chargeRate = chargeRateForRound(roundIndex + 1);
  strokes = 0;
  fileTimer = FILE_SECONDS;
  shavings = [];
  lastReleaseForce = 0;
  hideOverlayEl(overlay);
  syncHUD();
}

function syncHUD(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent =
    lives > 0
      ? '●'.repeat(lives) + '○'.repeat(STARTING_LIVES - lives)
      : '○'.repeat(STARTING_LIVES);
  const show =
    state === 'intro'
      ? 1
      : state === 'gameover'
        ? Math.min(TOTAL_PIECES, Math.max(1, roundIndex))
        : Math.min(TOTAL_PIECES, roundIndex + 1);
  roundEl.textContent = `${show}/${TOTAL_PIECES}`;
}

function startLoop(): void {
  if (rafId !== null) return;
  lastT = performance.now();
  const token = gen.current();
  const tick = (now: number): void => {
    if (!gen.isCurrent(token)) {
      rafId = null;
      return;
    }
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    elapsed += dt;
    update(dt);
    draw();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function update(dt: number): void {
  if (state === 'clamp') {
    if (charging) {
      chargeForce += chargeRate * dt;
      if (chargeForce >= 100) {
        chargeForce = 100;
        charging = false;
        resolveClamp(100);
      }
    }
  } else if (state === 'file') {
    fileTimer -= dt;
    for (const s of shavings) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 380 * dt;
      s.life -= dt;
    }
    shavings = shavings.filter((s) => s.life > 0);
    if (fileTimer <= 0) {
      fileTimer = 0;
      failPiece('timeout');
    }
  } else if (state === 'result') {
    fileTimer -= dt;
    if (fileTimer <= 0) {
      roundIndex += 1;
      if (lives <= 0) {
        endGame(false);
      } else {
        startRound();
      }
    }
  }
}

function pressClampStart(): void {
  if (state !== 'clamp') return;
  if (charging || chargeForce > 0) return;
  charging = true;
}

function pressClampRelease(): void {
  if (state !== 'clamp' || !charging) return;
  charging = false;
  resolveClamp(chargeForce);
}

function resolveClamp(force: number): void {
  if (!current) return;
  lastReleaseForce = force;
  const lo = current.bandLow;
  const hi = current.bandHigh;
  if (force < lo) {
    failPiece('slip');
    return;
  }
  if (force > hi) {
    failPiece('crack');
    return;
  }
  const center = (lo + hi) / 2;
  const halfWidth = Math.max(1, (hi - lo) / 2);
  const offset = Math.abs(force - center) / halfWidth;
  lastBonus = Math.round(30 * (1 - offset));
  state = 'file';
  strokes = 0;
  fileTimer = FILE_SECONDS;
  dragging = false;
  dragDir = 0;
  syncHUD();
}

function failPiece(reason: FailReason): void {
  if (!current) return;
  lastFailReason = reason;
  lives -= 1;
  streakHits = 0;
  lastBonus = 0;
  lastPieceScore = 0;
  resultGood = false;
  state = 'result';
  fileTimer = RESULT_SECONDS;
  dragging = false;
  syncHUD();
}

function completePiece(): void {
  if (!current) return;
  const def = MATERIALS[current.kind];
  const base = 100;
  const mat = base * def.difficultyMul;
  const precision = lastBonus;
  const streakMul = 1 + streakBonus() * 0.5;
  const total = Math.round((mat + precision) * streakMul);
  score += total;
  lastPieceScore = total;
  streakHits += 1;
  lastFailReason = null;
  resultGood = true;
  commitBest();
  state = 'result';
  fileTimer = RESULT_SECONDS;
  dragging = false;
  syncHUD();
}

function endGame(completed: boolean): void {
  state = 'gameover';
  stopLoop();
  reportGameOver(SCORE_DESC, score);
  overlayTitle.textContent = completed
    ? lives === STARTING_LIVES
      ? 'Vardiya kusursuz!'
      : 'Vardiya tamam'
    : 'Tezgâh kapandı';
  overlayMsg.textContent =
    `Puan: ${score}\nEn iyi: ${best}\nTeslim: ${Math.min(TOTAL_PIECES, roundIndex)} / ${TOTAL_PIECES}\nEnter veya Yeniden başla ile yeni vardiya.`;
  showOverlayEl(overlay);
  syncHUD();
}

// ---------- Drag / file ----------

function canvasCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * W,
    y: ((e.clientY - rect.top) / rect.height) * H,
  };
}

function pointOverPiece(x: number, y: number): boolean {
  // Generous click target — file is drawn above the piece, so accept a band
  // a bit larger than the piece itself.
  return (
    x >= PIECE_X - 30 &&
    x <= PIECE_X + PIECE_W + 30 &&
    y >= PIECE_Y - 24 &&
    y <= PIECE_Y + PIECE_H + 24
  );
}

function startDrag(x: number, y: number): void {
  if (state !== 'file') return;
  if (!pointOverPiece(x, y)) return;
  dragging = true;
  dragMinX = x;
  dragMaxX = x;
  dragDir = 0;
  dragLastX = x;
  dragLastT = elapsed;
  canvas.classList.add('mn-cursor-grabbing');
}

function moveDrag(x: number, _y: number): void {
  if (!dragging) return;
  const now = elapsed;
  const dx = x - dragLastX;
  const dt = Math.max(0.0001, now - dragLastT);
  const speed = Math.abs(dx) / dt;
  if (speed > FILE_OVERSPEED_PX_PER_SEC && Math.abs(dx) > 4) {
    warningShakeT = elapsed;
    dragMinX = x;
    dragMaxX = x;
    dragDir = 0;
  } else {
    if (x < dragMinX) dragMinX = x;
    if (x > dragMaxX) dragMaxX = x;
    const movingRight = dx > 0.5;
    const movingLeft = dx < -0.5;
    if (movingRight && dragDir !== 1) {
      // Switching to right — start a fresh sweep from current x.
      if (dragDir === -1) {
        evaluateStroke();
        dragMinX = x;
        dragMaxX = x;
      }
      dragDir = 1;
    } else if (movingLeft && dragDir !== -1) {
      if (dragDir === 1) {
        evaluateStroke();
        dragMinX = x;
        dragMaxX = x;
      }
      dragDir = -1;
    }
    // Continuous detection: stroke completes when current sweep touches both edges.
    if (
      dragDir === 1 &&
      x >= RIGHT_MARK &&
      dragMinX <= LEFT_MARK + 6
    ) {
      registerStroke(x);
      dragMinX = x;
      dragMaxX = x;
    } else if (
      dragDir === -1 &&
      x <= LEFT_MARK &&
      dragMaxX >= RIGHT_MARK - 6
    ) {
      registerStroke(x);
      dragMinX = x;
      dragMaxX = x;
    }
  }
  dragLastX = x;
  dragLastT = now;
}

function evaluateStroke(): void {
  // Backup check on direction change or release: if the just-completed
  // sweep covered the full span edge-to-edge, count it.
  const span = dragMaxX - dragMinX;
  if (
    span >= STROKE_MIN_SPAN &&
    dragMinX <= LEFT_MARK + 6 &&
    dragMaxX >= RIGHT_MARK - 6
  ) {
    registerStroke((dragMinX + dragMaxX) / 2);
  }
}

function registerStroke(x: number): void {
  if (!current) return;
  strokes += 1;
  lastStrokeFlashT = elapsed;
  const def = MATERIALS[current.kind];
  const cx = Math.max(LEFT_MARK, Math.min(RIGHT_MARK, x));
  const cy = PIECE_Y + PIECE_H * 0.4;
  for (let i = 0; i < 14; i++) {
    shavings.push({
      x: cx + (rand() - 0.5) * 50,
      y: cy + (rand() - 0.5) * 10,
      vx: (rand() - 0.5) * 90,
      vy: -40 - rand() * 60,
      life: 0.55 + rand() * 0.35,
      color: def.shavingColor,
    });
  }
  if (shavings.length > 220) {
    shavings.splice(0, shavings.length - 220);
  }
  if (strokes >= current.requiredStrokes) {
    completePiece();
  }
}

function endDrag(): void {
  if (!dragging) return;
  dragging = false;
  evaluateStroke();
  dragDir = 0;
  canvas.classList.remove('mn-cursor-grabbing');
}

// ---------- Drawing ----------

function draw(): void {
  drawBench();
  drawJaws();
  drawPiece();
  drawShavings();
  drawFile();
  drawSidePanel();
  drawGauge();
  drawStrokeBar();
  if (state === 'result') drawResultFlash();
}

function drawBench(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#28201a');
  grad.addColorStop(0.5, '#1e1814');
  grad.addColorStop(1, '#14100c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 22; i++) {
    const y = 18 + i * 14 + ((i * 13) % 5);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(120, y + 1, 240, y - 1, 360, y + 1);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, 0, W, 30);
  ctx.fillStyle = '#cfb98a';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('MENGENE TEZGÂHI', 12, 15);
  ctx.textAlign = 'right';
  const phase =
    state === 'clamp'
      ? '1/2  SIK'
      : state === 'file'
        ? '2/2  EĞELE'
        : state === 'result'
          ? '— sonuç —'
          : state === 'gameover'
            ? 'kapalı'
            : 'hazır';
  ctx.fillText(phase, W - 12, 15);
}

function drawJaws(): void {
  let closure = 0;
  if (state === 'clamp') closure = Math.min(1, chargeForce / 100);
  else if (state === 'file' || state === 'result') closure = 1;
  drawJawHardware(PIECE_X, PIECE_Y - 22, PIECE_W, PIECE_H + 44, closure);
}

function drawJawHardware(
  x: number,
  y: number,
  w: number,
  h: number,
  closure: number,
): void {
  ctx.fillStyle = '#0e0a07';
  roundRect(x - 30, y + h - 10, w + 60, 18, 4);
  ctx.fill();
  const baseGrad = ctx.createLinearGradient(0, y + h - 8, 0, y + h + 12);
  baseGrad.addColorStop(0, '#3a3a40');
  baseGrad.addColorStop(1, '#1e1e22');
  ctx.fillStyle = baseGrad;
  roundRect(x - 22, y + h - 16, w + 44, 24, 6);
  ctx.fill();
  drawJaw(x - 6, y + 8, 22, h - 10, '#4a4a52');
  const slideMax = 40;
  const slide = slideMax * (1 - closure);
  drawJaw(x + w - 16 + slide, y + 8, 22, h - 10, '#5a5a62');
  const cx = x + w + slide + 28;
  const cy = y + h * 0.5;
  ctx.strokeStyle = '#bfbfc6';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x + w - 4 + slide, cy);
  ctx.lineTo(cx + 22, cy);
  ctx.stroke();
  const handleAngle =
    state === 'clamp' && charging
      ? (elapsed * 9) % (Math.PI * 2)
      : (closure * Math.PI * 2 * 1.5) % (Math.PI * 2);
  ctx.save();
  ctx.translate(cx + 22, cy);
  ctx.rotate(handleAngle);
  ctx.fillStyle = '#cfcfd6';
  ctx.fillRect(-2, -16, 4, 32);
  ctx.beginPath();
  ctx.arc(0, -16, 4, 0, Math.PI * 2);
  ctx.arc(0, 16, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#8a8a90';
  ctx.fill();
  ctx.restore();
}

function drawJaw(
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  const grad = ctx.createLinearGradient(x, y, x + w, y);
  grad.addColorStop(0, color);
  grad.addColorStop(0.5, '#7a7a82');
  grad.addColorStop(1, color);
  ctx.fillStyle = grad;
  roundRect(x, y, w, h, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.2;
  roundRect(x, y, w, h, 3);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 8; i++) {
    const ry = y + 8 + i * ((h - 16) / 7);
    ctx.beginPath();
    ctx.moveTo(x + 3, ry);
    ctx.lineTo(x + w - 3, ry);
    ctx.stroke();
  }
}

function drawPiece(): void {
  if (!current) return;
  if (state === 'intro' || state === 'gameover') return;
  const closure = state === 'clamp' ? Math.min(1, chargeForce / 100) : 1;
  const wobble =
    state === 'clamp' && !charging && chargeForce === 0
      ? Math.sin(elapsed * 6) * 1.5
      : 0;
  const shake =
    elapsed - warningShakeT < 0.2
      ? (rand() - 0.5) * 3 * (1 - (elapsed - warningShakeT) / 0.2)
      : 0;
  const def = MATERIALS[current.kind];
  const px = PIECE_X + shake;
  const py = PIECE_Y + wobble + shake;
  const grad = ctx.createLinearGradient(0, py, 0, py + PIECE_H);
  grad.addColorStop(0, def.bodyHi);
  grad.addColorStop(0.5, def.bodyFill);
  grad.addColorStop(1, def.bodyLo);
  ctx.fillStyle = grad;
  roundRect(px, py, PIECE_W, PIECE_H, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1.2;
  roundRect(px, py, PIECE_W, PIECE_H, 4);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.rect(px + 2, py + 2, PIECE_W - 4, PIECE_H - 4);
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let i = 0; i < 24; i++) {
    const fx = px + ((i * 37) % PIECE_W);
    const fy = py + 4 + ((i * 11) % (PIECE_H - 8));
    if (current.kind === 'oak') {
      ctx.fillRect(fx, fy, 14, 1);
    } else if (current.kind === 'brass') {
      ctx.beginPath();
      ctx.arc(fx, fy, 1, 0, Math.PI * 2);
      ctx.fill();
    } else if (current.kind === 'tile') {
      ctx.fillRect(fx, fy, 1, 6);
    } else {
      ctx.fillRect(fx, fy, 2, 1);
    }
  }
  ctx.restore();
  if (state === 'file') {
    ctx.fillStyle = '#d04a2a';
    ctx.fillRect(LEFT_MARK - 2, py - 8, 4, 8);
    ctx.fillRect(LEFT_MARK - 2, py + PIECE_H, 4, 8);
    ctx.fillRect(RIGHT_MARK - 2, py - 8, 4, 8);
    ctx.fillRect(RIGHT_MARK - 2, py + PIECE_H, 4, 8);
  }
  if (closure < 1 && state === 'clamp') {
    const visiblePad = (1 - closure) * 14;
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(
      px + PIECE_W - visiblePad,
      py - 6,
      visiblePad + 6,
      PIECE_H + 12,
    );
  }
}

function drawShavings(): void {
  for (const s of shavings) {
    ctx.globalAlpha = Math.max(0, Math.min(1, s.life / 0.6));
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x, s.y, 2, 1);
  }
  ctx.globalAlpha = 1;
}

function drawFile(): void {
  if (state !== 'file') return;
  const x = Math.max(LEFT_MARK - 30, Math.min(RIGHT_MARK + 30, dragLastX));
  const y = PIECE_Y - 14;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#3a3a40';
  ctx.fillRect(-44, -6, 88, 10);
  ctx.fillStyle = '#5a5a62';
  ctx.fillRect(-44, -7, 88, 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 0.7;
  for (let i = -40; i < 40; i += 3) {
    ctx.beginPath();
    ctx.moveTo(i, -5);
    ctx.lineTo(i + 4, 3);
    ctx.stroke();
  }
  ctx.fillStyle = '#7a4a22';
  ctx.fillRect(44, -8, 22, 14);
  ctx.fillStyle = '#5a3414';
  ctx.fillRect(44, -8, 4, 14);
  ctx.restore();
}

function drawSidePanel(): void {
  const x = 14;
  const y = 42;
  const w = 108;
  const h = 130;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  roundRect(x, y, w, h, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(220,200,160,0.18)';
  ctx.lineWidth = 1;
  roundRect(x, y, w, h, 6);
  ctx.stroke();
  ctx.fillStyle = '#cfb98a';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('MÜŞTERİ', x + 8, y + 6);
  if (!current) {
    ctx.fillStyle = 'rgba(220,200,160,0.55)';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText('—', x + 8, y + 24);
    return;
  }
  const def = MATERIALS[current.kind];
  const sx = x + 8;
  const sy = y + 22;
  const sw = w - 16;
  const sh = 24;
  const matGrad = ctx.createLinearGradient(sx, sy, sx, sy + sh);
  matGrad.addColorStop(0, def.bodyHi);
  matGrad.addColorStop(1, def.bodyLo);
  ctx.fillStyle = matGrad;
  roundRect(sx, sy, sw, sh, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  roundRect(sx, sy, sw, sh, 3);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(def.label, x + w / 2, sy + sh / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(220,200,160,0.85)';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.fillText('Sıkma bandı', x + 8, y + 54);
  ctx.fillStyle = '#9aff9c';
  ctx.font = '700 14px system-ui, sans-serif';
  ctx.fillText(`%${current.bandLow}-${current.bandHigh}`, x + 8, y + 66);
  ctx.fillStyle = 'rgba(220,200,160,0.85)';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.fillText('Eğe darbesi', x + 8, y + 86);
  ctx.fillStyle = '#fff';
  ctx.font = '700 14px system-ui, sans-serif';
  ctx.fillText(`${strokes}/${current.requiredStrokes}`, x + 8, y + 98);
  const barX = x + 8;
  const barY = y + 116;
  const barW = w - 16;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(barX, barY, barW, 6);
  const ratio =
    current.requiredStrokes > 0
      ? Math.min(1, strokes / current.requiredStrokes)
      : 0;
  ctx.fillStyle = '#5fb672';
  ctx.fillRect(barX, barY, barW * ratio, 6);
}

function drawGauge(): void {
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  roundRect(GAUGE_X - 6, GAUGE_Y - 6, GAUGE_W + 12, GAUGE_H + 36, 8);
  ctx.fill();
  ctx.fillStyle = '#cfb98a';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('KUVVET', GAUGE_X, GAUGE_Y - 4);
  ctx.fillStyle = '#0c0a08';
  ctx.fillRect(GAUGE_X, GAUGE_Y + 8, GAUGE_W, GAUGE_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeRect(GAUGE_X + 0.5, GAUGE_Y + 8 + 0.5, GAUGE_W - 1, GAUGE_H - 1);
  for (let i = 0; i <= 10; i++) {
    const tx = GAUGE_X + (GAUGE_W * i) / 10;
    const tickHigh = i % 5 === 0;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(tx - 0.5, GAUGE_Y + 8, 1, tickHigh ? 6 : 3);
    if (tickHigh) {
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(220,200,160,0.55)';
      ctx.fillText(`${i * 10}`, tx, GAUGE_Y + GAUGE_H + 10);
    }
  }
  if (
    current &&
    (state === 'clamp' || state === 'file' || state === 'result')
  ) {
    const lo = current.bandLow / 100;
    const hi = current.bandHigh / 100;
    const bx = GAUGE_X + GAUGE_W * lo;
    const bw = GAUGE_W * (hi - lo);
    ctx.fillStyle = 'rgba(95, 182, 114, 0.45)';
    ctx.fillRect(bx, GAUGE_Y + 8, bw, GAUGE_H);
    ctx.strokeStyle = '#5fb672';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx + 0.5, GAUGE_Y + 8 + 0.5, bw - 1, GAUGE_H - 1);
  }
  const force =
    state === 'clamp'
      ? chargeForce
      : state === 'file' || state === 'result'
        ? lastReleaseForce
        : 0;
  const fillW = (GAUGE_W * force) / 100;
  let color = '#e2b13c';
  if (current) {
    if (force < current.bandLow) color = '#5b8fd9';
    else if (force > current.bandHigh) color = '#d04a2a';
    else color = '#5fb672';
  }
  ctx.fillStyle = color;
  ctx.fillRect(GAUGE_X, GAUGE_Y + 8, fillW, GAUGE_H);
  if (state === 'clamp' || state === 'file' || state === 'result') {
    const nx = GAUGE_X + fillW;
    ctx.fillStyle = '#fff';
    ctx.fillRect(nx - 1, GAUGE_Y + 4, 2, GAUGE_H + 8);
    ctx.beginPath();
    ctx.moveTo(nx, GAUGE_Y);
    ctx.lineTo(nx - 5, GAUGE_Y - 6);
    ctx.lineTo(nx + 5, GAUGE_Y - 6);
    ctx.closePath();
    ctx.fill();
  }
}

function drawStrokeBar(): void {
  if (state === 'file') {
    const ratio = Math.max(0, Math.min(1, fileTimer / FILE_SECONDS));
    const barX = 12;
    const barY = 36;
    const barW = W - 24;
    const barH = 6;
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(barX, barY, barW, barH);
    const color = ratio > 0.4 ? '#5fb672' : ratio > 0.2 ? '#e2b13c' : '#d04a2a';
    ctx.fillStyle = color;
    ctx.fillRect(barX, barY, barW * ratio, barH);
  }
  if (elapsed - lastStrokeFlashT < 0.18) {
    const alpha = 1 - (elapsed - lastStrokeFlashT) / 0.18;
    ctx.fillStyle = `rgba(255,255,255,${0.25 * alpha})`;
    ctx.fillRect(PIECE_X, PIECE_Y - 4, PIECE_W, PIECE_H + 8);
  }
}

function drawResultFlash(): void {
  const color = resultGood
    ? 'rgba(35, 160, 88, 0.4)'
    : 'rgba(190, 50, 35, 0.4)';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let title = '';
  if (resultGood) {
    title = `+${lastPieceScore} PUAN`;
  } else if (lastFailReason === 'slip') {
    title = 'KAYDI · Az kuvvet';
  } else if (lastFailReason === 'crack') {
    title = 'ÇATLADI · Çok kuvvet';
  } else {
    title = 'SÜRE DOLDU';
  }
  ctx.fillText(title, W / 2, H / 2 - 6);
  ctx.font = '600 13px system-ui, sans-serif';
  if (resultGood && streakBonus() > 0) {
    ctx.fillText(`Seri ×${1 + streakBonus() * 0.5}`, W / 2, H / 2 + 20);
  } else if (!resultGood) {
    ctx.fillText(`Can: ${lives}`, W / 2, H / 2 + 20);
  }
}

function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------- Init ----------

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const { x, y } = canvasCoords(e);
    if (state === 'intro' || state === 'gameover') {
      reset();
      startRound();
      return;
    }
    if (state === 'file') {
      startDrag(x, y);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const { x, y } = canvasCoords(e);
    moveDrag(x, y);
  });
  const finishDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    e.preventDefault();
    endDrag();
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };
  canvas.addEventListener('pointerup', finishDrag);
  canvas.addEventListener('pointercancel', finishDrag);
  canvas.addEventListener('pointerleave', (e) => {
    if (dragging) finishDrag(e);
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'intro' || state === 'gameover') {
      reset();
      startRound();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === ' ' || e.code === 'Space') {
      if (state === 'clamp') {
        pressClampStart();
        e.preventDefault();
      } else if (state === 'intro' || state === 'gameover') {
        reset();
        startRound();
        e.preventDefault();
      }
    } else if (e.key === 'Enter') {
      if (state === 'intro' || state === 'gameover') {
        reset();
        startRound();
        e.preventDefault();
      } else {
        reset();
        e.preventDefault();
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.code === 'Space') {
      if (state === 'clamp') {
        pressClampRelease();
        e.preventDefault();
      }
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
