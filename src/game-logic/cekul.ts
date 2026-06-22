import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// Çekül — signal-from-noise observation game.
//
// Wind shakes a plumb-line; its time-averaged position is true vertical.
// The wall behind it tilts by a tiny random angle. The player must judge
// whether the wall is plumb, leaning left, or leaning right within a
// shrinking observation window.
//
// PITFALLS:
// - unguarded-storage: safeRead/safeWrite.
// - stale-async-callback: gen.bump() in reset() kills pending scheduleNext.
// - overlay-input-leak: explicit `state` enum, every handler early-returns
//   when state doesn't allow input.
// - invisible-boot: init() draws the static stage once so the first frame
//   shows the wall + plumb before the player clicks "Başla".
// - unreachable-start-state: overlay button + R + Enter/Space all start.

const STORAGE_BEST = 'cekul.best';

const CANVAS_W = 480;
const ANCHOR_X = 240;
const ANCHOR_Y = 80;
const PIVOT_Y = 420;
const WALL_LENGTH = PIVOT_Y - ANCHOR_Y - 20;
const WALL_HALF_W = 26;
const PLUMB_LENGTH = 320;
const TOL_RAD = 0.012;
const OBSERVE_MS_INITIAL = 8000;
const OBSERVE_MS_MIN = 3500;
const LIVES_MAX = 3;
const RESULT_PAUSE_MS = 1700;

type State = 'ready' | 'observing' | 'result' | 'gameover';
type Verdict = 'left' | 'plumb' | 'right';

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let lives = LIVES_MAX;
let level = 1;
let streak = 0;
let wallTilt = 0;
let windAmp = 14;
let windFreq = 1.1;
let windNoise = 0.12;
let windPhase = 0;
let observeStartedAt = 0;
let observeMs = OBSERVE_MS_INITIAL;
let lastVerdictCorrect: boolean | null = null;
let lastEarned = 0;
let rafId = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let levelEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let btnLeft!: HTMLButtonElement;
let btnPlumb!: HTMLButtonElement;
let btnRight!: HTMLButtonElement;
let hintEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function pickWallTilt(): number {
  const maxMag = Math.max(0.018, 0.058 - (level - 1) * 0.0035);
  const r = Math.random();
  if (r < 0.3) {
    return (Math.random() - 0.5) * TOL_RAD * 0.6;
  }
  const minOff = TOL_RAD * 1.6;
  const sign = Math.random() < 0.5 ? -1 : 1;
  const mag = minOff + Math.random() * Math.max(0.001, maxMag - minOff);
  return sign * mag;
}

function setLevelParams(): void {
  const lcap = Math.min(level - 1, 10);
  windAmp = 14 + lcap * 3.4;
  windFreq = 1.05 + lcap * 0.16;
  windNoise = 0.10 + lcap * 0.025;
  observeMs = Math.max(OBSERVE_MS_MIN, OBSERVE_MS_INITIAL - (level - 1) * 380);
  windPhase = Math.random() * Math.PI * 2;
}

function setButtonsEnabled(en: boolean): void {
  btnLeft.disabled = !en;
  btnPlumb.disabled = !en;
  btnRight.disabled = !en;
}

function updateHUD(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = String(lives);
  levelEl.textContent = String(level);
}

function classify(t: number): Verdict {
  if (Math.abs(t) < TOL_RAD) return 'plumb';
  return t > 0 ? 'right' : 'left';
}

function truthLabel(t: number): string {
  const v = classify(t);
  if (v === 'plumb') return 'Düz';
  if (v === 'left') return 'Sola eğik';
  return 'Sağa eğik';
}

function startRound(): void {
  setLevelParams();
  wallTilt = pickWallTilt();
  state = 'observing';
  observeStartedAt = performance.now();
  lastVerdictCorrect = null;
  lastEarned = 0;
  setButtonsEnabled(true);
  hintEl.textContent = 'Çekülü izle, ortalama dikeyini oku, karar ver.';
  hintEl.dataset.tone = 'neutral';
  ensureLoop();
}

function ensureLoop(): void {
  if (rafId !== 0) return;
  rafId = requestAnimationFrame(loop);
}

function loop(): void {
  rafId = 0;
  draw();
  if (state === 'observing') {
    const elapsed = performance.now() - observeStartedAt;
    if (elapsed >= observeMs) {
      timeoutMiss();
      return;
    }
    rafId = requestAnimationFrame(loop);
    return;
  }
  if (state === 'result') {
    rafId = requestAnimationFrame(loop);
  }
}

function timeoutMiss(): void {
  state = 'result';
  lives -= 1;
  streak = 0;
  lastVerdictCorrect = false;
  setButtonsEnabled(false);
  updateHUD();
  hintEl.textContent = `Süre doldu! Gerçek: ${truthLabel(wallTilt)}.`;
  hintEl.dataset.tone = 'wrong';
  scheduleNext();
  ensureLoop();
}

