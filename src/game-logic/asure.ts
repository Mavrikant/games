import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay, isOverlayHidden } from '@shared/overlay';

// PITFALLS guarded:
// - module-level-dom-access: all DOM access in init()
// - unguarded-storage: safeRead/safeWrite
// - stale-async-callback: gen-token + cancelAnimationFrame in reset()
// - overlay-input-leak: explicit `state` enum, guarded at each handler
// - visual-vs-hitbox: ingredient hit rects and draw rects share slotRect()
// - invisible-boot: initial draw() happens at end of reset() before user input
// - hud-counter-synced-only-at-lifecycle-edges: syncHud() inside loop tick
// - missing-overlay-css: .overlay--hidden defined in styles/games/asure.css

const STORAGE_BEST = 'asure.best';

type State = 'ready' | 'playing' | 'gameover';

const CANVAS_W = 560;
const CANVAS_H = 520;

const ROUND_SECONDS = 45;

// Layout — single source of truth (visual = hitbox).
const POT_CX = CANVAS_W / 2;
const POT_CY = 170;
const POT_RX = 170;
const POT_RY = 70;
const POT_DEPTH = 100;

const STRIP_TOP = 310;
const STRIP_H = 200;
const SLOT_GAP = 6;
const SLOT_TOTAL_W = CANVAS_W - 24;
const SLOT_W = (SLOT_TOTAL_W - SLOT_GAP * 6) / 7;
const SLOT_X0 = 12;

const ICON_TOP = STRIP_TOP + 14;
const ICON_H = 96;
const TIMELINE_TOP = ICON_TOP + ICON_H + 10;
const TIMELINE_H = 64;

interface Ingredient {
  id: number;
  name: string;
  color: string;
  shadowColor: string;
  windowStart: number;
  windowEnd: number;
  placed: boolean;
  placeT: number;
  placeKind: 'perfect' | 'good' | 'sour' | null;
  flashT: number;
}

const INGREDIENT_DEFS: { name: string; color: string; shadow: string }[] = [
  { name: 'Buğday', color: '#e3c870', shadow: '#a48a3a' },
  { name: 'Nohut', color: '#dcc99a', shadow: '#9a8458' },
  { name: 'Fasulye', color: '#7d3a2b', shadow: '#4a1d12' },
  { name: 'Ceviz', color: '#8b5a2b', shadow: '#5a3818' },
  { name: 'Üzüm', color: '#5a2a5e', shadow: '#341431' },
  { name: 'Tarçın', color: '#9b4622', shadow: '#5d2812' },
  { name: 'Şeker', color: '#f3eee3', shadow: '#b7b1a1' },
];

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let placedCount = 0;
let elapsed = 0;
let ingredients: Ingredient[] = [];

interface FloatText {
  x: number;
  y: number;
  t: number;
  text: string;
  color: string;
}
let floats: FloatText[] = [];

interface Bubble {
  x: number;
  y: number;
  r: number;
  vy: number;
  life: number;
}
let bubbles: Bubble[] = [];

let stewR = 110;
let stewG = 70;
let stewB = 36;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let placedEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;

let lastFrame = 0;
let rafId = 0;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function slotX(idx: number): number {
  return SLOT_X0 + idx * (SLOT_W + SLOT_GAP);
}

function slotRect(idx: number): { x: number; y: number; w: number; h: number } {
  return { x: slotX(idx), y: STRIP_TOP, w: SLOT_W, h: STRIP_H };
}

function makeIngredients(): Ingredient[] {
  // Each ingredient takes one of 7 staggered window slots; the assignment
  // is shuffled so the order changes every round.
  const order = [0, 1, 2, 3, 4, 5, 6];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  const baseStarts = [2.5, 6.5, 10.0, 14.5, 19.0, 24.5, 30.0];
  const out: Ingredient[] = [];
  for (let i = 0; i < 7; i++) {
    const defIdx = order[i]!;
    const def = INGREDIENT_DEFS[defIdx]!;
    const jitter = (Math.random() - 0.5) * 1.2;
    const start = baseStarts[i]! + jitter;
    const width = 5.2;
    out.push({
      id: i,
      name: def.name,
      color: def.color,
      shadowColor: def.shadow,
      windowStart: start,
      windowEnd: start + width,
      placed: false,
      placeT: -1,
      placeKind: null,
      flashT: 0,
    });
  }
  return out;
}

