import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - module-level-dom-access: all queries live inside init().
// - overlay-input-leak: explicit state enum; handleTap switches per state.
// - hud-counter-synced-only-at-lifecycle-edges: HUD is rewritten right after
//   every score mutation (endThrow), not just at game-over.

// ── Types ────────────────────────────────────────────────────────────────────
type State = 'ready' | 'spinning' | 'flying' | 'landed' | 'gameover';

// ── DOM (filled in init) ─────────────────────────────────────────────────────
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let throwEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

// ── Geometry / physics constants ─────────────────────────────────────────────
const W = 480;
const H = 480;
const ATHLETE_X = 70;
const GROUND_Y = 400;
const ATHLETE_Y = GROUND_Y - 30; // 370
const R = 55;                    // hammer chain length, px
const SCALE = 4;                 // px per meter (100m fits in 400px)
const G = 600;                   // gravity, px/s²
const OMEGA_MIN = 2.5;           // start angular vel
const OMEGA_MAX = 8.5;           // capped angular vel
const OMEGA_ACCEL = 1.5;         // rad/s² while spinning
const TOTAL_THROWS = 5;
const BALL_R = 8;

// Good release zone: hammer at upper-left of orbit (vector launches up-right).
// θ in canvas coords: 0=right, π/2=below, π=left, -π/2=above (y-down).
const RELEASE_ZONE_START = -Math.PI + 0.05;
const RELEASE_ZONE_END = -Math.PI / 2 - 0.05;
const RELEASE_OPTIMAL = (-3 * Math.PI) / 4;

const STORAGE_KEY = 'cekic-atma.best';
const SCORE_DESC = {
  gameId: 'cekic-atma',
  storageKey: STORAGE_KEY,
  direction: 'higher' as const,
};

// ── State variables ──────────────────────────────────────────────────────────
let state: State = 'ready';
let theta = Math.PI / 2;   // hammer starts hanging below athlete
let omega = OMEGA_MIN;
let throwIdx = 0;          // 0..TOTAL_THROWS-1
let totalScore = 0;
let best = 0;
let lastDistances: number[] = [];
let landings: number[] = []; // meters from athlete (committed throws)

// Flying state
let ballX = 0;
let ballY = 0;
let velX = 0;
let velY = 0;

