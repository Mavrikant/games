import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

const STORAGE_BEST = 'mihenk.best';
const SCORE_DESC = {
  gameId: 'mihenk',
  storageKey: STORAGE_BEST,
  direction: 'higher' as const,
};

type State = 'intro' | 'customer' | 'result' | 'gameover';
type MetalKind = 'gold' | 'gilded' | 'brass' | 'silver' | 'painted';
type Verdict = 'accept' | 'reject';
type Outcome = 'correct' | 'wrong' | 'expired';

const TOTAL_CUSTOMERS = 12;
const STARTING_LIVES = 3;
const DECISION_SECONDS = 10;
const RESULT_SECONDS = 0.9;

const W = 480;
const H = 320;

const STONE_X = 32;
const STONE_Y = 134;
const STONE_W = 296;
const STONE_H = 76;
const STONE_PAD = 6;

const ITEM_REST_X = 405;
const ITEM_REST_Y = 110;
const ITEM_RADIUS = 30;

interface MetalDef {
  surfaceColor: string;
  surfaceShade: string;
  streakColor: string;
  streakBlend: string | null;
  speckleDensity: number;
  flakeDensity: number;
  label: string;
}

const METALS: Record<MetalKind, MetalDef> = {
  gold: {
    surfaceColor: '#f5cf42',
    surfaceShade: '#a47915',
    streakColor: '#f5d04a',
    streakBlend: null,
    speckleDensity: 0.08,
    flakeDensity: 0,
    label: 'Saf altın',
  },
  gilded: {
    surfaceColor: '#efc846',
    surfaceShade: '#9a6f24',
    streakColor: '#eac246',
    streakBlend: '#8a5b1f',
    speckleDensity: 0.42,
    flakeDensity: 0,
    label: 'Altın kaplama',
  },
  brass: {
    surfaceColor: '#d3a83a',
    surfaceShade: '#7a541a',
    streakColor: '#c98326',
    streakBlend: '#7a4715',
    speckleDensity: 0.18,
    flakeDensity: 0,
    label: 'Pirinç',
  },
  silver: {
    surfaceColor: '#dbdee9',
    surfaceShade: '#7a7e8d',
    streakColor: '#b6bbcd',
    streakBlend: '#7d8294',
    speckleDensity: 0.18,
    flakeDensity: 0,
    label: 'Gümüş',
  },
  painted: {
    surfaceColor: '#e6bb3c',
    surfaceShade: '#8f6517',
    streakColor: '#dcb13b',
    streakBlend: null,
    speckleDensity: 0.12,
    flakeDensity: 0.28,
    label: 'Boyalı sahte',
  },
};

interface Item {
  kind: MetalKind;
  shape: 'coin' | 'ring' | 'medal';
  markSeed: number;
}

interface Particle {
  x: number;
  y: number;
  color: string;
  size: number;
  flake: boolean;
}

const gen = createGenToken();

let state: State = 'intro';
let score = 0;
let best = 0;
let lives = STARTING_LIVES;
let roundIndex = 0;
let queue: Item[] = [];
let current: Item | null = null;
let streak: Particle[] = [];
let decisionTimer = 0;
let resultTimer = 0;
let lastOutcome: Outcome | null = null;
let lastWasGold = false;

let dragging = false;
let pointerX = 0;
let pointerY = 0;
let lastDragX = 0;
let lastDragY = 0;
let lastDragInStone = false;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let roundEl!: HTMLElement;
let acceptBtn!: HTMLButtonElement;
let rejectBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let rafId: number | null = null;
let lastT = 0;

function rand(): number {
  return Math.random();
}

function pickKind(round1Based: number): MetalKind {
  // Difficulty curve: early rounds include more obvious metals (brass/silver).
  // Late rounds skew toward the visually-ambiguous trio (gold/gilded/painted).
  const t = (round1Based - 1) / Math.max(1, TOTAL_CUSTOMERS - 1);
  const goldChance = 0.36 - t * 0.06;
  const trickyChance = 0.34 + t * 0.16;
  const r = rand();
  if (r < goldChance) return 'gold';
  if (r < goldChance + trickyChance) return rand() < 0.55 ? 'gilded' : 'painted';
  return rand() < 0.65 ? 'brass' : 'silver';
}

