import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// PITFALLS:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() cancels rAF chain.
// - overlay-input-leak: state enum guards all input handlers.
// - module-level side effects: every DOM/storage call lives in init().
// - visual-vs-hitbox: shelf rects are computed once per draw and reused for
//   pointer hit-tests via the shared SHELF_GEOM table.

const STORAGE_BEST = 'firin.best';

type State = 'ready' | 'playing' | 'paused' | 'gameover';
type Kind = 'white' | 'rye' | 'sesame';

interface Loaf {
  id: number;
  kind: Kind;
  bake: number;          // 0..150+ (over-burn)
  perfectMin: number;
  perfectMax: number;
  entering: number;      // 1 → 0 (slide-in animation)
  flash: number;         // brief feedback flash (1 → 0)
  flashKind: 'good' | 'bad';
}

const SHELVES = 4;
// rate multipliers, index 0 = top shelf, 3 = bottom shelf
const SHELF_RATES = [0.5, 0.85, 1.2, 1.6];
const BAKE_BASE_RATE = 11; // % per second at neutral shelf
const BURN_THRESHOLD = 140; // auto-discard cap (grace past 108 max-perfect)
const LEVEL_EVERY = 6;
const NEW_LOAF_DELAY = 1.0; // seconds before empty shelf refills
const KINDS: Kind[] = ['white', 'rye', 'sesame'];

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let livesEl!: HTMLElement;
let levelEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const gen = createGenToken();

const shelves: (Loaf | null)[] = [null, null, null, null];
const pendingFill: number[] = [0, 0, 0, 0];
let nextLoafId = 1;
let score = 0;
let lives = 3;
let level = 1;
let perfectCount = 0;
let best = 0;
let state: State = 'ready';
let lastTs = 0;

// drag state — single active pointer at a time
let dragFrom: number | null = null;
let dragX = 0;
let dragY = 0;
let dragStartX = 0;
let dragStartY = 0;
let dragMoved = false;

// canvas-internal geometry (CSS px → canvas internal px ratio handled at hit-test)
const C_W = 480;
const C_H = 560;
const SHELF_AREA_TOP = 14;
const SHELF_AREA_BOTTOM = 60; // heat zone reserved at bottom
const SHELF_HEIGHT = (C_H - SHELF_AREA_TOP - SHELF_AREA_BOTTOM) / SHELVES;
const LOAF_PAD_X = 80; // canvas-internal padding from sides for loaf
const GAUGE_WIDTH = 18;
const GAUGE_GAP = 12;

function shelfRect(idx: number): { x: number; y: number; w: number; h: number } {
  const y = SHELF_AREA_TOP + idx * SHELF_HEIGHT;
  return { x: 0, y, w: C_W, h: SHELF_HEIGHT };
}

function loafRect(idx: number, loaf: Loaf): { x: number; y: number; w: number; h: number } {
  const sh = shelfRect(idx);
  const w = C_W - LOAF_PAD_X * 2 - (GAUGE_WIDTH + GAUGE_GAP);
  const h = sh.h * 0.62;
  const baseX = LOAF_PAD_X;
  const offsetX = loaf.entering > 0 ? -((C_W) * loaf.entering) : 0;
  return {
    x: baseX + offsetX,
    y: sh.y + (sh.h - h) / 2,
    w,
    h,
  };
}

function gaugeRect(idx: number): { x: number; y: number; w: number; h: number } {
  const sh = shelfRect(idx);
  const x = C_W - LOAF_PAD_X / 2 - GAUGE_WIDTH;
  const h = sh.h * 0.72;
  return { x, y: sh.y + (sh.h - h) / 2, w: GAUGE_WIDTH, h };
}

function pointToShelf(x: number, y: number): number | null {
  if (y < SHELF_AREA_TOP || y > C_H - SHELF_AREA_BOTTOM) return null;
  const idx = Math.floor((y - SHELF_AREA_TOP) / SHELF_HEIGHT);
  if (idx < 0 || idx >= SHELVES) return null;
  // ignore far-right HUD-ish zone
  if (x < 0 || x > C_W) return null;
  return idx;
}

function randomKind(): Kind {
  return KINDS[Math.floor(Math.random() * KINDS.length)]!;
}

