import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

const STORAGE_BEST = 'ebru.best';

const W = 640;
const H = 480;
const DROP_RADIUS = 46;
const TARGET_RADIUS = 24;

interface PaletteColor {
  id: string;
  name: string;
  hex: string;
}

const PALETTE: PaletteColor[] = [
  { id: 'red', name: 'Kırmızı', hex: '#d2453a' },
  { id: 'blue', name: 'Mavi', hex: '#2c6aa8' },
  { id: 'yellow', name: 'Sarı', hex: '#e6b836' },
  { id: 'green', name: 'Yeşil', hex: '#4b8a4f' },
  { id: 'purple', name: 'Mor', hex: '#6e3a8c' },
];

interface Drop {
  x: number;
  y: number;
  r: number;
  colorIdx: number;
}

interface Target {
  x: number;
  y: number;
  colorIdx: number;
  hit: boolean;
}

interface RoundDef {
  targets: number;
  budget: number;
}

const ROUNDS: RoundDef[] = [
  { targets: 3, budget: 5 },
  { targets: 4, budget: 7 },
  { targets: 5, budget: 9 },
];

type State = 'ready' | 'playing' | 'roundDone' | 'gameDone';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let paletteEl!: HTMLElement;
let roundEl!: HTMLElement;
let dropsEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let startBtn!: HTMLButtonElement;

let state: State = 'ready';
let roundIdx = 0;
let totalScore = 0;
let best = 0;
let activeColor = 0;
let dropsLeft = 0;
let drops: Drop[] = [];
let targets: Target[] = [];
let roundDoneAt = 0;
let rafId = 0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function fmtBest(): string {
  return best > 0 ? String(best) : '—';
}

function updateHud(): void {
  const r = ROUNDS[roundIdx]!;
  roundEl.textContent = `${roundIdx + 1}/${ROUNDS.length}`;
  dropsEl.textContent = `${r.budget - dropsLeft}/${r.budget}`;
  scoreEl.textContent = String(totalScore);
  bestEl.textContent = fmtBest();
}

function renderPalette(): void {
  paletteEl.innerHTML = '';
  PALETTE.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'palette__swatch' + (i === activeColor ? ' palette__swatch--active' : '');
    btn.style.background = c.hex;
    btn.setAttribute('aria-label', c.name);
    btn.setAttribute('aria-pressed', i === activeColor ? 'true' : 'false');
    btn.dataset['idx'] = String(i);
    btn.addEventListener('click', () => {
      activeColor = i;
      renderPalette();
    });
    paletteEl.appendChild(btn);
  });
}