function setMsg(title: string, msg: string): void {
  overlayTitleEl.textContent = title;
  overlayMsgEl.textContent = msg;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function syncHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  placedEl.textContent = `${placedCount}/7`;
  const remaining = Math.max(0, ROUND_SECONDS - elapsed);
  timeEl.textContent = remaining.toFixed(1);
}

function placeIngredient(idx: number): void {
  if (state !== 'playing') return;
  const ing = ingredients[idx];
  if (!ing || ing.placed) return;

  ing.placed = true;
  ing.placeT = elapsed;
  ing.flashT = 1;
  placedCount++;

  const ws = ing.windowStart;
  const we = ing.windowEnd;
  const mid = (ws + we) / 2;
  const halfW = (we - ws) / 2;

  let pts = 0;
  let kind: Ingredient['placeKind'];
  let label = '';
  let color = '#aab';

  if (elapsed < ws || elapsed > we) {
    pts = 10;
    kind = 'sour';
    label = 'Ekşi!';
    color = '#e06464';
  } else {
    const dist = Math.abs(elapsed - mid);
    const norm = dist / halfW; // 0 = perfect centre, 1 = edge
    if (norm < 0.4) {
      pts = 100;
      kind = 'perfect';
      label = 'Cuk!';
      color = '#7be08a';
    } else {
      pts = 60;
      kind = 'good';
      label = 'İyi';
      color = '#f4c25b';
    }
  }

  ing.placeKind = kind;
  score += pts;

  // Tint the stew toward the ingredient color, weighted by points.
  const weight = pts / 200 + 0.15;
  const tr = parseInt(ing.color.slice(1, 3), 16);
  const tg = parseInt(ing.color.slice(3, 5), 16);
  const tb = parseInt(ing.color.slice(5, 7), 16);
  stewR = stewR * (1 - weight) + tr * weight;
  stewG = stewG * (1 - weight) + tg * weight;
  stewB = stewB * (1 - weight) + tb * weight;

  const sx = slotX(idx) + SLOT_W / 2;
  floats.push({
    x: sx,
    y: ICON_TOP - 4,
    t: 0,
    text: `${label} +${pts}`,
    color,
  });

  for (let i = 0; i < 8; i++) {
    bubbles.push({
      x: POT_CX + (Math.random() - 0.5) * POT_RX * 1.2,
      y: POT_CY - 6 + Math.random() * POT_RY * 0.4,
      r: 3 + Math.random() * 5,
      vy: -10 - Math.random() * 18,
      life: 0.6 + Math.random() * 0.4,
    });
  }

  syncHud();

  if (placedCount >= 7) {
    endGame('done');
  }
}

function startGame(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  placedCount = 0;
  elapsed = 0;
  floats = [];
  bubbles = [];
  stewR = 110;
  stewG = 70;
  stewB = 36;
  ingredients = makeIngredients();
  hideOverlay(overlayEl);
  syncHud();
  lastFrame = performance.now();
  const myGen = gen.current();
  cancelAnimationFrame(rafId);
  const loop = (now: number): void => {
    if (!gen.isCurrent(myGen)) return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    tick(dt);
    draw();
    if (state === 'playing') {
      rafId = requestAnimationFrame(loop);
    }
  };
  rafId = requestAnimationFrame(loop);
}

function endGame(reason: 'time' | 'done'): void {
  state = 'gameover';
  commitBest();
  const missed = ingredients.filter((i) => !i.placed).length;
  const perfect = ingredients.filter((i) => i.placeKind === 'perfect').length;
  const lines: string[] = [];
  lines.push(reason === 'done' ? 'Aşure tamam!' : 'Süre bitti.');
  lines.push(`\nTam: ${perfect} · Eksik: ${missed}`);
  lines.push(`Skor: ${score}`);
  lines.push(`En iyi: ${best}`);
  lines.push("\nYeniden başlamak için Boşluk'a bas veya tıkla.");
  setMsg(reason === 'done' ? 'Aşure tamam!' : 'Süre bitti', lines.join('\n'));
  showOverlay(overlayEl);
  syncHud();
}

