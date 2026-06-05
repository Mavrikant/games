// Siege engines — each constrains launch speed/angle and draws distinctly.

import type { EngineDef, EngineId } from './types';
import { COL, GROUND_Y, P0X, P0Y } from './constants';

export const ENGINES: Record<EngineId, EngineDef> = {
  mancinik: {
    id: 'mancinik',
    name: 'Mancınık',
    desc: 'Dengeli; her işe gelir.',
    speedMin: 300,
    speedMax: 820,
    angleMin: -1.45,
    angleMax: -0.08,
    aimStep: 0.025,
    unlockWorld: 0,
  },
  mangonel: {
    id: 'mangonel',
    name: 'Mangonel',
    desc: 'Dik atış; yüksek surları aşar.',
    speedMin: 300,
    speedMax: 760,
    angleMin: -1.5,
    angleMax: -0.62,
    aimStep: 0.024,
    unlockWorld: 1,
  },
  trebuse: {
    id: 'trebuse',
    name: 'Trebüşe',
    desc: 'Ağır ve güçlü; uzun menzil.',
    speedMin: 380,
    speedMax: 1000,
    angleMin: -1.35,
    angleMax: -0.2,
    aimStep: 0.02,
    unlockWorld: 2,
  },
  balista: {
    id: 'balista',
    name: 'Balista',
    desc: 'Düz ve hızlı; sıra sıra deler.',
    speedMin: 540,
    speedMax: 1040,
    angleMin: -0.62,
    angleMax: -0.04,
    aimStep: 0.018,
    unlockWorld: 3,
  },
  bombard: {
    id: 'bombard',
    name: 'Bombard',
    desc: 'Orta-düz; patlayıcıya yatkın.',
    speedMin: 460,
    speedMax: 900,
    angleMin: -0.95,
    angleMax: -0.06,
    aimStep: 0.02,
    unlockWorld: 4,
  },
};

export const ENGINE_ORDER: EngineId[] = [
  'mancinik',
  'mangonel',
  'trebuse',
  'balista',
  'bombard',
];

export function getEngine(id: EngineId): EngineDef {
  return ENGINES[id];
}

export function drawEngine(ctx: CanvasRenderingContext2D, id: EngineId): void {
  ctx.save();
  // shared base + wheels
  ctx.fillStyle = COL.frameDark;
  ctx.fillRect(P0X - 34, GROUND_Y - 16, 70, 12);
  for (const wx of [P0X - 20, P0X + 18]) {
    ctx.fillStyle = COL.frameDark;
    ctx.beginPath();
    ctx.arc(wx, GROUND_Y - 4, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1c130a';
    ctx.beginPath();
    ctx.arc(wx, GROUND_Y - 4, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  if (id === 'balista') {
    // horizontal bow + rail
    ctx.strokeStyle = COL.frame;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(P0X - 18, P0Y);
    ctx.lineTo(P0X + 26, P0Y);
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(P0X - 6, P0Y - 16);
    ctx.quadraticCurveTo(P0X + 12, P0Y, P0X - 6, P0Y + 16);
    ctx.stroke();
  } else if (id === 'bombard') {
    // cannon barrel
    ctx.fillStyle = COL.frame;
    ctx.fillRect(P0X - 8, GROUND_Y - 24, 16, 16);
    ctx.fillStyle = '#2a2a2e';
    ctx.save();
    ctx.translate(P0X, P0Y + 6);
    ctx.rotate(-0.5);
    ctx.fillRect(-6, -10, 34, 18);
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(26, -1, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    // catapult / mangonel / trebuchet: frame + throwing arm
    const tall = id === 'trebuse' ? 50 : id === 'mangonel' ? 44 : 40;
    ctx.fillStyle = COL.frame;
    ctx.fillRect(P0X - 30, GROUND_Y - tall, 8, tall - 10);
    ctx.fillRect(P0X + 14, GROUND_Y - tall, 8, tall - 10);
    ctx.strokeStyle = COL.frame;
    ctx.lineWidth = id === 'trebuse' ? 8 : 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(P0X + 24, GROUND_Y - tall + 6);
    ctx.lineTo(P0X - 4, P0Y + 4);
    ctx.stroke();
    ctx.fillStyle = COL.frameDark;
    ctx.beginPath();
    ctx.arc(P0X + 27, GROUND_Y - tall + 6, id === 'trebuse' ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
