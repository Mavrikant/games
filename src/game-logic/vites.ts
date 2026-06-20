import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'vites.best';
const W = 480;
const H = 380;

const RUN_MS = 60_000;
const REDLINE = 7000;
const REDLINE_KILL_MS = 2000;
const IDLE_RPM = 900;
const MAX_SPEED = 240;

type Gear = 0 | 1 | 2 | 3 | 4 | 5;

interface GearSpec {
  readonly maxSpeed: number;
  readonly ratio: number;
  readonly accel: number;
}

const GEARS: Record<Exclude<Gear, 0>, GearSpec> = {
  1: { maxSpeed: 28, ratio: 7000 / 28, accel: 36 },
  2: { maxSpeed: 58, ratio: 7000 / 58, accel: 32 },
  3: { maxSpeed: 98, ratio: 7000 / 98, accel: 26 },
  4: { maxSpeed: 150, ratio: 7000 / 150, accel: 20 },
  5: { maxSpeed: 220, ratio: 7000 / 220, accel: 15 },
};

type State = 'ready' | 'playing' | 'gameover';

const gen = createGenToken();

let state: State = 'ready';
let gear: Gear = 0;
let rpm = 0;
let speed = 0;
let distance = 0;
let timeMs = RUN_MS;
let best = 0;

let throttle = false;
let brake = false;
let redlineMs = 0;
let flashMsg = '';
let flashUntilMs = 0;
let lastFrameMs = 0;
let rafId = 0;
let roadOffset = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let timeEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let gearReadout!: HTMLElement;
let btnGas!: HTMLButtonElement;
let btnBrake!: HTMLButtonElement;
let btnUp!: HTMLButtonElement;
let btnDown!: HTMLButtonElement;

function formatMeters(m: number): string {
  return `${Math.round(m)} m`;
}

function flash(msg: string): void {
  flashMsg = msg;
  flashUntilMs = 1400;
}

function trySetGear(next: Gear): void {
  if (state !== 'playing') return;
  if (next === gear) return;

  if (next === 0) {
    gear = 0;
    rpm = Math.max(rpm, IDLE_RPM);
    flash('Boş vites');
    return;
  }

  const spec = GEARS[next];
  const projectedRPM = speed * spec.ratio;

  if (projectedRPM > REDLINE + 500) {
    flash(`${next}. vites — devir çok yüksek!`);
    return;
  }

  gear = next;
  rpm = Math.max(IDLE_RPM, projectedRPM);
  if (projectedRPM < 1500 && speed > 3) {
    flash(`${next}. vitese erken — motor zorlanıyor`);
  } else {
    flash(`${next}. vites`);
  }
}

function shiftDelta(d: -1 | 1): void {
  const next = Math.max(0, Math.min(5, gear + d)) as Gear;
  if (next !== gear) trySetGear(next);
}

function step(dt: number): void {
  if (state !== 'playing') return;

  timeMs -= dt * 1000;
  if (timeMs <= 0) {
    timeMs = 0;
    endGame('time');
    return;
  }

  if (gear === 0) {
    if (throttle) rpm = Math.min(REDLINE + 800, rpm + 5200 * dt);
    else rpm = Math.max(0, rpm - 2800 * dt);
    speed = Math.max(0, speed - 6 * dt);
    if (brake) speed = Math.max(0, speed - 50 * dt);
  } else {
    const spec = GEARS[gear];

    // Engine torque curve: bell around 5000 rpm.
    let torque = 0;
    if (rpm >= 1500 && rpm <= REDLINE + 200) {
      const x = (rpm - 5000) / 3500;
      torque = Math.max(0, 1 - x * x);
    }
    if (rpm > REDLINE) torque *= 0.4;

    if (throttle) {
      // Launch boost: in 1st gear at very low speed, clutch slips and engine
      // can rev independently — model that with a flat launch impulse so the
      // car can move from a dead stop.
      if (gear === 1 && speed < 10) {
        speed += 14 * dt;
      }
      speed += spec.accel * torque * dt;
    }
    if (brake) {
      speed = Math.max(0, speed - 90 * dt);
    }
    // Aerodynamic + rolling drag. Tuned so each gear's wide-open equilibrium
    // sits in the yellow zone (~5800 rpm) — sitting at the cap means the
    // rev limiter is the only thing holding the engine together.
    const drag = 0.006 * speed + 0.0004 * speed * speed;
    speed = Math.max(0, speed - drag * dt);

    // Mechanical rev cap: speed can briefly exceed maxSpeed by a hair,
    // putting rpm into redline. Holding it there for 2 seconds blows the
    // engine — but only if you forget to shift, since the equilibrium
    // speed in each gear sits well below the cap.
    const cap = spec.maxSpeed * 1.02;
    if (speed > cap) speed = cap;

    // RPM is coupled to wheel speed, but engine idles at IDLE_RPM minimum.
    rpm = Math.max(IDLE_RPM, speed * spec.ratio);
  }

  rpm = Math.max(0, Math.min(REDLINE + 800, rpm));
  speed = Math.max(0, Math.min(MAX_SPEED, speed));

  if (rpm >= REDLINE) {
    redlineMs += dt * 1000;
    if (redlineMs >= REDLINE_KILL_MS) {
      endGame('blown');
      return;
    }
  } else {
    redlineMs = Math.max(0, redlineMs - dt * 600);
  }

  distance += (speed / 3.6) * dt;
  roadOffset = (roadOffset + speed * dt * 4) % 40;

  if (flashUntilMs > 0) {
    flashUntilMs -= dt * 1000;
    if (flashUntilMs <= 0) flashMsg = '';
  }
}