function generateQueue(): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < TOTAL_CUSTOMERS; i++) {
    const kind = pickKind(i + 1);
    const shape = (['coin', 'ring', 'medal'] as const)[Math.floor(rand() * 3)]!;
    out.push({ kind, shape, markSeed: Math.floor(rand() * 9999) });
  }
  // Guarantee at least 3 real gold items so the player has something to accept.
  let goldCount = out.filter((i) => i.kind === 'gold').length;
  for (let i = 0; i < out.length && goldCount < 3; i++) {
    if (out[i]!.kind !== 'gold') {
      out[i]!.kind = 'gold';
      goldCount++;
    }
  }
  return out;
}

function reset(): void {
  gen.bump();
  stopLoop();
  state = 'intro';
  score = 0;
  lives = STARTING_LIVES;
  roundIndex = 0;
  queue = generateQueue();
  current = null;
  streak = [];
  decisionTimer = 0;
  resultTimer = 0;
  lastOutcome = null;
  lastWasGold = false;
  dragging = false;
  lastDragInStone = false;
  overlayTitle.textContent = 'Mihenk';
  overlayMsg.textContent =
    'Sarı parlasa bile her takı altın değildir.\n' +
    'Takıyı tut, siyah mihenk taşına sürt.\n' +
    'Yumuşak, tek tonda kanarya iz: SAF.\n' +
    'Lekeli/turuncu/gri iz veya boya pulları: SAHTE.\n' +
    'Başlamak için tıkla veya Enter.';
  showOverlayEl(overlay);
  syncHUD();
  draw();
  startLoop();
}

function startRound(): void {
  if (roundIndex >= queue.length) {
    endGame();
    return;
  }
  current = queue[roundIndex]!;
  streak = [];
  decisionTimer = DECISION_SECONDS;
  state = 'customer';
  hideOverlayEl(overlay);
  syncHUD();
}

function syncHUD(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent =
    lives > 0
      ? '●'.repeat(lives) + '○'.repeat(STARTING_LIVES - lives)
      : '○'.repeat(STARTING_LIVES);
  const shown = Math.min(
    TOTAL_CUSTOMERS,
    roundIndex + (state === 'customer' || state === 'result' ? 1 : 0),
  );
  roundEl.textContent = `${state === 'gameover' ? roundIndex : Math.max(1, shown)}/${TOTAL_CUSTOMERS}`;
  const interactive = state === 'customer';
  acceptBtn.disabled = !interactive;
  rejectBtn.disabled = !interactive;
}

function startLoop(): void {
  if (rafId !== null) return;
  lastT = performance.now();
  const token = gen.current();
  const tick = (now: number): void => {
    if (!gen.isCurrent(token)) {
      rafId = null;
      return;
    }
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    update(dt);
    draw();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function update(dt: number): void {
  if (state === 'customer') {
    decisionTimer -= dt;
    if (decisionTimer <= 0) {
      decisionTimer = 0;
      resolveOutcome('expired');
    }
  } else if (state === 'result') {
    resultTimer -= dt;
    if (resultTimer <= 0) {
      roundIndex += 1;
      if (lives <= 0) {
        endGame();
      } else {
        startRound();
      }
    }
  }
}

function decide(v: Verdict): void {
  if (state !== 'customer' || !current) return;
  const isGold = current.kind === 'gold';
  const correct = (v === 'accept') === isGold;
  resolveOutcome(correct ? 'correct' : 'wrong');
}

function resolveOutcome(o: Outcome): void {
  if (state !== 'customer' || !current) return;
  lastOutcome = o;
  lastWasGold = current.kind === 'gold';
  if (o === 'correct') {
    score += 1;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
  } else {
    lives -= 1;
  }
  state = 'result';
  resultTimer = RESULT_SECONDS;
  dragging = false;
  syncHUD();
}

function endGame(): void {
  state = 'gameover';
  stopLoop();
  reportGameOver(SCORE_DESC, score);
  overlayTitle.textContent = score === TOTAL_CUSTOMERS ? 'Kusursuz mihir!' : 'Tezgâh kapandı';
  const lossLine =
    lives <= 0 && roundIndex < TOTAL_CUSTOMERS
      ? 'Üç mihir tükendi.'
      : `${TOTAL_CUSTOMERS} müşteri tamam.`;
  overlayMsg.textContent =
    `${lossLine}\nPuan: ${score} / ${TOTAL_CUSTOMERS}\nEn iyi: ${best}\nEnter veya Yeniden başla ile yeni tezgâh.`;
  showOverlayEl(overlay);
  syncHUD();
}

// ---------- Drag + streak ----------

function canvasCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * W,
    y: ((e.clientY - rect.top) / rect.height) * H,
  };
}

