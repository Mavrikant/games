// Canvas starfield behind the DOM UI. RAF guarded by the shared gen token; paused
// when the tab is hidden. The current planet's gradient + a brightness factor
// produce the gradual brightening toward Earth.

import { PLANETS } from './data';
import { gen, S } from './state';

interface Star {
  x: number;
  y: number;
  r: number;
  base: number;
  phase: number;
  pale: boolean;
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let stars: Star[] = [];
let running = false;
let t0 = 0;
let cssW = 0;
let cssH = 0;

function resize(): void {
  if (!canvas || !ctx) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cssW = Math.max(1, rect.width);
  cssH = Math.max(1, rect.height);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function seedStars(): void {
  const n = Math.round(Math.min(160, Math.max(60, (cssW * cssH) / 2600)));
  stars = Array.from({ length: n }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: 0.5 + Math.random() * 1.4,
    base: 0.25 + Math.random() * 0.6,
    phase: Math.random() * Math.PI * 2,
    pale: Math.random() < 0.35,
  }));
}

function frame(ts: number, myGen: number): void {
  if (!ctx || !canvas) return;
  if (!gen.isCurrent(myGen) || !running) return;
  const planet = PLANETS[Math.min(S.planetIndex, PLANETS.length - 1)]!;
  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, planet.gradTop);
  grad.addColorStop(1, planet.gradBot);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cssW, cssH);

  // Stars fade out as we approach the bright Earth scene.
  const starVis = 1 - planet.brightness * 0.92;
  if (starVis > 0.02) {
    const time = (ts - t0) / 1000;
    for (const s of stars) {
      const tw = 0.55 + 0.45 * Math.sin(time * 1.6 + s.phase);
      ctx.globalAlpha = Math.min(1, s.base * tw * starVis);
      ctx.fillStyle = s.pale ? '#FFF59D' : '#FFFFFF';
      ctx.beginPath();
      ctx.arc(s.x * cssW, s.y * cssH, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame((next) => frame(next, myGen));
}

export function initStarfield(el: HTMLCanvasElement): void {
  canvas = el;
  ctx = el.getContext('2d');
  resize();
  seedStars();
  window.addEventListener('resize', () => {
    resize();
    seedStars();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) running = false;
    else resumeStarfield();
  });
  resumeStarfield();
}

export function resumeStarfield(): void {
  if (running || !ctx) return;
  running = true;
  t0 = performance.now();
  const myGen = gen.current();
  requestAnimationFrame((ts) => frame(ts, myGen));
}

// Called after gen.bump() in reset() to relaunch the loop under the new token.
export function restartStarfield(): void {
  running = false;
  resumeStarfield();
}