function draw(): void {
  ctx.fillStyle = '#0a0b0e';
  ctx.fillRect(0, 0, W, H);

  drawRoad();
  drawTacho(240, 145, 100);
  drawSpeed(240, 200);
  drawGearStrip(40, 270, 400, 28);
  drawRpmBar(40, 332, 400, 18);
  drawHud();
  if (flashMsg) drawFlash();
}

function drawRoad(): void {
  const horizonY = 12;
  const baseY = 60;
  ctx.fillStyle = '#11131a';
  ctx.fillRect(0, 0, W, baseY);
  ctx.strokeStyle = 'rgba(249, 210, 76, 0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([14, 12]);
  ctx.lineDashOffset = -roadOffset;
  ctx.beginPath();
  ctx.moveTo(W / 2, horizonY);
  ctx.lineTo(W / 2, baseY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W * 0.32, horizonY);
  ctx.lineTo(W * 0.05, baseY);
  ctx.moveTo(W * 0.68, horizonY);
  ctx.lineTo(W * 0.95, baseY);
  ctx.stroke();
  const g = ctx.createLinearGradient(0, 0, 0, baseY);
  g.addColorStop(0, 'rgba(249, 210, 76, 0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, baseY);
}

function drawTacho(cx: number, cy: number, r: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  const startA = Math.PI * (200 / 180);
  const endA = Math.PI * (340 / 180);
  const totalA = endA - startA;

  const zones: Array<{ from: number; to: number; color: string }> = [
    { from: 0, to: 1500, color: 'rgba(120,140,170,0.6)' },
    { from: 1500, to: 5000, color: 'rgba(116, 200, 130, 0.85)' },
    { from: 5000, to: 6500, color: 'rgba(249, 210, 76, 0.85)' },
    { from: 6500, to: REDLINE, color: 'rgba(255, 160, 80, 0.85)' },
    { from: REDLINE, to: 8000, color: 'rgba(232, 90, 90, 0.95)' },
  ];
  for (const z of zones) {
    const a1 = startA + (z.from / 8000) * totalA;
    const a2 = startA + (z.to / 8000) * totalA;
    ctx.strokeStyle = z.color;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 14, a1, a2);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.5;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 8; i++) {
    const a = startA + (i / 8) * totalA;
    const x1 = cx + Math.cos(a) * (r - 4);
    const y1 = cy + Math.sin(a) * (r - 4);
    const x2 = cx + Math.cos(a) * (r - (i % 2 === 0 ? 24 : 18));
    const y2 = cy + Math.sin(a) * (r - (i % 2 === 0 ? 24 : 18));
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (i % 2 === 0) {
      const lx = cx + Math.cos(a) * (r - 36);
      const ly = cy + Math.sin(a) * (r - 36);
      ctx.fillText(String(i), lx, ly);
    }
  }

  const rpmA = startA + (Math.min(8000, Math.max(0, rpm)) / 8000) * totalA;
  ctx.strokeStyle = '#ff4d4d';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(rpmA) * (r - 18), cy + Math.sin(rpmA) * (r - 18));
  ctx.stroke();

  ctx.fillStyle = '#1b1d24';
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();

}

function drawSpeed(cx: number, baseY: number): void {
  const txt = String(Math.round(speed));
  ctx.fillStyle = '#f9d24c';
  ctx.font = '700 44px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(txt, cx, baseY);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.fillText('km/h', cx, baseY + 14);
}

