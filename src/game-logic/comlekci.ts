import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'comlekci.best';

interface Level {
  readonly name: string;
  readonly target: readonly number[];
}

const ROWS = 10;
const MIN_R = 1;
const MAX_R = 12;
const START_RADIUS = 5;
const BUDGET_BONUS = 6;

const LEVELS: readonly Level[] = [
  { name: 'Bardak', target: [3, 4, 4, 4, 4, 4, 4, 4, 4, 3] },
  { name: 'Vazo', target: [3, 4, 5, 6, 7, 7, 6, 5, 4, 3] },
  { name: 'Şişe', target: [3, 3, 3, 4, 6, 8, 8, 7, 6, 5] },
  { name: 'Kase', target: [8, 8, 7, 6, 5, 4, 3, 3, 3, 3] },
  { name: 'Amfora', target: [3, 4, 6, 7, 7, 6, 5, 3, 2, 3] },
];

type State = 'ready' | 'shaping' | 'reveal' | 'finished';

let state: State = 'ready';
let levelIdx = 0;
let radii: number[] = new Array(ROWS).fill(START_RADIUS) as number[];
let cursorBand = Math.floor(ROWS / 2);
let strokesUsed = 0;
let strokesBudget = 0;
let totalScore = 0;
let best = 0;

let stage!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let strokesEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let levelNameEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayBody!: HTMLElement;
let overlayAction!: HTMLButtonElement;

const TOP_PAD = 30;
const BOTTOM_Y = 510;
const PX_PER_UNIT = 14;

function bandHeightPx(): number {
  return (BOTTOM_Y - TOP_PAD) / ROWS;
}

function bandCenterY(i: number): number {
  return TOP_PAD + bandHeightPx() * (i + 0.5);
}

function optimalMoves(target: readonly number[]): number {
  let sum = 0;
  for (const t of target) sum += Math.abs(t - START_RADIUS);
  return sum;
}

function loadLevel(idx: number): void {
  const lvl = LEVELS[idx]!;
  radii = new Array(ROWS).fill(START_RADIUS) as number[];
  cursorBand = Math.floor(ROWS / 2);
  strokesUsed = 0;
  strokesBudget = optimalMoves(lvl.target) + BUDGET_BONUS;
  levelNameEl.textContent = lvl.name;
  state = 'shaping';
  hideOverlay(overlay);
  draw();
  updateHUD();
}

function updateHUD(): void {
  const shownIdx = Math.min(levelIdx + 1, LEVELS.length);
  levelEl.textContent = `${shownIdx}/${LEVELS.length}`;
  strokesEl.textContent = String(Math.max(0, strokesBudget - strokesUsed));
  scoreEl.textContent = String(totalScore);
  bestEl.textContent = String(best);
}

function drawPotPath(arr: readonly number[], centerX: number): Path2D {
  const path = new Path2D();
  const bh = bandHeightPx();
  for (let i = 0; i < ROWS; i++) {
    const yTop = TOP_PAD + i * bh;
    const yBot = yTop + bh;
    const r = arr[i]! * PX_PER_UNIT;
    if (i === 0) path.moveTo(centerX - r, yTop);
    else path.lineTo(centerX - r, yTop);
    path.lineTo(centerX - r, yBot);
  }
  for (let i = ROWS - 1; i >= 0; i--) {
    const yTop = TOP_PAD + i * bh;
    const yBot = yTop + bh;
    const r = arr[i]! * PX_PER_UNIT;
    path.lineTo(centerX + r, yBot);
    path.lineTo(centerX + r, yTop);
  }
  path.closePath();
  return path;
}

