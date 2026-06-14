import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite for localStorage.
// - stale-async-callback: gen-token guards RAF loop after reset.
// - overlay-input-leak: explicit state enum; handlers early-return when state
//   doesn't match. Overlay swallows canvas pointer when not hidden.
// - module-level-dom-access: all DOM/storage access inside init().
// - visual-vs-hitbox: IRON_HIT_R drives wrinkle clearing and also drives the
//   semi-transparent halo drawn around the iron — same constant for both.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual state.

const STORAGE_BEST = 'utucu.best';
const CANVAS_W = 480;
const CANVAS_H = 540;

const ROUND_MS = 90_000;
const WRINKLES_PER_SHIRT = 8;
const SCORCH_PENALTY = 2;
const SHIRT_BONUS = 3;

const TEMP_UP_RATE = 0.00085;   // /ms while pressing  (~1.2s to max)
const TEMP_DOWN_RATE = 0.00050; // /ms while released  (~2.0s to cool)
const READY_TEMP = 0.42;
const SCORCH_TEMP = 0.92;
const SMOOTH_RATE = 0.0021;     // /ms per wrinkle when iron is in sweet spot
const SCORCH_RATE = 0.0028;     // /ms scorch accumulation when too hot

const IRON_HIT_R = 30;

// Shirt geometry (drawn within these bounds)
const SHIRT_TOP = 110;
const SHIRT_BOTTOM = 470;
const SHIRT_CENTER_X = 230;
const SHIRT_BODY_W = 230;        // shoulders width
const SHIRT_SLEEVE_DROP = 70;    // sleeve extension down
const SHIRT_SLEEVE_OUT = 70;     // sleeve extension sideways
const SHIRT_COLLAR_R = 26;

type State = 'ready' | 'playing' | 'gameover';

interface Wrinkle {
  x: number;
  y: number;
  smoothness: number; // 0..1
  scorchAmount: number; // 0..1
  scorched: boolean;
  phase: number;
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_MS;

let temp = 0;             // 0..1
let pressing = false;
let ironX = CANVAS_W / 2;
let ironY = CANVAS_H / 2;

let wrinkles: Wrinkle[] = [];
let shirtsCompleted = 0;
let lastTickMs = 0;
let rafHandle: number | null = null;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pointInShirt(x: number, y: number): boolean {
  // Body rectangle (rounded-rect approximation)
  const halfW = SHIRT_BODY_W / 2;
  const inBody =
    x >= SHIRT_CENTER_X - halfW + 14 &&
    x <= SHIRT_CENTER_X + halfW - 14 &&
    y >= SHIRT_TOP + 30 &&
    y <= SHIRT_BOTTOM - 18;
  return inBody;
}

function newShirt(): void {
  wrinkles = [];
  let attempts = 0;
  while (wrinkles.length < WRINKLES_PER_SHIRT && attempts < 400) {
    attempts++;
    const x = rand(SHIRT_CENTER_X - SHIRT_BODY_W / 2 + 22, SHIRT_CENTER_X + SHIRT_BODY_W / 2 - 22);
    const y = rand(SHIRT_TOP + 50, SHIRT_BOTTOM - 30);
    if (!pointInShirt(x, y)) continue;
    // Avoid clustering too tight
    let ok = true;
    for (const w of wrinkles) {
      const dx = w.x - x;
      const dy = w.y - y;
      if (dx * dx + dy * dy < 46 * 46) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    wrinkles.push({
      x,
      y,
      smoothness: 0,
      scorchAmount: 0,
      scorched: false,
      phase: Math.random() * Math.PI * 2,
    });
  }
}

function shirtFinished(): boolean {
  for (const w of wrinkles) {
    if (!w.scorched && w.smoothness < 1) return false;
  }
  return true;
}

function updateScoreEl(): void {
  scoreEl.textContent = String(score);
}

function updateTimeEl(): void {
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeftMs / 1000)));
}

