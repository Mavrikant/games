import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'karpuz.best';
const SCORE_DESC = {
  gameId: 'karpuz',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

const MATCH_MS = 60_000;
const TAP_MS = 1800;

const SLOT_X = [110, 270, 430];
const SLOT_Y = 210;
const MELON_RX = 70;
const MELON_RY = 55;

type Phase = 'ready' | 'playing' | 'gameover';

type Ripeness = 'unripe' | 'ripe' | 'over';

type Melon = {
  ripeness: number;
  category: Ripeness;
  tapped: boolean;
  tapStart: number;
};

function makeMelon(target: Ripeness): Melon {
  let r: number;
  if (target === 'unripe') r = 0.06 + Math.random() * 0.34;
  else if (target === 'ripe') r = 0.46 + Math.random() * 0.3;
  else r = 0.8 + Math.random() * 0.18;
  return { ripeness: r, category: target, tapped: false, tapStart: 0 };
}

let phase: Phase = 'ready';
let melons: Melon[] = [];
let selected = -1;
let score = 0;
let best = 0;
let matchEndAt = 0;
let lastTimeLabel = -1;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let takeBtn!: HTMLButtonElement;
let rejectBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayBody!: HTMLElement;

const gen = createGenToken();
let rafId = 0;

function newStall(): void {
  // Always guarantee exactly one perfectly ripe melon. Others are random
  // mix of unripe / over so the player must compare, not just pick.
  const ripeIdx = Math.floor(Math.random() * 3);
  const others: Ripeness[] = [];
  for (let i = 0; i < 2; i++) {
    others.push(Math.random() < 0.55 ? 'unripe' : 'over');
  }
  melons = [];
  let o = 0;
  for (let i = 0; i < 3; i++) {
    if (i === ripeIdx) melons.push(makeMelon('ripe'));
    else melons.push(makeMelon(others[o++]!));
  }
  selected = -1;
  syncActionButtons();
}

function syncActionButtons(): void {
  const enabled = phase === 'playing' && selected >= 0 && melons[selected]!.tapped;
  takeBtn.disabled = !enabled;
  rejectBtn.disabled = !enabled;
}

function setOverlay(title: string, html: string): void {
  overlayTitle.textContent = title;
  overlayBody.innerHTML = html;
  showOverlay(overlay);
}

function hideOverlayUI(): void {
  hideOverlay(overlay);
}

function startMatch(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  phase = 'playing';
  score = 0;
  matchEndAt = performance.now() + MATCH_MS;
  lastTimeLabel = -1;
  scoreEl.textContent = '0';
  newStall();
  hideOverlayUI();
  loop();
}

function endMatch(): void {
  phase = 'gameover';
  cancelAnimationFrame(rafId);
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  reportGameOver(SCORE_DESC, score);
  timeEl.textContent = '0';
  syncActionButtons();
  setOverlay(
    'Tezgâh kapandı',
    `Sepetinde <strong>${score}</strong> olgun karpuz var. Rekorun: <strong>${best}</strong>.<br/>Boşluk / dokunma: yeni parti.`,
  );
  draw();
}

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  phase = 'ready';
  score = 0;
  melons = [];
  selected = -1;
  scoreEl.textContent = '0';
  timeEl.textContent = String(Math.round(MATCH_MS / 1000));
  lastTimeLabel = -1;
  syncActionButtons();
  setOverlay(
    'Karpuz',
    'Karpuza tıkla, parmağınla şıklat.<br/>Dalgayı oku, olgununu sepete koy.<br/>Boşluk / dokunma: başla.',
  );
  draw();
}