function answer(v: Verdict): void {
  if (state !== 'observing') return;
  const truth = classify(wallTilt);
  const elapsed = performance.now() - observeStartedAt;
  state = 'result';
  setButtonsEnabled(false);
  lastVerdictCorrect = v === truth;
  if (lastVerdictCorrect) {
    streak += 1;
    const timeBonus = Math.max(0, Math.round((observeMs - elapsed) / 100));
    const streakBonus = Math.min(streak - 1, 10) * 5;
    lastEarned = 60 + timeBonus + streakBonus;
    score += lastEarned;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
    if (streak > 0 && streak % 4 === 0) level += 1;
    const deg = (Math.abs(wallTilt) * 180) / Math.PI;
    hintEl.textContent = `Doğru! +${lastEarned} · gerçek tilt ${deg.toFixed(2)}°`;
    hintEl.dataset.tone = 'right';
  } else {
    streak = 0;
    lives -= 1;
    const deg = (Math.abs(wallTilt) * 180) / Math.PI;
    hintEl.textContent = `Yanlış. Gerçek: ${truthLabel(wallTilt)} (${deg.toFixed(2)}°).`;
    hintEl.dataset.tone = 'wrong';
  }
  updateHUD();
  scheduleNext();
  ensureLoop();
}

function scheduleNext(): void {
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'result') return;
    if (lives <= 0) {
      gameOver();
    } else {
      startRound();
    }
  }, RESULT_PAUSE_MS);
}

function gameOver(): void {
  state = 'gameover';
  setButtonsEnabled(false);
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  draw();
  showOverlayMsg(
    'Çıraklık bitti',
    `Toplam puan: ${score}\nRekor: ${best}\nSeviye: ${level}`,
    'Yeniden başla',
  );
}

function showOverlayMsg(title: string, msg: string, btnText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnText;
  showOverlay(overlay);
}

function bobX(t: number): number {
  const main = Math.sin(t * windFreq + windPhase) * windAmp;
  const noise1 =
    Math.sin(t * windFreq * 1.7 + windPhase + 0.4) * windNoise * windAmp;
  const noise2 =
    Math.sin(t * windFreq * 0.55 + windPhase + 1.1) * windNoise * windAmp * 0.8;
  return ANCHOR_X + main + noise1 + noise2;
}

function currentT(): number {
  if (state === 'observing' || state === 'result') {
    return (performance.now() - observeStartedAt) / 1000;
  }
  return 0;
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#1a2030');
  sky.addColorStop(1, '#0a0c14');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(140,160,180,0.32)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(30, PIVOT_Y + 18);
  ctx.lineTo(w - 30, PIVOT_Y + 18);
  ctx.stroke();

  drawWall();

  const t = currentT();
  const x = bobX(t);
  drawPlumb(x);

  drawWindIndicator(t);

  if (state === 'observing') drawTimer();
  if (state === 'result') drawResultOverlay();
}

function drawWall(): void {
  const halfW = WALL_HALF_W;
  const length = WALL_LENGTH;
  ctx.save();
  ctx.translate(ANCHOR_X, PIVOT_Y);
  ctx.rotate(wallTilt);

  ctx.fillStyle = '#3a3025';
  ctx.fillRect(-halfW, -length, halfW * 2, length);

  ctx.strokeStyle = '#5c4a36';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-halfW, -length, halfW * 2, length);

  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = 1;
  const rows = 8;
  for (let i = 1; i < rows; i++) {
    const y = -length + (length / rows) * i;
    ctx.beginPath();
    ctx.moveTo(-halfW, y);
    ctx.lineTo(halfW, y);
    ctx.stroke();
    if (i % 2 === 0) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(0, y - length / rows);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(-halfW / 2, y);
      ctx.lineTo(-halfW / 2, y - length / rows);
      ctx.moveTo(halfW / 2, y);
      ctx.lineTo(halfW / 2, y - length / rows);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-halfW + 2, -length + 3);
  ctx.lineTo(halfW - 2, -length + 3);
  ctx.stroke();

  ctx.restore();
}