function makeLoaf(): Loaf {
  const kind = randomKind();
  let min: number, max: number;
  if (kind === 'white') {
    min = 55; max = 75;
  } else if (kind === 'rye') {
    min = 72; max = 92;
  } else {
    min = 88; max = 108;
  }
  // shrink window with level (cap at 8 each side → 16-unit minimum window for white)
  const shrink = Math.min((level - 1) * 0.9, 6);
  return {
    id: nextLoafId++,
    kind,
    bake: 0,
    perfectMin: min + shrink,
    perfectMax: max - shrink,
    entering: 1,
    flash: 0,
    flashKind: 'good',
  };
}

function updateHUD(): void {
  scoreEl.textContent = String(score);
  livesEl.textContent = String(Math.max(0, lives));
  levelEl.textContent = String(level);
  bestEl.textContent = String(best);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function startGame(): void {
  state = 'playing';
  score = 0;
  lives = 3;
  level = 1;
  perfectCount = 0;
  // Start with all shelves filled and entry animations staggered.
  for (let i = 0; i < SHELVES; i++) {
    const loaf = makeLoaf();
    loaf.entering = 1 - i * 0.18; // top enters first, bottom last → first-feedback within ~250ms
    shelves[i] = loaf;
    pendingFill[i] = 0;
  }
  updateHUD();
  hideOverlay();
  loop();
}

function resetGame(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  lives = 3;
  level = 1;
  perfectCount = 0;
  dragFrom = null;
  dragMoved = false;
  for (let i = 0; i < SHELVES; i++) {
    shelves[i] = null;
    pendingFill[i] = 0;
  }
  updateHUD();
  showOverlay('Fırın', 'Ekmekleri yeşil bandın içindeyken çıkar. Sürükle: rafları takas et.\n\nBaşlamak için Boşluk veya tıkla.');
  draw();
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function gameOver(): void {
  state = 'gameover';
  commitBest();
  showOverlay('Bitti!', `Skor: ${score} · Seviye: ${level}\n\nBoşluk veya tıkla: tekrar başla`);
}

function pullOut(shelfIdx: number): void {
  if (state !== 'playing') return;
  const loaf = shelves[shelfIdx];
  if (!loaf || loaf.entering > 0.2) return; // can't pull while sliding in
  const inWindow = loaf.bake >= loaf.perfectMin && loaf.bake <= loaf.perfectMax;
  if (inWindow) {
    score += 1;
    perfectCount += 1;
    loaf.flash = 1;
    loaf.flashKind = 'good';
    if (perfectCount % LEVEL_EVERY === 0) {
      level += 1;
    }
  } else {
    lives -= 1;
    loaf.flash = 1;
    loaf.flashKind = 'bad';
  }
  // briefly leave loaf in place for flash, then clear
  const dyingLoaf = loaf;
  shelves[shelfIdx] = dyingLoaf; // keep for flash render
  // schedule removal after 220ms
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    if (shelves[shelfIdx] === dyingLoaf) {
      shelves[shelfIdx] = null;
      pendingFill[shelfIdx] = NEW_LOAF_DELAY;
    }
  }, 220);
  updateHUD();
  if (lives <= 0) {
    // delay gameover so flash visible
    const myGen2 = gen.current();
    window.setTimeout(() => {
      if (!gen.isCurrent(myGen2)) return;
      gameOver();
    }, 250);
  }
  commitBest();
}

function swapShelves(a: number, b: number): void {
  if (a === b) return;
  const la = shelves[a];
  const lb = shelves[b];
  shelves[a] = lb;
  shelves[b] = la;
  // refresh entering animation when moved if entering already done
  // (Don't reset entering; gives instant swap which feels right.)
}