function tick(now: number, myGen: number): void {
  if (!gen.isCurrent(myGen)) return;
  if (state !== 'playing') {
    rafHandle = null;
    return;
  }
  const dt = Math.min(48, now - lastTickMs);
  lastTickMs = now;

  // Time
  timeLeftMs -= dt;
  if (timeLeftMs <= 0) {
    timeLeftMs = 0;
    endGame();
    draw();
    return;
  }

  // Temperature
  if (pressing) {
    temp = Math.min(1, temp + TEMP_UP_RATE * dt);
  } else {
    temp = Math.max(0, temp - TEMP_DOWN_RATE * dt);
  }

  // Apply iron effects to wrinkles within hit radius
  if (pressing) {
    for (const w of wrinkles) {
      if (w.scorched || w.smoothness >= 1) continue;
      const dx = w.x - ironX;
      const dy = w.y - ironY;
      if (dx * dx + dy * dy > IRON_HIT_R * IRON_HIT_R) continue;

      if (temp >= SCORCH_TEMP) {
        w.scorchAmount += SCORCH_RATE * dt;
        if (w.scorchAmount >= 1) {
          w.scorched = true;
          score -= SCORCH_PENALTY;
          updateScoreEl();
        }
      } else if (temp >= READY_TEMP) {
        // Smoothing rate scales mildly with how warm above ready
        const heat = (temp - READY_TEMP) / (SCORCH_TEMP - READY_TEMP);
        const rate = SMOOTH_RATE * (0.55 + 0.45 * heat);
        w.smoothness += rate * dt;
        if (w.smoothness >= 1) {
          w.smoothness = 1;
          score += 1;
          updateScoreEl();
        }
      }
    }
  }

  // Next shirt?
  if (shirtFinished()) {
    shirtsCompleted++;
    score += SHIRT_BONUS;
    updateScoreEl();
    newShirt();
  }

  updateTimeEl();
  draw();
  rafHandle = requestAnimationFrame((t) => tick(t, myGen));
}

function startLoop(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  lastTickMs = performance.now();
  rafHandle = requestAnimationFrame((t) => tick(t, myGen));
}

function stopLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  score = 0;
  shirtsCompleted = 0;
  timeLeftMs = ROUND_MS;
  temp = 0;
  pressing = false;
  newShirt();
  updateScoreEl();
  updateTimeEl();
  hideOverlayEl(overlay);
  startLoop();
}

function endGame(): void {
  state = 'gameover';
  pressing = false;
  stopLoop();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
  overlayTitle.textContent = 'Süre bitti';
  overlayMsg.textContent =
    `Skor: ${score}\nÜtülenen gömlek: ${shirtsCompleted}\nDokun veya R ile tekrar oyna.`;
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'ready';
  score = 0;
  shirtsCompleted = 0;
  timeLeftMs = ROUND_MS;
  temp = 0;
  pressing = false;
  newShirt();
  updateScoreEl();
  updateTimeEl();
  bestEl.textContent = String(best);
  overlayTitle.textContent = 'Ütücü';
  overlayMsg.textContent =
    'Ütüyü basılı tutup buruşukların üzerinden geçir. Fazla bekletme — kumaşı yakarsın. Başlamak için dokun.';
  showOverlayEl(overlay);
  draw();
}

// ---------- Rendering ----------

function drawBoard(): void {
  // Backdrop
  ctx.fillStyle = '#1f242c';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Ironing board: light wood ellipse / rounded shape
  const boardX = 36;
  const boardY = 80;
  const boardW = CANVAS_W - 72;
  const boardH = 410;
  ctx.fillStyle = '#d9b58c';
  roundRectPath(boardX, boardY, boardW, boardH, 70);
  ctx.fill();
  // Board cloth shadow
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  roundRectPath(boardX + 12, boardY + boardH - 32, boardW - 24, 22, 12);
  ctx.fill();
  // Board fabric cover
  ctx.fillStyle = '#f1e1c8';
  roundRectPath(boardX + 10, boardY + 10, boardW - 20, boardH - 30, 60);
  ctx.fill();
}

