// Havai Fişek — fuse-sync timing puzzle.
// Each round shows a Target time and N fuses with known burn times. The player
// must light each fuse so that light_time + burn_time == Target. All fuses
// must explode within tolerance of the target moment.
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM/storage access lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() cancels the RAF loop on reset/restart.
// - overlay-input-leak: pointer + key handlers gate on state.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual.
// - unreachable-start-state: overlay has both a Start button and Space/Enter.
// - hud-counter-synced-only-at-lifecycle-edges: clock + flame redrawn every frame.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'havai-fisek.best';
const MAX_LIVES = 3;
const LATE_GRACE = 1.5;
const RESULT_DELAY = 1.6;
const BASE_TOLERANCE = 0.30;
const MIN_TOLERANCE = 0.16;
const TOL_DECAY_PER_ROUND = 0.015;

type State = 'ready' | 'playing' | 'judging' | 'gameover';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

interface Fuse {
  burnTime: number;
  color: string;
  litAt: number | null;
  exploded: boolean;
  explosionTime: number | null;
  verdict: 'clean' | 'okay' | 'miss' | null;
  particles: Particle[];
}

const FUSE_COLORS = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#c084fc'];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let roundEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let round = 0;
let lives = MAX_LIVES;
let best = 0;
let target = 4;
let tolerance = BASE_TOLERANCE;
let fuses: Fuse[] = [];
let nowSec = 0;
let judgingElapsed = 0;
let resultText = '';
let resultColor = '#e8edff';

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const val = v || fallback;
  cssCache.set(name, val);
  return val;
}

function rndSnap(min: number, max: number, step: number): number {
  const ticks = Math.max(0, Math.floor((max - min) / step));
  const t = Math.floor(Math.random() * (ticks + 1));
  return Math.round((min + t * step) * 10) / 10;
}

function configureRound(): void {
  const n = Math.min(3 + Math.floor(round / 4), 5);
  const minTarget = Math.max(3.5, 1.2 * n);
  target = rndSnap(minTarget, minTarget + 2, 0.5);
  tolerance = Math.max(
    MIN_TOLERANCE,
    BASE_TOLERANCE - round * TOL_DECAY_PER_ROUND,
  );

  fuses = [];
  const usedBurns = new Set<number>();
  for (let i = 0; i < n; i++) {
    let bt = 1;
    for (let attempt = 0; attempt < 30; attempt++) {
      const candidate = rndSnap(0.6, Math.max(0.8, target - 0.5), 0.1);
      if (!usedBurns.has(candidate)) {
        bt = candidate;
        break;
      }
      bt = candidate;
    }
    usedBurns.add(bt);
    fuses.push({
      burnTime: bt,
      color: FUSE_COLORS[i % FUSE_COLORS.length]!,
      litAt: null,
      exploded: false,
      explosionTime: null,
      verdict: null,
      particles: [],
    });
  }
  fuses.sort((a, b) => b.burnTime - a.burnTime);

  nowSec = 0;
  judgingElapsed = 0;
  resultText = '';
  resultColor = '#e8edff';
}

function igniteFuse(idx: number): void {
  if (state !== 'playing') return;
  const f = fuses[idx];
  if (!f || f.litAt !== null) return;
  f.litAt = nowSec;
}

function explodeFuse(f: Fuse): void {
  f.exploded = true;
  f.explosionTime = (f.litAt ?? 0) + f.burnTime;
  for (let i = 0; i < 22; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 70 + Math.random() * 80;
    f.particles.push({
      x: 0,
      y: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 30,
      life: 1,
      color: f.particles.length % 2 === 0 ? f.color : '#fde68a',
    });
  }
}

function judgeRound(): void {
  state = 'judging';
  judgingElapsed = 0;
  let cleanCount = 0;
  let okayCount = 0;
  let missCount = 0;
  for (const f of fuses) {
    if (!f.exploded || f.explosionTime === null) {
      f.verdict = 'miss';
      missCount++;
      continue;
    }
    const dev = Math.abs(f.explosionTime - target);
    if (dev <= tolerance) {
      f.verdict = 'clean';
      cleanCount++;
    } else if (dev <= tolerance * 2) {
      f.verdict = 'okay';
      okayCount++;
    } else {
      f.verdict = 'miss';
      missCount++;
    }
  }

  if (missCount === 0 && cleanCount === fuses.length) {
    round++;
    if (round > best) {
      best = round;
      safeWrite(STORAGE_BEST, best);
    }
    resultText = 'Mükemmel senkron!';
    resultColor = '#34d399';
  } else if (missCount === 0) {
    round++;
    if (round > best) {
      best = round;
      safeWrite(STORAGE_BEST, best);
    }
    resultText = okayCount > 0 ? 'İdare eder.' : 'Tamam.';
    resultColor = '#fbbf24';
  } else {
    lives--;
    resultText =
      lives > 0 ? `Kayıp! ${lives} can kaldı.` : 'Oyun bitti.';
    resultColor = '#f87171';
  }
  updateHud();
}

