// All canvas drawing: themed background, catapult, blocks, projectiles, aim
// preview, and a steady on-canvas HUD strip. Applies screen shake to the
// scene layer only (HUD stays put). One blockRect() source (from blocks.ts).

import { S } from './state';
import {
  BLOCK,
  CASTLE_X,
  COL,
  GROUND_Y,
  GRAVITY,
  H,
  P0X,
  P0Y,
  W,
  clamp,
} from './constants';
import type { Block, WorldDef } from './types';
import { blockRect } from './blocks';
import { drawEngine } from './engines';
import { AMMO } from './ammo';
import { ENGINES } from './engines';
import { gravScale } from './physics';
import { WORLDS } from './levels';
import { drawParticles, drawPopups } from './fx';

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let dpr = 1;
let boardWrap: HTMLElement | null = null;
let ksRoot: HTMLElement | null = null;
let hudEl: HTMLElement | null = null;
let subhudEl: HTMLElement | null = null;

export function bindCanvas(c: HTMLCanvasElement): void {
  canvas = c;
  ctx = c.getContext('2d')!;
  boardWrap = c.closest('.board-wrap');
  ksRoot = document.querySelector('#ks-root');
  hudEl = document.querySelector('.hud');
  subhudEl = document.querySelector('.subhud');
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => resizeCanvas()).observe(c);
  }
  resizeCanvas();
}

export function getCanvas(): HTMLCanvasElement {
  return canvas;
}

// Backing store tracks the canvas's actual displayed size so it stays crisp at
// any scale (normal stage, fullscreen, or the CSS-maximize fallback). The game
// keeps drawing in logical W×H coords; the transform absorbs the scale.
export function resizeCanvas(): void {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || W;
  dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(cssW * (H / W) * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const s = (cssW / W) * dpr;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.imageSmoothingEnabled = true;
  draw();
}

// Size the board to fill the screen (minus the HUD) at 16:10 when fullscreen /
// maximized; clear the inline size to fall back to the normal stage layout.
export function applyFullscreenLayout(active: boolean): void {
  if (!boardWrap) return;
  if (!active) {
    boardWrap.style.width = '';
    return;
  }
  const root = ksRoot ?? boardWrap.parentElement;
  const availW = (root?.clientWidth ?? window.innerWidth) - 24;
  const hud = (hudEl?.offsetHeight ?? 0) + (subhudEl?.offsetHeight ?? 0) + 24;
  const availH = (root?.clientHeight ?? window.innerHeight) - hud;
  const scale = Math.max(0.1, Math.min(availW / W, availH / H));
  boardWrap.style.width = `${Math.floor(W * scale)}px`;
}


function theme(): WorldDef {
  return WORLDS[S.level?.world ?? 0] ?? WORLDS[0]!;
}

export function launchSpeed(): number {
  const e = ENGINES[S.engineId];
  return e.speedMin + S.power * (e.speedMax - e.speedMin);
}

function drawSky(th: WorldDef): void {
  const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  g.addColorStop(0, th.skyTop);
  g.addColorStop(1, th.skyBot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, GROUND_Y);
  ctx.fillStyle = COL.sun;
  ctx.beginPath();
  ctx.arc(540, 70, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = th.hillFar;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.quadraticCurveTo(160, 232, 330, GROUND_Y);
  ctx.fill();
  ctx.fillStyle = th.hillNear;
  ctx.beginPath();
  ctx.moveTo(250, GROUND_Y);
  ctx.quadraticCurveTo(470, 250, 640, GROUND_Y);
  ctx.fill();
}

function drawGround(th: WorldDef): void {
  ctx.fillStyle = th.dirt;
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.fillStyle = th.groundTop;
  ctx.fillRect(0, GROUND_Y, W, 8);
  ctx.fillStyle = th.groundBot;
  ctx.fillRect(0, GROUND_Y + 8, W, 3);
}

function shade(x: number, y: number, fill: string, top: string, edge: string): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, BLOCK, BLOCK);
  ctx.fillStyle = top;
  ctx.fillRect(x, y, BLOCK, 4);
  ctx.fillStyle = edge;
  ctx.fillRect(x, y + BLOCK - 3, BLOCK, 3);
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BLOCK - 1, BLOCK - 1);
}

