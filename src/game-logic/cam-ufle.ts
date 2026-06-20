import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Cam Üfle — molten-glass blowing timing game.
//
// Mechanics: a glowing glass bubble (radius `r`) sits in the canvas. While the
// player holds Space (or pointer), `r` grows and `heat` drops. Releasing
// freezes the bubble at its current size. The target is a ghosted ring of
// radius `target`. Hit the ring within tolerance → score. Overshoot by more
// than POP_MARGIN → bubble pops, lose a life. Heat reaching 0 mid-blow stops
// growth (the glass froze too soon).

const STORAGE_BEST = 'cam-ufle.best';

const W = 540;
const H = 420;
const CENTER_X = 220;
const CENTER_Y = 230;

const START_R = 18;
const MIN_TARGET = 60;
const MAX_TARGET = 150;
const POP_MARGIN = 26;
const GROW_RATE = 70; // px/sec
const HEAT_DRAIN = 55; // units/sec
const HEAT_REGEN = 75; // units/sec
const TOTAL_ROUNDS = 10;
const STARTING_LIVES = 3;

const TOL_BULL = 6;
const TOL_GOOD = 14;
const TOL_OK = 24;

type Phase =
  | 'ready'
  | 'idle'
  | 'blowing'
  | 'frozen'
  | 'popped'
  | 'reveal'
  | 'match-over';

let phase: Phase = 'ready';
let round = 0;
let score = 0;
let best = 0;
let lives = STARTING_LIVES;

let target = 0;
let r = START_R;
let heat = 100;
let popFrame = 0;

let lastNow = 0;
let rafId = 0;
let pressed = false;
let keyHeld = false;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let roundEl!: HTMLElement;
let livesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayBody!: HTMLElement;
let heatFillEl!: HTMLElement;
let targetLabelEl!: HTMLElement;

const gen = createGenToken();

function isBlowing(): boolean {
  return pressed || keyHeld;
}

function pickTarget(): number {
  const easy = round <= 3;
  const mid = round <= 7;
  const lo = easy ? 70 : MIN_TARGET;
  const hi = easy ? 130 : mid ? 140 : MAX_TARGET;
  return Math.round(lo + Math.random() * (hi - lo));
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  roundEl.textContent = `${Math.min(round, TOTAL_ROUNDS)}/${TOTAL_ROUNDS}`;
  livesEl.textContent =
    lives <= 0
      ? '○○○'
      : '●'.repeat(lives) + '○'.repeat(STARTING_LIVES - lives);
  bestEl.textContent = String(best);
  heatFillEl.style.width = `${Math.max(0, Math.min(100, heat)).toFixed(1)}%`;
  targetLabelEl.textContent = target > 0 ? `${target}px` : '—';
}

const cssCache = new Map<string, string>();
function readVar(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const val = v || fallback;
  cssCache.set(name, val);
  return val;
}

