import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

// PITFALLS guarded here:
// - unguarded-storage: safeRead/safeWrite wrap localStorage in try/catch.
// - stale-async-callback: gen.bump() in reset() cancels in-flight RAF + timers.
// - overlay-input-leak: every input handler reads `state` and bails when
//   we're not in 'playing'. Overlay swallows pointer events visually via
//   .overlay--hidden + pointer-events:none from the per-game CSS.
// - module-level-dom-access: every querySelector, addEventListener and
//   localStorage read lives in init() — defineGame schedules it after parse.

type State = 'ready' | 'playing' | 'roundComplete' | 'gameover';

type Star = {
  n: number; // 1-based label shown to the player
  x: number;
  y: number;
  radius: number;
  twinkle: number; // phase offset for the gentle pulsing animation
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
};

type BgStar = {
  x: number;
  y: number;
  size: number;
  alpha: number;
  speed: number;
};

const STORAGE_KEY = 'takimyildiz.best';
const ROUND_SECONDS = 30;
const STARS_BASE = 5; // round 1
const MAX_STARS = 12;
const MIN_STAR_DIST = 70; // px between cluster stars
const STAR_RADIUS = 18; // hit radius for clicks
const SCORE_DESC = {
  gameId: 'takimyildiz',
  storageKey: STORAGE_KEY,
  direction: 'higher' as const,
};

// 20 zodiac / classical constellation names — picked uniformly per round so
// each completion feels like discovering a new patch of sky.
const CONSTELLATIONS = [
  'Avcı',
  'Akrep',
  'Boğa',
  'Yay',
  'İkizler',
  'Aslan',
  'Başak',
  'Balık',
  'Yengeç',
  'Koç',
  'Kova',
  'Oğlak',
  'Büyük Ayı',
  'Küçük Ayı',
  'Kuğu',
  'Kartal',
  'Lir',
  'Pegasus',
  'Kasiyopeya',
  'Andromeda',
];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let timeEl!: HTMLElement;
let livesEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let undoBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

const gen = createGenToken();
let state: State = 'ready';
let stars: Star[] = [];
let clickedOrder: number[] = []; // sequence of star indices the player has hit
let nextNeeded = 1; // 1..stars.length
let score = 0;
let best = 0;
let round = 1;
let lives = 3;
let timeLeft = ROUND_SECONDS;
let timerHandle: number | null = null;
let rafHandle: number | null = null;
let particles: Particle[] = [];
let bg: BgStar[] = [];
let lastFrame = 0;
let shakeUntil = 0;
let constellationName = '';
let lastWrongStar = -1; // index of star flashing red after wrong click
let lastWrongUntil = 0;
let revealUntil = 0; // when the round-complete glow fades

function randRange(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function buildBackground(): void {
  bg = [];
  for (let i = 0; i < 70; i++) {
    bg.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: randRange(0.4, 1.6),
      alpha: randRange(0.15, 0.55),
      speed: randRange(0.005, 0.02),
    });
  }
}

function spawnStars(count: number): Star[] {
  // Place `count` stars at least MIN_STAR_DIST apart inside a padded rect.
  // Loosen spacing if we fail to place after many tries so we never deadlock.
  const padding = 50;
  const out: Star[] = [];
  let dist = MIN_STAR_DIST;
  let safety = 0;
  while (out.length < count) {
    const cx = randRange(padding, canvas.width - padding);
    const cy = randRange(padding, canvas.height - padding);
    const tooClose = out.some((s) => distance(cx, cy, s.x, s.y) < dist);
    if (!tooClose) {
      out.push({
        n: out.length + 1,
        x: cx,
        y: cy,
        radius: randRange(7, 11),
        twinkle: Math.random() * Math.PI * 2,
      });
    }
    safety++;
    if (safety > 400) {
      dist *= 0.9;
      safety = 0;
    }
  }
  // Shuffle the labels so the visual order on screen doesn't match the
  // numerical order — this is the whole game.
  const labels: number[] = Array.from({ length: count }, (_, i) => i + 1);
  for (let i = labels.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = labels[i]!;
    labels[i] = labels[j]!;
    labels[j] = tmp;
  }
  out.forEach((s, i) => {
    s.n = labels[i]!;
  });
  return out;
}

function setOverlay(title: string, msg: string, btnLabel: string | null): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  if (btnLabel === null) {
    overlayBtn.style.display = 'none';
  } else {
    overlayBtn.style.display = '';
    overlayBtn.textContent = btnLabel;
  }
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function renderHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  roundEl.textContent = String(round);
  timeEl.textContent = String(Math.max(0, timeLeft));
  livesEl.textContent =
    lives > 0 ? '♥'.repeat(lives) + '♡'.repeat(3 - lives) : '♡♡♡';
}

