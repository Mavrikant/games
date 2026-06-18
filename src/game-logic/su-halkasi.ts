// Su Halkası — single-shot chain-reaction puzzle on a pond surface.
//
// Each level seeds N lily pads that drift slowly across the pond and bounce
// off the edges. The player drops ONE stone per level; the resulting ring
// expands, holds, and fades. Any pad the ring touches "ignites" into its own
// ring, propagating the chain. When every ring has faded, the level ends:
// reach the target hit count to pass and unlock a harder level, fall short
// and the run ends.
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM/storage access lives in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() in reset() cancels the RAF loop so a
//   restart during a chain doesn't leave the old loop ticking.
// - overlay-input-leak: pointer + key handlers gate on the State enum; the
//   only way out of every state is an explicit transition.
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual.
// - hud-counter-synced-only-at-lifecycle-edges: hitCount HUD is written via
//   updateHud() every time a pad is ignited, not only at chain end.
// - visual-vs-hitbox: pads draw and collide using the same PAD_R/RING_MAX_R
//   constants; ring radius comes from ringRadius() in both draw and update.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'su-halkasi.best';

const W = 480;
const H = 540;

const PAD_R = 14;
const RING_MAX_R = 95;
const RING_EXPAND = 0.55;
const RING_HOLD = 0.45;
const RING_FADE = 0.55;
const RING_LIFE = RING_EXPAND + RING_HOLD + RING_FADE; // 1.55 s

const PAD_MIN_SPEED = 14;
const PAD_MAX_SPEED = 32;
// Minimum centre-to-centre distance when seeding pads, to avoid them spawning
// already overlapping.
const PAD_SPAWN_MIN_DIST = PAD_R * 2 + 4;

type State = 'ready' | 'aiming' | 'rippling' | 'levelend' | 'gameover';

interface Pad {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: number; // green hue variation
  ignited: boolean;
  ringBorn: number;
  glow: number; // 0..1, ignition glow envelope for draw
}

interface Ring {
  x: number;
  y: number;
  born: number;
  source: 'stone' | 'pad';
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let goalEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let level = 1;
let best = 0;
let hitCount = 0;
let target = 0;
let totalPads = 0;

let pads: Pad[] = [];
let rings: Ring[] = [];

let nowSec = 0;
let lastFrame = 0;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function padCountFor(lv: number): number {
  return Math.min(60, 12 + lv * 2);
}

function targetFor(lv: number): number {
  return Math.min(padCountFor(lv) - 1, lv + 2);
}

function updateHud(): void {
  levelEl.textContent = String(level);
  goalEl.textContent = `${hitCount}/${target}`;
  bestEl.textContent = String(best);
}

function ringRadius(r: Ring): number {
  const age = nowSec - r.born;
  if (age < 0) return 0;
  if (age < RING_EXPAND) return (age / RING_EXPAND) * RING_MAX_R;
  return RING_MAX_R;
}

function ringAlpha(r: Ring): number {
  const age = nowSec - r.born;
  if (age < RING_EXPAND) return 0.55 + 0.45 * (age / RING_EXPAND);
  if (age < RING_EXPAND + RING_HOLD) return 1;
  const fade = (age - RING_EXPAND - RING_HOLD) / RING_FADE;
  return Math.max(0, 1 - fade);
}

function ringDead(r: Ring): boolean {
  return nowSec - r.born >= RING_LIFE;
}

function farEnough(x: number, y: number, list: Pad[]): boolean {
  for (const p of list) {
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy < PAD_SPAWN_MIN_DIST * PAD_SPAWN_MIN_DIST) return false;
  }
  return true;
}

function seedPads(count: number): Pad[] {
  const list: Pad[] = [];
  const margin = PAD_R + 8;
  let attempts = 0;
  while (list.length < count && attempts < count * 50) {
    attempts++;
    const x = rand(margin, W - margin);
    const y = rand(margin, H - margin);
    if (!farEnough(x, y, list)) continue;
    const speed = rand(PAD_MIN_SPEED, PAD_MAX_SPEED);
    const ang = rand(0, Math.PI * 2);
    list.push({
      x,
      y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      hue: rand(95, 145),
      ignited: false,
      ringBorn: 0,
      glow: 0,
    });
  }
  return list;
}

function setupLevel(lv: number): void {
  level = lv;
  totalPads = padCountFor(lv);
  target = targetFor(lv);
  hitCount = 0;
  pads = seedPads(totalPads);
  rings = [];
  updateHud();
}

function commitBest(passed: boolean): void {
  // "Best" is the highest level number the player reached. Passing level N
  // means they are about to play N+1, so the best they've "reached" so far
  // including the current run is N if they passed, or N-1 if they failed.
  const reached = passed ? level : level - 1;
  if (reached > best) {
    best = reached;
    safeWrite(STORAGE_BEST, best);
  }
}