function itemDrawPos(): { x: number; y: number } {
  if (dragging) return { x: pointerX, y: pointerY };
  return { x: ITEM_REST_X, y: ITEM_REST_Y };
}

function pointOverItem(x: number, y: number): boolean {
  const { x: ix, y: iy } = itemDrawPos();
  const dx = x - ix;
  const dy = y - iy;
  return dx * dx + dy * dy <= (ITEM_RADIUS + 6) * (ITEM_RADIUS + 6);
}

function pointInStone(x: number, y: number): boolean {
  return (
    x >= STONE_X + STONE_PAD &&
    x <= STONE_X + STONE_W - STONE_PAD &&
    y >= STONE_Y + STONE_PAD &&
    y <= STONE_Y + STONE_H - STONE_PAD
  );
}

function startDrag(x: number, y: number): void {
  if (state !== 'customer') return;
  if (!pointOverItem(x, y)) return;
  dragging = true;
  pointerX = x;
  pointerY = y;
  lastDragX = x;
  lastDragY = y;
  lastDragInStone = pointInStone(x, y);
  canvas.classList.add('is-dragging');
}

function moveDrag(x: number, y: number): void {
  if (!dragging) return;
  pointerX = x;
  pointerY = y;
  const inStoneNow = pointInStone(x, y);
  if (inStoneNow && lastDragInStone) {
    paintSegment(lastDragX, lastDragY, x, y);
  }
  lastDragX = x;
  lastDragY = y;
  lastDragInStone = inStoneNow;
}

function endDrag(): void {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('is-dragging');
}

function paintSegment(x0: number, y0: number, x1: number, y1: number): void {
  if (!current) return;
  const def = METALS[current.kind];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return;
  const steps = Math.max(1, Math.ceil(dist * 0.85));
  for (let i = 0; i < steps; i++) {
    const t = (i + 1) / steps;
    const px = x0 + dx * t;
    const py = y0 + dy * t;
    if (!pointInStone(px, py)) continue;
    streak.push({
      x: px + (rand() - 0.5) * 2.4,
      y: py + (rand() - 0.5) * 3.4,
      color: def.streakColor,
      size: 1.5 + rand() * 1.4,
      flake: false,
    });
    if (def.streakBlend && rand() < def.speckleDensity) {
      streak.push({
        x: px + (rand() - 0.5) * 4,
        y: py + (rand() - 0.5) * 5,
        color: def.streakBlend,
        size: 1.0 + rand() * 1.2,
        flake: false,
      });
    } else if (!def.streakBlend && rand() < def.speckleDensity) {
      streak.push({
        x: px + (rand() - 0.5) * 3,
        y: py + (rand() - 0.5) * 4,
        color: lighten(def.streakColor, 0.18),
        size: 0.8 + rand() * 0.8,
        flake: false,
      });
    }
    if (def.flakeDensity > 0 && rand() < def.flakeDensity * 0.18) {
      streak.push({
        x: px + (rand() - 0.5) * 7,
        y: py + (rand() - 0.5) * 6,
        color: '#1e1812',
        size: 2.0 + rand() * 1.8,
        flake: true,
      });
    }
  }
  if (streak.length > 1400) {
    streak.splice(0, streak.length - 1400);
  }
}

function lighten(hex: string, amt: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.min(255, Math.round(r + (255 - r) * amt));
  const lg = Math.min(255, Math.round(g + (255 - g) * amt));
  const lb = Math.min(255, Math.round(b + (255 - b) * amt));
  return `rgb(${lr}, ${lg}, ${lb})`;
}

// ---------- Drawing ----------

function draw(): void {
  drawCounter();
  drawHeader();
  drawLegend();
  drawStone();
  drawStreak();
  drawItemRest();
  if (current) drawItem();
  if (state === 'result') drawResultFlash();
}

