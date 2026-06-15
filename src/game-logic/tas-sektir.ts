import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen-token cancels the rAF loop + the post-throw
//   setTimeout when reset() runs mid-flight.
// - overlay-input-leak: explicit `state` enum; each handler guards on it,
//   and the overlay carries its own pointerdown for round-over restart.
// - module-level side effects: all DOM/storage access lives in init().
// - missing-overlay-css: scaffold ships .overlay--hidden — preserved.
// - visual-vs-hitbox: drawing constants (W, H, WATER_Y, STONE_HOME_*) feed
//   both render and collision so the water surface a stone draws at is the
//   same one its skip test compares against.

const STORAGE_BEST = 'tas-sektir.best';
const STONES_PER_ROUND = 5;

const W = 720;
const H = 420;
const WATER_Y = 280;
const STONE_HOME_X = 70;
const STONE_HOME_Y = WATER_Y - 12;

const GRAVITY = 0.32;
const SKIP_VY_DAMP = 0.55;
const SKIP_VX_DAMP = 0.86;
const MAX_SKIP_ANGLE = 0.62; // ~36° — steeper than this and the stone sinks.
const MIN_SKIP_VX = 1.4;
const MAX_THROW_POWER = 240;
const THROW_VEL_SCALE = 0.12;

type State = 'ready' | 'aiming' | 'flying' | 'settled' | 'roundover';

type LilyPad = { x: number; r: number; hit: boolean };
type Splash = { x: number; y: number; t: number };
type TrailPt = { x: number; y: number; a: number };

const gen = createGenToken();
let state: State = 'ready';

let stonesLeft = STONES_PER_ROUND;
let throwSkips = 0;
let roundScore = 0;
let best = 0;

let stoneX = STONE_HOME_X;
let stoneY = STONE_HOME_Y;
let vx = 0;
let vy = 0;

let aimStart: { x: number; y: number } | null = null;
let aimNow: { x: number; y: number } | null = null;

let lilies: LilyPad[] = [];
let splashes: Splash[] = [];
let trail: TrailPt[] = [];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let roundEl!: HTMLElement;
let bestEl!: HTMLElement;
let stonesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function syncHud(): void {
  scoreEl.textContent = String(throwSkips);
  roundEl.textContent = String(roundScore);
  bestEl.textContent = String(best);
  stonesEl.textContent = String(stonesLeft);
}

function spawnLilies(): void {
  lilies = [];
  const count = 2 + Math.floor(Math.random() * 2);
  const minX = 220;
  const maxX = W - 60;
  for (let i = 0; i < count; i++) {
    const x = minX + Math.random() * (maxX - minX);
    const r = 14 + Math.random() * 8;
    lilies.push({ x, r, hit: false });
  }
}

function resetStoneAtHand(): void {
  stoneX = STONE_HOME_X;
  stoneY = STONE_HOME_Y;
  vx = 0;
  vy = 0;
  trail = [];
  throwSkips = 0;
  aimStart = null;
  aimNow = null;
}

function reset(): void {
  gen.bump();
  stonesLeft = STONES_PER_ROUND;
  roundScore = 0;
  resetStoneAtHand();
  spawnLilies();
  splashes = [];
  state = 'ready';
  syncHud();
  draw();
  showOverlay(
    'Taş Sektir',
    'Suya tıkla ve atmak istediğin yöne sürükle, bırak.\nDüşük açı + yüksek hız = çok sekme.\nNilüfere değersen bonus, suya batarsan o taş biter.',
  );
}

function commitBest(): void {
  if (roundScore > best) {
    best = roundScore;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function startAim(px: number, py: number): void {
  if (state !== 'ready') return;
  hideOverlay();
  aimStart = { x: px, y: py };
  aimNow = { x: px, y: py };
  state = 'aiming';
}

function updateAim(px: number, py: number): void {
  if (state !== 'aiming') return;
  aimNow = { x: px, y: py };
}

function releaseAim(): void {
  if (state !== 'aiming' || !aimStart || !aimNow) {
    aimStart = null;
    aimNow = null;
    state = 'ready';
    return;
  }
  // Swipe vector points the direction the stone is thrown. Matches a real
  // throwing motion (swipe right-down = stone goes right-down) instead of
  // a slingshot pull-back, which testers found unintuitive.
  const dx = aimNow.x - aimStart.x;
  const dy = aimNow.y - aimStart.y;
  const len = Math.hypot(dx, dy);
  aimStart = null;
  aimNow = null;
  if (len < 12) {
    state = 'ready';
    return;
  }
  const power = Math.min(len, MAX_THROW_POWER);
  const nx = dx / len;
  const ny = dy / len;
  const tvx = nx * (power * THROW_VEL_SCALE);
  const tvy = ny * (power * THROW_VEL_SCALE);
  // Refuse non-forward throws — keeps the gameplay axis honest.
  if (tvx <= 0.3) {
    state = 'ready';
    return;
  }
  vx = tvx;
  vy = tvy;
  state = 'flying';
  trail = [];
}

function addSplash(x: number): void {
  splashes.push({ x, y: WATER_Y, t: 0 });
}

function endThrow(reason: 'sunk' | 'offscreen'): void {
  roundScore += throwSkips;
  commitBest();
  stonesLeft--;
  syncHud();
  if (reason === 'sunk') addSplash(stoneX);
  state = 'settled';
  const myToken = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myToken)) return;
    if (stonesLeft <= 0) {
      state = 'roundover';
      const msg = roundScore === best && best > 0
        ? `Yeni rekor: ${roundScore} sek!\nBaşka tura geç: tıkla veya R.`
        : `Tur skoru: ${roundScore} sek\nRekor: ${best}\nBaşka tura geç: tıkla veya R.`;
      showOverlay('Tur bitti', msg);
    } else {
      resetStoneAtHand();
      syncHud();
      state = 'ready';
    }
  }, 650);
}