function draw(): void {
  const W = stage.width;
  const H = stage.height;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#15171c';
  ctx.fillRect(0, BOTTOM_Y, W, H - BOTTOM_Y);
  ctx.beginPath();
  ctx.ellipse(W / 2, BOTTOM_Y + 15, 190, 18, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#2a2c33';
  ctx.fill();
  ctx.strokeStyle = '#3a3d44';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(W / 2, BOTTOM_Y + 11, 165, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#33363e';
  ctx.fill();

  ctx.strokeStyle = 'rgba(180,200,255,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2, TOP_PAD - 5);
  ctx.lineTo(W / 2, BOTTOM_Y);
  ctx.stroke();

  const centerX = W / 2;
  const active = state === 'shaping' || state === 'reveal';

  if (active) {
    const lvl = LEVELS[levelIdx]!;

    const cPath = drawPotPath(radii, centerX);
    const grad = ctx.createLinearGradient(centerX - 100, 0, centerX + 100, 0);
    grad.addColorStop(0, '#6b3f1f');
    grad.addColorStop(0.5, '#c47a3e');
    grad.addColorStop(1, '#6b3f1f');
    ctx.fillStyle = grad;
    ctx.fill(cPath);
    ctx.strokeStyle = '#3a2210';
    ctx.lineWidth = 2;
    ctx.stroke(cPath);

    // Target outline drawn on top of the clay so it stays visible even
    // when the current shape covers it.
    const tPath = drawPotPath(lvl.target, centerX);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(140,225,255,0.95)';
    ctx.stroke(tPath);
    ctx.restore();

    if (state === 'shaping') {
      const bh = bandHeightPx();
      const yTop = TOP_PAD + cursorBand * bh;
      const cr = Math.max(radii[cursorBand]!, 2) * PX_PER_UNIT;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,225,140,0.95)';
      ctx.lineWidth = 2;
      ctx.strokeRect(centerX - cr - 6, yTop + 1, (cr + 6) * 2, bh - 2);
      ctx.fillStyle = 'rgba(255,225,140,0.9)';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText('▸', centerX + cr + 10, yTop + bh / 2);
      ctx.textAlign = 'right';
      ctx.fillText('◂', centerX - cr - 10, yTop + bh / 2);
      ctx.restore();
    }

    for (let i = 0; i < ROWS; i++) {
      const diff = Math.abs(radii[i]! - lvl.target[i]!);
      const y = bandCenterY(i);
      const x = W - 16;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle =
        diff === 0 ? '#5fd97d' : diff === 1 ? '#e0c050' : '#d05a3e';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function moveCursor(delta: number): void {
  if (state !== 'shaping') return;
  cursorBand = Math.max(0, Math.min(ROWS - 1, cursorBand + delta));
  draw();
}

function adjustRadius(delta: number): void {
  if (state !== 'shaping') return;
  if (strokesUsed >= strokesBudget) return;
  const cur = radii[cursorBand]!;
  const next = Math.max(MIN_R, Math.min(MAX_R, cur + delta));
  if (next === cur) return;
  radii[cursorBand] = next;
  strokesUsed++;
  draw();
  updateHUD();
}

function scoreLevel(): { earned: number; perfectBands: number } {
  const lvl = LEVELS[levelIdx]!;
  let penalty = 0;
  let perfectBands = 0;
  for (let i = 0; i < ROWS; i++) {
    const diff = Math.abs(radii[i]! - lvl.target[i]!);
    if (diff === 0) perfectBands++;
    penalty += diff * 5;
  }
  const base = 100;
  const remaining = Math.max(0, strokesBudget - strokesUsed);
  const bonus = remaining * 2;
  const earned = Math.max(0, base - penalty + bonus);
  return { earned, perfectBands };
}

function finalize(): void {
  if (state !== 'shaping') return;
  const { earned, perfectBands } = scoreLevel();
  totalScore += earned;
  state = 'reveal';
  const lvl = LEVELS[levelIdx]!;
  const isLast = levelIdx + 1 >= LEVELS.length;
  overlayTitle.textContent = `${lvl.name} — ${earned} puan`;
  overlayBody.textContent =
    `${perfectBands}/${ROWS} bant tam isabet.\nToplam skor: ${totalScore}` +
    (isLast ? '' : '\nSıradaki çömleğe geç.');
  overlayAction.textContent = isLast ? 'Tezgahı bitir' : 'Sonraki seviye';
  draw();
  updateHUD();
  showOverlay(overlay);
}

function nextLevelOrFinish(): void {
  if (levelIdx + 1 < LEVELS.length) {
    levelIdx++;
    loadLevel(levelIdx);
    return;
  }
  if (totalScore > best) {
    best = totalScore;
    safeWrite(STORAGE_BEST, best);
  }
  state = 'finished';
  overlayTitle.textContent = 'Tezgah bitti';
  overlayBody.textContent =
    `5 çömlek tamamlandı.\nToplam: ${totalScore} puan • Rekor: ${best}`;
  overlayAction.textContent = 'Tekrar dene';
  updateHUD();
  showOverlay(overlay);
}

function fullReset(): void {
  levelIdx = 0;
  totalScore = 0;
  strokesUsed = 0;
  strokesBudget = 0;
  state = 'ready';
  radii = new Array(ROWS).fill(START_RADIUS) as number[];
  cursorBand = Math.floor(ROWS / 2);
  levelNameEl.textContent = LEVELS[0]!.name;
  overlayTitle.textContent = 'Çömlekçi';
  overlayBody.textContent =
    'Tornada dönen kile şekil ver. Hedef silüetine (kesik mavi çizgi) uyacak şekilde her bandın yarıçapını ayarla. 5 farklı çömlek seni bekliyor.';
  overlayAction.textContent = 'Tezgaha başla';
  showOverlay(overlay);
  draw();
  updateHUD();
}

function restartCurrentLevel(): void {
  if (state === 'shaping') {
    loadLevel(levelIdx);
    return;
  }
  fullReset();
}

function handleOverlayAction(): void {
  if (state === 'ready') {
    loadLevel(levelIdx);
    return;
  }
  if (state === 'reveal') {
    nextLevelOrFinish();
    return;
  }
  if (state === 'finished') {
    fullReset();
    return;
  }
}

function onCanvasPointer(e: PointerEvent): void {
  if (state !== 'shaping') return;
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * stage.width;
  const y = ((e.clientY - rect.top) / rect.height) * stage.height;
  const bh = bandHeightPx();
  const idx = Math.floor((y - TOP_PAD) / bh);
  if (idx < 0 || idx >= ROWS) return;
  cursorBand = idx;
  const centerX = stage.width / 2;
  if (x < centerX) {
    adjustRadius(-1);
  } else {
    adjustRadius(+1);
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (state === 'shaping') {
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      moveCursor(-1);
      e.preventDefault();
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      moveCursor(+1);
      e.preventDefault();
    } else if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
      adjustRadius(-1);
      e.preventDefault();
    } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
      adjustRadius(+1);
      e.preventDefault();
    } else if (k === 'Enter' || k === ' ') {
      finalize();
      e.preventDefault();
    } else if (k === 'r' || k === 'R') {
      restartCurrentLevel();
      e.preventDefault();
    }
    return;
  }
  if (k === 'Enter' || k === ' ') {
    handleOverlayAction();
    e.preventDefault();
  } else if (k === 'r' || k === 'R') {
    fullReset();
    e.preventDefault();
  }
}

function init(): void {
  stage = document.querySelector<HTMLCanvasElement>('#stage')!;
  ctx = stage.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  strokesEl = document.querySelector<HTMLElement>('#strokes')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  levelNameEl = document.querySelector<HTMLElement>('#level-name')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayBody = document.querySelector<HTMLElement>('#overlay-body')!;
  overlayAction = document.querySelector<HTMLButtonElement>('#overlay-action')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', restartCurrentLevel);
  overlayAction.addEventListener('click', handleOverlayAction);
  stage.addEventListener('pointerdown', onCanvasPointer);
  window.addEventListener('keydown', onKey);

  fullReset();
}

export const game = defineGame({ init, reset: fullReset });