function drawCounter(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#3a2516');
  grad.addColorStop(0.5, '#2a1a0e');
  grad.addColorStop(1, '#1a1008');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    const y = 18 + i * 22 + ((i * 7) % 9);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(120, y + 3, 240, y - 4, 360, y + 2);
    ctx.lineTo(W, y + 1);
    ctx.stroke();
  }
}

function drawHeader(): void {
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(0, 0, W, 32);
  ctx.fillStyle = '#cfb98a';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('MİHENK TEZGÂHI', 12, 16);

  if (state === 'customer' || state === 'result') {
    const barX = 150;
    const barY = 10;
    const barW = W - barX - 14;
    const barH = 12;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(barX, barY, barW, barH);
    const ratio = state === 'customer' ? Math.max(0, decisionTimer / DECISION_SECONDS) : 0;
    const fillW = barW * ratio;
    const color =
      ratio > 0.5 ? '#5fb672' : ratio > 0.25 ? '#e2b13c' : '#d04a2a';
    ctx.fillStyle = color;
    ctx.fillRect(barX, barY, fillW, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
  }
}

function drawStone(): void {
  const baseGrad = ctx.createLinearGradient(STONE_X, STONE_Y, STONE_X, STONE_Y + STONE_H);
  baseGrad.addColorStop(0, '#1c1a18');
  baseGrad.addColorStop(0.4, '#0c0a08');
  baseGrad.addColorStop(1, '#070605');
  ctx.fillStyle = baseGrad;
  roundRect(STONE_X, STONE_Y, STONE_W, STONE_H, 6);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.rect(STONE_X + 2, STONE_Y + 2, STONE_W - 4, STONE_H - 4);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 18; i++) {
    const sx = STONE_X + ((i * 37) % STONE_W);
    const sy = STONE_Y + 8 + ((i * 11) % (STONE_H - 12));
    const len = 14 + ((i * 5) % 22);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + len, sy + (i % 2 === 0 ? 1.4 : -1.4));
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = '#5c4222';
  ctx.lineWidth = 1.5;
  roundRect(STONE_X, STONE_Y, STONE_W, STONE_H, 6);
  ctx.stroke();
  ctx.fillStyle = 'rgba(220,200,160,0.55)';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('MİHENK TAŞI', STONE_X + 8, STONE_Y + 6);
}