function drawBlock(b: Block): void {
  const x = CASTLE_X + b.col * BLOCK;
  const y = b.drawY;
  switch (b.kind) {
    case 'stone':
      shade(x, y, COL.stone, COL.stoneTop, COL.stoneEdge);
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.moveTo(x + BLOCK / 2, y + 4);
      ctx.lineTo(x + BLOCK / 2, y + BLOCK - 3);
      ctx.stroke();
      break;
    case 'wood':
      shade(x, y, COL.wood, COL.woodTop, COL.woodEdge);
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.moveTo(x + 2, y + BLOCK / 2);
      ctx.lineTo(x + BLOCK - 2, y + BLOCK / 2);
      ctx.stroke();
      break;
    case 'iron':
      shade(x, y, COL.iron, COL.ironTop, COL.ironEdge);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      for (const bx of [x + 5, x + BLOCK - 7]) {
        for (const by of [y + 6, y + BLOCK - 8]) {
          ctx.beginPath();
          ctx.arc(bx, by, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    case 'tnt':
      shade(x, y, COL.tnt, COL.tntTop, COL.tntDark);
      ctx.fillStyle = COL.tntDark;
      ctx.fillRect(x + 6, y + BLOCK / 2 - 2, BLOCK - 12, 4);
      ctx.fillStyle = '#1c1c1c';
      ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', x + BLOCK / 2, y + BLOCK / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      break;
    case 'glass':
      ctx.fillStyle = 'rgba(127,214,230,0.55)';
      ctx.fillRect(x + 2, y + 2, BLOCK - 4, BLOCK - 4);
      ctx.fillStyle = COL.glassTop;
      ctx.fillRect(x + 2, y + 2, BLOCK - 4, 3);
      ctx.strokeStyle = COL.glassEdge;
      ctx.strokeRect(x + 2.5, y + 2.5, BLOCK - 5, BLOCK - 5);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.moveTo(x + 6, y + BLOCK - 6);
      ctx.lineTo(x + BLOCK - 8, y + 6);
      ctx.stroke();
      break;
    case 'supply':
      ctx.fillStyle = COL.supply;
      ctx.fillRect(x + 3, y + 2, BLOCK - 6, BLOCK - 4);
      ctx.fillStyle = COL.supplyTop;
      ctx.fillRect(x + 3, y + 2, BLOCK - 6, 4);
      ctx.fillStyle = COL.supplyHoop;
      ctx.fillRect(x + 3, y + 9, BLOCK - 6, 3);
      ctx.fillRect(x + 3, y + BLOCK - 11, BLOCK - 6, 3);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.strokeRect(x + 3.5, y + 2.5, BLOCK - 7, BLOCK - 5);
      break;
    case 'target':
    default:
      shade(x, y, COL.keep, COL.keep, COL.keepEdge);
      ctx.fillStyle = COL.keepEdge;
      ctx.fillRect(x + 4, y, 6, 6);
      ctx.fillRect(x + BLOCK - 10, y, 6, 6);
      ctx.fillStyle = COL.pole;
      ctx.fillRect(x + BLOCK / 2 - 1, y - 18, 2, 22);
      ctx.fillStyle = COL.banner;
      ctx.beginPath();
      ctx.moveTo(x + BLOCK / 2 + 1, y - 18);
      ctx.lineTo(x + BLOCK / 2 + 15, y - 14);
      ctx.lineTo(x + BLOCK / 2 + 1, y - 10);
      ctx.closePath();
      ctx.fill();
      break;
  }
  if (b.flash > 0) {
    ctx.globalAlpha = b.flash * 0.6;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, y, BLOCK, BLOCK);
    ctx.globalAlpha = 1;
  }
}

function drawProjectile(p: { x: number; y: number; r: number; ammo: keyof typeof AMMO; rot: number }): void {
  const def = AMMO[p.ammo];
  if (def.behavior === 'fire' || def.behavior === 'keg') {
    ctx.fillStyle = 'rgba(255,138,60,0.35)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COL.fireCore;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (def.behavior === 'bolt') {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(p.r, p.r) + p.rot * 0 + Math.atan2(0, 1));
    ctx.fillStyle = def.color;
    ctx.fillRect(-p.r * 2, -p.r / 1.5, p.r * 4, p.r * 1.3);
    ctx.restore();
    return;
  }
  ctx.fillStyle = def.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath();
  ctx.arc(p.x - p.r * 0.3, p.y - p.r * 0.3, p.r * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COL.ballEdge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  ctx.stroke();
}

function previewPath(): Array<{ x: number; y: number }> {
  const e = ENGINES[S.engineId];
  const def = AMMO[S.activeAmmo];
  const s = launchSpeed();
  const g = GRAVITY * gravScale(S.activeAmmo);
  let x = P0X;
  let y = P0Y;
  let vx = Math.cos(S.aimAngle) * s;
  let vy = Math.sin(S.aimAngle) * s;
  const dt = 1 / 60;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 170; i++) {
    vy += g * dt;
    x += vx * dt;
    y += vy * dt;
    if (y + def.r >= GROUND_Y || x > W + 20 || x < -20 || y < -60) break;
    let hit = false;
    for (const b of S.blocks) {
      if (!b.alive) continue;
      const r = blockRect(b);
      if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) {
        hit = true;
        break;
      }
    }
    if (hit) break;
    if (i % 5 === 0) pts.push({ x, y });
    if (pts.length >= 24) break;
  }
  void e;
  return pts;
}

function drawAim(): void {
  for (const p of previewPath()) {
    ctx.fillStyle = COL.traj;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  const len = 26 + S.power * 26;
  ctx.strokeStyle = 'rgba(245,246,248,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(P0X, P0Y);
  ctx.lineTo(P0X + Math.cos(S.aimAngle) * len, P0Y + Math.sin(S.aimAngle) * len);
  ctx.stroke();

  const gx = 16;
  const gh = 96;
  const gy = GROUND_Y - 12 - gh;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(gx, gy, 8, gh);
  const ph = gh * S.power;
  const grad = ctx.createLinearGradient(0, gy + gh, 0, gy);
  grad.addColorStop(0, '#34d399');
  grad.addColorStop(0.6, '#f4b942');
  grad.addColorStop(1, '#ef4444');
  ctx.fillStyle = grad;
  ctx.fillRect(gx, gy + gh - ph, 8, ph);

  const def = AMMO[S.activeAmmo];
  drawProjectile({ x: P0X, y: P0Y, r: def.r, ammo: S.activeAmmo, rot: 0 });

  ctx.fillStyle = 'rgba(245,246,248,0.8)';
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(`Açı ${Math.round(-S.aimAngle * (180 / Math.PI))}°`, gx + 16, gy + 12);
}

function drawCanvasHud(): void {
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(245,246,248,0.9)';
  ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(`${ENGINES[S.engineId].name}`, W - 14, 12);
  ctx.fillStyle = '#f3b0b0';
  ctx.fillText(`Sancak: ${S.targetsLeft}`, W - 14, 30);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

export function draw(): void {
  if (!ctx) return;
  const th = theme();
  ctx.clearRect(0, 0, W, H);
  drawSky(th);
  drawGround(th);

  ctx.save();
  ctx.translate(S.shakeX, S.shakeY);
  drawEngine(ctx, S.engineId);
  for (const b of S.blocks) if (b.alive) drawBlock(b);
  for (const p of S.projectiles) if (p.active) drawProjectile(p);
  drawParticles(ctx);
  const playing = S.state === 'aiming' || S.state === 'intro' || S.state === 'prelevel';
  if (playing) drawAim();
  drawPopups(ctx);
  ctx.restore();

  drawCanvasHud();
}

export { clamp };