function loop(): void {
  const myGen = gen.current();
  const step = (now: number) => {
    if (!gen.isCurrent(myGen)) return;
    if (phase !== 'playing') return;
    const remain = matchEndAt - now;
    if (remain <= 0) {
      endMatch();
      return;
    }
    const secs = Math.max(0, Math.ceil(remain / 1000));
    if (secs !== lastTimeLabel) {
      timeEl.textContent = String(secs);
      lastTimeLabel = secs;
    }
    draw();
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function tapMelon(i: number): void {
  if (phase !== 'playing') return;
  if (i < 0 || i >= melons.length) return;
  const m = melons[i]!;
  m.tapped = true;
  m.tapStart = performance.now();
  selected = i;
  syncActionButtons();
}

function takeSelected(): void {
  if (phase !== 'playing' || selected < 0) return;
  const m = melons[selected]!;
  if (!m.tapped) return;
  if (m.category === 'ripe') {
    score++;
    scoreEl.textContent = String(score);
    flashStall(true);
  } else if (m.category === 'over') {
    // Looks sound but breaks open: no point, no penalty, but stall changes.
    flashStall(false);
  } else {
    // Unripe: -1, but never below 0.
    score = Math.max(0, score - 1);
    scoreEl.textContent = String(score);
    flashStall(false);
  }
  newStall();
}

function rejectSelected(): void {
  if (phase !== 'playing' || selected < 0) return;
  // Refuse current selection — just deselect. Cheap, no penalty.
  selected = -1;
  syncActionButtons();
}

let flashKind: 'good' | 'bad' | null = null;
let flashUntil = 0;
function flashStall(good: boolean): void {
  flashKind = good ? 'good' : 'bad';
  flashUntil = performance.now() + 320;
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = readVar('--bg', '#0a0b0e');
  ctx.fillRect(0, 0, w, h);

  // Stall plank (table).
  ctx.fillStyle = '#1f2228';
  ctx.fillRect(0, SLOT_Y + MELON_RY + 12, w, h - (SLOT_Y + MELON_RY + 12));
  ctx.strokeStyle = '#2a2d33';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, SLOT_Y + MELON_RY + 12);
  ctx.lineTo(w, SLOT_Y + MELON_RY + 12);
  ctx.stroke();

  // Top sign.
  ctx.fillStyle = 'rgba(220, 220, 230, 0.55)';
  ctx.font = '14px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('Tezgâhtaki üç karpuzdan en olgununu seç', w / 2, 18);

  // Flash overlay.
  const now = performance.now();
  if (flashKind && now < flashUntil) {
    const k = Math.max(0, (flashUntil - now) / 320);
    ctx.fillStyle =
      flashKind === 'good' ? `rgba(125,216,122,${0.18 * k})` : `rgba(225,96,96,${0.18 * k})`;
    ctx.fillRect(0, 0, w, h);
  } else {
    flashKind = null;
  }

  for (let i = 0; i < melons.length; i++) {
    drawMelon(i, melons[i]!);
  }
}

function drawMelon(i: number, m: Melon): void {
  const cx = SLOT_X[i]!;
  const cy = SLOT_Y;
  const isSel = i === selected;

  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + MELON_RY + 6, MELON_RX * 0.9, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body — dark green ellipse.
  ctx.fillStyle = '#1f7a3a';
  ctx.beginPath();
  ctx.ellipse(cx, cy, MELON_RX, MELON_RY, 0, 0, Math.PI * 2);
  ctx.fill();

  // Curved stripes, clipped to body.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, MELON_RX, MELON_RY, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = '#0f5024';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  // Five vertical "longitude" stripes that bow out — each is a bezier
  // arc from (cx + offset, top) to (cx + offset, bottom) with the control
  // point pushed outward so the stripe hugs the curvature of the body.
  for (let s = -2; s <= 2; s++) {
    const offset = (s / 2.4) * MELON_RX * 0.9;
    const bow = (s / 2.4) * 12; // outer stripes bow further
    ctx.beginPath();
    ctx.moveTo(cx + offset, cy - MELON_RY - 4);
    ctx.quadraticCurveTo(cx + offset + bow, cy, cx + offset, cy + MELON_RY + 4);
    ctx.stroke();
  }

  // Tap wave inside (clipped to body).
  if (m.tapped) {
    const t = (performance.now() - m.tapStart) / TAP_MS;
    drawWaveInside(cx, cy, m, Math.min(1, t));
  }

  ctx.restore();

  // Tone bar lives OUTSIDE the body clip so it can sit below the melon.
  if (m.tapped) {
    const t = (performance.now() - m.tapStart) / TAP_MS;
    drawToneBar(cx, cy, m, Math.min(1, t));
  }

  // Highlight rim.
  ctx.strokeStyle = '#0a3a1a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, MELON_RX, MELON_RY, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Glossy crescent.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(
    cx - MELON_RX * 0.35,
    cy - MELON_RY * 0.45,
    MELON_RX * 0.45,
    MELON_RY * 0.22,
    -0.35,
    0,
    Math.PI,
    true,
  );
  ctx.stroke();

  // Selection ring.
  if (isSel) {
    ctx.strokeStyle = '#e2b450';
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.ellipse(cx, cy, MELON_RX + 8, MELON_RY + 8, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Slot number badge — sits below the tone bar so they don't overlap.
  ctx.fillStyle = isSel ? '#e2b450' : 'rgba(220,220,230,0.45)';
  ctx.font = 'bold 16px ui-sans-serif, system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(i + 1), cx, cy + MELON_RY + (m.tapped ? 56 : 28));

  // Tap hint.
  if (!m.tapped) {
    ctx.fillStyle = 'rgba(220,220,230,0.55)';
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('şıklat', cx, cy + 4);
  }
}

// Ripple rings inside the body. The wave shape encodes ripeness: ripe
// → slow, wide-spaced rings; unripe → fast, tight rings; over → broken
// dashed arcs.
function drawWaveInside(cx: number, cy: number, m: Melon, t: number): void {
  const env = (1 - t) * Math.max(0, 1 - Math.pow(t * 1.2, 2));
  if (env <= 0.001) return;
  const phaseTime = t * (1.6 + m.ripeness * 0.8) * Math.PI * 2;
  const tilt = m.category === 'over' ? Math.sin(t * 14) * 0.18 : 0;
  const rings = 4;
  // Ripe rings travel slow; unripe rings travel fast.
  const speed = MELON_RX * 0.85 * (1 - m.ripeness * 0.4);
  // Ring spacing — wider for ripe so they look like a bell, tighter for unripe.
  const ringStride = MELON_RX * (0.18 + (1 - m.ripeness) * 0.16);
  for (let k = 0; k < rings; k++) {
    const r = (t * speed + k * ringStride) % MELON_RX;
    if (r < 4) continue;
    const alpha = (1 - r / MELON_RX) * env * 0.85;
    if (alpha <= 0.02) continue;
    if (m.category === 'over') {
      ctx.strokeStyle = `rgba(255, 235, 200, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 9]);
    } else if (m.category === 'unripe') {
      ctx.strokeStyle = `rgba(180, 230, 255, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = `rgba(255, 200, 180, ${alpha})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.ellipse(
      cx + Math.sin(phaseTime + k) * 1.5,
      cy + tilt * MELON_RY,
      r,
      (r * MELON_RY) / MELON_RX,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// "Tone bar" rendered below the melon — a damped sinusoid that makes the
// resonance shape readable as a literal waveform, not just rings.
function drawToneBar(cx: number, cy: number, m: Melon, t: number): void {
  const env = (1 - t) * Math.max(0, 1 - Math.pow(t * 1.2, 2));
  if (env <= 0.001) return;
  const freq = 5.0 - m.ripeness * 3.6;
  const phaseTime = t * (1.6 + m.ripeness * 0.8) * Math.PI * 2;
  const barW = MELON_RX * 1.6;
  const barH = 26;
  const bx0 = cx - barW / 2;
  const by = cy + MELON_RY + 24;

  ctx.fillStyle = 'rgba(15,18,22,0.85)';
  ctx.fillRect(bx0 - 4, by - barH / 2 - 4, barW + 8, barH + 8);
  ctx.strokeStyle = 'rgba(120,140,160,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx0 - 4, by - barH / 2 - 4, barW + 8, barH + 8);

  ctx.strokeStyle =
    m.category === 'ripe'
      ? '#ffb88a'
      : m.category === 'unripe'
        ? '#9fd6ff'
        : '#f0c060';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const samples = 96;
  // Ripe waves decay slowly (long resonance); unripe decay sharply.
  const decayRate = m.ripeness < 0.42 ? 2.4 : m.ripeness > 0.78 ? 1.8 : 0.8;
  for (let s = 0; s <= samples; s++) {
    const u = s / samples;
    const x = bx0 + u * barW;
    const decay = Math.exp(-u * decayRate);
    let y = Math.sin(u * Math.PI * 2 * freq + phaseTime) * (barH / 2 - 2) * decay * env;
    if (m.category === 'over') {
      y += Math.sin(u * Math.PI * 2 * freq * 2.7 + phaseTime * 1.7) * (barH / 3) * decay * env * 0.6;
    }
    if (s === 0) ctx.moveTo(x, by + y);
    else ctx.lineTo(x, by + y);
  }
  ctx.stroke();
}

const cssCache = new Map<string, string>();
function readVar(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const val = v || fallback;
  cssCache.set(name, val);
  return val;
}

function pickMelonAt(px: number, py: number): number {
  for (let i = 0; i < melons.length; i++) {
    const dx = (px - SLOT_X[i]!) / MELON_RX;
    const dy = (py - SLOT_Y) / MELON_RY;
    if (dx * dx + dy * dy <= 1) return i;
  }
  return -1;
}

function onCanvasPointer(e: PointerEvent): void {
  // Ready/gameover: tapping the board starts a new match (single tap).
  if (phase === 'ready' || phase === 'gameover') {
    startMatch();
    if (e.cancelable) e.preventDefault();
    return;
  }
  if (phase !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * sx;
  const py = (e.clientY - rect.top) * sy;
  const i = pickMelonAt(px, py);
  if (i >= 0) {
    tapMelon(i);
    if (e.cancelable) e.preventDefault();
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (phase === 'ready' || phase === 'gameover') {
    if (e.key === ' ' || e.key === 'Enter') {
      startMatch();
      e.preventDefault();
    }
    return;
  }
  if (phase !== 'playing') return;
  if (e.key === '1') {
    tapMelon(0);
    e.preventDefault();
  } else if (e.key === '2') {
    tapMelon(1);
    e.preventDefault();
  } else if (e.key === '3') {
    tapMelon(2);
    e.preventDefault();
  } else if (e.key === ' ' || e.key === 's' || e.key === 'S') {
    takeSelected();
    e.preventDefault();
  } else if (e.key === 'a' || e.key === 'A') {
    rejectSelected();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  takeBtn = document.querySelector<HTMLButtonElement>('#take')!;
  rejectBtn = document.querySelector<HTMLButtonElement>('#reject')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayBody = document.querySelector<HTMLElement>('#overlay-body')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);
  timeEl.textContent = String(Math.round(MATCH_MS / 1000));

  restartBtn.addEventListener('click', reset);
  takeBtn.addEventListener('click', takeSelected);
  rejectBtn.addEventListener('click', rejectSelected);
  canvas.addEventListener('pointerdown', onCanvasPointer);
  overlay.addEventListener('pointerdown', (e) => {
    if (phase === 'ready' || phase === 'gameover') {
      startMatch();
      e.preventDefault();
    }
  });
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