function endRoundAndContinue(): void {
  if (lives <= 0) {
    state = 'gameover';
    overlayTitle.textContent = 'Oyun bitti';
    overlayMsg.textContent = `Tamamlanan: ${round} tur.\nEn iyi: ${best}.`;
    overlayBtn.textContent = 'Tekrar başla';
    showOverlay(overlay);
    return;
  }
  startNextRound();
}

function startNextRound(): void {
  configureRound();
  state = 'playing';
  updateHud();
}

function updateParticles(dtMs: number): void {
  const dt = dtMs / 1000;
  for (const f of fuses) {
    for (const p of f.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 110 * dt;
      p.life -= dt / 1.4;
    }
    if (f.particles.length > 0) {
      f.particles = f.particles.filter((p) => p.life > 0);
    }
  }
}

function tick(dtMs: number): void {
  if (state === 'playing') {
    nowSec += dtMs / 1000;
    let allExploded = true;
    for (const f of fuses) {
      if (f.litAt !== null && !f.exploded) {
        if (nowSec - f.litAt >= f.burnTime) {
          explodeFuse(f);
        }
      }
      if (!f.exploded) allExploded = false;
    }
    if (allExploded || nowSec > target + LATE_GRACE) {
      judgeRound();
    }
  } else if (state === 'judging') {
    judgingElapsed += dtMs / 1000;
    if (judgingElapsed >= RESULT_DELAY) {
      endRoundAndContinue();
    }
  }
  updateParticles(dtMs);
}

function getFuseSlot(idx: number): { x: number; w: number } {
  const left = 30;
  const right = canvas.width - 30;
  const slotW = (right - left) / fuses.length;
  return { x: left + idx * slotW, w: slotW };
}

const FUSE_BASE_Y = 470;
const FUSE_TOP_Y = 240;
const FUSE_LEN = FUSE_BASE_Y - FUSE_TOP_Y;

function pointerToFuseIndex(clientX: number, clientY: number): number {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (clientX - rect.left) * sx;
  const py = (clientY - rect.top) * sy;
  if (py < FUSE_TOP_Y - 30 || py > FUSE_BASE_Y + 40) return -1;
  for (let i = 0; i < fuses.length; i++) {
    const slot = getFuseSlot(i);
    if (px >= slot.x && px < slot.x + slot.w) return i;
  }
  return -1;
}