function startTimer(): void {
  stopTimer();
  const myGen = gen.current();
  timerHandle = window.setInterval(() => {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing') return;
    timeLeft--;
    timeEl.textContent = String(Math.max(0, timeLeft));
    if (timeLeft <= 0) {
      loseLife('Süre doldu!');
    }
  }, 1000);
}

function stopTimer(): void {
  if (timerHandle !== null) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function startRound(): void {
  gen.bump();
  state = 'playing';
  hideOverlay();
  const starCount = Math.min(MAX_STARS, STARS_BASE + (round - 1));
  stars = spawnStars(starCount);
  clickedOrder = [];
  nextNeeded = 1;
  timeLeft = ROUND_SECONDS;
  constellationName =
    CONSTELLATIONS[Math.floor(Math.random() * CONSTELLATIONS.length)]!;
  lastWrongStar = -1;
  lastWrongUntil = 0;
  revealUntil = 0;
  particles = [];
  renderHud();
  startTimer();
}

function loseLife(reason: string): void {
  lives--;
  renderHud();
  shakeUntil = performance.now() + 300;
  if (lives <= 0) {
    gameOver(reason);
  } else {
    state = 'roundComplete';
    stopTimer();
    setOverlay(
      'Tekrar dene',
      `${reason}\nKalan can: ${'♥'.repeat(lives)}`,
      'Devam',
    );
  }
}

function gameOver(reason: string): void {
  state = 'gameover';
  stopTimer();
  reportGameOver(SCORE_DESC, score);
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
    bestEl.textContent = String(best);
  }
  setOverlay(
    'Oyun bitti',
    `${reason}\nSkor: ${score}\nR ile yeniden başla.`,
    'Yeniden başla',
  );
}

function finishRound(): void {
  state = 'roundComplete';
  stopTimer();
  const bonus = Math.max(0, timeLeft) * 10;
  const base = stars.length * 20;
  const gained = base + bonus;
  score += gained;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
  }
  renderHud();
  burst();
  revealUntil = performance.now() + 1200;
  setOverlay(
    `★ ${constellationName} ★`,
    `+${base} desen · +${bonus} zaman\nToplam: ${score}`,
    'Sonraki round',
  );
}

function burst(): void {
  // Confetti-like particle burst from each star — the celebratory beat that
  // sells "you completed a constellation".
  for (const s of stars) {
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = randRange(60, 180);
      particles.push({
        x: s.x,
        y: s.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        maxLife: randRange(0.6, 1.2),
        color: pickAccent(i),
        size: randRange(1.5, 3),
      });
    }
  }
}

function pickAccent(i: number): string {
  const palette = ['#ff79c6', '#b15cff', '#34d2ff', '#3ee686', '#ffd166'];
  return palette[i % palette.length]!;
}

