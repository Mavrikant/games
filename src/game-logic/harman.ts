import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() on reset; rAF checks token.
// - overlay-input-leak: explicit state enum + guard at top of each handler.
// - module-level-dom-access: all DOM lookups inside init().
// - visual-vs-hitbox: BASKET_W is the single source of truth for both draw + catch.

const STORAGE_BEST = 'harman.best';
const SCORE_DESC = {
  gameId: 'harman',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

const CANVAS_W = 480;
const CANVAS_H = 540;
const GROUND_Y = 480;
const YABA_X = 150;
const YABA_TOP_Y = 240;
const BASKET_W = 96;
const BASKET_H = 18;
const BASKET_Y = GROUND_Y - BASKET_H;
const BASKET_MIN_X = 12;
const BASKET_MAX_X = CANVAS_W - BASKET_W - 12;
const GRAVITY = 0.40;
// Wind is modeled as a settle-toward-target velocity: each frame the particle's
// vx eases toward (wind * driftScale). Chaff settles fast and drifts far;
// grain settles slowly with low drift, so wind separates them naturally.
const WIND_GRAIN_DRIFT = 1.3;
const WIND_CHAFF_DRIFT = 3.8;
const GRAIN_EASE = 0.035;
const CHAFF_EASE = 0.085;
const BASE_VY = -9.4;
const MAX_VY = -13.6;
const CHARGE_MS_FULL = 900;
const PARTICLES_PER_TOSS = 30;
const GRAINS_PER_TOSS = 20;
const ROUNDS_PER_GAME = 8;
const TICK_MS = 16;

type State = 'ready' | 'aim' | 'charge' | 'fly' | 'gameover';
type ParticleType = 'grain' | 'chaff';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: ParticleType;
  rot: number;
  vrot: number;
  alive: boolean;
  caught: boolean;
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let round = 0;
let wind = 0;
let basketX = (CANVAS_W - BASKET_W) / 2;
let basketVel = 0;
let chargeStartTs = 0;
let chargeLevel = 0;
let particles: Particle[] = [];
let leftHeld = false;
let rightHeld = false;
let rafToken = 0;
let lastFrameTs = 0;
let yabaShakePhase = 0;
let roundScore = 0;
let roundGrains = 0;
let roundChaff = 0;
let revealUntilTs = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const resolved = v.length > 0 ? v : fallback;
  cssCache.set(name, resolved);
  return resolved;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function nextWind(): number {
  // Avoid near-zero wind to keep the game interesting.
  const dir = Math.random() < 0.5 ? -1 : 1;
  const mag = 0.55 + Math.random() * 0.95;
  return dir * mag;
}

function startRound(): void {
  round++;
  wind = nextWind();
  particles = [];
  state = 'aim';
  roundScore = 0;
  roundGrains = 0;
  roundChaff = 0;
  updateHud();
  hideOverlay();
}

function beginCharge(ts: number): void {
  if (state !== 'aim') return;
  state = 'charge';
  chargeStartTs = ts;
  chargeLevel = 0;
}

function releaseToss(ts: number): void {
  if (state !== 'charge') return;
  chargeLevel = Math.min(1, (ts - chargeStartTs) / CHARGE_MS_FULL);
  state = 'fly';
  spawnParticles();
}

function spawnParticles(): void {
  const baseVy = BASE_VY + (MAX_VY - BASE_VY) * chargeLevel;
  for (let i = 0; i < PARTICLES_PER_TOSS; i++) {
    const isGrain = i < GRAINS_PER_TOSS;
    const vy = baseVy + (Math.random() - 0.5) * 1.2;
    // Small initial scatter — wind does the heavy horizontal work.
    const vx = (Math.random() - 0.5) * (isGrain ? 0.7 : 1.3);
    particles.push({
      x: YABA_X + (Math.random() - 0.5) * 18,
      y: YABA_TOP_Y - 6 - Math.random() * 14,
      vx,
      vy,
      type: isGrain ? 'grain' : 'chaff',
      rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 0.35,
      alive: true,
      caught: false,
    });
  }
}

function basketContains(x: number): boolean {
  return x >= basketX && x <= basketX + BASKET_W;
}

function updateParticles(dt: number): void {
  let aliveAny = false;
  for (const p of particles) {
    if (!p.alive) continue;
    aliveAny = true;
    const drift = p.type === 'grain' ? WIND_GRAIN_DRIFT : WIND_CHAFF_DRIFT;
    const ease = p.type === 'grain' ? GRAIN_EASE : CHAFF_EASE;
    const targetVx = wind * drift;
    p.vx += (targetVx - p.vx) * ease * dt;
    p.vy += GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vrot * dt;
    if (p.y >= BASKET_Y && basketContains(p.x)) {
      p.alive = false;
      p.caught = true;
      if (p.type === 'grain') {
        roundGrains++;
        roundScore += 2;
      } else {
        roundChaff++;
        roundScore -= 1;
      }
    } else if (p.y >= GROUND_Y + 30 || p.x < -40 || p.x > CANVAS_W + 40) {
      p.alive = false;
    }
  }
  if (!aliveAny && state === 'fly') {
    finishRound();
  }
}

function finishRound(): void {
  // Score floor at 0 per round so a hostile wind never makes total negative.
  const earned = Math.max(0, roundScore);
  score += earned;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  if (round >= ROUNDS_PER_GAME) {
    state = 'gameover';
    reportGameOver(SCORE_DESC, score);
    showOverlay(
      'Harman bitti',
      `Toplam: ${score} tane · Son tur ${roundGrains} tane / ${roundChaff} saman\nBoşluk veya R ile tekrar başla.`,
    );
    return;
  }
  state = 'aim';
  revealUntilTs = performance.now() + 700;
  startRound();
}

function loop(myToken: number): void {
  if (myToken !== gen.current()) return;
  const now = performance.now();
  const dt = Math.min(2.5, (now - lastFrameTs) / TICK_MS);
  lastFrameTs = now;

  if (state !== 'gameover' && state !== 'ready') {
    const accel = 0.95;
    const friction = 0.78;
    if (leftHeld) basketVel -= accel * dt;
    if (rightHeld) basketVel += accel * dt;
    if (!leftHeld && !rightHeld) basketVel *= Math.pow(friction, dt);
    basketVel = Math.max(-7.2, Math.min(7.2, basketVel));
    basketX += basketVel * dt;
    if (basketX < BASKET_MIN_X) {
      basketX = BASKET_MIN_X;
      basketVel = 0;
    } else if (basketX > BASKET_MAX_X) {
      basketX = BASKET_MAX_X;
      basketVel = 0;
    }
  }

  if (state === 'charge') {
    chargeLevel = Math.min(1, (now - chargeStartTs) / CHARGE_MS_FULL);
    yabaShakePhase += dt * 0.5;
  } else {
    yabaShakePhase *= 0.9;
  }

  if (state === 'fly') {
    updateParticles(dt);
  }

  drawScene(now);
  rafToken = requestAnimationFrame(() => loop(myToken));
}

function drawScene(now: number): void {
  const surface = getCss('--surface', '#161821');
  const accent = getCss('--accent', '#f4c95d');
  const text = getCss('--text', '#e9eef6');
  const dim = getCss('--text-dim', '#9aa3b2');

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const skyTop = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  skyTop.addColorStop(0, 'rgba(110, 140, 200, 0.18)');
  skyTop.addColorStop(1, 'rgba(120, 90, 60, 0.05)');
  ctx.fillStyle = skyTop;
  ctx.fillRect(0, 0, CANVAS_W, GROUND_Y);

  ctx.fillStyle = 'rgba(120, 85, 50, 0.35)';
  ctx.fillRect(0, GROUND_Y, CANVAS_W, CANVAS_H - GROUND_Y);
  ctx.fillStyle = 'rgba(60, 45, 30, 0.55)';
  ctx.fillRect(0, GROUND_Y, CANVAS_W, 3);

  drawWindIndicator(text, dim);
  drawYaba(now, accent);

  for (const p of particles) {
    if (!p.alive) continue;
    drawParticle(p);
  }

  drawBasket();

  if (state === 'charge') {
    drawChargeMeter();
  }

  if (state === 'aim' && now < revealUntilTs && round > 1) {
    drawRoundReveal(now, accent);
  }

  drawTopHint(text, dim);
}

function drawWindIndicator(text: string, dim: string): void {
  const x = 18;
  const y = 30;
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.fillStyle = dim;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('RÜZGAR', x, y);

  const barX = x;
  const barY = y + 18;
  const barW = 140;
  const barH = 10;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(barX + barW / 2 - 1, barY - 3, 2, barH + 6);

  const magNorm = Math.min(1, Math.abs(wind) / 1.5);
  const dir = wind >= 0 ? 1 : -1;
  const fillW = (barW / 2) * magNorm;
  ctx.fillStyle = dir > 0 ? 'rgba(244, 201, 93, 0.9)' : 'rgba(110, 180, 240, 0.9)';
  if (dir > 0) {
    ctx.fillRect(barX + barW / 2, barY, fillW, barH);
  } else {
    ctx.fillRect(barX + barW / 2 - fillW, barY, fillW, barH);
  }

  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillStyle = text;
  const dirText = dir > 0 ? '→ doğuya' : '← batıya';
  const strength =
    Math.abs(wind) < 0.75 ? 'hafif' : Math.abs(wind) < 1.15 ? 'orta' : 'sert';
  ctx.fillText(`${dirText} · ${strength}`, x, barY + barH + 6);
}

function drawYaba(now: number, accent: string): void {
  const shake = state === 'charge' ? Math.sin(now * 0.04) * 1.4 * chargeLevel : 0;
  const cx = YABA_X + shake;
  ctx.strokeStyle = 'rgba(180, 130, 80, 0.95)';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, GROUND_Y - 4);
  ctx.lineTo(cx, YABA_TOP_Y + 12);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(220, 170, 110, 0.95)';
  ctx.lineWidth = 3;
  const prongLen = 28;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, YABA_TOP_Y + 12);
    ctx.lineTo(cx + i * 12, YABA_TOP_Y + 12 - prongLen);
    ctx.stroke();
  }
  if (state !== 'fly') {
    const pileGrains = 26;
    const charge = state === 'charge' ? chargeLevel : 0;
    for (let i = 0; i < pileGrains; i++) {
      const a = (i / pileGrains) * Math.PI * 2;
      const r = 7 + (i % 5) * 1.8;
      const px = cx + Math.cos(a) * r + (Math.random() - 0.5) * 1.5;
      const py = YABA_TOP_Y + 4 + Math.sin(a) * r * 0.55 - charge * 3 - (i % 4);
      ctx.fillStyle = i % 4 === 0 ? 'rgba(170, 120, 70, 0.9)' : accent;
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawParticle(p: Particle): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  if (p.type === 'grain') {
    ctx.fillStyle = '#f4c95d';
    ctx.beginPath();
    ctx.ellipse(0, 0, 3.4, 2.0, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 80, 30, 0.55)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(-3, 0);
    ctx.lineTo(3, 0);
    ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(195, 165, 120, 0.85)';
    ctx.fillRect(-3.6, -0.7, 7.2, 1.5);
    ctx.fillStyle = 'rgba(160, 130, 90, 0.75)';
    ctx.fillRect(-2.4, -1.2, 4.8, 0.6);
  }
  ctx.restore();
}

function drawBasket(): void {
  ctx.fillStyle = 'rgba(125, 80, 45, 0.95)';
  ctx.fillRect(basketX, BASKET_Y, BASKET_W, BASKET_H);
  ctx.strokeStyle = 'rgba(60, 35, 20, 0.7)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const lx = basketX + (BASKET_W / 8) * i;
    ctx.beginPath();
    ctx.moveTo(lx, BASKET_Y);
    ctx.lineTo(lx, BASKET_Y + BASKET_H);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(60, 35, 20, 0.55)';
  ctx.beginPath();
  ctx.moveTo(basketX, BASKET_Y + BASKET_H / 2);
  ctx.lineTo(basketX + BASKET_W, BASKET_Y + BASKET_H / 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(180, 120, 70, 0.95)';
  ctx.fillRect(basketX - 3, BASKET_Y - 3, BASKET_W + 6, 4);
  if (state === 'aim') {
    ctx.fillStyle = 'rgba(244, 201, 93, 0.85)';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('SEPET', basketX + BASKET_W / 2, BASKET_Y - 6);
  }
}

function drawChargeMeter(): void {
  const x = YABA_X - 30;
  const y = YABA_TOP_Y - 40;
  const w = 60;
  const h = 8;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#f4c95d';
  ctx.fillRect(x, y, w * chargeLevel, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}

function drawRoundReveal(now: number, accent: string): void {
  const remaining = (revealUntilTs - now) / 700;
  ctx.globalAlpha = Math.max(0, Math.min(1, remaining));
  ctx.fillStyle = accent;
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const earned = Math.max(0, roundScore);
  ctx.fillText(`+${earned} tane`, CANVAS_W / 2, 92);
  ctx.font = '500 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText(`önceki tur · ${roundGrains} tane / ${roundChaff} saman`, CANVAS_W / 2, 114);
  ctx.globalAlpha = 1;
}

function drawTopHint(text: string, dim: string): void {
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.fillStyle = dim;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(`Tur ${round}/${ROUNDS_PER_GAME}`, CANVAS_W - 18, 30);
  if (state === 'aim') {
    ctx.fillStyle = text;
    ctx.fillText('Boşluğu basılı tut & bırak', CANVAS_W - 18, 48);
  } else if (state === 'charge') {
    ctx.fillStyle = '#f4c95d';
    ctx.fillText('Bırak!', CANVAS_W - 18, 48);
  } else if (state === 'fly') {
    ctx.fillStyle = text;
    ctx.fillText('Sepeti taşı (← →)', CANVAS_W - 18, 48);
  }
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  roundEl.textContent = `${round}/${ROUNDS_PER_GAME}`;
}

function startGame(): void {
  score = 0;
  round = 0;
  basketX = (CANVAS_W - BASKET_W) / 2;
  basketVel = 0;
  particles = [];
  startRound();
  hideOverlay();
}

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafToken);
  state = 'ready';
  score = 0;
  round = 0;
  particles = [];
  basketX = (CANVAS_W - BASKET_W) / 2;
  basketVel = 0;
  leftHeld = false;
  rightHeld = false;
  chargeLevel = 0;
  updateHud();
  showOverlay(
    'Harman',
    'Yabayı doldur ve havaya savur. Rüzgar samanı sürükler, taneler sepete düşer.\nBoşluk: savur · ← → veya A/D: sepet · R: yeniden',
  );
  lastFrameTs = performance.now();
  const myToken = gen.current();
  rafToken = requestAnimationFrame(() => loop(myToken));
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      leftHeld = true;
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      rightHeld = true;
      e.preventDefault();
    } else if (k === ' ' || k === 'spacebar') {
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      if (state === 'ready' || state === 'gameover') {
        startGame();
      }
      beginCharge(performance.now());
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    } else if (k === 'enter') {
      if (state === 'ready' || state === 'gameover') {
        startGame();
        e.preventDefault();
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') {
      leftHeld = false;
    } else if (k === 'arrowright' || k === 'd') {
      rightHeld = false;
    } else if (k === ' ' || k === 'spacebar') {
      releaseToss(performance.now());
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const action = btn.dataset.action as 'left' | 'right' | 'toss' | undefined;
    if (!action) return;
    if (action === 'left') {
      const start = (ev: Event) => {
        ev.preventDefault();
        leftHeld = true;
        rightHeld = false;
      };
      const end = () => {
        leftHeld = false;
      };
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', end);
      btn.addEventListener('pointercancel', end);
    } else if (action === 'right') {
      const start = (ev: Event) => {
        ev.preventDefault();
        rightHeld = true;
        leftHeld = false;
      };
      const end = () => {
        rightHeld = false;
      };
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointerleave', end);
      btn.addEventListener('pointercancel', end);
    } else if (action === 'toss') {
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        if (state === 'ready' || state === 'gameover') {
          startGame();
        }
        beginCharge(performance.now());
      });
      btn.addEventListener('pointerup', (ev) => {
        ev.preventDefault();
        releaseToss(performance.now());
      });
      btn.addEventListener('pointerleave', () => {
        releaseToss(performance.now());
      });
      btn.addEventListener('pointercancel', () => {
        releaseToss(performance.now());
      });
    }
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
}

export const game = defineGame({ init, reset });