function drawStreak(): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    STONE_X + STONE_PAD,
    STONE_Y + STONE_PAD,
    STONE_W - STONE_PAD * 2,
    STONE_H - STONE_PAD * 2,
  );
  ctx.clip();
  for (const p of streak) {
    if (p.flake) {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.4, p.size, p.size * 0.8);
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawItemRest(): void {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(ITEM_REST_X, ITEM_REST_Y + 26, 40, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180,140,80,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(ITEM_REST_X, ITEM_REST_Y + 26, 40, 8, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawItem(): void {
  if (!current) return;
  const { x, y } = itemDrawPos();
  const def = METALS[current.kind];
  if (dragging) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(x, y + 18, ITEM_RADIUS * 0.85, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const grad = ctx.createRadialGradient(x - 10, y - 10, 2, x, y, ITEM_RADIUS);
  grad.addColorStop(0, lighten(def.surfaceColor, 0.3));
  grad.addColorStop(0.55, def.surfaceColor);
  grad.addColorStop(1, def.surfaceShade);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, ITEM_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, ITEM_RADIUS - 6, 0, Math.PI * 2);
  ctx.stroke();
  drawItemMarkings(x, y, current);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.ellipse(x - 9, y - 11, 5, 3, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawItemMarkings(x: number, y: number, item: Item): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = 1;
  ctx.rotate(((item.markSeed % 360) * Math.PI) / 180);
  if (item.shape === 'coin') {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 === 0 ? 12 : 5;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  } else if (item.shape === 'ring') {
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 14, Math.sin(a) * 14, 1.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, 11, Math.PI * 0.25, Math.PI * 1.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(2, 1, 9, Math.PI * 0.15, Math.PI * 1.55);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLegend(): void {
  const lx = 22;
  const ly = 232;
  const lw = W - 44;
  const lh = 70;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  roundRect(lx, ly, lw, lh, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(220,200,160,0.18)';
  ctx.lineWidth = 1;
  roundRect(lx, ly, lw, lh, 6);
  ctx.stroke();
  ctx.fillStyle = 'rgba(220,200,160,0.65)';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('SÜRMELER', lx + 8, ly + 6);

  const kinds: MetalKind[] = ['gold', 'gilded', 'brass', 'silver', 'painted'];
  const slotW = (lw - 16) / kinds.length;
  for (let i = 0; i < kinds.length; i++) {
    const k = kinds[i]!;
    const def = METALS[k];
    const sx = lx + 8 + i * slotW;
    const sy = ly + 22;
    const sw = slotW - 4;
    ctx.fillStyle = '#0c0a08';
    roundRect(sx, sy, sw, 22, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    roundRect(sx, sy, sw, 22, 3);
    ctx.stroke();
    const seed = i * 91 + 7;
    for (let p = 0; p < 28; p++) {
      const px = sx + 3 + (((seed + p * 19) * 13) % Math.max(1, sw - 6));
      const py = sy + 4 + (((seed + p * 23) * 7) % 14);
      ctx.fillStyle = def.streakColor;
      ctx.beginPath();
      ctx.arc(px, py, 1.4, 0, Math.PI * 2);
      ctx.fill();
      if (def.streakBlend && p % 3 === 0) {
        ctx.fillStyle = def.streakBlend;
        ctx.beginPath();
        ctx.arc(px + 1.5, py + 0.5, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      if (def.flakeDensity > 0 && p % 6 === 0) {
        ctx.fillStyle = '#1e1812';
        ctx.fillRect(px - 1.2, py - 0.8, 2.4, 1.6);
      }
    }
    ctx.fillStyle = k === 'gold' ? '#7fdb95' : '#e8a99c';
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(def.label, sx + sw / 2, sy + 24);
  }
}

function drawResultFlash(): void {
  if (!lastOutcome) return;
  const correct = lastOutcome === 'correct';
  const color = correct ? 'rgba(35, 160, 88, 0.45)' : 'rgba(190, 50, 35, 0.45)';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const title =
    lastOutcome === 'correct'
      ? lastWasGold
        ? 'DOĞRU: SAF ALTIN'
        : 'DOĞRU: SAHTE'
      : lastOutcome === 'expired'
        ? 'SÜRE DOLDU'
        : lastWasGold
          ? 'YANLIŞ: SAFTI'
          : 'YANLIŞ: SAHTEYDİ';
  ctx.fillText(title, W / 2, H / 2 - 6);
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillText(
    correct ? '+1 Puan' : `Mihir kaldı: ${lives}`,
    W / 2,
    H / 2 + 22,
  );
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

// ---------- Init ----------

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  roundEl = document.querySelector<HTMLElement>('#round')!;
  acceptBtn = document.querySelector<HTMLButtonElement>('#accept')!;
  rejectBtn = document.querySelector<HTMLButtonElement>('#reject')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  acceptBtn.addEventListener('click', () => decide('accept'));
  rejectBtn.addEventListener('click', () => decide('reject'));
  restartBtn.addEventListener('click', () => {
    reset();
  });

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const { x, y } = canvasCoords(e);
    if (state === 'intro' || state === 'gameover') {
      reset();
      startRound();
      return;
    }
    if (state === 'customer') {
      startDrag(x, y);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const { x, y } = canvasCoords(e);
    moveDrag(x, y);
  });
  const finishDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    e.preventDefault();
    endDrag();
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };
  canvas.addEventListener('pointerup', finishDrag);
  canvas.addEventListener('pointercancel', finishDrag);
  canvas.addEventListener('pointerleave', (e) => {
    if (dragging) finishDrag(e);
  });

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'intro' || state === 'gameover') {
      reset();
      startRound();
    }
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'enter') {
      if (state === 'intro' || state === 'gameover') {
        reset();
        startRound();
        e.preventDefault();
      }
    } else if (k === 'a' || k === 'arrowleft') {
      if (state === 'customer') {
        decide('accept');
        e.preventDefault();
      }
    } else if (k === 'r' || k === 'arrowright') {
      if (state === 'customer') {
        decide('reject');
        e.preventDefault();
      }
    } else if (k === ' ' || e.code === 'Space') {
      if (state === 'customer') {
        streak = [];
        e.preventDefault();
      }
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