function showOverlay(title: string, msg: string, buttonText: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = buttonText;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function genTargets(count: number): Target[] {
  const out: Target[] = [];
  const margin = 70;
  const minDist = 110;
  let attempts = 0;
  while (out.length < count && attempts < 400) {
    attempts++;
    const x = margin + Math.random() * (W - 2 * margin);
    const y = margin + Math.random() * (H - 2 * margin);
    let ok = true;
    for (const t of out) {
      if (Math.hypot(t.x - x, t.y - y) < minDist) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const colorIdx = Math.floor(Math.random() * PALETTE.length);
    out.push({ x, y, colorIdx, hit: false });
  }
  return out;
}

function loadRound(idx: number): void {
  const r = ROUNDS[idx]!;
  drops = [];
  targets = genTargets(r.targets);
  dropsLeft = r.budget;
}

function reset(): void {
  state = 'ready';
  roundIdx = 0;
  totalScore = 0;
  activeColor = 0;
  loadRound(0);
  updateHud();
  renderPalette();
  showOverlay(
    'Ebru',
    `${ROUNDS.length} tur. Her turda hedef noktalar belirir; doğru renkten damla bırakıp üzerlerini renklendir.\nYeni damla, yakındaki eski damlaları yana iter — sıralama önemli.`,
    'Başla',
  );
}

function startGame(): void {
  roundIdx = 0;
  totalScore = 0;
  loadRound(0);
  state = 'playing';
  updateHud();
  hideOverlay();
}

function nextRound(): void {
  if (roundIdx + 1 < ROUNDS.length) {
    roundIdx++;
    loadRound(roundIdx);
    state = 'playing';
    updateHud();
  } else {
    finishGame();
  }
}

function finishGame(): void {
  state = 'gameDone';
  let improved = false;
  if (totalScore > best) {
    best = totalScore;
    safeWrite(STORAGE_BEST, best);
    improved = true;
  }
  updateHud();
  const tail = improved
    ? `Yeni rekor: ${best}!`
    : best > 0
      ? `En iyi: ${best}`
      : '';
  showOverlay(
    'Ebru tamam!',
    `Toplam ${totalScore} puan.\n${tail}`,
    'Tekrar oyna',
  );
}

function pushExisting(nx: number, ny: number, nr: number): void {
  for (const d of drops) {
    const dx = d.x - nx;
    const dy = d.y - ny;
    const dist = Math.hypot(dx, dy);
    const reach = nr + d.r;
    if (dist >= reach || dist < 0.001) continue;
    const push = (reach - dist) * 0.65;
    const ux = dist === 0 ? 1 : dx / dist;
    const uy = dist === 0 ? 0 : dy / dist;
    d.x += ux * push;
    d.y += uy * push;
    d.x = clamp(d.x, -d.r * 0.8, W + d.r * 0.8);
    d.y = clamp(d.y, -d.r * 0.8, H + d.r * 0.8);
  }
}

function topColorAt(x: number, y: number): number | null {
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i]!;
    if (Math.hypot(d.x - x, d.y - y) <= d.r) return d.colorIdx;
  }
  return null;
}

function evaluateAndScore(): void {
  let hits = 0;
  for (const t of targets) {
    const top = topColorAt(t.x, t.y);
    t.hit = top === t.colorIdx;
    if (t.hit) hits++;
  }
  const r = ROUNDS[roundIdx]!;
  const base = hits * 100;
  const efficiency = Math.max(0, dropsLeft) * 10;
  const allBonus = hits === r.targets ? 50 : 0;
  totalScore += base + efficiency + allBonus;
  updateHud();
  state = 'roundDone';
  roundDoneAt = performance.now();
}

function dropAt(x: number, y: number): void {
  if (state !== 'playing' || dropsLeft <= 0) return;
  pushExisting(x, y, DROP_RADIUS);
  drops.push({ x, y, r: DROP_RADIUS, colorIdx: activeColor });
  dropsLeft--;
  updateHud();
  if (dropsLeft <= 0) {
    evaluateAndScore();
  }
}

function getCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function drawTekneBackground(): void {
  ctx.fillStyle = '#eadfca';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  for (let i = 0; i < 60; i++) {
    const x = (i * 137.5) % W;
    const y = (i * 91.3) % H;
    ctx.fillStyle = `rgba(120, 95, 60, ${(((i * 17) % 30) / 600).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, 12 + ((i * 7) % 16), 4 + ((i * 3) % 6), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(80, 60, 30, 0.18)';
  ctx.lineWidth = 1;
  for (let y = 18; y < H; y += 36) {
    ctx.beginPath();
    let first = true;
    for (let x = 0; x <= W; x += 8) {
      const yy = y + Math.sin(x * 0.04) * 2;
      if (first) {
        ctx.moveTo(x, yy);
        first = false;
      } else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
}

function drawDrop(d: Drop): void {
  const color = PALETTE[d.colorIdx]!.hex;
  const grad = ctx.createRadialGradient(
    d.x - d.r * 0.25,
    d.y - d.r * 0.25,
    d.r * 0.1,
    d.x,
    d.y,
    d.r,
  );
  grad.addColorStop(0, lighten(color, 0.25));
  grad.addColorStop(0.7, color);
  grad.addColorStop(1, darken(color, 0.25));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = darken(color, 0.45);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  ctx.stroke();
}

function drawTarget(t: Target): void {
  const color = PALETTE[t.colorIdx]!.hex;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(20, 12, 4, 0.9)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  ctx.arc(t.x, t.y, TARGET_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(t.x, t.y, TARGET_RADIUS - 6, 0, Math.PI * 2);
  ctx.fill();

  if (t.hit && (state === 'roundDone' || state === 'gameDone')) {
    ctx.strokeStyle = '#1a8c3a';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(t.x - 8, t.y);
    ctx.lineTo(t.x - 2, t.y + 7);
    ctx.lineTo(t.x + 9, t.y - 7);
    ctx.stroke();
  } else if (
    !t.hit &&
    (state === 'roundDone' || state === 'gameDone')
  ) {
    ctx.strokeStyle = '#b32020';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(t.x - 7, t.y - 7);
    ctx.lineTo(t.x + 7, t.y + 7);
    ctx.moveTo(t.x + 7, t.y - 7);
    ctx.lineTo(t.x - 7, t.y + 7);
    ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(20, 12, 4, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(t.x - 6, t.y);
    ctx.lineTo(t.x + 6, t.y);
    ctx.moveTo(t.x, t.y - 6);
    ctx.lineTo(t.x, t.y + 6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRoundDoneBanner(): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, H / 2 - 36, W, 72);
  ctx.fillStyle = '#fff4cf';
  ctx.font = '700 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const isLast = roundIdx + 1 >= ROUNDS.length;
  const hits = targets.filter((t) => t.hit).length;
  const t = isLast ? 'Son tur tamam' : `Tur ${roundIdx + 1} bitti`;
  ctx.fillText(t, W / 2, H / 2 - 6);
  ctx.fillStyle = '#e8d99c';
  ctx.font = '500 14px system-ui, sans-serif';
  ctx.fillText(`${hits}/${targets.length} hedef · skor ${totalScore}`, W / 2, H / 2 + 18);
}

function draw(): void {
  drawTekneBackground();
  for (const d of drops) drawDrop(d);
  for (const t of targets) drawTarget(t);
  if (state === 'roundDone') drawRoundDoneBanner();
}

function tick(now: number): void {
  if (state === 'roundDone' && now - roundDoneAt > 1500) {
    nextRound();
  }
  draw();
  rafId = requestAnimationFrame(tick);
}

function lighten(hex: string, amt: number): string {
  const { r, g, b } = parseHex(hex);
  const nr = Math.round(r + (255 - r) * amt);
  const ng = Math.round(g + (255 - g) * amt);
  const nb = Math.round(b + (255 - b) * amt);
  return `rgb(${nr},${ng},${nb})`;
}

function darken(hex: string, amt: number): string {
  const { r, g, b } = parseHex(hex);
  const nr = Math.round(r * (1 - amt));
  const ng = Math.round(g * (1 - amt));
  const nb = Math.round(b * (1 - amt));
  return `rgb(${nr},${ng},${nb})`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  paletteEl = document.querySelector<HTMLElement>('#palette')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  dropsEl = document.querySelector<HTMLElement>('#drops')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;

  const stored = safeRead<number>(STORAGE_BEST, 0);
  best = stored > 0 ? stored : 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (state !== 'playing') return;
    const { x, y } = getCoords(e);
    dropAt(x, y);
    e.preventDefault();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (state === 'ready' || state === 'gameDone') {
      if (e.key === ' ' || e.key === 'Enter') {
        startGame();
        e.preventDefault();
      }
      return;
    }
    if (state === 'playing') {
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= PALETTE.length) {
        activeColor = n - 1;
        renderPalette();
        e.preventDefault();
      }
    }
  });

  startBtn.addEventListener('click', () => {
    if (state === 'ready' || state === 'gameDone') startGame();
  });
  restartBtn.addEventListener('click', reset);

  reset();
  rafId = requestAnimationFrame(tick);
  void rafId;
}

export const game = defineGame({ init, reset });
