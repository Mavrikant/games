import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'ahenk.best';
const MAX_MISSES = 5;
const PIVOT_Y = 70;
const ROPE_LEN = 260;
const BOB_R = 18;
const PIVOTS_X = [120, 240, 360];
// Sync judged on the horizontal bob offset relative to its pivot. The
// tolerance is the same constant used by both draw() (lock-band width)
// and judge() (pass/fail test). PITFALLS#visual-vs-hitbox.
const LOCK_TOLERANCE_PX = 22;
const MISS_FLASH_MS = 350;
const HIT_FLASH_MS = 300;
const HIT_FREEZE_MS = 280;

type State = 'ready' | 'playing' | 'gameover';

interface Pendulum {
  amp: number;
  freq: number;
  phase: number;
  theta: number;
  x: number;
  y: number;
}

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let misses = 0;
let startTs = 0;
let pausedAccum = 0;
let freezeUntil = 0;
let flashUntil = 0;
let flashKind: 'hit' | 'miss' = 'hit';
let level = 1;
let pends: Pendulum[] = [];
let lockedAt = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let missEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let touchBtn!: HTMLButtonElement;

const cssCache = new Map<string, string>();
function css(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const final = v || fallback;
  cssCache.set(name, final);
  return final;
}

function showOverlay(title: string, msg: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btnLabel;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function randPhase(): number {
  return Math.random() * Math.PI * 2;
}

function spawnLevel(n: number): void {
  // Frequencies in Hz; all coprime-ish so simultaneous zero-crossings are
  // rare. Higher levels widen the spread → harder to read.
  const base = 0.42 + (n - 1) * 0.04;
  const spread = 0.16 + (n - 1) * 0.025;
  pends = [
    {
      amp: 0.78,
      freq: base,
      phase: randPhase(),
      theta: 0,
      x: PIVOTS_X[0]!,
      y: PIVOT_Y,
    },
    {
      amp: 0.78,
      freq: base + spread,
      phase: randPhase(),
      theta: 0,
      x: PIVOTS_X[1]!,
      y: PIVOT_Y,
    },
    {
      amp: 0.78,
      freq: base + 2 * spread,
      phase: randPhase(),
      theta: 0,
      x: PIVOTS_X[2]!,
      y: PIVOT_Y,
    },
  ];
}

function setHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  missEl.textContent = `${misses}/${MAX_MISSES}`;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  misses = 0;
  level = 1;
  pausedAccum = 0;
  freezeUntil = 0;
  flashUntil = 0;
  lockedAt = 0;
  spawnLevel(level);
  setHud();
  showOverlay('Ahenk', 'Üç sarkaç aynı anda dikeyden geçince Boşluk\'a bas. 5 ıska ile elenirsin.', 'Başla');
  // Start the draw loop so the player sees motion immediately even
  // before pressing Start. PITFALLS#invisible-boot.
  startLoop();
}

function startPlaying(): void {
  if (state !== 'ready' && state !== 'gameover') return;
  const fromGameover = state === 'gameover';
  if (fromGameover) {
    // Fresh game from gameover overlay; bump invalidates the previous
    // draw loop so we restart it below.
    gen.bump();
    score = 0;
    misses = 0;
    level = 1;
    spawnLevel(level);
    setHud();
  }
  state = 'playing';
  startTs = performance.now();
  pausedAccum = 0;
  freezeUntil = 0;
  flashUntil = 0;
  hideOverlay();
  if (fromGameover) startLoop();
}