function step(): void {
  if (state !== 'flying') return;
  // Two substeps for accurate water-line collisions at high speed.
  for (let s = 0; s < 2; s++) {
    vy += GRAVITY * 0.5;
    stoneX += vx * 0.5;
    stoneY += vy * 0.5;

    // Lily pad: stone grazes the lily's surface while descending. Awards
    // a bonus skip and gives an extra bounce — converts a doomed throw
    // into a long one.
    for (const lp of lilies) {
      if (lp.hit) continue;
      if (
        Math.abs(stoneX - lp.x) <= lp.r * 0.9 &&
        stoneY >= WATER_Y - 8 &&
        stoneY <= WATER_Y + 4 &&
        vy >= 0
      ) {
        lp.hit = true;
        throwSkips += 2;
        addSplash(lp.x);
        vy = -Math.max(Math.abs(vy), 3.2) * 0.85;
        vx *= 0.94;
        syncHud();
      }
    }

    if (stoneY >= WATER_Y) {
      const angle = Math.atan2(vy, Math.max(0.01, vx));
      if (angle <= MAX_SKIP_ANGLE && vx >= MIN_SKIP_VX) {
        addSplash(stoneX);
        stoneY = WATER_Y - 1;
        vy = -Math.abs(vy) * SKIP_VY_DAMP;
        vx *= SKIP_VX_DAMP;
        throwSkips++;
        syncHud();
      } else {
        endThrow('sunk');
        return;
      }
    }

    if (stoneX > W + 20 || stoneX < -20 || stoneY > H + 30) {
      endThrow('offscreen');
      return;
    }
  }

  trail.push({ x: stoneX, y: stoneY, a: 1 });
  if (trail.length > 28) trail.shift();
  for (const t of trail) t.a *= 0.92;
}

function drawSky(): void {
  const g = ctx.createLinearGradient(0, 0, 0, WATER_Y);
  g.addColorStop(0, '#1a2238');
  g.addColorStop(1, '#3a5070');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, WATER_Y);

  ctx.fillStyle = 'rgba(255, 220, 160, 0.85)';
  ctx.beginPath();
  ctx.arc(W - 90, 60, 22, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#212d44';
  ctx.beginPath();
  ctx.moveTo(0, WATER_Y);
  const peaks: ReadonlyArray<readonly [number, number]> = [
    [60, 200], [140, 175], [210, 205], [290, 160], [370, 195],
    [440, 175], [520, 210], [600, 180], [680, 205], [720, 195],
  ];
  for (const p of peaks) ctx.lineTo(p[0], p[1]);
  ctx.lineTo(W, WATER_Y);
  ctx.closePath();
  ctx.fill();
}