function tick(dt: number): void {
  if (state !== 'playing') return;

  elapsed += dt;

  if (elapsed >= ROUND_SECONDS) {
    elapsed = ROUND_SECONDS;
    syncHud();
    endGame('time');
    return;
  }

  for (const ing of ingredients) {
    if (ing.flashT > 0) ing.flashT = Math.max(0, ing.flashT - dt * 2.2);
  }
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i]!;
    f.t += dt;
    if (f.t > 1.1) floats.splice(i, 1);
  }

  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i]!;
    b.life -= dt;
    b.y += b.vy * dt;
    b.vy += 28 * dt;
    if (b.life <= 0) bubbles.splice(i, 1);
  }
  if (Math.random() < 0.45) {
    bubbles.push({
      x: POT_CX + (Math.random() - 0.5) * POT_RX * 1.5,
      y: POT_CY + (Math.random() - 0.5) * POT_RY * 1.4,
      r: 2 + Math.random() * 3,
      vy: -6 - Math.random() * 8,
      life: 0.7 + Math.random() * 0.5,
    });
  }

  syncHud();
}

// ── Drawing ───────────────────────────────────────────────────────────────

function draw(): void {
  ctx.save();
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, '#1b1410');
  grad.addColorStop(1, '#0c0805');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawHearth();
  drawPot();
  drawBubbles();
  drawIngredientStrip();
  drawFloats();
  ctx.restore();
}

