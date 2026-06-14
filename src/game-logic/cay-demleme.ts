// Çay Demleme — pour at the right temperature, serve at the right steep time.
// Single kettle, three live cup orders. Heat carries between cups so the player
// must schedule hot teas before cool ones (or wait out cooling).
//
// PITFALLS guarded:
// - module-level-dom-access: all DOM lookups in init().
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() cancels the in-flight RAF loop on reset.
// - overlay-input-leak: state enum gates every input handler.
// - missing-overlay-css: per-game CSS defines `.overlay--hidden`.
// - hud-counter-synced-only-at-lifecycle-edges: HUD updated every tick.

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'cay-demleme.best';
const ROUND_DURATION = 60;
const ROOM_TEMP = 20;
const MAX_TEMP = 100;
const HEAT_RATE = 4;
const COOL_RATE = 1.6;
const SLOTS = 3;

type State = 'ready' | 'playing' | 'gameover';
type CupState = 'idle' | 'steeping';

interface TeaType {
  name: string;
  targetTemp: number;
  targetSteep: number;
  color: string;
}

const TEAS: TeaType[] = [
  { name: 'Yeşil', targetTemp: 70, targetSteep: 3.0, color: '#86efac' },
  { name: 'Beyaz', targetTemp: 80, targetSteep: 2.5, color: '#e5e7eb' },
  { name: 'Earl Grey', targetTemp: 85, targetSteep: 4.0, color: '#a78bfa' },
  { name: 'Demli Siyah', targetTemp: 95, targetSteep: 5.0, color: '#b45309' },
  { name: 'Oolong', targetTemp: 90, targetSteep: 3.5, color: '#fb923c' },
  { name: 'Papatya', targetTemp: 100, targetSteep: 4.5, color: '#fde047' },
];