function drawRocket(
  cx: number,
  cy: number,
  color: string,
  exploded: boolean,
): void {
  if (exploded) {
    ctx.strokeStyle = getCss('--border', '#23283b');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - 9, cy + 8);
  ctx.lineTo(cx + 9, cy + 8);
  ctx.lineTo(cx + 9, cy - 6);
  ctx.lineTo(cx, cy - 18);
  ctx.lineTo(cx - 9, cy - 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.arc(cx, cy - 2, 2.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(cx - 9, cy + 5, 18, 3);
}

function drawFuses(): void {
  const text = getCss('--text', '#e8edff');
  const muted = getCss('--text-muted', '#8a93b0');
  const border = getCss('--border', '#23283b');

  for (let i = 0; i < fuses.length; i++) {
    const f = fuses[i]!;
    const slot = getFuseSlot(i);
    const cx = slot.x + slot.w / 2;

    const rocketY = FUSE_BASE_Y - FUSE_LEN;

    let burned = 0;
    if (f.litAt !== null) {
      burned = f.exploded
        ? f.burnTime
        : Math.min(f.burnTime, nowSec - f.litAt);
    }
    const burnRatio = burned / f.burnTime;
    const flameY = FUSE_BASE_Y - burnRatio * FUSE_LEN;

    if (!f.exploded) {
      ctx.lineCap = 'round';
      ctx.lineWidth = 3;

      if (f.litAt !== null) {
        ctx.strokeStyle = '#3f2d22';
        ctx.beginPath();
        ctx.moveTo(cx, FUSE_BASE_Y);
        ctx.lineTo(cx, flameY);
        ctx.stroke();
      }

      ctx.strokeStyle = f.litAt !== null ? '#cbd5e1' : '#94a3b8';
      ctx.beginPath();
      ctx.moveTo(cx, f.litAt !== null ? flameY : FUSE_BASE_Y);
      ctx.lineTo(cx, rocketY);
      ctx.stroke();

      if (f.litAt !== null) {
        const grad = ctx.createRadialGradient(cx, flameY, 0, cx, flameY, 9);
        grad.addColorStop(0, '#fef3c7');
        grad.addColorStop(0.5, '#fb923c');
        grad.addColorStop(1, 'rgba(251,146,60,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, flameY, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawRocket(cx, rocketY, f.color, f.exploded);

    ctx.font = '600 14px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(f.burnTime.toFixed(1) + ' sn', cx, FUSE_BASE_Y + 22);

    ctx.font = '500 10px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = muted;
    ctx.fillText('[' + (i + 1) + ']', cx, FUSE_BASE_Y + 36);

    if (state === 'judging' && f.verdict) {
      const badgeY = FUSE_BASE_Y + 52;
      const color =
        f.verdict === 'clean'
          ? '#34d399'
          : f.verdict === 'okay'
            ? '#fbbf24'
            : '#f87171';
      const label =
        f.verdict === 'clean'
          ? 'temiz'
          : f.verdict === 'okay'
            ? 'kabul'
            : 'kayıp';
      ctx.fillStyle = color;
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.fillText(label, cx, badgeY);
    }

    for (const p of f.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(cx + p.x, rocketY + p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (i < fuses.length - 1) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(slot.x + slot.w, FUSE_TOP_Y - 8);
      ctx.lineTo(slot.x + slot.w, FUSE_BASE_Y + 12);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawTimeline(W: number): void {
  const left = 40;
  const right = W - 40;
  const y = 130;
  const maxT = target + LATE_GRACE;

  const muted = getCss('--text-muted', '#8a93b0');
  const accent = getCss('--accent', '#818cf8');
  const border = getCss('--border', '#23283b');
  const text = getCss('--text', '#e8edff');

  const xT = left + (right - left) * (target / maxT);
  const xTolL = left + (right - left) * ((target - tolerance) / maxT);
  const xTolR = left + (right - left) * ((target + tolerance) / maxT);
  ctx.fillStyle = 'rgba(129,140,248,0.15)';
  ctx.fillRect(xTolL, y - 12, xTolR - xTolL, 24);

  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();

  ctx.font = '500 10px system-ui, sans-serif';
  ctx.fillStyle = muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const maxTick = Math.floor(maxT);
  for (let t = 0; t <= maxTick; t++) {
    const x = left + (right - left) * (t / maxT);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.stroke();
    ctx.fillText(String(t), x, y + 18);
  }

  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xT, y - 16);
  ctx.lineTo(xT, y + 16);
  ctx.stroke();

  ctx.font = '600 10px system-ui, sans-serif';
  ctx.fillStyle = accent;
  ctx.fillText('HEDEF', xT, y - 22);

  if (state === 'playing') {
    const xNow = left + (right - left) * Math.min(nowSec / maxT, 1);
    ctx.strokeStyle = text;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xNow, y - 14);
    ctx.lineTo(xNow, y + 14);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const f of fuses) {
    if (f.explosionTime !== null) {
      const x =
        left + (right - left) * Math.min(f.explosionTime / maxT, 1);
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function render(): void {
  const W = canvas.width;
  const H = canvas.height;

  const surface = getCss('--surface', '#10131c');
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, W, H);

  const muted = getCss('--text-muted', '#8a93b0');
  const accent = getCss('--accent', '#818cf8');
  const text = getCss('--text', '#e8edff');

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillStyle = muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('HEDEF SÜRE', W / 2, 32);

  ctx.font = '700 40px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = accent;
  ctx.fillText(target.toFixed(1) + ' sn', W / 2, 78);

  drawTimeline(W);

  ctx.font = '700 22px system-ui, sans-serif';
  ctx.fillStyle = state === 'playing' ? text : muted;
  ctx.fillText(nowSec.toFixed(1) + ' sn', W / 2, 188);

  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillStyle = muted;
  ctx.fillText(
    'Tolerans ±' + tolerance.toFixed(2) + ' sn',
    W / 2,
    210,
  );

  drawFuses();

  if (state === 'judging') {
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillStyle = resultColor;
    ctx.textAlign = 'center';
    ctx.fillText(resultText, W / 2, H - 14);
  }
}

function updateHud(): void {
  roundEl.textContent = String(round);
  livesEl.textContent = String(lives);
  bestEl.textContent = String(best);
}

function showStartOverlay(): void {
  overlayTitle.textContent = 'Havai Fişek';
  overlayMsg.textContent =
    'Fitiller farklı sürelerde yanar. Hepsi tam hedef anda patlasın.\n' +
    'Ateşle = tıkla veya [1-5].';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function startFirstRound(): void {
  state = 'playing';
  hideOverlay(overlay);
  updateHud();
}

function resetAll(): void {
  gen.bump();
  state = 'ready';
  round = 0;
  lives = MAX_LIVES;
  configureRound();
  updateHud();
  showStartOverlay();
  startLoop();
}

function onOverlayBtn(): void {
  if (state === 'gameover') {
    resetAll();
    return;
  }
  if (state === 'ready') {
    startFirstRound();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  const idx = pointerToFuseIndex(e.clientX, e.clientY);
  if (idx >= 0) igniteFuse(idx);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    resetAll();
    return;
  }
  if ((e.key === ' ' || e.key === 'Enter') && state !== 'playing') {
    e.preventDefault();
    onOverlayBtn();
    return;
  }
  if (state === 'playing' && e.key >= '1' && e.key <= '5') {
    const idx = parseInt(e.key, 10) - 1;
    if (idx >= 0 && idx < fuses.length) {
      e.preventDefault();
      igniteFuse(idx);
    }
  }
}

function startLoop(): void {
  const myGen = gen.current();
  let last = 0;
  function frame(now: number): void {
    if (!gen.isCurrent(myGen)) return;
    const dt = last === 0 ? 16 : Math.min(64, now - last);
    last = now;
    tick(dt);
    render();
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', resetAll);
  overlayBtn.addEventListener('click', onOverlayBtn);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKey);

  resetAll();
}

export const game = defineGame({ init, reset: resetAll });