function drawWater(): void {
  const g = ctx.createLinearGradient(0, WATER_Y, 0, H);
  g.addColorStop(0, '#0e2238');
  g.addColorStop(1, '#06121e');
  ctx.fillStyle = g;
  ctx.fillRect(0, WATER_Y, W, H - WATER_Y);

  ctx.strokeStyle = 'rgba(170, 200, 230, 0.10)';
  ctx.lineWidth = 1;
  for (let y = WATER_Y + 10; y < H; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

function drawShore(): void {
  ctx.fillStyle = '#2a2620';
  ctx.beginPath();
  ctx.moveTo(0, WATER_Y);
  ctx.lineTo(0, H);
  ctx.lineTo(110, H);
  ctx.lineTo(120, WATER_Y - 2);
  ctx.lineTo(95, WATER_Y - 4);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#4a4036';
  ctx.beginPath();
  ctx.ellipse(55, WATER_Y - 8, 28, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3a3128';
  ctx.beginPath();
  ctx.ellipse(45, WATER_Y - 12, 18, 6, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawLilies(): void {
  for (const lp of lilies) {
    ctx.fillStyle = lp.hit ? 'rgba(90, 140, 90, 0.45)' : '#2f7a3f';
    ctx.beginPath();
    ctx.ellipse(lp.x, WATER_Y + 1, lp.r, lp.r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!lp.hit) {
      ctx.strokeStyle = '#9bd29a';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(lp.x - lp.r * 0.6, WATER_Y + 1);
      ctx.lineTo(lp.x + lp.r * 0.6, WATER_Y + 1);
      ctx.stroke();
    }
  }
}

function drawSplashes(): void {
  for (let i = splashes.length - 1; i >= 0; i--) {
    const s = splashes[i]!;
    s.t++;
    const r = 3 + s.t * 1.6;
    const a = Math.max(0, 0.9 - s.t * 0.06);
    ctx.strokeStyle = `rgba(220, 235, 255, ${a})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (s.t > 18) splashes.splice(i, 1);
  }
}

function drawTrail(): void {
  for (const t of trail) {
    ctx.fillStyle = `rgba(220, 220, 220, ${t.a * 0.5})`;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStone(): void {
  if (state === 'settled' || state === 'roundover') return;
  ctx.fillStyle = '#cfd2d8';
  ctx.beginPath();
  ctx.ellipse(stoneX, stoneY, 7, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6a6f78';
  ctx.beginPath();
  ctx.ellipse(stoneX - 1.5, stoneY - 1, 4, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawStonesLeftIndicator(): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('Kalan taş:', 14, H - 38);
  for (let i = 0; i < STONES_PER_ROUND; i++) {
    const cx = 80 + i * 14;
    const cy = H - 30;
    ctx.fillStyle = i < stonesLeft ? '#cfd2d8' : 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, 5, 3.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawAimGuide(): void {
  if (state !== 'aiming' || !aimStart || !aimNow) return;
  const dx = aimNow.x - aimStart.x;
  const dy = aimNow.y - aimStart.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;
  const power = Math.min(len, MAX_THROW_POWER);
  const nx = dx / len;
  const ny = dy / len;
  let pvx = nx * (power * THROW_VEL_SCALE);
  let pvy = ny * (power * THROW_VEL_SCALE);
  if (pvx <= 0.3) {
    ctx.strokeStyle = 'rgba(240, 90, 90, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(aimNow.x - 6, aimNow.y - 6);
    ctx.lineTo(aimNow.x + 6, aimNow.y + 6);
    ctx.moveTo(aimNow.x - 6, aimNow.y + 6);
    ctx.lineTo(aimNow.x + 6, aimNow.y - 6);
    ctx.stroke();
    return;
  }
  let px = STONE_HOME_X;
  let py = STONE_HOME_Y;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  for (let i = 0; i < 24; i++) {
    pvy += GRAVITY;
    px += pvx;
    py += pvy;
    if (py >= WATER_Y || px > W) break;
    if (i % 2 === 0) {
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const ratio = power / MAX_THROW_POWER;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.fillRect(STONE_HOME_X - 18, STONE_HOME_Y - 30, 36, 4);
  ctx.fillStyle = ratio > 0.85 ? '#f5c560' : '#9be19b';
  ctx.fillRect(STONE_HOME_X - 18, STONE_HOME_Y - 30, 36 * ratio, 4);
}

function draw(): void {
  ctx.clearRect(0, 0, W, H);
  drawSky();
  drawWater();
  drawShore();
  drawLilies();
  drawSplashes();
  drawTrail();
  drawStone();
  drawAimGuide();
  drawStonesLeftIndicator();
}

function loop(myToken: number): void {
  if (!gen.isCurrent(myToken)) return;
  step();
  draw();
  requestAnimationFrame(() => loop(myToken));
}

function getEventXY(ev: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  stonesEl = document.querySelector<HTMLElement>('#stones')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  // pointerdown is accepted from either the canvas or the overlay (when
  // it covers the canvas in ready/roundover). The overlay sits at
  // .board-wrap inset:0 so its coordinates align with the canvas's
  // bounding rect — getEventXY scales correctly from either source.
  // PITFALLS#unreachable-start-state: an overlay that hides the canvas
  // must accept the action it promises.
  function onDown(e: PointerEvent): void {
    if (state === 'roundover') {
      reset();
      e.preventDefault();
      return;
    }
    if (state !== 'ready') return;
    const p = getEventXY(e);
    startAim(p.x, p.y);
    e.preventDefault();
  }
  canvas.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointerdown', (e) => {
    onDown(e);
    e.stopPropagation();
  });

  // Drag + release tracked on window so the gesture survives the overlay
  // hide between pointerdown and pointermove.
  window.addEventListener('pointermove', (e) => {
    if (state !== 'aiming') return;
    const p = getEventXY(e);
    updateAim(p.x, p.y);
  });
  window.addEventListener('pointerup', () => {
    if (state === 'aiming') releaseAim();
  });
  window.addEventListener('pointercancel', () => {
    if (state === 'aiming') {
      aimStart = null;
      aimNow = null;
      state = 'ready';
    }
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
    } else if ((k === ' ' || k === 'enter') && state === 'roundover') {
      reset();
      e.preventDefault();
    }
  });

  restartBtn.addEventListener('click', reset);

  reset();
  const myToken = gen.current();
  requestAnimationFrame(() => loop(myToken));
}

export const game = defineGame({ init, reset });