function draw(): void {
  ctx.fillStyle = readVar('--bg', '#0a0b0e');
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = readVar('--border', '#2a2d33');
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, W - 16, H - 16);

  ctx.strokeStyle = 'rgba(170, 180, 200, 0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = 80; y < H - 16; y += 36) {
    ctx.moveTo(16, y + 0.5);
    ctx.lineTo(W - 16, y + 0.5);
  }
  ctx.stroke();

  // Blowpipe (decorative; line under the bubble so it visually feeds it).
  ctx.strokeStyle = '#7a6b5b';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(40, H - 70);
  ctx.lineTo(CENTER_X - r - 4, CENTER_Y + (H - 70 - CENTER_Y) * 0.35);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // Target ghost ring (right of center, separate so the player can compare).
  const targetX = CENTER_X + 180;
  if (target > 0 && phase !== 'ready') {
    ctx.strokeStyle = 'rgba(170, 200, 240, 0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(targetX, CENTER_Y, target, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(170, 200, 240, 0.75)';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('hedef', targetX, CENTER_Y - target - 10);
  }

  // Glass bubble.
  if (phase !== 'popped' || popFrame < 0.99) {
    const tHeat = Math.max(0, Math.min(1, heat / 100));
    const hr = Math.round(255 * (0.6 + 0.4 * tHeat));
    const hg = Math.round(170 * (0.4 + 0.6 * tHeat));
    const hb = Math.round(90 * (0.3 + 0.5 * tHeat));
    ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, 0.85)`;
    ctx.beginPath();
    ctx.arc(CENTER_X, CENTER_Y, r, 0, Math.PI * 2);
    ctx.fill();
    const grd = ctx.createRadialGradient(
      CENTER_X - r * 0.4,
      CENTER_Y - r * 0.4,
      r * 0.1,
      CENTER_X,
      CENTER_Y,
      r,
    );
    grd.addColorStop(0, `rgba(255, 240, 200, ${0.45 * tHeat + 0.15})`);
    grd.addColorStop(1, 'rgba(255, 240, 200, 0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(CENTER_X, CENTER_Y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 220, 170, ${0.4 + 0.4 * tHeat})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Pop shards.
  if (phase === 'popped') {
    const t = popFrame;
    const shards = 12;
    const baseR = r * (1 + t * 1.4);
    ctx.strokeStyle = `rgba(220, 110, 70, ${1 - t})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < shards; i++) {
      const ang = (i / shards) * Math.PI * 2;
      const r0 = r * (0.6 + 0.3 * Math.sin(i));
      const r1 = baseR + 12;
      const x0 = CENTER_X + Math.cos(ang) * r0;
      const y0 = CENTER_Y + Math.sin(ang) * r0;
      const x1 = CENTER_X + Math.cos(ang) * r1;
      const y1 = CENTER_Y + Math.sin(ang) * r1;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }

  ctx.fillStyle = readVar('--text-dim', '#aab');
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  if (phase === 'idle') {
    ctx.fillText('Boşluk veya basılı tut → üfle', 20, H - 28);
  } else if (phase === 'blowing') {
    ctx.fillStyle = '#ffb15c';
    ctx.fillText('üflüyor…', 20, H - 28);
  } else if (phase === 'frozen') {
    ctx.fillStyle = readVar('--text-dim', '#aab');
    ctx.fillText('dondu', 20, H - 28);
  }
}

function setOverlay(title: string, body: string): void {
  overlayTitle.textContent = title;
  overlayBody.innerHTML = body;
  showOverlay(overlay);
}

function startMatch(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  score = 0;
  round = 0;
  lives = STARTING_LIVES;
  target = 0;
  r = START_R;
  heat = 100;
  pressed = false;
  keyHeld = false;
  phase = 'ready';
  setOverlay(
    'Cam Üfle',
    `Sıcak cam küreyi <strong>hedef yüzüğün</strong> boyutuna kadar üfle, sonra bırak.<br/>` +
      `<strong>Boşluk</strong> veya ekrana <strong>basılı tut</strong>: üfle · bırakınca dondur.<br/>` +
      `Çok büyük → patlar (−1 can). Çok küçük → ham kalır (puan az).<br/>` +
      `${TOTAL_ROUNDS} tur · ${STARTING_LIVES} can · Enter ile başla.`,
  );
  updateHud();
  draw();
  startLoop();
}

function nextRound(): void {
  if (round >= TOTAL_ROUNDS || lives <= 0) {
    endMatch();
    return;
  }
  round++;
  target = pickTarget();
  r = START_R;
  heat = 100;
  pressed = false;
  keyHeld = false;
  phase = 'idle';
  hideOverlay(overlay);
  updateHud();
  draw();
}

function evaluateBubble(): void {
  const diff = r - target;
  if (diff > POP_MARGIN) return; // pop path handles it
  const ad = Math.abs(diff);
  let gain: number;
  let label: string;
  if (ad <= TOL_BULL) {
    gain = 25;
    label = 'Tam isabet!';
  } else if (ad <= TOL_GOOD) {
    gain = 12;
    label = diff < 0 ? 'Biraz küçük' : 'Biraz büyük';
  } else if (ad <= TOL_OK) {
    gain = 4;
    label = diff < 0 ? 'Ham kalmış' : 'Şişkin';
  } else {
    gain = 0;
    label = diff < 0 ? 'Çok ham' : 'Çok şişkin';
  }
  score += gain;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  phase = 'reveal';
  setOverlay(
    `+${gain}`,
    `${label} · küre <strong>${Math.round(r)}px</strong>, hedef <strong>${target}px</strong>.<br/>` +
      `Enter/Boşluk: sonraki tur.`,
  );
  updateHud();
  draw();
}

