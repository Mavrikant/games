// Juice: debris particles, score popups, screen shake. Respects reduced-motion.

import { S } from './state';
import { MAX_PARTICLES, MAX_POPUPS, clamp } from './constants';

export function spawnDebris(
  x: number,
  y: number,
  color: string,
  n: number,
  spread = 150,
): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = Math.random() * spread;
    S.particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 50,
      life: 0.45 + Math.random() * 0.5,
      max: 0.95,
      color,
      size: 2 + Math.random() * 3.5,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 12,
      grav: 620,
    });
  }
  if (S.particles.length > MAX_PARTICLES) {
    S.particles.splice(0, S.particles.length - MAX_PARTICLES);
  }
}

export function spawnSparks(x: number, y: number, color: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 60 + Math.random() * 180;
    S.particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.25 + Math.random() * 0.3,
      max: 0.55,
      color,
      size: 1.5 + Math.random() * 2,
      rot: 0,
      spin: 0,
      grav: 120,
    });
  }
  if (S.particles.length > MAX_PARTICLES) {
    S.particles.splice(0, S.particles.length - MAX_PARTICLES);
  }
}

export function addPopup(x: number, y: number, text: string, color: string, size = 16): void {
  S.popups.push({ x, y, life: 1.1, max: 1.1, text, color, size });
  if (S.popups.length > MAX_POPUPS) S.popups.splice(0, S.popups.length - MAX_POPUPS);
}

export function addShake(mag: number): void {
  if (S.profile.settings.reducedMotion) return;
  S.shake = Math.min(16, S.shake + mag);
}

export function updateFx(dt: number): void {
  for (let i = S.particles.length - 1; i >= 0; i--) {
    const p = S.particles[i]!;
    p.life -= dt;
    if (p.life <= 0) {
      S.particles.splice(i, 1);
      continue;
    }
    p.vy += p.grav * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.spin * dt;
  }
  for (let i = S.popups.length - 1; i >= 0; i--) {
    const p = S.popups[i]!;
    p.life -= dt;
    if (p.life <= 0) {
      S.popups.splice(i, 1);
      continue;
    }
    p.y -= 26 * dt;
  }
  if (S.shake > 0.05) {
    S.shakeX = (Math.random() * 2 - 1) * S.shake;
    S.shakeY = (Math.random() * 2 - 1) * S.shake;
    S.shake *= Math.pow(0.0025, dt); // fast decay, frame-rate independent
  } else {
    S.shake = 0;
    S.shakeX = 0;
    S.shakeY = 0;
  }
}

export function drawParticles(ctx: CanvasRenderingContext2D): void {
  for (const p of S.particles) {
    const a = clamp(p.life / p.max, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    if (p.size > 3) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    } else {
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;
}

export function drawPopups(ctx: CanvasRenderingContext2D): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of S.popups) {
    const a = clamp(p.life / p.max, 0, 1);
    ctx.globalAlpha = a;
    ctx.font = `800 ${p.size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(p.text, p.x, p.y);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
