import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite for best score.
// - stale-async-callback: gen-token cancels delayed between-round transition.
// - overlay-input-leak: explicit state enum; every input handler guards.
// - module-level-dom-access: all DOM/storage access lives in init().
// - missing-overlay-css: .overlay--hidden defined in bes-tas.css.
// - visual-vs-hitbox: stones drawn and hit-tested off the same Stone record.
// - invisible-boot: ready overlay + initial floor stones rendered at reset().
// - unreachable-start-state: Start button + Space + canvas/overlay click toss.

const STORAGE_BEST = 'bes-tas.best';

const W = 480;
const H = 480;
const FLOOR_Y = 360;
const STONE_R = 22;
const AIR_STONE_R = 18;
const PEAK_Y = 70;
const MAX_ROUND = 5;
// Air time per round (ms). Index 0 unused.
const TOSS_DURATIONS = [0, 1700, 1500, 1300, 1100, 950];

type State = 'ready' | 'tossing' | 'between' | 'gameover' | 'won';

interface Stone {
  id: number;
  x: number;
  y: number;
  tint: string;
  picked: boolean;
  pickT: number;
}

const gen = createGenToken();

let state: State = 'ready';
let round = 1;
let best = 0;
let target = 1;
let floorStones: Stone[] = [];
let pickedThisToss: number[] = [];
let tossStartT = 0;
let tossDuration = TOSS_DURATIONS[1]!;
let lastT = 0;
let rafId = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let targetEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const TINTS = ['#d8c5a3', '#b9a07a', '#cfb892', '#a48a64', '#e0cba4'];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function placeFloorStones(): void {
  floorStones = [];
  const slotW = (W - 80) / 5;
  for (let i = 0; i < 5; i++) {
    const cx = 40 + slotW * (i + 0.5) + rand(-12, 12);
    const cy = FLOOR_Y + rand(-10, 18);
    floorStones.push({
      id: i,
      x: cx,
      y: cy,
      tint: TINTS[i % TINTS.length]!,
      picked: false,
      pickT: 0,
    });
  }
}

function activeStones(): Stone[] {
  return floorStones.filter((s) => !s.picked);
}

function computeTarget(): number {
  const remaining = activeStones().length;
  return Math.min(round, remaining);
}

function updateHud(): void {
  scoreEl.textContent = String(round);
  bestEl.textContent = String(best);
  targetEl.textContent = String(target);
}

function commitBest(): void {
  if (round > best) {
    best = round;
    safeWrite(STORAGE_BEST, best);
  }
}

function setOverlay(title: string, html: string, showStart: boolean): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = html;
  startBtn.style.display = showStart ? 'inline-block' : 'none';
  showOverlay(overlayEl);
}

function readyOverlay(): void {
  setOverlay(
    'Beş Taş',
    `Havadaki taşı düşmeden, yerden <strong>${target}</strong> taş kap.<br />` +
      `Her tur bir taş daha — beş turu bitir.`,
    true,
  );
}

function reset(): void {
  gen.bump();
  state = 'ready';
  round = 1;
  pickedThisToss = [];
  placeFloorStones();
  target = computeTarget();
  tossDuration = TOSS_DURATIONS[round]!;
  updateHud();
  readyOverlay();
}

function nextRound(): void {
  round = Math.min(MAX_ROUND, round + 1);
  pickedThisToss = [];
  placeFloorStones();
  target = computeTarget();
  tossDuration = TOSS_DURATIONS[round]!;
  updateHud();
}

function toss(): void {
  if (state !== 'ready' && state !== 'between') return;
  if (activeStones().length === 0) {
    nextRound();
  }
  target = computeTarget();
  pickedThisToss = [];
  tossStartT = performance.now();
  state = 'tossing';
  hideOverlay(overlayEl);
  updateHud();
}

function tossT(): number {
  if (state !== 'tossing') return 0;
  return Math.min(1, (performance.now() - tossStartT) / tossDuration);
}

function airStonePos(): { x: number; y: number; landing: boolean } {
  const t = tossT();
  const cx = W / 2;
  const startY = FLOOR_Y - 40;
  const arc = 1 - (2 * t - 1) * (2 * t - 1);
  const y = startY - (startY - PEAK_Y) * arc;
  const x = cx + Math.sin(t * Math.PI) * 6 - 6;
  return { x, y, landing: t > 0.78 };
}