function drawPlumb(bx: number): void {
  const dx = bx - ANCHOR_X;
  const maxDx = PLUMB_LENGTH - 1;
  const clampedDx = Math.max(-maxDx, Math.min(maxDx, dx));
  const dy = Math.sqrt(PLUMB_LENGTH * PLUMB_LENGTH - clampedDx * clampedDx);
  const bobY = ANCHOR_Y + dy;
  const bxc = ANCHOR_X + clampedDx;

  ctx.fillStyle = '#9aa6b7';
  ctx.beginPath();
  ctx.moveTo(ANCHOR_X - 6, ANCHOR_Y - 6);
  ctx.lineTo(ANCHOR_X + 6, ANCHOR_Y - 6);
  ctx.lineTo(ANCHOR_X + 2, ANCHOR_Y);
  ctx.lineTo(ANCHOR_X - 2, ANCHOR_Y);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#f1f4f8';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(ANCHOR_X, ANCHOR_Y);
  ctx.lineTo(bxc, bobY);
  ctx.stroke();

  ctx.fillStyle = '#d33f2c';
  ctx.beginPath();
  ctx.moveTo(bxc, bobY - 10);
  ctx.lineTo(bxc - 9, bobY);
  ctx.lineTo(bxc, bobY + 18);
  ctx.lineTo(bxc + 9, bobY);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#6b1b10';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(bxc - 3, bobY - 3, 1.8, 2.6, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawWindIndicator(t: number): void {
  const dir = Math.sin(t * windFreq + windPhase);
  const cx = 56;
  const cy = 110;
  ctx.fillStyle = 'rgba(200,210,220,0.55)';
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Rüzgar', cx - 22, cy - 14);

  ctx.strokeStyle = 'rgba(180,200,230,0.65)';
  ctx.fillStyle = 'rgba(180,200,230,0.85)';
  ctx.lineWidth = 2;
  const len = 28 * dir;
  ctx.beginPath();
  ctx.moveTo(cx - 30, cy);
  ctx.lineTo(cx + 30, cy);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.stroke();

  ctx.strokeStyle = 'rgba(180,200,230,0.75)';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + len, cy);
  ctx.stroke();

  if (Math.abs(len) > 2) {
    const sign = Math.sign(len);
    ctx.beginPath();
    ctx.moveTo(cx + len, cy);
    ctx.lineTo(cx + len - 6 * sign, cy - 4);
    ctx.lineTo(cx + len - 6 * sign, cy + 4);
    ctx.closePath();
    ctx.fillStyle = 'rgba(180,200,230,0.85)';
    ctx.fill();
  }
}

function drawTimer(): void {
  const elapsed = performance.now() - observeStartedAt;
  const remaining = Math.max(0, observeMs - elapsed);
  const frac = remaining / observeMs;
  const barW = 380;
  const barX = (CANVAS_W - barW) / 2;
  const barY = 30;
  const barH = 8;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = frac > 0.4 ? '#34d399' : frac > 0.2 ? '#fbbf24' : '#f87171';
  ctx.fillRect(barX, barY, barW * frac, barH);
}

function drawResultOverlay(): void {
  ctx.save();
  ctx.strokeStyle = lastVerdictCorrect
    ? 'rgba(52,211,153,0.85)'
    : 'rgba(248,113,113,0.85)';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(ANCHOR_X, ANCHOR_Y);
  ctx.lineTo(ANCHOR_X, PIVOT_Y);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.translate(ANCHOR_X, PIVOT_Y);
  ctx.rotate(wallTilt);
  ctx.strokeStyle = 'rgba(245,158,11,0.7)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -WALL_LENGTH);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = lastVerdictCorrect
    ? 'rgba(52,211,153,0.95)'
    : 'rgba(248,113,113,0.95)';
  ctx.font = 'bold 14px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  const banner = lastVerdictCorrect
    ? `Doğru!  +${lastEarned}`
    : `Yanlış  —  ${truthLabel(wallTilt)}`;
  ctx.fillText(banner, CANVAS_W / 2, 60);
  ctx.restore();
}

function reset(): void {
  gen.bump();
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  hideOverlay(overlay);
  score = 0;
  lives = LIVES_MAX;
  level = 1;
  streak = 0;
  state = 'ready';
  lastVerdictCorrect = null;
  lastEarned = 0;
  updateHUD();
  startRound();
}

function onKey(e: KeyboardEvent): void {
  if (e.repeat) return;

  if (state === 'observing') {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      answer('left');
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      answer('right');
      return;
    }
    if (
      e.key === 'ArrowUp' ||
      e.key === 's' ||
      e.key === 'S' ||
      e.key === ' ' ||
      e.code === 'Space'
    ) {
      e.preventDefault();
      answer('plumb');
      return;
    }
  }

  if (state === 'ready' || state === 'gameover') {
    if (
      e.key === ' ' ||
      e.code === 'Space' ||
      e.key === 'Enter'
    ) {
      e.preventDefault();
      reset();
      return;
    }
  }

  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  btnLeft = document.querySelector<HTMLButtonElement>('#btn-left')!;
  btnPlumb = document.querySelector<HTMLButtonElement>('#btn-plumb')!;
  btnRight = document.querySelector<HTMLButtonElement>('#btn-right')!;
  hintEl = document.querySelector<HTMLElement>('#hint')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  updateHUD();

  restartBtn.addEventListener('click', reset);
  btnLeft.addEventListener('click', () => answer('left'));
  btnPlumb.addEventListener('click', () => answer('plumb'));
  btnRight.addEventListener('click', () => answer('right'));
  overlayBtn.addEventListener('click', () => {
    reset();
  });
  window.addEventListener('keydown', onKey);

  setButtonsEnabled(false);
  draw();
  showOverlayMsg(
    'Çekül',
    'Sen duvarcı çırağısın.\nRüzgarda salınan çekülün ortalama konumu gerçek dikey çizgidir.\nDuvar düz mü, yoksa sola/sağa mı eğik?\nÜç mihir hakkın var.',
    'Başla',
  );
}

export const game = defineGame({ init, reset });