// Loop
let lastTs = 0;
let rafId = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
function showInfo(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideInfo(): void {
  hideOverlayEl(overlay);
}

function updateHud(): void {
  scoreEl.textContent = String(totalScore);
  bestEl.textContent = String(best);
  const idx = Math.min(throwIdx + 1, TOTAL_THROWS);
  throwEl.textContent = `${idx}/${TOTAL_THROWS}`;
}

// ── State transitions ────────────────────────────────────────────────────────
function reset(): void {
  state = 'ready';
  theta = Math.PI / 2;
  omega = OMEGA_MIN;
  throwIdx = 0;
  totalScore = 0;
  lastDistances = [];
  landings = [];
  ballX = 0;
  ballY = 0;
  velX = 0;
  velY = 0;
  updateHud();
  showInfo(
    'Çekiç Atma',
    '5 atış yapacaksın.\n' +
      'SPACE / tıkla: önce dönmeye başla, sonra bırak.\n' +
      'Üst-sol yeşil yayda bırak → maksimum mesafe.',
  );
}

function startSpin(): void {
  state = 'spinning';
  theta = Math.PI / 2;
  omega = OMEGA_MIN;
  hideInfo();
}

function releaseHammer(): void {
  state = 'flying';
  // Tangent velocity at angle θ on a CW-rotating orbit (canvas y-down):
  //   dpos/dt = R*ω * (-sin θ, cos θ)
  velX = -R * omega * Math.sin(theta);
  velY = R * omega * Math.cos(theta);
  ballX = ATHLETE_X + R * Math.cos(theta);
  ballY = ATHLETE_Y + R * Math.sin(theta);
}

function endThrow(distancePx: number): void {
  const meters = Math.max(0, Math.round(distancePx / SCALE));
  lastDistances.push(meters);
  landings.push(meters);
  totalScore += meters;
  throwIdx++;
  updateHud();

  if (throwIdx >= TOTAL_THROWS) {
    state = 'gameover';
    if (totalScore > best) {
      best = totalScore;
      safeWrite(STORAGE_KEY, best);
    }
    updateHud();
    reportGameOver(SCORE_DESC, totalScore);
    const lines = lastDistances.map((d, i) => `Atış ${i + 1}: ${d}m`).join('\n');
    showInfo(
      'Seri bitti!',
      `Toplam: ${totalScore}m · Rekor: ${best}m\n\n${lines}\n\nSPACE: tekrar oyna`,
    );
  } else {
    state = 'landed';
    showInfo(
      `Atış ${throwIdx}: ${meters}m`,
      `Toplam: ${totalScore}m · Kalan: ${TOTAL_THROWS - throwIdx}\nSPACE: sıradaki atışa başla`,
    );
  }
}

// ── Input ────────────────────────────────────────────────────────────────────
function handleTap(): void {
  if (state === 'ready') {
    startSpin();
    return;
  }
  if (state === 'spinning') {
    releaseHammer();
    return;
  }
  if (state === 'landed') {
    // Reset per-throw transient state, then immediately go into spin so the
    // tap that closed the result modal also starts the next windup. Skipping
    // the explicit ready→spin step keeps cadence tight.
    theta = Math.PI / 2;
    omega = OMEGA_MIN;
    hideInfo();
    startSpin();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  // 'flying' — ignore taps; let the ball land on its own.
}

// ── Update ───────────────────────────────────────────────────────────────────
function update(dt: number): void {
  if (state === 'spinning') {
    omega = Math.min(OMEGA_MAX, omega + OMEGA_ACCEL * dt);
    theta += omega * dt;
    // Normalize to (-π, π] so release zone test stays simple.
    while (theta > Math.PI) theta -= 2 * Math.PI;
    while (theta <= -Math.PI) theta += 2 * Math.PI;
    return;
  }
  if (state === 'flying') {
    ballX += velX * dt;
    ballY += velY * dt;
    velY += G * dt;
    // Hit ground?
    if (ballY >= GROUND_Y) {
      endThrow(ballX - ATHLETE_X);
      return;
    }
    // Safety: if it leaves the visible area (way off canvas), commit landing.
    if (ballX < -100 || ballX > W + 400 || ballY > H + 200) {
      endThrow(ballX - ATHLETE_X);
    }
  }
}

// ── Draw ─────────────────────────────────────────────────────────────────────
function drawX(x: number, y: number, size: number, color: string, lw: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x - size, y - size);
  ctx.lineTo(x + size, y + size);
  ctx.moveTo(x + size, y - size);
  ctx.lineTo(x - size, y + size);
  ctx.stroke();
}

function draw(): void {
  // Sky gradient
  const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  skyGrad.addColorStop(0, '#0a0b0e');
  skyGrad.addColorStop(1, '#1c2030');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, GROUND_Y);

  // Far stadium silhouette (decorative)
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  for (let i = 0; i < 14; i++) {
    const bx = (i * 40) % W;
    const bh = 18 + ((i * 17) % 22);
    ctx.fillRect(bx, GROUND_Y - bh, 32, bh);
  }

  // Ground
  ctx.fillStyle = '#2a2e3a';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.strokeStyle = '#525a6c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y + 0.5);
  ctx.lineTo(W, GROUND_Y + 0.5);
  ctx.stroke();

  // Foul line (under athlete)
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ATHLETE_X, GROUND_Y - 2);
  ctx.lineTo(ATHLETE_X, GROUND_Y + 14);
  ctx.stroke();

  // Distance markers
  ctx.textAlign = 'center';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  for (let m = 0; m <= 100; m += 10) {
    const x = ATHLETE_X + m * SCALE;
    if (x > W - 4) break;
    const major = m % 20 === 0;
    ctx.strokeStyle = major ? '#9aa3b2' : '#525a6c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y);
    ctx.lineTo(x, GROUND_Y + (major ? 7 : 4));
    ctx.stroke();
    if (major && m > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`${m}m`, x, GROUND_Y + 22);
    }
  }

  // Past landing × marks (older first, last brighter)
  const lastIdx = landings.length - 1;
  for (let i = 0; i < landings.length; i++) {
    const m = landings[i]!;
    const x = Math.min(W - 8, ATHLETE_X + m * SCALE);
    const isLast = i === lastIdx && (state === 'landed' || state === 'gameover');
    drawX(
      x,
      GROUND_Y - 4,
      isLast ? 7 : 5,
      isLast ? '#fbbf24' : 'rgba(253,224,71,0.55)',
      isLast ? 2.5 : 1.8,
    );
  }

  // Release-zone arc (only while spinning)
  if (state === 'spinning') {
    ctx.beginPath();
    ctx.arc(
      ATHLETE_X,
      ATHLETE_Y,
      R + 14,
      RELEASE_ZONE_START,
      RELEASE_ZONE_END,
      false,
    );
    ctx.strokeStyle = 'rgba(34,197,94,0.45)';
    ctx.lineWidth = 8;
    ctx.stroke();

    // Sweet-spot star
    const sx = ATHLETE_X + (R + 22) * Math.cos(RELEASE_OPTIMAL);
    const sy = ATHLETE_Y + (R + 22) * Math.sin(RELEASE_OPTIMAL);
    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 14px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', sx, sy);
    ctx.textBaseline = 'alphabetic';
  }

  // Athlete (small silhouette)
  ctx.fillStyle = '#9aa3b2';
  // body
  ctx.beginPath();
  ctx.arc(ATHLETE_X, ATHLETE_Y, 9, 0, Math.PI * 2);
  ctx.fill();
  // legs
  ctx.fillRect(ATHLETE_X - 6, ATHLETE_Y + 6, 4, 20);
  ctx.fillRect(ATHLETE_X + 2, ATHLETE_Y + 6, 4, 20);

  // Hammer (chain + ball) — visible during ready & spinning
  if (state === 'ready' || state === 'spinning') {
    const bx = ATHLETE_X + R * Math.cos(theta);
    const by = ATHLETE_Y + R * Math.sin(theta);
    ctx.strokeStyle = '#8a8f9a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ATHLETE_X, ATHLETE_Y);
    ctx.lineTo(bx, by);
    ctx.stroke();
    // ball with subtle glow when in sweet spot
    const inZone =
      state === 'spinning' && theta >= RELEASE_ZONE_START && theta <= RELEASE_ZONE_END;
    if (inZone) {
      ctx.shadowColor = 'rgba(34,197,94,0.85)';
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = '#e6ebf2';
    ctx.beginPath();
    ctx.arc(bx, by, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Power bar (only while spinning)
  if (state === 'spinning') {
    const power = (omega - OMEGA_MIN) / (OMEGA_MAX - OMEGA_MIN);
    const barW = 80;
    const bx = ATHLETE_X - barW / 2;
    const by = ATHLETE_Y - 58;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(bx, by, barW, 7);
    const c =
      power > 0.85 ? '#22c55e' : power > 0.55 ? '#eab308' : '#f97316';
    ctx.fillStyle = c;
    ctx.fillRect(bx, by, barW * power, 7);
    ctx.strokeStyle = '#5c6478';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, barW - 1, 6);
    // label
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GÜÇ', ATHLETE_X, by - 4);
  }

  // Hammer in flight
  if (state === 'flying') {
    // chain stub
    ctx.strokeStyle = '#8a8f9a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ATHLETE_X, ATHLETE_Y - 4);
    ctx.lineTo(ATHLETE_X + 6, ATHLETE_Y - 12);
    ctx.stroke();
    // ball
    ctx.fillStyle = '#e6ebf2';
    ctx.beginPath();
    ctx.arc(ballX, ballY, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    // motion trail
    ctx.strokeStyle = 'rgba(230,235,242,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ballX - velX * 0.035, ballY - velY * 0.035);
    ctx.lineTo(ballX, ballY);
    ctx.stroke();
  }

  // Top-left status overlay (small, always visible)
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  const statusY = 22;
  if (state === 'spinning') {
    ctx.fillText(`Atış ${throwIdx + 1}/${TOTAL_THROWS}`, 12, statusY);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('SPACE / tıkla → bırak', 12, statusY + 16);
  } else if (state === 'flying') {
    ctx.fillText(`Atış ${throwIdx + 1}/${TOTAL_THROWS}`, 12, statusY);
  } else if (state === 'landed' || state === 'gameover') {
    ctx.fillText(`Toplam: ${totalScore}m`, 12, statusY);
  }
}

// ── Loop ─────────────────────────────────────────────────────────────────────
function frame(ts: number): void {
  const dt = lastTs === 0 ? 0 : Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  update(dt);
  draw();
  rafId = requestAnimationFrame(frame);
}

// ── Init ─────────────────────────────────────────────────────────────────────
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  throwEl = document.querySelector<HTMLElement>('#throw')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_KEY, 0);
  if (!Number.isFinite(best) || best < 0) best = 0;

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      handleTap();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      reset();
    }
  });

  const tapHandler = (e: Event) => {
    e.preventDefault();
    handleTap();
  };
  canvas.addEventListener('pointerdown', tapHandler, { passive: false });
  overlay.addEventListener('pointerdown', tapHandler, { passive: false });
  restartBtn.addEventListener('click', () => reset());

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lastTs = 0;
  });

  reset();
  cancelAnimationFrame(rafId);
  lastTs = 0;
  rafId = requestAnimationFrame(frame);
}

export const game = defineGame({ init, reset });