function update(dt: number): void {
  if (state !== 'playing') return;
  const speedMul = 1 + (level - 1) * 0.08;
  for (let i = 0; i < SHELVES; i++) {
    const loaf = shelves[i];
    if (loaf) {
      if (loaf.entering > 0) loaf.entering = Math.max(0, loaf.entering - dt * 2.4);
      if (loaf.flash > 0) loaf.flash = Math.max(0, loaf.flash - dt * 4);
      // Don't bake during entering (avoids slot getting hot before user sees it)
      if (loaf.entering < 0.1) {
        loaf.bake += SHELF_RATES[i]! * BAKE_BASE_RATE * speedMul * dt;
      }
      if (loaf.bake >= BURN_THRESHOLD) {
        // auto-discard burnt loaf, lose life
        loaf.flash = 1;
        loaf.flashKind = 'bad';
        lives -= 1;
        const dyingLoaf = loaf;
        const myGen = gen.current();
        window.setTimeout(() => {
          if (!gen.isCurrent(myGen)) return;
          if (shelves[i] === dyingLoaf) {
            shelves[i] = null;
            pendingFill[i] = NEW_LOAF_DELAY;
          }
        }, 280);
        updateHUD();
        if (lives <= 0) {
          const myGen2 = gen.current();
          window.setTimeout(() => {
            if (!gen.isCurrent(myGen2)) return;
            gameOver();
          }, 300);
        }
      }
    } else if (pendingFill[i]! > 0) {
      pendingFill[i] = Math.max(0, pendingFill[i]! - dt);
      if (pendingFill[i] === 0) {
        shelves[i] = makeLoaf();
      }
    }
  }
}

// ---- rendering ----

function loafFill(bake: number): string {
  // pale → golden → brown → black
  if (bake < 30) {
    // pale beige → light tan
    const t = bake / 30;
    return lerpColor('#f4dfb4', '#e6c389', t);
  }
  if (bake < 70) {
    const t = (bake - 30) / 40;
    return lerpColor('#e6c389', '#c98a4b', t);
  }
  if (bake < 105) {
    const t = (bake - 70) / 35;
    return lerpColor('#c98a4b', '#7a4218', t);
  }
  if (bake < 130) {
    const t = (bake - 105) / 25;
    return lerpColor('#7a4218', '#1a0f08', t);
  }
  return '#0a0604';
}