function drawRpmBar(x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = '#11131a';
  ctx.fillRect(x, y, w, h);

  const sections: Array<[number, string]> = [
    [1500, '#1d2a1d'],
    [5000, '#2a4a30'],
    [6500, '#4a4220'],
    [REDLINE, '#5a3a20'],
    [8000, '#5a2020'],
  ];
  let lastEnd = 0;
  for (const [end, color] of sections) {
    const x1 = x + (lastEnd / 8000) * w;
    const x2 = x + (end / 8000) * w;
    ctx.fillStyle = color;
    ctx.fillRect(x1, y, x2 - x1, h);
    lastEnd = end;
  }

  const rpmFrac = Math.max(0, Math.min(1, rpm / 8000));
  let fillColor = '#74c882';
  if (rpm >= REDLINE) fillColor = '#e85a5a';
  else if (rpm >= 6500) fillColor = '#ffa050';
  else if (rpm >= 5000) fillColor = '#f9d24c';
  ctx.fillStyle = fillColor;
  ctx.fillRect(x, y, w * rpmFrac, h);

  const redX = x + (REDLINE / 8000) * w;
  ctx.strokeStyle = '#ff3030';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(redX, y - 3);
  ctx.lineTo(redX, y + h + 3);
  ctx.stroke();

  const optX = x + (5500 / 8000) * w;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(optX, y - 5);
  ctx.lineTo(optX, y + h + 5);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('DEVİR', x, y + h + 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(rpm)}`, x + w, y + h + 4);
}

function drawGearStrip(x: number, y: number, w: number, h: number): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const slots = ['N', '1', '2', '3', '4', '5'];
  const slotW = w / slots.length;
  for (let i = 0; i < slots.length; i++) {
    const sx = x + i * slotW + 2;
    const sy = y;
    const sw = slotW - 4;
    const active = i === gear;
    ctx.fillStyle = active ? '#f9d24c' : '#11131a';
    ctx.fillRect(sx, sy, sw, h);
    ctx.strokeStyle = active ? '#f9d24c' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, h - 1);
    ctx.fillStyle = active ? '#0a0b0e' : 'rgba(255,255,255,0.7)';
    ctx.font = `${active ? '700 ' : ''}16px system-ui, -apple-system, sans-serif`;
    ctx.fillText(slots[i]!, sx + sw / 2, sy + h / 2 + 1);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('VİTES (0-5 veya Q/E)', x, y - 14);
}

function drawHud(): void {
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Mesafe: ${Math.round(distance)} m`, 12, 76);
  ctx.fillText(`Süre: ${(timeMs / 1000).toFixed(1)} s`, 12, 92);

  if (rpm >= REDLINE && state === 'playing') {
    const frac = Math.min(1, redlineMs / REDLINE_KILL_MS);
    ctx.fillStyle = `rgba(232, 90, 90, ${0.6 + 0.4 * Math.sin(Date.now() / 80)})`;
    ctx.font = '700 14px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('⚠ REDLINE', W - 12, 76);
    ctx.fillStyle = '#e85a5a';
    ctx.fillRect(W - 92, 96, 80 * frac, 4);
    ctx.strokeStyle = 'rgba(232,90,90,0.5)';
    ctx.strokeRect(W - 92 + 0.5, 96 + 0.5, 80 - 1, 4 - 1);
  } else if (gear > 0 && rpm < 1500 && throttle) {
    ctx.fillStyle = 'rgba(255, 200, 80, 0.85)';
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('motor zorlanıyor', W - 12, 76);
  }
}

function drawFlash(): void {
  const alpha = Math.min(1, flashUntilMs / 600);
  ctx.fillStyle = `rgba(249, 210, 76, ${0.95 * alpha})`;
  ctx.font = '700 14px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(flashMsg, W / 2, 78);
}

function loop(ts: number): void {
  rafId = 0;
  if (state !== 'playing') return;
  const myGen = gen.current();
  if (lastFrameMs === 0) lastFrameMs = ts;
  const dt = Math.min(0.05, (ts - lastFrameMs) / 1000);
  lastFrameMs = ts;

  step(dt);
  syncHud();
  draw();

  if (gen.isCurrent(myGen) && state === 'playing') {
    rafId = requestAnimationFrame(loop);
  }
}

function syncHud(): void {
  scoreEl.textContent = formatMeters(distance);
  timeEl.textContent = (timeMs / 1000).toFixed(1);
  gearReadout.textContent = gear === 0 ? 'N' : String(gear);
}