function showReadyOverlay(): void {
  overlayTitle.textContent = 'Su Halkası';
  overlayMsg.textContent =
    'Tek bir taşın var.\n' +
    'Yapraklar göletin üstünde yavaşça süzülür — zincire değecek bir küme bul.\n' +
    'Halka kaç yaprağı tetiklerse o kadar puan; hedefe ulaş ve seviyeyi geç.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function showLevelEndOverlay(): void {
  overlayTitle.textContent = `Seviye ${level} tamam`;
  overlayMsg.textContent =
    `${hitCount} yaprak ${target} hedefin üstünde — geçtin.\n` +
    `Sonraki seviye: ${padCountFor(level + 1)} yaprak, hedef ${targetFor(level + 1)}.\n` +
    `Rekorun ${best}.`;
  overlayBtn.textContent = 'Sonraki seviye';
  showOverlay(overlay);
}

function showGameOverOverlay(): void {
  overlayTitle.textContent = 'Sular durdu';
  overlayMsg.textContent =
    `${hitCount} yaprak ${target} hedefin altında.\n` +
    `Ulaştığın en yüksek seviye: ${best}.\n` +
    'Yeniden başlamak için butona, Boşluk/Enter tuşuna ya da gölete dokun.';
  overlayBtn.textContent = 'Yeniden başla';
  showOverlay(overlay);
}

function dropStone(cx: number, cy: number): void {
  // Clamp so the drop point is inside the pond (a stone falling on the rim
  // would otherwise create a half-ring with a misleading hitbox).
  const x = Math.max(8, Math.min(W - 8, cx));
  const y = Math.max(8, Math.min(H - 8, cy));
  rings.push({ x, y, born: nowSec, source: 'stone' });
  state = 'rippling';
}

function igniteAt(x: number, y: number): void {
  rings.push({ x, y, born: nowSec, source: 'pad' });
}

function update(dt: number): void {
  nowSec += dt;

  // Pads drift while aiming, and continue (slower) during the ripple so
  // ignited pads' new rings stay anchored where the pad was.
  for (const p of pads) {
    if (p.ignited) {
      // Ignited pads gently expand their glow envelope then fade.
      const age = nowSec - p.ringBorn;
      const env =
        age < RING_EXPAND
          ? age / RING_EXPAND
          : Math.max(0, 1 - (age - RING_EXPAND) / (RING_HOLD + RING_FADE));
      p.glow = env;
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.x < PAD_R) {
      p.x = PAD_R;
      p.vx = -p.vx;
    }
    if (p.x > W - PAD_R) {
      p.x = W - PAD_R;
      p.vx = -p.vx;
    }
    if (p.y < PAD_R) {
      p.y = PAD_R;
      p.vy = -p.vy;
    }
    if (p.y > H - PAD_R) {
      p.y = H - PAD_R;
      p.vy = -p.vy;
    }
  }

  if (state === 'rippling') {
    // Test every un-ignited pad against every live ring. A pad is touched if
    // its centre lies within the ring's current expanded radius (plus the
    // pad's own radius for fairness). Same constants as draw → no
    // visual-vs-hitbox drift.
    for (const p of pads) {
      if (p.ignited) continue;
      for (const r of rings) {
        if (ringDead(r)) continue;
        const rad = ringRadius(r);
        // Avoid igniting from a ring centred ON the pad (the stone's own
        // origin pad): the ring needs at least a tiny radius first.
        if (rad < 4) continue;
        const dx = p.x - r.x;
        const dy = p.y - r.y;
        const d2 = dx * dx + dy * dy;
        const reach = rad + PAD_R;
        if (d2 <= reach * reach) {
          p.ignited = true;
          p.ringBorn = nowSec;
          igniteAt(p.x, p.y);
          hitCount++;
          updateHud();
          break;
        }
      }
    }

    rings = rings.filter((r) => !ringDead(r));

    if (rings.length === 0) {
      const passed = hitCount >= target;
      commitBest(passed);
      updateHud();
      if (passed) {
        state = 'levelend';
        showLevelEndOverlay();
      } else {
        state = 'gameover';
        showGameOverOverlay();
      }
    }
  }
}