interface Cup {
  tea: TeaType;
  state: CupState;
  pourTemp: number;
  steepElapsed: number;
  flash: number;
  flashColor: string;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timerEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

const gen = createGenToken();

let state: State = 'ready';
let temp = ROOM_TEMP;
let heating = false;
let timeLeft = ROUND_DURATION;
let score = 0;
let best = 0;
let cups: Cup[] = [];
let cupsServed = 0;
let lastResult: { text: string; color: string; t: number } | null = null;

function pickTea(): TeaType {
  return TEAS[Math.floor(Math.random() * TEAS.length)]!;
}

function newCup(): Cup {
  return {
    tea: pickTea(),
    state: 'idle',
    pourTemp: 0,
    steepElapsed: 0,
    flash: 0,
    flashColor: '#34d399',
  };
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(Math.max(best, score));
  timerEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
}

function showStartOverlay(): void {
  overlayTitle.textContent = 'Çay Demleme';
  overlayMsg.textContent =
    'Suyu hedef sıcaklığa getir, kupayı seç → dök, doğru süreyi bekleyip yine bas → serv et.\n' +
    'Boşluk: ocak · 1/2/3: kupa · 60 saniyede maksimum puan.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function showEndOverlay(): void {
  overlayTitle.textContent = 'Vardiya bitti';
  overlayMsg.textContent =
    `Skor: ${score}\nServ edilen: ${cupsServed} kupa\nRekor: ${best}`;
  overlayBtn.textContent = 'Tekrar başla';
  showOverlay(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  temp = ROOM_TEMP;
  heating = false;
  timeLeft = ROUND_DURATION;
  score = 0;
  cupsServed = 0;
  lastResult = null;
  cups = [];
  for (let i = 0; i < SLOTS; i++) cups.push(newCup());
  updateHud();
  showStartOverlay();
  startLoop();
}

function startGame(): void {
  state = 'playing';
  hideOverlay(overlay);
}

function endGame(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  showEndOverlay();
}

function scoreCup(c: Cup): { pourPts: number; steepPts: number; total: number } {
  const tempDiff = Math.abs(c.pourTemp - c.tea.targetTemp);
  const timeDiff = Math.abs(c.steepElapsed - c.tea.targetSteep);
  const pourPts = Math.max(0, Math.round(50 - 5 * tempDiff));
  const steepPts = Math.max(0, Math.round(50 - 28 * timeDiff));
  return { pourPts, steepPts, total: pourPts + steepPts };
}

function selectCup(idx: number): void {
  if (state !== 'playing') return;
  const c = cups[idx];
  if (!c) return;
  if (c.state === 'idle') {
    c.pourTemp = Math.round(temp);
    c.state = 'steeping';
    c.steepElapsed = 0;
  } else {
    const { pourPts, steepPts, total } = scoreCup(c);
    score += total;
    cupsServed++;
    const color =
      total >= 80 ? '#34d399' : total >= 50 ? '#fbbf24' : '#f87171';
    lastResult = {
      text: `+${total}  (dök ${pourPts} · süre ${steepPts})`,
      color,
      t: 1.4,
    };
    const fresh = newCup();
    fresh.flash = 1;
    fresh.flashColor = color;
    cups[idx] = fresh;
    updateHud();
  }
}

function tick(dtMs: number): void {
  if (state !== 'playing') return;
  const dt = dtMs / 1000;

  if (heating) {
    temp = Math.min(MAX_TEMP, temp + HEAT_RATE * dt);
  } else if (temp > ROOM_TEMP) {
    temp = Math.max(ROOM_TEMP, temp - COOL_RATE * dt);
  }

  for (const c of cups) {
    if (c.state === 'steeping') c.steepElapsed += dt;
    if (c.flash > 0) {
      c.flash -= dt / 0.7;
      if (c.flash < 0) c.flash = 0;
    }
  }

  if (lastResult) {
    lastResult.t -= dt;
    if (lastResult.t <= 0) lastResult = null;
  }

  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    updateHud();
    endGame();
    return;
  }
  updateHud();
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  const val = v || fallback;
  cssCache.set(name, val);
  return val;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function tempColor(t: number): string {
  if (t <= 60) {
    const u = Math.max(0, (t - ROOM_TEMP) / (60 - ROOM_TEMP));
    const r = Math.round(lerp(96, 251, u));
    const g = Math.round(lerp(165, 191, u));
    const b = Math.round(lerp(250, 36, u));
    return `rgb(${r},${g},${b})`;
  }
  const u = Math.min(1, (t - 60) / 40);
  const r = Math.round(lerp(251, 248, u));
  const g = Math.round(lerp(191, 113, u));
  const b = Math.round(lerp(36, 113, u));
  return `rgb(${r},${g},${b})`;
}

function drawKettleArea(): void {
  const muted = getCss('--text-muted', '#8a93b0');
  const border = getCss('--border', '#23283b');

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillStyle = muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('OCAK & ÇAYDANLIK', 24, 26);

  const kx = 130;
  const ky = 140;
  const kw = 120;
  const kh = 90;

  ctx.fillStyle = '#0e1118';
  ctx.beginPath();
  ctx.ellipse(kx, ky + kh + 22, kw / 2 + 10, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  if (heating) {
    const intensity = 0.65 + 0.35 * Math.sin(performance.now() / 90);
    const fgrad = ctx.createRadialGradient(
      kx, ky + kh + 22, 4,
      kx, ky + kh + 22, 60,
    );
    fgrad.addColorStop(0, `rgba(253,224,71,${intensity})`);
    fgrad.addColorStop(0.45, `rgba(251,146,60,${intensity * 0.6})`);
    fgrad.addColorStop(1, 'rgba(248,113,113,0)');
    ctx.fillStyle = fgrad;
    ctx.beginPath();
    ctx.ellipse(kx, ky + kh + 22, kw / 2 + 6, 30, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#2a2f3d';
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(kx - kw / 2, ky, kw, kh, [12, 12, 24, 24]);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = tempColor(temp);
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.roundRect(kx - kw / 2 + 8, ky + 20, kw - 16, kh - 28, [6, 6, 18, 18]);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.moveTo(kx - kw / 2, ky + 28);
  ctx.lineTo(kx - kw / 2 - 18, ky + 16);
  ctx.lineTo(kx - kw / 2 - 18, ky + 28);
  ctx.lineTo(kx - kw / 2, ky + 40);
  ctx.closePath();
  ctx.fillStyle = '#2a2f3d';
  ctx.fill();
  ctx.stroke();

  ctx.lineWidth = 4;
  ctx.strokeStyle = '#1f2330';
  ctx.beginPath();
  ctx.moveTo(kx + kw / 2 - 6, ky + 8);
  ctx.quadraticCurveTo(
    kx + kw / 2 + 24, ky + kh / 2 - 4,
    kx + kw / 2 - 6, ky + kh - 16,
  );
  ctx.stroke();

  ctx.fillStyle = '#1f2330';
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(kx - 16, ky - 14, 32, 14, 6);
  ctx.fill();
  ctx.stroke();

  if (temp > 65) {
    const steamA = Math.min(1, (temp - 65) / 30);
    ctx.strokeStyle = `rgba(232,237,255,${0.28 * steamA})`;
    ctx.lineWidth = 2;
    const tnow = performance.now() / 1000;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      const sx = kx + (i - 1) * 14;
      const sway = Math.sin(tnow * 2 + i) * 10;
      ctx.moveTo(sx, ky - 14);
      ctx.quadraticCurveTo(sx + sway, ky - 36, sx, ky - 56);
      ctx.stroke();
    }
  }

  const tx = 340;
  const ty = 60;
  const tw = 32;
  const th = 200;
  ctx.fillStyle = '#0f1218';
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(tx, ty, tw, th, 16);
  ctx.fill();
  ctx.stroke();

  const filledH = ((temp - ROOM_TEMP) / (MAX_TEMP - ROOM_TEMP)) * (th - 12);
  const filledY = ty + th - 6 - filledH;
  ctx.fillStyle = tempColor(temp);
  ctx.beginPath();
  ctx.roundRect(tx + 6, filledY, tw - 12, filledH, 6);
  ctx.fill();

  ctx.font = '500 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let v = 20; v <= 100; v += 20) {
    const y = ty + th - 6 - ((v - ROOM_TEMP) / (MAX_TEMP - ROOM_TEMP)) * (th - 12);
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(tx + tw + 4, y);
    ctx.lineTo(tx + tw + 10, y);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(`${v}°`, tx + tw + 14, y);
  }

  for (let i = 0; i < cups.length; i++) {
    const c = cups[i]!;
    if (c.state !== 'idle') continue;
    const y = ty + th - 6 -
      ((c.tea.targetTemp - ROOM_TEMP) / (MAX_TEMP - ROOM_TEMP)) * (th - 12);
    ctx.fillStyle = c.tea.color;
    ctx.beginPath();
    ctx.moveTo(tx - 4, y);
    ctx.lineTo(tx - 14, y - 6);
    ctx.lineTo(tx - 14, y + 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0a0b0e';
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), tx - 9, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 40px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = tempColor(temp);
  ctx.fillText(`${Math.round(temp)}°C`, 240, 58);

  ctx.font = '500 11px system-ui, sans-serif';
  ctx.fillStyle = heating ? '#fb923c' : muted;
  ctx.fillText(heating ? 'OCAK AÇIK • BOŞLUK' : 'BOŞLUK İLE ISIT', 240, 78);
}

const CUP_X = 24;
const CUP_W = 432;
const CUP_TOP = 308;
const CUP_H = 92;
const CUP_GAP = 8;

function cupRect(i: number): { x: number; y: number; w: number; h: number } {
  return { x: CUP_X, y: CUP_TOP + i * (CUP_H + CUP_GAP), w: CUP_W, h: CUP_H };
}

function drawCups(): void {
  const muted = getCss('--text-muted', '#8a93b0');
  const text = getCss('--text', '#e8edff');
  const border = getCss('--border', '#23283b');
  const surface2 = getCss('--surface-2', '#161922');

  ctx.font = '600 11px system-ui, sans-serif';
  ctx.fillStyle = muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('SİPARİŞLER', 24, 298);

  for (let i = 0; i < cups.length; i++) {
    const c = cups[i]!;
    const r = cupRect(i);

    if (c.flash > 0) {
      ctx.fillStyle = c.flashColor;
      ctx.globalAlpha = 0.28 * c.flash;
      ctx.beginPath();
      ctx.roundRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8, 14);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = surface2;
    ctx.strokeStyle = c.state === 'steeping' ? c.tea.color : border;
    ctx.lineWidth = c.state === 'steeping' ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 12);
    ctx.fill();
    ctx.stroke();

    const ix = r.x + 38;
    const iy = r.y + r.h / 2;
    const bw = 40;
    const bh = 36;

    ctx.fillStyle = c.tea.color;
    ctx.globalAlpha = c.state === 'steeping' ? 0.92 : 0.45;
    ctx.beginPath();
    ctx.moveTo(ix - bw / 2, iy - bh / 2);
    ctx.lineTo(ix + bw / 2, iy - bh / 2);
    ctx.lineTo(ix + bw / 2 - 4, iy + bh / 2);
    ctx.lineTo(ix - bw / 2 + 4, iy + bh / 2);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ix + bw / 2 + 4, iy, 8, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();

    if (c.state === 'steeping') {
      const tnow = performance.now() / 1000;
      ctx.strokeStyle = 'rgba(232,237,255,0.35)';
      ctx.lineWidth = 1.5;
      for (let s = 0; s < 2; s++) {
        const sx = ix + (s - 0.5) * 10;
        ctx.beginPath();
        ctx.moveTo(sx, iy - bh / 2 - 2);
        ctx.quadraticCurveTo(
          sx + Math.sin(tnow * 3 + s + i) * 5,
          iy - bh / 2 - 12,
          sx,
          iy - bh / 2 - 22,
        );
        ctx.stroke();
      }
    }

    const tx0 = r.x + 86;

    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillStyle = text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(c.tea.name, tx0, r.y + 24);

    ctx.font = '500 12px system-ui, sans-serif';
    ctx.fillStyle = muted;
    ctx.fillText(
      `Hedef ${c.tea.targetTemp}°C · ${c.tea.targetSteep.toFixed(1)} sn`,
      tx0,
      r.y + 42,
    );

    if (c.state === 'idle') {
      const okPour = Math.abs(temp - c.tea.targetTemp) <= 4;
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = okPour ? '#34d399' : muted;
      ctx.fillText(
        okPour ? 'Sıcaklık tamam — dök!' : 'Boş kupa — sıcaklık geldiğinde dök',
        tx0,
        r.y + 76,
      );
    } else {
      const tempDelta = c.pourTemp - c.tea.targetTemp;
      const tempColorCue =
        Math.abs(tempDelta) <= 3 ? '#34d399' :
        Math.abs(tempDelta) <= 8 ? '#fbbf24' : '#f87171';
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.fillStyle = muted;
      ctx.fillText('Dök:', tx0, r.y + 62);
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillStyle = tempColorCue;
      const sign = tempDelta >= 0 ? '+' : '';
      ctx.fillText(`${c.pourTemp}°C (${sign}${tempDelta})`, tx0 + 32, r.y + 62);

      const barX = tx0;
      const barY = r.y + 72;
      const barW = r.w - 86 - 80;
      const barH = 10;
      ctx.fillStyle = '#0f1218';
      ctx.beginPath();
      ctx.roundRect(barX, barY, barW, barH, 5);
      ctx.fill();

      const targetMax = c.tea.targetSteep + 3;
      const bandStart = Math.max(0, c.tea.targetSteep - 0.4) / targetMax;
      const bandEnd = Math.min(1, (c.tea.targetSteep + 0.4) / targetMax);
      ctx.fillStyle = 'rgba(52,211,153,0.28)';
      ctx.fillRect(barX + bandStart * barW, barY, (bandEnd - bandStart) * barW, barH);

      const elapsedRatio = Math.min(1, c.steepElapsed / targetMax);
      const overshoot = c.steepElapsed > c.tea.targetSteep + 0.5;
      ctx.fillStyle = overshoot ? '#f87171' : c.tea.color;
      ctx.beginPath();
      ctx.roundRect(barX, barY, elapsedRatio * barW, barH, 5);
      ctx.fill();

      const xT = barX + (c.tea.targetSteep / targetMax) * barW;
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xT, barY - 2);
      ctx.lineTo(xT, barY + barH + 2);
      ctx.stroke();

      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillStyle = text;
      ctx.textAlign = 'right';
      ctx.fillText(
        `${c.steepElapsed.toFixed(1)} / ${c.tea.targetSteep.toFixed(1)} sn`,
        r.x + r.w - 16,
        r.y + 82,
      );
      ctx.textAlign = 'left';
    }

    const kbx = r.x + r.w - 30;
    const kby = r.y + 20;
    ctx.fillStyle = '#0f1218';
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(kbx - 14, kby - 14, 28, 24, 6);
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), kbx, kby - 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
}

function drawBottom(): void {
  const muted = getCss('--text-muted', '#8a93b0');

  const W = canvas.width;
  const tbx = 24;
  const tby = 616;
  const tbw = W - 48;
  const tbh = 8;
  ctx.fillStyle = '#0f1218';
  ctx.beginPath();
  ctx.roundRect(tbx, tby, tbw, tbh, 4);
  ctx.fill();
  const ratio = Math.max(0, timeLeft / ROUND_DURATION);
  ctx.fillStyle =
    ratio > 0.5 ? '#34d399' : ratio > 0.2 ? '#fbbf24' : '#f87171';
  ctx.beginPath();
  ctx.roundRect(tbx, tby, tbw * ratio, tbh, 4);
  ctx.fill();

  if (lastResult) {
    ctx.globalAlpha = Math.min(1, lastResult.t);
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.fillStyle = lastResult.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(lastResult.text, W / 2, 608);
    ctx.globalAlpha = 1;
  } else {
    ctx.font = '500 10px system-ui, sans-serif';
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`Kalan: ${Math.ceil(timeLeft)} sn`, W / 2, 608);
  }
}

function render(): void {
  const bg = getCss('--surface', '#10131c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawKettleArea();
  drawCups();
  drawBottom();
}

function pointInRect(
  px: number, py: number,
  r: { x: number; y: number; w: number; h: number },
): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const px = (e.clientX - rect.left) * sx;
  const py = (e.clientY - rect.top) * sy;
  for (let i = 0; i < cups.length; i++) {
    if (pointInRect(px, py, cupRect(i))) {
      e.preventDefault();
      selectCup(i);
      return;
    }
  }
  if (py < 290) {
    e.preventDefault();
    heating = true;
  }
}

function onPointerUp(): void {
  heating = false;
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (state !== 'playing') {
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      onOverlayBtn();
      if (k === ' ' && (state as State) === 'playing') heating = true;
    }
    return;
  }
  if (k === ' ') {
    e.preventDefault();
    heating = true;
    return;
  }
  if (k >= '1' && k <= '3') {
    const idx = parseInt(k, 10) - 1;
    if (idx >= 0 && idx < cups.length) {
      e.preventDefault();
      selectCup(idx);
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === ' ') {
    e.preventDefault();
    heating = false;
  }
}

function onBlur(): void {
  heating = false;
}

function onOverlayBtn(): void {
  if (state === 'ready') {
    startGame();
  } else if (state === 'gameover') {
    reset();
    startGame();
  }
}

function startLoop(): void {
  const myGen = gen.current();
  let last = 0;
  function frame(now: number): void {
    if (!gen.isCurrent(myGen)) return;
    const dt = last === 0 ? 16 : Math.min(64, now - last);
    last = now;
    tick(dt);
    render();
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timerEl = document.querySelector<HTMLElement>('#timer')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', onOverlayBtn);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  reset();
}

export const game = defineGame({ init, reset });