function endGame(reason: 'time' | 'blown'): void {
  if (distance > best) {
    best = Math.floor(distance);
    safeWrite(STORAGE_BEST, best);
  }
  bestEl.textContent = formatMeters(best);
  state = 'gameover';
  throttle = false;
  brake = false;
  syncPedalActiveStates();
  gen.bump();

  if (reason === 'blown') {
    overlayTitle.textContent = 'Motor patladı';
    overlayMsg.textContent =
      `Devir redline'da çok kaldı.\nMesafe: ${Math.round(distance)} m  ·  Rekor: ${best} m`;
  } else {
    overlayTitle.textContent = 'Süre bitti';
    overlayMsg.textContent =
      `Mesafe: ${Math.round(distance)} m  ·  Rekor: ${best} m\n` +
      `Daha iyi: 5500 devirde vites at, redline'a değme.`;
  }
  overlayBtn.textContent = 'Tekrar oyna';
  showOverlay(overlay);
  draw();
}

function startGame(): void {
  gen.bump();
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  gear = 0;
  rpm = 0;
  speed = 0;
  distance = 0;
  timeMs = RUN_MS;
  throttle = false;
  brake = false;
  redlineMs = 0;
  flashMsg = '';
  flashUntilMs = 0;
  lastFrameMs = 0;
  roadOffset = 0;
  state = 'playing';
  syncHud();
  syncPedalActiveStates();
  hideOverlay(overlay);
  draw();
  rafId = requestAnimationFrame(loop);
}

function reset(): void {
  startGame();
}

function syncPedalActiveStates(): void {
  btnGas.dataset.active = throttle ? 'true' : 'false';
  btnBrake.dataset.active = brake ? 'true' : 'false';
}

function bindPedal(
  el: HTMLButtonElement,
  onDown: () => void,
  onUp: () => void,
): void {
  const down = (e: Event): void => {
    e.preventDefault();
    onDown();
  };
  const up = (e: Event): void => {
    e.preventDefault();
    onUp();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  gearReadout = document.querySelector<HTMLElement>('#gear-readout')!;
  btnGas = document.querySelector<HTMLButtonElement>('#btn-gas')!;
  btnBrake = document.querySelector<HTMLButtonElement>('#btn-brake')!;
  btnUp = document.querySelector<HTMLButtonElement>('#btn-up')!;
  btnDown = document.querySelector<HTMLButtonElement>('#btn-down')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = formatMeters(best);
  scoreEl.textContent = '0 m';
  timeEl.textContent = (RUN_MS / 1000).toFixed(1);

  restartBtn.addEventListener('click', () => startGame());
  overlayBtn.addEventListener('click', () => startGame());

  bindPedal(
    btnGas,
    () => {
      throttle = true;
      syncPedalActiveStates();
    },
    () => {
      throttle = false;
      syncPedalActiveStates();
    },
  );
  bindPedal(
    btnBrake,
    () => {
      brake = true;
      syncPedalActiveStates();
    },
    () => {
      brake = false;
      syncPedalActiveStates();
    },
  );
  btnUp.addEventListener('click', (e) => {
    e.preventDefault();
    shiftDelta(1);
  });
  btnDown.addEventListener('click', (e) => {
    e.preventDefault();
    shiftDelta(-1);
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      startGame();
      e.preventDefault();
      return;
    }
    if (k === ' ' || k === 'enter') {
      if (state !== 'playing') {
        startGame();
        e.preventDefault();
      }
      return;
    }
    if (state !== 'playing') return;
    if (k === 'w' || k === 'arrowup') {
      if (!throttle) {
        throttle = true;
        syncPedalActiveStates();
      }
      e.preventDefault();
    } else if (k === 's' || k === 'arrowdown') {
      if (!brake) {
        brake = true;
        syncPedalActiveStates();
      }
      e.preventDefault();
    } else if (k === 'e' || k === '+' || k === '=') {
      shiftDelta(1);
      e.preventDefault();
    } else if (k === 'q' || k === '-' || k === '_') {
      shiftDelta(-1);
      e.preventDefault();
    } else if (k >= '0' && k <= '5') {
      trySetGear(Number(k) as Gear);
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'arrowup') {
      throttle = false;
      syncPedalActiveStates();
      e.preventDefault();
    } else if (k === 's' || k === 'arrowdown') {
      brake = false;
      syncPedalActiveStates();
      e.preventDefault();
    }
  });

  state = 'ready';
  overlayTitle.textContent = 'Vites';
  overlayMsg.textContent =
    'Manuel vites. 0 — boş; 1-5 — vites. Gaza basıp birinciye geç (1 tuşu ' +
    'veya + düğmesi), devir yeşil banda girince yukarı vites at. ' +
    'Sarı sınır 5500 devir — ideal değişim noktası. Kırmızıya 2 saniye ' +
    'kalırsan motor patlar. 60 saniyede en uzak yolu kat.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
  draw();
}

export const game = defineGame({ init, reset });