function startLoop(): void {
  const token = gen.current();
  const loop = (now: number) => {
    if (!gen.isCurrent(token)) return;
    step(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function step(now: number): void {
  // Sample positions for both draw and (potential) judge.
  const tSec =
    state === 'playing'
      ? (now - startTs - pausedAccum) / 1000
      : now / 1000;
  if (state === 'playing' && now < freezeUntil) {
    // Stay frozen at the last drawn theta (don't advance time during freeze).
    // We do this by pretending the freeze interval is part of pausedAccum.
    // Implemented by skipping the freq advance during freeze.
  }
  const sampleT = state === 'playing' && now < freezeUntil ? lockedAt / 1000 : tSec;
  for (const p of pends) {
    p.theta = p.amp * Math.sin(2 * Math.PI * p.freq * sampleT + p.phase);
  }
  draw(now);
}

function judge(now: number): void {
  if (state !== 'playing') return;
  if (now < freezeUntil) return;
  // Lock condition: each bob's horizontal offset from its pivot is within
  // LOCK_TOLERANCE_PX. Mathematically equivalent to small |theta|, but we
  // use pixel distance so it matches what the player visually sees.
  const dx = pends.map((p) => ROPE_LEN * Math.sin(p.theta));
  const allInBand = dx.every((d) => Math.abs(d) <= LOCK_TOLERANCE_PX);
  if (allInBand) {
    score++;
    commitBest();
    if (score % 3 === 0) level++;
    setHud();
    flashKind = 'hit';
    flashUntil = now + HIT_FLASH_MS;
    freezeUntil = now + HIT_FREEZE_MS;
    lockedAt = performance.now() - startTs - pausedAccum;
    // Re-roll frequencies/phases after the freeze so the next round is fresh.
    // Done at freeze-start; the visual stays frozen, sampleT stays pinned.
    queueAfterFreeze(now + HIT_FREEZE_MS);
  } else {
    misses++;
    setHud();
    flashKind = 'miss';
    flashUntil = now + MISS_FLASH_MS;
    if (misses >= MAX_MISSES) {
      state = 'gameover';
      showOverlay(
        'Bitti',
        `Skor: ${score}\nRekor: ${best}\nBoşluk veya Başla ile yeniden dene.`,
        'Yeniden başla',
      );
    }
  }
}

function queueAfterFreeze(deadline: number): void {
  const token = gen.current();
  const tick = (now: number) => {
    if (!gen.isCurrent(token)) return;
    if (now < deadline) {
      requestAnimationFrame(tick);
      return;
    }
    if (state !== 'playing') return;
    // Reset the time origin so frequencies start fresh from the locked instant,
    // hiding the "snap" — and absorb the freeze duration into pausedAccum so
    // sampleT continues smoothly.
    spawnLevel(level);
    const elapsedBeforeFreeze = lockedAt;
    startTs = now;
    pausedAccum = -elapsedBeforeFreeze;
  };
  requestAnimationFrame(tick);
}

function draw(now: number): void {
  const w = canvas.width;
  const h = canvas.height;
  const bg = css('--surface', '#11141a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Top bar (the rail the pendulums hang from).
  ctx.fillStyle = css('--border', '#2a2f38');
  ctx.fillRect(60, PIVOT_Y - 4, w - 120, 4);

  // Lock band — a soft vertical strip under each pivot, the size of the
  // tolerance the judge() function actually uses.
  const flashActive = now < flashUntil;
  let bandColor = 'rgba(99, 102, 241, 0.16)';
  let bandEdge = 'rgba(99, 102, 241, 0.45)';
  if (flashActive && flashKind === 'hit') {
    bandColor = 'rgba(52, 211, 153, 0.28)';
    bandEdge = 'rgba(52, 211, 153, 0.75)';
  } else if (flashActive && flashKind === 'miss') {
    bandColor = 'rgba(251, 113, 133, 0.24)';
    bandEdge = 'rgba(251, 113, 133, 0.7)';
  }
  for (const px of PIVOTS_X) {
    ctx.fillStyle = bandColor;
    ctx.fillRect(px - LOCK_TOLERANCE_PX, PIVOT_Y, LOCK_TOLERANCE_PX * 2, ROPE_LEN + BOB_R + 10);
    ctx.strokeStyle = bandEdge;
    ctx.lineWidth = 1;
    ctx.strokeRect(px - LOCK_TOLERANCE_PX, PIVOT_Y, LOCK_TOLERANCE_PX * 2, ROPE_LEN + BOB_R + 10);
  }

  // Pendulums.
  const colors = [
    css('--ahenk-a', '#60a5fa'),
    css('--ahenk-b', '#fbbf24'),
    css('--ahenk-c', '#34d399'),
  ];
  for (let i = 0; i < pends.length; i++) {
    const p = pends[i]!;
    const bx = p.x + ROPE_LEN * Math.sin(p.theta);
    const by = p.y + ROPE_LEN * Math.cos(p.theta);

    // Rope.
    ctx.strokeStyle = css('--text-dim', '#6b7280');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(bx, by);
    ctx.stroke();

    // Pivot.
    ctx.fillStyle = css('--text', '#e5e7eb');
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();

    // Bob.
    const inBand = Math.abs(ROPE_LEN * Math.sin(p.theta)) <= LOCK_TOLERANCE_PX;
    ctx.fillStyle = colors[i]!;
    ctx.beginPath();
    ctx.arc(bx, by, BOB_R, 0, Math.PI * 2);
    ctx.fill();
    if (inBand) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, BOB_R + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Bottom prompt.
  ctx.fillStyle = css('--text-dim', '#9ca3af');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  if (state === 'playing') {
    const allIn = pends.every((p) => Math.abs(ROPE_LEN * Math.sin(p.theta)) <= LOCK_TOLERANCE_PX);
    ctx.fillStyle = allIn ? css('--ahenk-c', '#34d399') : css('--text-dim', '#9ca3af');
    ctx.fillText(allIn ? 'ŞİMDİ — Boşluk!' : 'Seviye ' + level, w / 2, h - 14);
  } else if (state === 'ready') {
    ctx.fillText('Başla → sarkaçlar dikeyden geçince Boşluk', w / 2, h - 14);
  } else {
    ctx.fillText('Bitti — Boşluk veya butonla yeniden başla', w / 2, h - 14);
  }
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === ' ' || k === 'Spacebar') {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') {
      startPlaying();
      return;
    }
    judge(performance.now());
  } else if (k === 'r' || k === 'R') {
    e.preventDefault();
    reset();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  missEl = document.querySelector<HTMLElement>('#miss')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  touchBtn = document.querySelector<HTMLButtonElement>('#touch-lock')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', () => reset());
  overlayBtn.addEventListener('click', () => startPlaying());
  touchBtn.addEventListener('click', () => {
    if (state === 'ready' || state === 'gameover') {
      startPlaying();
      return;
    }
    judge(performance.now());
  });

  reset();
}

export const game = defineGame({ init, reset });