function lerpColor(a: string, b: string, t: number): string {
  const av = hexToRgb(a);
  const bv = hexToRgb(b);
  const tt = Math.max(0, Math.min(1, t));
  const r = Math.round(av[0] + (bv[0] - av[0]) * tt);
  const g = Math.round(av[1] + (bv[1] - av[1]) * tt);
  const bb = Math.round(av[2] + (bv[2] - av[2]) * tt);
  return `rgb(${r},${g},${bb})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function drawHeatZone(): void {
  const y = C_H - SHELF_AREA_BOTTOM;
  // Stone hearth
  ctx.fillStyle = '#1a120c';
  ctx.fillRect(0, y, C_W, SHELF_AREA_BOTTOM);
  // Fire gradient
  const grad = ctx.createLinearGradient(0, y, 0, C_H);
  grad.addColorStop(0, '#dc2626');
  grad.addColorStop(0.5, '#f97316');
  grad.addColorStop(1, '#fbbf24');
  ctx.fillStyle = grad;
  // animated flickering flame tongues
  const t = performance.now() / 200;
  ctx.beginPath();
  ctx.moveTo(0, C_H);
  for (let i = 0; i <= 16; i++) {
    const x = (i / 16) * C_W;
    const flame = Math.sin(t + i * 0.7) * 6 + Math.cos(t * 1.3 + i * 1.1) * 4;
    ctx.lineTo(x, y + 16 + flame);
  }
  ctx.lineTo(C_W, C_H);
  ctx.closePath();
  ctx.fill();
  // Glow line
  ctx.fillStyle = 'rgba(251, 191, 36, 0.45)';
  ctx.fillRect(0, y - 2, C_W, 3);
}

function drawShelfFrame(idx: number): void {
  const sh = shelfRect(idx);
  // alternating stone shading
  ctx.fillStyle = idx % 2 === 0 ? '#221913' : '#1c150f';
  ctx.fillRect(sh.x, sh.y, sh.w, sh.h);
  // shelf bar at bottom
  ctx.fillStyle = '#3a2c20';
  ctx.fillRect(sh.x + 18, sh.y + sh.h - 4, sh.w - 36, 3);
  // heat-rate label on left
  ctx.fillStyle = 'rgba(251, 146, 60, 0.55)';
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const rate = SHELF_RATES[idx]!;
  ctx.fillText(`${rate.toFixed(2).replace(/\.?0+$/, '')}×`, 12, sh.y + sh.h / 2);
  // shelf number on right side
  ctx.fillStyle = 'rgba(120, 100, 80, 0.6)';
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(String(idx + 1), C_W - 12, sh.y + sh.h / 2);
}

function drawLoaf(idx: number, loaf: Loaf, overrideX?: number, overrideY?: number): void {
  const r = loafRect(idx, loaf);
  const x = overrideX ?? r.x;
  const y = overrideY ?? r.y;
  const w = r.w;
  const h = r.h;
  // base shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h + 4, w * 0.42, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  // loaf body (rounded blob)
  ctx.fillStyle = loafFill(loaf.bake);
  roundedRect(x, y, w, h, h * 0.45);
  ctx.fill();
  // crust shine
  ctx.fillStyle = 'rgba(255, 240, 200, 0.18)';
  roundedRect(x + 8, y + 4, w - 16, h * 0.32, h * 0.16);
  ctx.fill();
  // kind marker
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  if (loaf.kind === 'rye') {
    // central slash
    ctx.fillRect(x + w * 0.18, y + h * 0.46, w * 0.64, 2);
  } else if (loaf.kind === 'sesame') {
    // sesame dots
    for (let i = 0; i < 7; i++) {
      const px = x + w * 0.18 + (w * 0.64) * (i / 6);
      const py = y + h * 0.4 + Math.sin(i * 1.7) * 4;
      ctx.beginPath();
      ctx.arc(px, py, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // white: small score line on top
    ctx.fillRect(x + w * 0.3, y + h * 0.38, w * 0.4, 1.4);
  }
  // flash overlay
  if (loaf.flash > 0) {
    ctx.fillStyle =
      loaf.flashKind === 'good'
        ? `rgba(52, 211, 153, ${loaf.flash * 0.55})`
        : `rgba(239, 68, 68, ${loaf.flash * 0.55})`;
    roundedRect(x - 4, y - 4, w + 8, h + 8, h * 0.5);
    ctx.fill();
  }
}

function drawGauge(idx: number, loaf: Loaf): void {
  const g = gaugeRect(idx);
  // background
  ctx.fillStyle = '#0a0604';
  ctx.fillRect(g.x, g.y, g.w, g.h);
  // perfect window band (mapped: 0 at top → BURN_THRESHOLD at bottom)
  const yFor = (bake: number) => g.y + (Math.min(bake, BURN_THRESHOLD) / BURN_THRESHOLD) * g.h;
  ctx.fillStyle = 'rgba(52, 211, 153, 0.55)';
  const minY = yFor(loaf.perfectMin);
  const maxY = yFor(loaf.perfectMax);
  ctx.fillRect(g.x, minY, g.w, maxY - minY);
  // burn zone band (top = nothing, last 25 units = warning red)
  ctx.fillStyle = 'rgba(239, 68, 68, 0.32)';
  const burnY = yFor(105);
  ctx.fillRect(g.x, burnY, g.w, g.y + g.h - burnY);
  // current bake fill (bottom-style: from top to current level)
  const cur = yFor(loaf.bake);
  ctx.fillStyle =
    loaf.bake < loaf.perfectMin
      ? '#fbbf24'
      : loaf.bake <= loaf.perfectMax
        ? '#34d399'
        : '#ef4444';
  ctx.fillRect(g.x + 2, cur - 2, g.w - 4, 3);
  // outline
  ctx.strokeStyle = '#3a2c20';
  ctx.lineWidth = 1;
  ctx.strokeRect(g.x + 0.5, g.y + 0.5, g.w - 1, g.h - 1);
}

function drawPendingSlot(idx: number, remaining: number): void {
  const sh = shelfRect(idx);
  const cx = sh.x + LOAF_PAD_X + 30;
  const cy = sh.y + sh.h / 2;
  ctx.fillStyle = 'rgba(180, 140, 100, 0.18)';
  ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Yeni ekmek geliyor…  ${remaining.toFixed(1)}s`, cx, cy);
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function draw(): void {
  // background
  ctx.fillStyle = '#0a0807';
  ctx.fillRect(0, 0, C_W, C_H);
  // oven frame top
  ctx.fillStyle = '#1c1410';
  ctx.fillRect(0, 0, C_W, SHELF_AREA_TOP);

  // shelves & their contents (skip dragged loaf in-place)
  for (let i = 0; i < SHELVES; i++) {
    drawShelfFrame(i);
    const loaf = shelves[i];
    if (loaf) {
      if (dragFrom === i && dragMoved) {
        // draw faded ghost in original slot
        ctx.globalAlpha = 0.25;
        drawLoaf(i, loaf);
        ctx.globalAlpha = 1;
        // gauge stays full
        drawGauge(i, loaf);
        // and floating copy at cursor (later, after all shelves done)
      } else {
        drawLoaf(i, loaf);
        drawGauge(i, loaf);
      }
    } else if (pendingFill[i]! > 0) {
      drawPendingSlot(i, pendingFill[i]!);
    }
  }

  // heat zone
  drawHeatZone();

  // dragged loaf at cursor (drawn last → on top)
  if (dragFrom !== null && dragMoved) {
    const loaf = shelves[dragFrom];
    if (loaf) {
      const r = loafRect(dragFrom, loaf);
      drawLoaf(dragFrom, loaf, dragX - r.w / 2, dragY - r.h / 2);
    }
  }
}