function drawBackground(): void {
  ctx.clearRect(0, 0, W, H);
  // CSS gradient does most of the work; we just paint a few soft sparkles to
  // give the pond a faint living shimmer.
  ctx.save();
  for (let i = 0; i < 28; i++) {
    const x = ((i * 173 + Math.sin(nowSec * 0.7 + i) * 40) % W + W) % W;
    const y = ((i * 211 + Math.cos(nowSec * 0.5 + i) * 30) % H + H) % H;
    const a = 0.04 + 0.04 * Math.sin(nowSec * 1.3 + i);
    ctx.fillStyle = `rgba(180, 220, 255, ${a})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawLilyPad(p: Pad): void {
  ctx.save();
  ctx.translate(p.x, p.y);

  // Soft underwater shadow.
  ctx.fillStyle = 'rgba(0, 12, 24, 0.35)';
  ctx.beginPath();
  ctx.ellipse(2, 4, PAD_R + 1, PAD_R * 0.7 + 1, 0, 0, Math.PI * 2);
  ctx.fill();

  const lit = p.ignited;
  const baseLight = lit ? Math.min(80, 50 + p.glow * 30) : 42;
  const baseSat = lit ? 70 : 55;
  const hue = p.hue;
  ctx.fillStyle = `hsl(${hue}, ${baseSat}%, ${baseLight}%)`;
  ctx.beginPath();
  ctx.arc(0, 0, PAD_R, 0, Math.PI * 2);
  ctx.fill();

  // Lily-pad slot — a thin wedge cut out at a fixed angle keyed to position
  // so it doesn't spin distractingly each frame.
  const slotAng = (p.x * 0.013 + p.y * 0.017) % (Math.PI * 2);
  ctx.fillStyle = '#06182c';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const slotW = 0.34; // radians
  ctx.arc(0, 0, PAD_R + 0.4, slotAng - slotW / 2, slotAng + slotW / 2);
  ctx.closePath();
  ctx.fill();

  // Rim highlight.
  ctx.strokeStyle = lit
    ? `hsla(${hue}, 80%, ${Math.min(90, 60 + p.glow * 30)}%, 0.9)`
    : `hsla(${hue}, 60%, 28%, 0.95)`;
  ctx.lineWidth = lit ? 1.6 : 1.2;
  ctx.beginPath();
  ctx.arc(0, 0, PAD_R, 0, Math.PI * 2);
  ctx.stroke();

  // Ignition flash.
  if (lit && p.glow > 0) {
    ctx.globalAlpha = 0.4 * p.glow;
    ctx.fillStyle = `hsl(${hue}, 90%, 92%)`;
    ctx.beginPath();
    ctx.arc(0, 0, PAD_R * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawRing(r: Ring): void {
  const rad = ringRadius(r);
  const a = ringAlpha(r);
  if (rad < 1 || a <= 0) return;
  ctx.save();
  // Outer band — a bright thin stroke at the current radius.
  ctx.strokeStyle = `rgba(190, 235, 255, ${0.85 * a})`;
  ctx.lineWidth = r.source === 'stone' ? 2.4 : 1.8;
  ctx.beginPath();
  ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
  ctx.stroke();
  // Inner glow — soft radial wash so the ring reads as a filled water bulge,
  // not just an outline.
  const grd = ctx.createRadialGradient(r.x, r.y, Math.max(0, rad - 22), r.x, r.y, rad);
  grd.addColorStop(0, `rgba(120, 200, 240, 0)`);
  grd.addColorStop(0.7, `rgba(140, 215, 245, ${0.18 * a})`);
  grd.addColorStop(1, `rgba(200, 235, 255, ${0.55 * a})`);
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAimHint(): void {
  // Subtle pulsing crosshair around the centre as a "tap anywhere" hint when
  // aiming and the pointer is presumably off-canvas (no extra event needed).
  if (state !== 'aiming') return;
  const pulse = 0.5 + 0.5 * Math.sin(nowSec * 2.4);
  ctx.save();
  ctx.globalAlpha = 0.18 + 0.18 * pulse;
  ctx.strokeStyle = '#cfeaff';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 36 + 6 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function draw(): void {
  drawBackground();
  drawAimHint();
  for (const p of pads) drawLilyPad(p);
  for (const r of rings) drawRing(r);
}

function loop(timestamp: number): void {
  const myGen = gen.current();
  if (!gen.isCurrent(myGen)) return;

  const t = timestamp / 1000;
  const raw = lastFrame === 0 ? 0 : t - lastFrame;
  // Tab-backgrounded catch-up guard: cap dt at 1/15 s.
  const dt = Math.min(raw, 1 / 15);
  lastFrame = t;

  update(dt);
  draw();

  if (gen.isCurrent(myGen)) {
    requestAnimationFrame((ts) => {
      if (gen.isCurrent(myGen)) loop(ts);
    });
  }
}

function startGame(): void {
  setupLevel(1);
  state = 'aiming';
  hideOverlay(overlay);
}

function advanceLevel(): void {
  setupLevel(level + 1);
  state = 'aiming';
  hideOverlay(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  level = 1;
  hitCount = 0;
  target = targetFor(1);
  totalPads = padCountFor(1);
  pads = seedPads(totalPads);
  rings = [];
  nowSec = 0;
  lastFrame = 0;
  updateHud();
  showReadyOverlay();
  draw();
  requestAnimationFrame(loop);
}

function pointerToCanvas(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function onPointer(e: PointerEvent): void {
  if (state === 'ready') {
    startGame();
    return;
  }
  if (state === 'levelend') {
    advanceLevel();
    return;
  }
  if (state === 'gameover') {
    reset();
    return;
  }
  if (state === 'aiming') {
    const { x, y } = pointerToCanvas(e);
    dropStone(x, y);
    return;
  }
  // 'rippling' swallows the input — the chain is playing out.
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    reset();
    e.preventDefault();
    return;
  }
  if (k === 'n' && state === 'levelend') {
    advanceLevel();
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'enter') {
    if (state === 'ready') startGame();
    else if (state === 'levelend') advanceLevel();
    else if (state === 'gameover') reset();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  goalEl = document.querySelector<HTMLElement>('#goal')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointer);
  window.addEventListener('keydown', onKey);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', () => {
    if (state === 'ready') startGame();
    else if (state === 'levelend') advanceLevel();
    else if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