function popBubble(): void {
  lives = Math.max(0, lives - 1);
  phase = 'popped';
  popFrame = 0;
  updateHud();
  draw();
  const myGen = gen.current();
  const start = performance.now();
  const dur = 420;
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    popFrame = Math.min(1, (now - start) / dur);
    draw();
    if (popFrame < 1) {
      requestAnimationFrame(step);
    } else {
      if (lives <= 0) {
        phase = 'reveal';
        setOverlay(
          'Patladı!',
          `Cam patladı, son canını da kaybettin.<br/>Enter/Boşluk: yeni parti.`,
        );
      } else {
        phase = 'reveal';
        setOverlay(
          'Patladı!',
          `Cam patladı. Kalan can: <strong>${lives}</strong>.<br/>` +
            `Enter/Boşluk: sonraki tur.`,
        );
      }
      updateHud();
      draw();
    }
  };
  requestAnimationFrame(step);
}

function endMatch(): void {
  phase = 'match-over';
  setOverlay(
    'Parti bitti',
    `Toplam <strong>${score}</strong> puan · Rekor <strong>${best}</strong>.<br/>` +
      `Enter/Boşluk veya Yeniden başla: yeni parti.`,
  );
  updateHud();
  draw();
}

function startLoop(): void {
  cancelAnimationFrame(rafId);
  const myGen = gen.current();
  lastNow = performance.now();
  const step = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    const dt = Math.min(0.05, (now - lastNow) / 1000);
    lastNow = now;
    tick(dt);
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function tick(dt: number): void {
  if (phase === 'blowing') {
    if (heat <= 0) {
      heat = 0;
      phase = 'frozen';
      evaluateBubble();
      updateHud();
      draw();
      return;
    }
    if (isBlowing()) {
      r += GROW_RATE * dt;
      heat -= HEAT_DRAIN * dt;
      if (r - target > POP_MARGIN) {
        popBubble();
        return;
      }
    } else {
      phase = 'frozen';
      evaluateBubble();
      return;
    }
  } else if (phase === 'idle') {
    if (isBlowing()) {
      phase = 'blowing';
    } else {
      heat = Math.min(100, heat + HEAT_REGEN * dt);
    }
  }
  updateHud();
  draw();
}

function startPressFromIdle(): void {
  if (phase === 'idle') {
    phase = 'blowing';
  }
}

function advanceOverlay(): void {
  if (phase === 'ready') {
    nextRound();
  } else if (phase === 'reveal') {
    if (lives <= 0) startMatch();
    else nextRound();
  } else if (phase === 'match-over') {
    startMatch();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    startMatch();
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    if (phase === 'ready' || phase === 'reveal' || phase === 'match-over') {
      advanceOverlay();
      e.preventDefault();
      return;
    }
    if (phase === 'idle' || phase === 'blowing') {
      if (!keyHeld) {
        keyHeld = true;
        startPressFromIdle();
      }
      e.preventDefault();
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    if (keyHeld) {
      keyHeld = false;
      e.preventDefault();
    }
  }
}

function onPointerDown(e: PointerEvent): void {
  if (phase === 'idle' || phase === 'blowing') {
    pressed = true;
    startPressFromIdle();
    if (e.cancelable) e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // headless / unsupported
    }
  }
}

function onPointerUp(e: PointerEvent): void {
  if (pressed) {
    pressed = false;
    if (e.cancelable) e.preventDefault();
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }
}

function onOverlayDown(e: PointerEvent): void {
  if (phase === 'ready' || phase === 'reveal' || phase === 'match-over') {
    advanceOverlay();
    e.preventDefault();
  }
}

function reset(): void {
  startMatch();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayBody = document.querySelector<HTMLElement>('#overlay-body')!;
  heatFillEl = document.querySelector<HTMLElement>('#heat-fill')!;
  targetLabelEl = document.querySelector<HTMLElement>('#target-label')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  overlay.addEventListener('pointerdown', onOverlayDown);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  startMatch();
}

export const game = defineGame({ init, reset });