function loop(): void {
  const myGen = gen.current();
  function tick(ts: number): void {
    if (!gen.isCurrent(myGen)) return;
    if (state !== 'playing' && state !== 'paused') {
      lastTs = 0;
      return;
    }
    if (lastTs === 0) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    if (state === 'playing') update(dt);
    draw();
    requestAnimationFrame(tick);
  }
  lastTs = 0;
  requestAnimationFrame(tick);
}

// ---- input ----

function getCanvasPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * sx,
    y: (e.clientY - rect.top) * sy,
  };
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'ready' || state === 'gameover') {
    if (state === 'gameover') {
      startGame();
    } else {
      startGame();
    }
    return;
  }
  if (state !== 'playing') return;
  const p = getCanvasPoint(e);
  const idx = pointToShelf(p.x, p.y);
  if (idx === null) return;
  const loaf = shelves[idx];
  if (!loaf || loaf.entering > 0.2) return;
  dragFrom = idx;
  dragStartX = dragX = p.x;
  dragStartY = dragY = p.y;
  dragMoved = false;
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (dragFrom === null) return;
  const p = getCanvasPoint(e);
  dragX = p.x;
  dragY = p.y;
  if (!dragMoved) {
    const dx = p.x - dragStartX;
    const dy = p.y - dragStartY;
    if (dx * dx + dy * dy > 16 * 16) dragMoved = true;
  }
}

function onPointerUp(e: PointerEvent): void {
  if (dragFrom === null) return;
  const p = getCanvasPoint(e);
  const from = dragFrom;
  dragFrom = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (!dragMoved) {
    // treat as click → pull out
    pullOut(from);
  } else {
    const to = pointToShelf(p.x, p.y);
    if (to !== null && to !== from) {
      swapShelves(from, to);
    }
    dragMoved = false;
  }
}

function onPointerCancel(): void {
  dragFrom = null;
  dragMoved = false;
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    resetGame();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'space' || k === 'enter') {
    if (state === 'ready' || state === 'gameover') {
      startGame();
    } else if (state === 'playing') {
      state = 'paused';
      showOverlay('Duraklatıldı', 'Devam için Boşluk veya tıkla.');
    } else if (state === 'paused') {
      state = 'playing';
      hideOverlay();
      lastTs = 0;
      loop();
    }
    e.preventDefault();
    return;
  }
  if (k === '1' || k === '2' || k === '3' || k === '4') {
    if (state !== 'playing') return;
    pullOut(Number(k) - 1);
    e.preventDefault();
  }
}

function onOverlayClick(): void {
  if (state === 'ready' || state === 'gameover') {
    startGame();
  } else if (state === 'paused') {
    state = 'playing';
    hideOverlay();
    lastTs = 0;
    loop();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  overlay.addEventListener('click', onOverlayClick);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', resetGame);

  resetGame();
}

export const game = defineGame({ init, reset: resetGame });