function endRoundCheck(): void {
  if (state !== 'tossing') return;
  if (pickedThisToss.length !== target) {
    state = 'gameover';
    commitBest();
    const reason =
      pickedThisToss.length < target
        ? `Yetersiz: ${pickedThisToss.length}/${target} kaptın.`
        : `Fazla: ${pickedThisToss.length}/${target} kaptın.`;
    setOverlay(
      'Düştü!',
      `${reason}<br />Tur: <strong>${round}</strong><br />Yeniden için <strong>R</strong> veya Başla.`,
      true,
    );
    return;
  }
  if (activeStones().length === 0) {
    if (round >= MAX_ROUND) {
      commitBest();
      state = 'won';
      setOverlay(
        'Bitirdin!',
        `Beş turu da tamamladın.<br />Yeniden için <strong>R</strong> veya Başla.`,
        true,
      );
      return;
    }
    state = 'between';
    commitBest();
    setOverlay(
      `Tur ${round} tamam`,
      `Bir sonraki tur: her atışta <strong>${Math.min(round + 1, MAX_ROUND)}</strong> taş.`,
      false,
    );
    const myGen = gen.current();
    setTimeout(() => {
      if (!gen.isCurrent(myGen)) return;
      if (state !== 'between') return;
      nextRound();
      setOverlay(
        `Tur ${round}`,
        `Her atışta <strong>${target}</strong> taş.<br />Boşluk veya zemine tıkla → at`,
        false,
      );
    }, 850);
    return;
  }
  state = 'between';
  target = computeTarget();
  updateHud();
  setOverlay(
    `Güzel kaptın`,
    `Kalan: <strong>${activeStones().length}</strong> taş.<br />` +
      `Sonraki atış: <strong>${target}</strong> taş.<br />Boşluk veya zemine tıkla → at`,
    false,
  );
}

function pickStone(s: Stone): void {
  if (s.picked) return;
  s.picked = true;
  s.pickT = 420;
  pickedThisToss.push(s.id);
}

function hitStone(px: number, py: number): Stone | null {
  for (let i = floorStones.length - 1; i >= 0; i--) {
    const s = floorStones[i]!;
    if (s.picked) continue;
    const dx = px - s.x;
    const dy = py - s.y;
    if (dx * dx + dy * dy <= STONE_R * STONE_R) return s;
  }
  return null;
}

function canvasCoord(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault();
  if (state === 'gameover' || state === 'won') {
    reset();
    return;
  }
  const { x, y } = canvasCoord(e);
  if (state === 'tossing') {
    const s = hitStone(x, y);
    if (s) pickStone(s);
    return;
  }
  if (state === 'ready' || state === 'between') {
    toss();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  if (e.code === 'KeyR') {
    e.preventDefault();
    reset();
    return;
  }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (state === 'gameover' || state === 'won') {
      reset();
      return;
    }
    if (state === 'ready' || state === 'between') {
      toss();
    }
  }
}

function drawFloor(): void {
  const g = ctx.createLinearGradient(0, FLOOR_Y - 30, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.4, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, FLOOR_Y - 30, W, H - FLOOR_Y + 30);
  ctx.strokeStyle = 'rgba(180, 220, 140, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 60; i++) {
    const x = (i * 53) % W;
    const y = FLOOR_Y + 20 + ((i * 17) % 80);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 2, y - 4);
    ctx.stroke();
  }
}