function drawShirt(): void {
  const cx = SHIRT_CENTER_X;
  const top = SHIRT_TOP;
  const bottom = SHIRT_BOTTOM;
  const halfW = SHIRT_BODY_W / 2;

  ctx.save();
  // Shirt outline (sleeves + body)
  ctx.beginPath();
  // Start at left shoulder
  ctx.moveTo(cx - halfW, top + 18);
  // Left sleeve out
  ctx.lineTo(cx - halfW - SHIRT_SLEEVE_OUT, top + 18);
  ctx.lineTo(cx - halfW - SHIRT_SLEEVE_OUT, top + 18 + SHIRT_SLEEVE_DROP);
  ctx.lineTo(cx - halfW, top + 18 + SHIRT_SLEEVE_DROP);
  // Down to hem (left side)
  ctx.lineTo(cx - halfW, bottom);
  // Hem
  ctx.lineTo(cx + halfW, bottom);
  // Up right body
  ctx.lineTo(cx + halfW, top + 18 + SHIRT_SLEEVE_DROP);
  // Right sleeve
  ctx.lineTo(cx + halfW + SHIRT_SLEEVE_OUT, top + 18 + SHIRT_SLEEVE_DROP);
  ctx.lineTo(cx + halfW + SHIRT_SLEEVE_OUT, top + 18);
  ctx.lineTo(cx + halfW, top + 18);
  // Right shoulder to collar
  ctx.lineTo(cx + SHIRT_COLLAR_R, top + 18);
  // Collar cutout (arc)
  ctx.arc(cx, top + 18, SHIRT_COLLAR_R, 0, Math.PI, false);
  ctx.lineTo(cx - halfW, top + 18);
  ctx.closePath();

  // Fill
  ctx.fillStyle = '#fdfdfd';
  ctx.fill();
  // Outline
  ctx.strokeStyle = '#7f8aa0';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Buttons down the center
  ctx.fillStyle = '#c2cad8';
  const btnCount = 4;
  const btnTop = top + 60;
  const btnBottom = bottom - 30;
  for (let i = 0; i < btnCount; i++) {
    const by = btnTop + ((btnBottom - btnTop) * i) / (btnCount - 1);
    ctx.beginPath();
    ctx.arc(cx, by, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // Placket line
  ctx.strokeStyle = '#d6dbe3';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, top + 44);
  ctx.lineTo(cx, bottom - 16);
  ctx.stroke();

  ctx.restore();
}

function drawWrinkles(): void {
  for (const w of wrinkles) {
    if (w.scorched) {
      // Scorch mark: brown irregular circle
      ctx.save();
      const grad = ctx.createRadialGradient(w.x, w.y, 2, w.x, w.y, 18);
      grad.addColorStop(0, 'rgba(78, 36, 14, 0.92)');
      grad.addColorStop(0.55, 'rgba(110, 56, 22, 0.7)');
      grad.addColorStop(1, 'rgba(120, 70, 30, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(w.x, w.y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      continue;
    }
    if (w.smoothness >= 1) continue; // gone

    const alpha = 0.70 * (1 - w.smoothness);
    // Draw 3 wavy parallel arcs to simulate a wrinkle
    ctx.save();
    ctx.strokeStyle = `rgba(120, 130, 150, ${alpha.toFixed(3)})`;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      const offY = i * 6;
      for (let t = 0; t <= 22; t++) {
        const px = w.x - 11 + t;
        const py = w.y + offY + Math.sin(t * 0.55 + w.phase + i) * 1.6;
        if (t === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // Heating-up scorch tint (warning before full scorch)
    if (w.scorchAmount > 0.04) {
      ctx.fillStyle = `rgba(150, 70, 20, ${(0.35 * w.scorchAmount).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(w.x, w.y, 14, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function ironColor(): { body: string; tip: string; halo: string } {
  // Cold = steel gray; warm = orange; scorch = red
  if (temp < READY_TEMP) {
    const t = temp / READY_TEMP;
    return {
      body: lerpColor([110, 120, 138], [220, 150, 60], t),
      tip: lerpColor([200, 210, 224], [255, 200, 80], t),
      halo: `rgba(255, 180, 60, ${(0.18 * t).toFixed(3)})`,
    };
  } else if (temp < SCORCH_TEMP) {
    const t = (temp - READY_TEMP) / (SCORCH_TEMP - READY_TEMP);
    return {
      body: lerpColor([220, 150, 60], [225, 95, 60], t),
      tip: lerpColor([255, 200, 80], [255, 130, 70], t),
      halo: `rgba(255, 140, 60, ${(0.28 + 0.18 * t).toFixed(3)})`,
    };
  } else {
    return {
      body: '#d83a30',
      tip: '#ffb060',
      halo: 'rgba(255, 70, 50, 0.55)',
    };
  }
}

function lerpColor(a: number[], b: number[], t: number): string {
  const r = Math.round(a[0]! + (b[0]! - a[0]!) * t);
  const g = Math.round(a[1]! + (b[1]! - a[1]!) * t);
  const bl = Math.round(a[2]! + (b[2]! - a[2]!) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function drawIron(): void {
  if (state !== 'playing') return;
  const col = ironColor();

  ctx.save();
  // Halo of heat (also a visual cue for the hitbox radius)
  if (temp > 0.05) {
    ctx.fillStyle = col.halo;
    ctx.beginPath();
    ctx.arc(ironX, ironY, IRON_HIT_R + 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Iron body — pointed trapezoid (tip down for usability hint)
  ctx.translate(ironX, ironY);
  ctx.beginPath();
  ctx.moveTo(-28, -14);
  ctx.lineTo(28, -14);
  ctx.lineTo(20, 14);
  ctx.lineTo(-20, 14);
  ctx.closePath();
  ctx.fillStyle = col.body;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Sole plate (tip) glow
  ctx.beginPath();
  ctx.moveTo(-20, 14);
  ctx.lineTo(20, 14);
  ctx.lineTo(14, 22);
  ctx.lineTo(-14, 22);
  ctx.closePath();
  ctx.fillStyle = col.tip;
  ctx.fill();

  // Handle on top
  ctx.beginPath();
  ctx.moveTo(-16, -14);
  ctx.lineTo(-12, -28);
  ctx.lineTo(12, -28);
  ctx.lineTo(16, -14);
  ctx.fillStyle = '#2a2f3a';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.stroke();

  // Steam puffs when ready
  if (temp >= READY_TEMP && temp < SCORCH_TEMP && pressing) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const t = performance.now() * 0.005;
    for (let i = 0; i < 3; i++) {
      const sx = -18 + i * 16;
      const sy = -30 - ((t + i) % 1) * 18;
      ctx.beginPath();
      ctx.arc(sx, sy, 4 + i * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawTempGauge(): void {
  const gx = CANVAS_W - 26;
  const gy = 100;
  const gw = 14;
  const gh = 380;

  ctx.save();
  // Track
  ctx.fillStyle = '#2a3140';
  roundRectPath(gx, gy, gw, gh, 7);
  ctx.fill();
  ctx.strokeStyle = '#3a4254';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Fill (bottom to top)
  const fillH = gh * temp;
  let col1 = '#3da4ff';
  let col2 = '#3da4ff';
  if (temp < READY_TEMP) {
    col1 = '#3da4ff';
    col2 = '#74c8d8';
  } else if (temp < SCORCH_TEMP) {
    col1 = '#74c8d8';
    col2 = '#ffb84d';
  } else {
    col1 = '#ffb84d';
    col2 = '#ff4a44';
  }
  const grad = ctx.createLinearGradient(gx, gy + gh, gx, gy);
  grad.addColorStop(0, col1);
  grad.addColorStop(1, col2);
  ctx.fillStyle = grad;
  roundRectPath(gx, gy + gh - fillH, gw, fillH, 7);
  ctx.fill();

  // Threshold markers
  const readyY = gy + gh - gh * READY_TEMP;
  const scorchY = gy + gh - gh * SCORCH_TEMP;
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx - 4, readyY);
  ctx.lineTo(gx + gw + 4, readyY);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 90, 60, 0.85)';
  ctx.beginPath();
  ctx.moveTo(gx - 4, scorchY);
  ctx.lineTo(gx + gw + 4, scorchY);
  ctx.stroke();

  // Labels
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('Sıcak', gx - 6, readyY + 4);
  ctx.fillStyle = 'rgba(255, 120, 80, 0.95)';
  ctx.fillText('Yanık', gx - 6, scorchY + 4);
  ctx.restore();
}

function drawHeader(): void {
  // Tiny shirt-counter pill at top-left
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  roundRectPath(18, 18, 130, 32, 10);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Gömlek: ${shirtsCompleted}`, 30, 34);
  ctx.restore();
}

function draw(): void {
  drawBoard();
  drawShirt();
  drawWrinkles();
  drawTempGauge();
  drawHeader();
  drawIron();
}

function roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// ---------- Input ----------

function getCanvasPos(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * CANVAS_W,
    y: ((clientY - rect.top) / rect.height) * CANVAS_H,
  };
}

function onCanvasPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  pressing = true;
  const p = getCanvasPos(e.clientX, e.clientY);
  ironX = p.x;
  ironY = p.y;
}

function onCanvasPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  const p = getCanvasPos(e.clientX, e.clientY);
  ironX = p.x;
  ironY = p.y;
}

function onCanvasPointerUp(e: PointerEvent): void {
  if (canvas.hasPointerCapture?.(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
  pressing = false;
}

function onOverlayPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'ready' || state === 'gameover') {
    startGame();
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    if (state === 'ready' || state === 'gameover') {
      e.preventDefault();
      startGame();
    }
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  const c = canvas.getContext('2d');
  if (!c) return;
  ctx = c;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  restartBtn.addEventListener('click', () => reset());
  overlay.addEventListener('pointerdown', onOverlayPointerDown);

  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointermove', onCanvasPointerMove);
  canvas.addEventListener('pointerup', onCanvasPointerUp);
  canvas.addEventListener('pointercancel', onCanvasPointerUp);
  canvas.addEventListener('pointerleave', onCanvasPointerUp);

  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