function drawHearth(): void {
  ctx.fillStyle = '#1f1611';
  ctx.fillRect(40, POT_CY + POT_RY + POT_DEPTH * 0.7, CANVAS_W - 80, 22);
  ctx.fillStyle = '#0e0905';
  ctx.fillRect(40, POT_CY + POT_RY + POT_DEPTH * 0.7 + 18, CANVAS_W - 80, 6);

  const t = performance.now() / 1000;
  for (let i = 0; i < 5; i++) {
    const fx = 100 + i * ((CANVAS_W - 200) / 4);
    const flicker = Math.sin(t * 6 + i) * 4;
    const h = 18 + Math.sin(t * 3 + i * 2.2) * 6 + flicker;
    const fg = ctx.createRadialGradient(
      fx,
      POT_CY + POT_RY + POT_DEPTH * 0.7 + 6,
      0,
      fx,
      POT_CY + POT_RY + POT_DEPTH * 0.7 + 6,
      26,
    );
    fg.addColorStop(0, 'rgba(255,180,40,0.65)');
    fg.addColorStop(0.6, 'rgba(220,90,20,0.35)');
    fg.addColorStop(1, 'rgba(220,90,20,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.ellipse(
      fx,
      POT_CY + POT_RY + POT_DEPTH * 0.7 + 6 - h * 0.4,
      14,
      18 + h * 0.2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

function drawPot(): void {
  ctx.save();

  const bowlGrad = ctx.createLinearGradient(0, POT_CY, 0, POT_CY + POT_DEPTH + POT_RY);
  bowlGrad.addColorStop(0, '#3a2c20');
  bowlGrad.addColorStop(1, '#15100a');
  ctx.fillStyle = bowlGrad;
  ctx.beginPath();
  ctx.moveTo(POT_CX - POT_RX, POT_CY);
  ctx.quadraticCurveTo(
    POT_CX - POT_RX - 12,
    POT_CY + POT_DEPTH * 0.6,
    POT_CX,
    POT_CY + POT_DEPTH,
  );
  ctx.quadraticCurveTo(
    POT_CX + POT_RX + 12,
    POT_CY + POT_DEPTH * 0.6,
    POT_CX + POT_RX,
    POT_CY,
  );
  ctx.bezierCurveTo(
    POT_CX + POT_RX,
    POT_CY - 6,
    POT_CX - POT_RX,
    POT_CY - 6,
    POT_CX - POT_RX,
    POT_CY,
  );
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#0a0805';
  ctx.lineWidth = 2;
  ctx.stroke();

  const r = Math.round(stewR);
  const g = Math.round(stewG);
  const b = Math.round(stewB);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.beginPath();
  ctx.ellipse(POT_CX, POT_CY, POT_RX - 8, POT_RY - 6, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,235,200,0.12)';
  ctx.beginPath();
  ctx.ellipse(POT_CX - 30, POT_CY - 14, POT_RX * 0.4, POT_RY * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#2a1f15';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(POT_CX, POT_CY, POT_RX, POT_RY, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#2c1f15';
  ctx.beginPath();
  ctx.ellipse(POT_CX - POT_RX - 6, POT_CY + 24, 18, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(POT_CX + POT_RX + 6, POT_CY + 24, 18, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawBubbles(): void {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(POT_CX, POT_CY, POT_RX - 8, POT_RY - 6, 0, 0, Math.PI * 2);
  ctx.clip();

  for (const b of bubbles) {
    const a = clamp(b.life * 1.2, 0, 1);
    ctx.fillStyle = `rgba(255,255,255,${0.20 * a})`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(255,235,200,${0.35 * a})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

function isWindowOpen(ing: Ingredient): boolean {
  return elapsed >= ing.windowStart && elapsed <= ing.windowEnd && !ing.placed;
}

function isWindowPast(ing: Ingredient): boolean {
  return elapsed > ing.windowEnd && !ing.placed;
}

function drawIngredientStrip(): void {
  ctx.save();
  ctx.fillStyle = '#0e0a07';
  ctx.fillRect(0, STRIP_TOP - 6, CANVAS_W, STRIP_H + 12);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, STRIP_TOP - 6, CANVAS_W, 2);

  for (let i = 0; i < ingredients.length; i++) {
    drawIngredientSlot(i);
  }
  ctx.restore();
}

function drawIngredientSlot(idx: number): void {
  const ing = ingredients[idx]!;
  const sx = slotX(idx);
  const open = isWindowOpen(ing);
  const past = isWindowPast(ing);

  if (ing.placed) {
    const tint =
      ing.placeKind === 'perfect'
        ? 'rgba(123,224,138,0.18)'
        : ing.placeKind === 'good'
          ? 'rgba(244,194,91,0.18)'
          : 'rgba(224,100,100,0.22)';
    ctx.fillStyle = tint;
  } else if (past) {
    ctx.fillStyle = 'rgba(224,100,100,0.12)';
  } else if (open) {
    ctx.fillStyle = 'rgba(123,224,138,0.18)';
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
  }
  ctx.fillRect(sx, STRIP_TOP, SLOT_W, STRIP_H);

  ctx.strokeStyle = open
    ? '#7be08a'
    : past
      ? '#5a2a2a'
      : ing.placed
        ? '#3a3a40'
        : '#23201b';
  ctx.lineWidth = open ? 2 : 1;
  ctx.strokeRect(sx + 0.5, STRIP_TOP + 0.5, SLOT_W - 1, STRIP_H - 1);

  ctx.fillStyle = open ? '#7be08a' : '#675f53';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(String(idx + 1), sx + 6, STRIP_TOP + 5);

  drawIngredientIcon(ing, sx + SLOT_W / 2, ICON_TOP + ICON_H / 2, open, past, ing.placed);

  ctx.fillStyle = open ? '#e8f5ea' : ing.placed ? '#7a7268' : '#9a9286';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ing.name, sx + SLOT_W / 2, ICON_TOP + ICON_H - 8);

  drawSlotTimeline(idx, ing);

  if (ing.flashT > 0 && ing.placeKind) {
    const color =
      ing.placeKind === 'perfect'
        ? '#7be08a'
        : ing.placeKind === 'good'
          ? '#f4c25b'
          : '#e06464';
    ctx.save();
    ctx.globalAlpha = ing.flashT;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(sx + 2, STRIP_TOP + 2, SLOT_W - 4, STRIP_H - 4);
    ctx.restore();
  }
}

function drawIngredientIcon(
  ing: Ingredient,
  cx: number,
  cy: number,
  open: boolean,
  past: boolean,
  placed: boolean,
): void {
  ctx.save();

  if (open) {
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 160);
    const gg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 38);
    gg.addColorStop(0, `rgba(123,224,138,${0.45 * pulse})`);
    gg.addColorStop(1, 'rgba(123,224,138,0)');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.arc(cx, cy, 38, 0, Math.PI * 2);
    ctx.fill();
  }

  const r = 22;
  const baseGrad = ctx.createRadialGradient(cx - 4, cy - 6, 2, cx, cy, r);
  if (past || placed) {
    baseGrad.addColorStop(0, ing.shadowColor);
    baseGrad.addColorStop(1, '#1c1611');
  } else {
    baseGrad.addColorStop(0, ing.color);
    baseGrad.addColorStop(1, ing.shadowColor);
  }
  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = open ? '#1c1611' : 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
  ctx.clip();
  drawIngredientTexture(ing, cx, cy);
  ctx.restore();

  if (placed) {
    if (ing.placeKind === 'sour') {
      ctx.strokeStyle = '#e06464';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#e06464';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', cx, cy + r + 14);
    } else {
      ctx.fillStyle = ing.placeKind === 'perfect' ? '#7be08a' : '#f4c25b';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✓', cx, cy + r + 14);
    }
  } else if (past) {
    ctx.fillStyle = '#e06464';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×', cx, cy + r + 14);
  }

  ctx.restore();
}

function drawIngredientTexture(ing: Ingredient, cx: number, cy: number): void {
  ctx.save();
  ctx.globalAlpha = 0.65;
  // Texture is keyed off the ingredient's name, not its slot id, so each
  // distinct ingredient keeps its own look regardless of shuffled order.
  const name = ing.name;
  if (name === 'Buğday') {
    ctx.strokeStyle = ing.shadowColor;
    ctx.lineWidth = 1.5;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(cx - 10 + i * 4, cy - 12);
      ctx.lineTo(cx - 8 + i * 4, cy + 10);
      ctx.stroke();
    }
  } else if (name === 'Nohut') {
    ctx.fillStyle = ing.shadowColor;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * 9, cy + Math.sin(a) * 9, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  } else if (name === 'Fasulye') {
    ctx.fillStyle = ing.shadowColor;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 11, 6, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a0805';
    ctx.beginPath();
    ctx.ellipse(cx - 2, cy - 1, 3, 1.5, 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (name === 'Ceviz') {
    ctx.strokeStyle = ing.shadowColor;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 10);
    ctx.quadraticCurveTo(cx + 8, cy, cx, cy + 10);
    ctx.moveTo(cx, cy - 10);
    ctx.quadraticCurveTo(cx - 8, cy, cx, cy + 10);
    ctx.moveTo(cx - 9, cy);
    ctx.lineTo(cx + 9, cy);
    ctx.stroke();
  } else if (name === 'Üzüm') {
    ctx.fillStyle = ing.shadowColor;
    const grapes: [number, number][] = [
      [-6, -5],
      [6, -5],
      [0, -8],
      [-7, 4],
      [7, 4],
      [0, 8],
      [-2, 0],
      [4, 1],
    ];
    for (const g of grapes) {
      ctx.beginPath();
      ctx.arc(cx + g[0], cy + g[1], 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (name === 'Tarçın') {
    ctx.strokeStyle = ing.shadowColor;
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, 4 + i * 4, -0.4, 1.6);
      ctx.stroke();
    }
  } else {
    // Şeker
    ctx.fillStyle = ing.shadowColor;
    ctx.beginPath();
    ctx.moveTo(cx - 9, cy);
    ctx.lineTo(cx, cy - 11);
    ctx.lineTo(cx + 9, cy);
    ctx.lineTo(cx, cy + 11);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 11);
    ctx.lineTo(cx, cy + 11);
    ctx.moveTo(cx - 9, cy);
    ctx.lineTo(cx + 9, cy);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSlotTimeline(idx: number, ing: Ingredient): void {
  const sx = slotX(idx);
  const tx = sx + 6;
  const ty = TIMELINE_TOP;
  const tw = SLOT_W - 12;
  const th = TIMELINE_H - 10;

  ctx.fillStyle = '#1a1610';
  ctx.fillRect(tx, ty, tw, th);
  ctx.strokeStyle = '#2b251c';
  ctx.lineWidth = 1;
  ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1);

  const sFrac = clamp(ing.windowStart / ROUND_SECONDS, 0, 1);
  const eFrac = clamp(ing.windowEnd / ROUND_SECONDS, 0, 1);
  const wx = tx + sFrac * tw;
  const ww = (eFrac - sFrac) * tw;
  const isLive = isWindowOpen(ing);
  ctx.fillStyle = ing.placed
    ? ing.placeKind === 'perfect'
      ? 'rgba(123,224,138,0.55)'
      : ing.placeKind === 'good'
        ? 'rgba(244,194,91,0.55)'
        : 'rgba(224,100,100,0.55)'
    : isLive
      ? 'rgba(123,224,138,0.55)'
      : isWindowPast(ing)
        ? 'rgba(224,100,100,0.35)'
        : 'rgba(123,224,138,0.22)';
  ctx.fillRect(wx, ty + 2, Math.max(2, ww), th - 4);

  const midFrac = (sFrac + eFrac) / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tx + midFrac * tw, ty + 2);
  ctx.lineTo(tx + midFrac * tw, ty + th - 2);
  ctx.stroke();

  const curFrac = clamp(elapsed / ROUND_SECONDS, 0, 1);
  const cxp = tx + curFrac * tw;
  ctx.strokeStyle = '#f4c25b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cxp, ty - 2);
  ctx.lineTo(cxp, ty + th + 2);
  ctx.stroke();

  if (ing.placed && ing.placeT >= 0) {
    const pFrac = clamp(ing.placeT / ROUND_SECONDS, 0, 1);
    const px = tx + pFrac * tw;
    ctx.fillStyle =
      ing.placeKind === 'perfect'
        ? '#7be08a'
        : ing.placeKind === 'good'
          ? '#f4c25b'
          : '#e06464';
    ctx.beginPath();
    ctx.arc(px, ty + th / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFloats(): void {
  ctx.save();
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const f of floats) {
    const a = 1 - f.t / 1.1;
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y - f.t * 30);
  }
  ctx.restore();
}

// ── Input ─────────────────────────────────────────────────────────────────

function hitTestSlot(px: number, py: number): number {
  if (py < STRIP_TOP || py > STRIP_TOP + STRIP_H) return -1;
  for (let i = 0; i < ingredients.length; i++) {
    const r = slotRect(i);
    if (px >= r.x && px <= r.x + r.w) return i;
  }
  return -1;
}

function canvasCoords(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
  const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
  return { x, y };
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  if (state === 'ready') {
    startGame();
    return;
  }
  if (state === 'gameover') {
    reset();
    startGame();
    return;
  }
  const { x, y } = canvasCoords(e);
  const idx = hitTestSlot(x, y);
  if (idx >= 0) placeIngredient(idx);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (e.code === 'Space' || e.key === 'Enter') {
    e.preventDefault();
    if (state === 'ready') {
      startGame();
    } else if (state === 'gameover') {
      reset();
      startGame();
    }
    return;
  }
  if (state !== 'playing') return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= 7) {
    e.preventDefault();
    placeIngredient(n - 1);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

function reset(): void {
  gen.bump();
  cancelAnimationFrame(rafId);
  state = 'ready';
  score = 0;
  placedCount = 0;
  elapsed = 0;
  floats = [];
  bubbles = [];
  stewR = 110;
  stewG = 70;
  stewB = 36;
  ingredients = makeIngredients();
  commitBest();
  syncHud();
  setMsg(
    'Aşure',
    "Kazan kaynıyor. Her malzemenin kendi zaman penceresi var — ikon yeşil yandığında (ya da klavyede sırasındaki rakama 1–7 basarak) at. Tam pencerenin ortasında 100 puan, kenarında 60, dışında 10 puan ve aşure ekşir. Pencereyi kaçırırsan o malzeme yok.\n\nBaşlamak için tıkla veya Boşluk'a bas.",
  );
  showOverlay(overlayEl);
  draw();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  placedEl = document.querySelector<HTMLElement>('#placed')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });
  canvas.addEventListener('pointerdown', onPointerDown);
  overlayEl.addEventListener('pointerdown', (e) => {
    if (isOverlayHidden(overlayEl)) return;
    onPointerDown(e);
  });
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