function drawStone(s: Stone): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath();
  ctx.ellipse(s.x + 3, s.y + STONE_R * 0.85, STONE_R * 0.85, STONE_R * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const grad = ctx.createRadialGradient(
    s.x - STONE_R * 0.35,
    s.y - STONE_R * 0.35,
    STONE_R * 0.15,
    s.x,
    s.y,
    STONE_R,
  );
  grad.addColorStop(0, '#fff7e2');
  grad.addColorStop(0.4, s.tint);
  grad.addColorStop(1, '#5a4a30');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(s.x, s.y, STONE_R, STONE_R * 0.82, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(80,60,30,0.18)';
  for (let i = 0; i < 4; i++) {
    const ang = (i * 1.7 + s.id) % (Math.PI * 2);
    const r = STONE_R * (0.35 + 0.4 * Math.abs(Math.sin(s.id + i)));
    ctx.beginPath();
    ctx.arc(s.x + Math.cos(ang) * r * 0.6, s.y + Math.sin(ang) * r * 0.4, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state === 'tossing') {
    ctx.strokeStyle = 'rgba(255,247,200,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, STONE_R + 2, STONE_R * 0.82 + 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPickedFlash(s: Stone): void {
  const alpha = Math.max(0, s.pickT / 420);
  ctx.fillStyle = `rgba(245, 215, 110, ${0.55 * alpha})`;
  ctx.beginPath();
  ctx.arc(s.x, s.y, STONE_R * (1 + (1 - alpha) * 0.4), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(245, 215, 110, ${0.9 * alpha})`;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(s.x - 8, s.y);
  ctx.lineTo(s.x - 2, s.y + 7);
  ctx.lineTo(s.x + 9, s.y - 7);
  ctx.stroke();
}

function drawAirStone(): void {
  if (state !== 'tossing') return;
  const { x, y, landing } = airStonePos();
  const heightFrac = (FLOOR_Y - 40 - y) / (FLOOR_Y - 40 - PEAK_Y);
  const shadowScale = 1 - heightFrac * 0.55;
  ctx.fillStyle = `rgba(0,0,0,${0.18 + 0.22 * shadowScale})`;
  ctx.beginPath();
  ctx.ellipse(W / 2, FLOOR_Y + 8, 16 * shadowScale, 6 * shadowScale, 0, 0, Math.PI * 2);
  ctx.fill();

  const grad = ctx.createRadialGradient(
    x - AIR_STONE_R * 0.35,
    y - AIR_STONE_R * 0.35,
    AIR_STONE_R * 0.2,
    x,
    y,
    AIR_STONE_R,
  );
  grad.addColorStop(0, '#fff8e2');
  grad.addColorStop(0.5, '#e8c97a');
  grad.addColorStop(1, '#7a5b1c');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, y, AIR_STONE_R, AIR_STONE_R * 0.85, 0.3, 0, Math.PI * 2);
  ctx.fill();

  if (landing) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.02);
    ctx.strokeStyle = `rgba(255, 140, 80, ${0.4 + 0.4 * pulse})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, AIR_STONE_R + 4 + pulse * 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  const t = tossT();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(40, 24, W - 80, 8);
  ctx.fillStyle = landing ? '#ff8c50' : '#f5d76e';
  ctx.fillRect(40, 24, (W - 80) * (1 - t), 8);
}

function drawHud(): void {
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.font = 'bold 16px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`Elindeki: ${pickedThisToss.length} / ${target}`, 14, 52);
  ctx.textAlign = 'right';
  ctx.fillText(`Tur ${round}/${MAX_ROUND}`, W - 14, 52);
}

function render(): void {
  ctx.clearRect(0, 0, W, H);
  drawFloor();
  for (const s of floorStones) {
    if (!s.picked) drawStone(s);
    else if (s.pickT > 0) drawPickedFlash(s);
  }
  drawAirStone();
  drawHud();
}

function frame(now: number): void {
  rafId = requestAnimationFrame(frame);
  if (!lastT) lastT = now;
  const dt = Math.min(60, now - lastT);
  lastT = now;

  for (const s of floorStones) {
    if (s.pickT > 0) s.pickT = Math.max(0, s.pickT - dt);
  }

  if (state === 'tossing' && tossT() >= 1) {
    endRoundCheck();
  }

  render();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  targetEl = document.querySelector<HTMLElement>('#target')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });
  startBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state === 'gameover' || state === 'won') {
      reset();
    } else if (state === 'ready' || state === 'between') {
      toss();
    }
  });
  canvas.addEventListener('pointerdown', onPointerDown);
  overlayEl.addEventListener('pointerdown', (e) => {
    if (e.target === startBtn) return;
    e.preventDefault();
    if (state === 'gameover' || state === 'won') {
      reset();
    } else if (state === 'ready' || state === 'between') {
      toss();
    }
  });
  window.addEventListener('keydown', onKeyDown);

  reset();
  rafId = requestAnimationFrame(frame);
}

function destroy(): void {
  cancelAnimationFrame(rafId);
  window.removeEventListener('keydown', onKeyDown);
}

export const game = defineGame({ init, reset, destroy });
