import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'bukalemun.best';
const SCORE_DESC = {
  gameId: 'bukalemun',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

type State = 'ready' | 'playing' | 'reveal' | 'gameover';
type RGB = [number, number, number];
type Channel = 'r' | 'g' | 'b';

const CHANNELS: Channel[] = ['r', 'g', 'b'];
const CHANNEL_IDX: Record<Channel, 0 | 1 | 2> = { r: 0, g: 1, b: 2 };

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let round = 1;
let lives = 3;
let activeChannel: Channel = 'r';

let target: RGB = [128, 128, 128];
let player: RGB = [128, 128, 128];
let lastRoundScore = 0;
let lastSuccess = false;

let roundDeadline = 0;
let roundDuration = 7000;

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let roundEl!: HTMLElement;
let livesEl!: HTMLElement;
let timerBarEl!: HTMLElement;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let commitBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
const sliders = {} as Record<Channel, HTMLInputElement>;
const sliderVals = {} as Record<Channel, HTMLElement>;

let rafHandle: number | null = null;

function rgbStr(c: RGB): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function colorDistance(a: RGB, b: RGB): number {
  const dr = (a[0] - b[0]) / 255;
  const dg = (a[1] - b[1]) / 255;
  const db = (a[2] - b[2]) / 255;
  return Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function randomTarget(): RGB {
  const h = Math.random() * 360;
  const sLo = round < 4 ? 0.5 : round < 7 ? 0.35 : 0.2;
  const sHi = round < 4 ? 0.9 : round < 7 ? 0.75 : 0.55;
  const lLo = round < 7 ? 0.32 : 0.42;
  const lHi = round < 7 ? 0.7 : 0.62;
  const s = sLo + Math.random() * (sHi - sLo);
  const l = lLo + Math.random() * (lHi - lLo);
  return hslToRgb(h, s, l);
}

function roundDurationMs(): number {
  return Math.max(3500, 7000 - (round - 1) * 350);
}

function scoreForDistance(d: number): number {
  const factor = 100 + (round - 1) * 10;
  return Math.max(0, Math.round(100 - d * factor));
}

function isSuccess(d: number): boolean {
  const tol = Math.max(0.12, 0.22 - (round - 1) * 0.012);
  return d <= tol;
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  roundEl.textContent = String(round);
  const filled = Math.max(0, lives);
  const empty = Math.max(0, 3 - filled);
  livesEl.textContent = '♥'.repeat(filled) + '♡'.repeat(empty);
}

function syncSliderInputs(): void {
  for (const ch of CHANNELS) {
    const v = player[CHANNEL_IDX[ch]];
    sliders[ch].value = String(v);
    sliderVals[ch].textContent = String(v);
  }
}

function setActiveChannel(ch: Channel): void {
  activeChannel = ch;
  for (const c of CHANNELS) {
    const wrap = sliders[c].closest('.bk-slider');
    if (wrap) wrap.classList.toggle('bk-slider--active', c === ch);
  }
}

function startRound(): void {
  state = 'playing';
  target = randomTarget();
  player = [128, 128, 128];
  syncSliderInputs();
  roundDuration = roundDurationMs();
  roundDeadline = performance.now() + roundDuration;
  commitBtn.disabled = false;
  timerBarEl.style.width = '100%';
  updateHud();
  draw();
  startRaf();
}

function startRaf(): void {
  if (rafHandle !== null) return;
  const myGen = gen.current();
  const tick = (): void => {
    if (!gen.isCurrent(myGen)) {
      rafHandle = null;
      return;
    }
    rafHandle = requestAnimationFrame(tick);
    if (state === 'playing') {
      const remain = Math.max(0, roundDeadline - performance.now());
      timerBarEl.style.width = `${(remain / roundDuration) * 100}%`;
      if (remain <= 0) {
        commit();
        return;
      }
    }
    draw();
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopRaf(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

function commit(): void {
  if (state !== 'playing') return;
  state = 'reveal';
  commitBtn.disabled = true;
  const d = colorDistance(player, target);
  lastRoundScore = scoreForDistance(d);
  lastSuccess = isSuccess(d);
  score += lastRoundScore;
  if (!lastSuccess) lives -= 1;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  draw();
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (lives <= 0) {
      gameOver();
    } else {
      round += 1;
      startRound();
    }
  }, 1400);
}

function gameOver(): void {
  state = 'gameover';
  stopRaf();
  reportGameOver(SCORE_DESC, score);
  overlayTitle.textContent = 'Yakalandın';
  overlayMsg.textContent =
    `${round}. turda görüldün. Toplam skor: ${score}.\n` +
    `Tekrar denemek için Başla'ya bas (R tuşu da çalışır).`;
  overlayBtn.textContent = 'Tekrar dene';
  showOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  stopRaf();
  state = 'ready';
  score = 0;
  round = 1;
  lives = 3;
  target = [128, 128, 128];
  player = [128, 128, 128];
  lastRoundScore = 0;
  lastSuccess = false;
  syncSliderInputs();
  timerBarEl.style.width = '100%';
  commitBtn.disabled = false;
  overlayTitle.textContent = 'Bukalemun';
  overlayMsg.textContent =
    'Avcı görmeden önce sürgüleri ayarla, bukalemunu arka planın rengine kamufle et.\n' +
    'Klavye: 1/2/3 → kanal seç, ←→ veya ↑↓ → ayarla, Boşluk → onayla.\n' +
    '3 başarısızlıkta oyun biter.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  updateHud();
  draw();
}

function startFromOverlay(): void {
  hideOverlayEl(overlay);
  startRound();
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = rgbStr(target);
  ctx.fillRect(0, 0, w, h);

  const grad = ctx.createRadialGradient(w / 2, h / 2, w * 0.18, w / 2, h / 2, w * 0.7);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  drawChameleon(w / 2, h * 0.58, rgbStr(player));

  if (state === 'reveal') drawRevealBanner();
}

function drawChameleon(cx: number, cy: number, fill: string): void {
  const scale = canvas.width / 480;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);

  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(20, 56, 130, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  const body = new Path2D();
  body.moveTo(-60, 8);
  body.bezierCurveTo(-72, -56, 0, -78, 60, -58);
  body.bezierCurveTo(100, -48, 126, -28, 132, -2);
  body.quadraticCurveTo(134, 22, 110, 22);
  body.quadraticCurveTo(85, 30, 35, 32);
  body.bezierCurveTo(-15, 38, -50, 35, -60, 8);
  body.closePath();

  const tail = new Path2D();
  tail.moveTo(-60, 2);
  tail.bezierCurveTo(-118, -10, -154, 20, -132, 56);
  tail.bezierCurveTo(-114, 82, -82, 80, -74, 56);
  tail.bezierCurveTo(-70, 40, -82, 22, -90, 18);
  tail.closePath();

  const crest = new Path2D();
  crest.moveTo(-10, -68);
  crest.lineTo(8, -78);
  crest.lineTo(22, -68);
  crest.lineTo(38, -76);
  crest.lineTo(54, -64);
  crest.lineTo(40, -58);
  crest.lineTo(20, -62);
  crest.closePath();

  ctx.fillStyle = fill;
  ctx.fill(tail);
  ctx.fill(body);
  ctx.fill(crest);

  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 2.2;
  ctx.stroke(tail);
  ctx.stroke(body);
  ctx.stroke(crest);

  const legs: Array<[number, number, number, number]> = [
    [-12, 36, 9, 16],
    [60, 34, 9, 16],
    [-34, 33, 7, 13],
    [88, 28, 7, 13],
  ];
  ctx.fillStyle = fill;
  for (const [lx, ly, rw, rh] of legs) {
    ctx.beginPath();
    ctx.ellipse(lx, ly, rw, rh, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(100, -22, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#0a0b0e';
  ctx.beginPath();
  ctx.arc(103, -21, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(101, -23, 1.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawRevealBanner(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = 'rgba(10,11,14,0.5)';
  ctx.fillRect(0, 0, w, h);

  const bw = Math.min(w * 0.78, 340);
  const bh = 108;
  const bx = (w - bw) / 2;
  const by = Math.max(12, h * 0.14);
  ctx.fillStyle = 'rgba(20,22,28,0.94)';
  roundRect(bx, by, bw, bh, 14);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const sw = 40;
  const sy = by + 18;
  ctx.fillStyle = rgbStr(target);
  ctx.fillRect(bx + 18, sy, sw, sw);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx + 18, sy, sw, sw);

  ctx.fillStyle = rgbStr(player);
  ctx.fillRect(bx + 18 + sw + 10, sy, sw, sw);
  ctx.strokeRect(bx + 18 + sw + 10, sy, sw, sw);

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillText('Hedef', bx + 18 + sw / 2, sy + sw + 6);
  ctx.fillText('Sen', bx + 18 + sw + 10 + sw / 2, sy + sw + 6);

  const tx = bx + 18 + (sw + 10) * 2 + 12;
  ctx.textAlign = 'left';
  ctx.font = 'bold 20px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = lastSuccess ? '#6ee7b7' : '#ff8c8c';
  ctx.fillText(lastSuccess ? '✓ Kamuflaj' : '✗ Görüldün', tx, sy + 2);
  ctx.fillStyle = '#fff';
  ctx.font = '13px system-ui, -apple-system, sans-serif';
  ctx.fillText(`+${lastRoundScore} puan`, tx, sy + 30);
  if (!lastSuccess) {
    ctx.fillStyle = '#ff8c8c';
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.fillText('Bir can gitti', tx, sy + 50);
  }
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function adjustChannel(ch: Channel, delta: number): void {
  if (state !== 'playing') return;
  const idx = CHANNEL_IDX[ch];
  const next = Math.max(0, Math.min(255, player[idx] + delta));
  player = [player[0], player[1], player[2]];
  player[idx] = next;
  syncSliderInputs();
  setActiveChannel(ch);
  draw();
}

function onSliderInput(ch: Channel): void {
  if (state !== 'playing') return;
  const idx = CHANNEL_IDX[ch];
  const v = Number(sliders[ch].value);
  player = [player[0], player[1], player[2]];
  player[idx] = v;
  sliderVals[ch].textContent = String(v);
  setActiveChannel(ch);
  draw();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (k === 'enter' || k === ' ') {
      startFromOverlay();
      e.preventDefault();
    }
    return;
  }
  if (state !== 'playing') return;
  if (k === '1') {
    setActiveChannel('r');
    sliders.r.focus();
    e.preventDefault();
    return;
  }
  if (k === '2') {
    setActiveChannel('g');
    sliders.g.focus();
    e.preventDefault();
    return;
  }
  if (k === '3') {
    setActiveChannel('b');
    sliders.b.focus();
    e.preventDefault();
    return;
  }
  const step = e.shiftKey ? 32 : 8;
  if (k === 'arrowleft' || k === 'arrowdown') {
    adjustChannel(activeChannel, -step);
    e.preventDefault();
    return;
  }
  if (k === 'arrowright' || k === 'arrowup') {
    adjustChannel(activeChannel, step);
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    commit();
    e.preventDefault();
  }
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  timerBarEl = document.querySelector<HTMLElement>('#timer-bar')!;
  canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
  ctx = canvas.getContext('2d')!;
  commitBtn = document.querySelector<HTMLButtonElement>('#commit')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  sliders.r = document.querySelector<HTMLInputElement>('#r-input')!;
  sliders.g = document.querySelector<HTMLInputElement>('#g-input')!;
  sliders.b = document.querySelector<HTMLInputElement>('#b-input')!;
  sliderVals.r = document.querySelector<HTMLElement>('#r-val')!;
  sliderVals.g = document.querySelector<HTMLElement>('#g-val')!;
  sliderVals.b = document.querySelector<HTMLElement>('#b-val')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  for (const ch of CHANNELS) {
    sliders[ch].addEventListener('input', () => onSliderInput(ch));
    sliders[ch].addEventListener('focus', () => setActiveChannel(ch));
  }
  commitBtn.addEventListener('click', () => commit());
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', startFromOverlay);
  window.addEventListener('keydown', onKey);

  setActiveChannel('r');
  reset();
}

export const game = defineGame({ init, reset });