function handleClickCanvas(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  // Generous nearest-star pick within the hit radius — touch friendly.
  let bestIdx = -1;
  let bestDist = STAR_RADIUS * 1.8;
  for (let i = 0; i < stars.length; i++) {
    const d = distance(px, py, stars[i]!.x, stars[i]!.y);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return;
  const s = stars[bestIdx]!;
  if (clickedOrder.includes(bestIdx)) return;
  if (s.n !== nextNeeded) {
    lastWrongStar = bestIdx;
    lastWrongUntil = performance.now() + 280;
    loseLife(`Sıra ${nextNeeded} idi, ${s.n}'i tıkladın.`);
    return;
  }
  clickedOrder.push(bestIdx);
  nextNeeded++;
  if (nextNeeded > stars.length) {
    finishRound();
  }
}

function undo(): void {
  if (state !== 'playing') return;
  if (clickedOrder.length === 0) return;
  clickedOrder.pop();
  nextNeeded--;
}

function nextRound(): void {
  if (round < 99) round++;
  startRound();
}

function reset(): void {
  gen.bump();
  stopTimer();
  state = 'ready';
  score = 0;
  round = 1;
  lives = 3;
  timeLeft = ROUND_SECONDS;
  stars = [];
  clickedOrder = [];
  nextNeeded = 1;
  particles = [];
  lastWrongStar = -1;
  lastWrongUntil = 0;
  revealUntil = 0;
  shakeUntil = 0;
  renderHud();
  setOverlay(
    'Takımyıldız',
    "Yıldızlara 1, 2, 3 … sırasıyla bas. Yanlış tıklarsan can kaybedersin.",
    'Başla',
  );
}

function onOverlayClick(): void {
  if (state === 'ready') {
    startRound();
  } else if (state === 'roundComplete') {
    if (nextNeeded > stars.length) {
      // Just finished a full round → advance.
      nextRound();
    } else {
      // Soft-fail "Devam" path — replay the same round with a fresh layout.
      startRound();
    }
  } else if (state === 'gameover') {
    reset();
  }
}

// ---------------- rendering ----------------

function drawBackground(t: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#0a0728');
  grad.addColorStop(1, '#1c0f3d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const s of bg) {
    s.y += s.speed;
    if (s.y > canvas.height) s.y = 0;
    const a = s.alpha + Math.sin(t * 0.002 + s.x) * 0.08;
    ctx.fillStyle = `rgba(255,255,255,${Math.max(0, a)})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawConnections(t: number): void {
  if (clickedOrder.length < 1) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < clickedOrder.length; i++) {
    const a = stars[clickedOrder[i - 1]!]!;
    const b = stars[clickedOrder[i]!]!;
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(180,200,255,0.85)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.4;
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(150,180,255,0.7)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  if (revealUntil > t) {
    const fade = (revealUntil - t) / 1200;
    ctx.strokeStyle = `rgba(255,210,128,${fade * 0.7})`;
    ctx.lineWidth = 4.5;
    for (let i = 1; i < clickedOrder.length; i++) {
      const a = stars[clickedOrder[i - 1]!]!;
      const b = stars[clickedOrder[i]!]!;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}

function drawStar(s: Star, idx: number, t: number): void {
  const isHit = clickedOrder.includes(idx);
  const isWrong = lastWrongStar === idx && lastWrongUntil > t;
  const twinkle = Math.sin(t * 0.003 + s.twinkle) * 0.18 + 0.82;
  const baseR = s.radius * twinkle;
  const haloR = baseR * 2.2;
  const halo = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, haloR);
  if (isWrong) {
    halo.addColorStop(0, 'rgba(255,90,90,0.7)');
    halo.addColorStop(1, 'rgba(255,90,90,0)');
  } else if (isHit) {
    halo.addColorStop(0, 'rgba(255,220,140,0.8)');
    halo.addColorStop(1, 'rgba(255,220,140,0)');
  } else {
    halo.addColorStop(0, 'rgba(255,255,255,0.45)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
  }
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(s.x, s.y, haloR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = isHit ? '#ffd87a' : '#fff';
  ctx.beginPath();
  ctx.arc(s.x, s.y, baseR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = isHit ? '#3b2400' : '#1a153d';
  ctx.font = `700 ${Math.round(baseR * 1.05)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(s.n), s.x, s.y + 0.5);
  if (state === 'playing' && s.n === nextNeeded) {
    ctx.strokeStyle = 'rgba(80,200,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, baseR + 6 + Math.sin(t * 0.006) * 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawParticles(dt: number): void {
  for (const p of particles) {
    p.life += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 80 * dt;
    const a = 1 - p.life / p.maxLife;
    if (a <= 0) continue;
    ctx.fillStyle = p.color;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  particles = particles.filter((p) => p.life < p.maxLife);
}

function frame(now: number): void {
  rafHandle = requestAnimationFrame(frame);
  const dt = lastFrame === 0 ? 0 : Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  let shake = 0;
  if (shakeUntil > now) {
    shake = (shakeUntil - now) / 300;
  }
  ctx.save();
  if (shake > 0) {
    ctx.translate(
      Math.sin(now * 0.06) * shake * 6,
      Math.cos(now * 0.05) * shake * 6,
    );
  }

  drawBackground(now);
  drawConnections(now);
  for (let i = 0; i < stars.length; i++) {
    drawStar(stars[i]!, i, now);
  }
  drawParticles(dt);

  ctx.restore();
}

function startLoop(): void {
  if (rafHandle !== null) return;
  lastFrame = 0;
  rafHandle = requestAnimationFrame(frame);
}

// ---------------- bootstrap ----------------

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  buildBackground();

  canvas.addEventListener('pointerdown', handleClickCanvas);
  overlayBtn.addEventListener('click', onOverlayClick);
  undoBtn.addEventListener('click', undo);
  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
    } else if (k === 'z') {
      undo();
      e.preventDefault();
    } else if ((k === 'enter' || k === ' ') && state !== 'playing') {
      onOverlayClick();
      e.preventDefault();
    }
  });

  reset();
  startLoop();
}

export const game = defineGame({ init, reset });
