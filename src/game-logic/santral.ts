import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - stale-async-callback: gen.bump() invalidates pending RAF callbacks.
// - overlay-input-leak: every handler returns early unless state === 'playing'.
// - module-level side effects: all DOM access happens in init().
// - missing-overlay-css: per-game CSS defines .overlay--hidden visual rules.
// - visual-vs-hitbox: jack hit detection uses same JACK_R the renderer draws with.

const STORAGE_BEST = 'santral.best';
const LINES = 8;
const MAX_LIVES = 3;
const MAX_ACTIVE = 4;
const JACK_R = 18;
const ROUND_SECONDS = 90;

type State = 'ready' | 'playing' | 'gameover';

interface Call {
  id: number;
  caller: number;       // index 0-7
  destination: number;  // index 0-7
  bornMs: number;
  patienceMs: number;   // total patience window
  status: 'ringing' | 'connected' | 'done';
  flash: number;        // 0-1 visual pulse (ringing)
  connectStartMs: number;
  connectDurationMs: number;
}

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let streak = 0;
let lives = MAX_LIVES;
let calls: Call[] = [];
let selectedCallId: number | null = null;
let pointer = { x: 0, y: 0, has: false };
let nextCallId = 1;
let nextSpawnMs = 0;
let elapsedMs = 0;
let lastFrameMs = 0;
let rafHandle: number | null = null;
let endsAtMs = 0;
let errorFlashes: { caller: number; dest: number; bornMs: number }[] = [];

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let streakEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function jackPos(row: 'top' | 'bottom', i: number): { x: number; y: number } {
  const padX = 60;
  const w = canvas.width;
  const usable = w - padX * 2;
  const step = usable / (LINES - 1);
  const x = padX + step * i;
  const y = row === 'top' ? 120 : canvas.height - 90;
  return { x, y };
}

function spawnIntervalMs(): number {
  // Calls arrive ~3.2s apart at start, drop toward ~1.2s by ~60s in.
  const t = Math.min(1, elapsedMs / 60_000);
  return 3200 - t * 2000;
}

function patienceFor(): number {
  // 7.5s at start, shrinking to ~4.5s late game.
  const t = Math.min(1, elapsedMs / 60_000);
  return 7500 - t * 3000;
}

function spawnCall(): void {
  if (calls.filter((c) => c.status === 'ringing').length >= MAX_ACTIVE) return;

  // pick a caller jack not currently active (ringing or connected on that caller)
  const usedCallers = new Set(
    calls.filter((c) => c.status !== 'done').map((c) => c.caller),
  );
  const free: number[] = [];
  for (let i = 0; i < LINES; i++) if (!usedCallers.has(i)) free.push(i);
  if (free.length === 0) return;
  const caller = free[Math.floor(Math.random() * free.length)]!;

  // pick a destination not equal to caller and not currently connected
  const usedDests = new Set(
    calls
      .filter((c) => c.status === 'connected')
      .map((c) => c.destination),
  );
  const destChoices: number[] = [];
  for (let i = 0; i < LINES; i++) {
    if (i !== caller && !usedDests.has(i)) destChoices.push(i);
  }
  if (destChoices.length === 0) return;
  const destination =
    destChoices[Math.floor(Math.random() * destChoices.length)]!;

  calls.push({
    id: nextCallId++,
    caller,
    destination,
    bornMs: elapsedMs,
    patienceMs: patienceFor(),
    status: 'ringing',
    flash: 0,
    connectStartMs: 0,
    connectDurationMs: 0,
  });
}

function loseLife(): void {
  lives -= 1;
  streak = 0;
  updateHud();
  if (lives <= 0) endGame();
}

function endGame(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  overlayTitleEl.textContent = 'Santral kapandı';
  overlayMsgEl.textContent = `Bağlantı: ${score} · Rekor: ${best}\nYeniden başla için Başla'ya bas.`;
  overlayBtn.textContent = 'Yeniden başla';
  showOverlayEl(overlayEl);
  updateHud();
}

function endRoundByTime(): void {
  state = 'gameover';
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  overlayTitleEl.textContent = 'Vardiya bitti';
  overlayMsgEl.textContent = `Bağlantı: ${score} · Rekor: ${best}\n90 saniye doldu — başka bir vardiya?`;
  overlayBtn.textContent = 'Tekrar';
  showOverlayEl(overlayEl);
  updateHud();
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  streakEl.textContent = String(streak);
  livesEl.textContent = lives > 0 ? '♥ '.repeat(lives).trim() : '–';
  livesEl.setAttribute('aria-label', `kalan can: ${Math.max(0, lives)}`);
}

function tryConnect(caller: number, destination: number): void {
  const call = calls.find(
    (c) => c.status === 'ringing' && c.caller === caller,
  );
  if (!call) return;

  if (call.destination === destination) {
    call.status = 'connected';
    call.connectStartMs = elapsedMs;
    call.connectDurationMs = 4000 + Math.random() * 6000;
    score += 1;
    streak += 1;
    if (streak >= 3 && streak % 3 === 0) {
      const bonus = Math.min(4, 1 + Math.floor((streak - 3) / 3));
      score += bonus;
    }
    updateHud();
  } else {
    errorFlashes.push({
      caller,
      dest: destination,
      bornMs: elapsedMs,
    });
    loseLife();
  }
}

function onJackClick(row: 'top' | 'bottom', i: number): void {
  if (state !== 'playing') return;
  if (row === 'top') {
    // selecting a caller
    const ringing = calls.find(
      (c) => c.status === 'ringing' && c.caller === i,
    );
    if (!ringing) return; // can only pick a ringing caller
    selectedCallId = ringing.id;
  } else {
    if (selectedCallId === null) return;
    const call = calls.find((c) => c.id === selectedCallId);
    selectedCallId = null;
    if (!call || call.status !== 'ringing') return;
    tryConnect(call.caller, i);
  }
}

function pointerToJack(
  px: number,
  py: number,
): { row: 'top' | 'bottom'; index: number } | null {
  for (let i = 0; i < LINES; i++) {
    const top = jackPos('top', i);
    if ((px - top.x) ** 2 + (py - top.y) ** 2 <= (JACK_R + 6) ** 2) {
      return { row: 'top', index: i };
    }
    const bot = jackPos('bottom', i);
    if ((px - bot.x) ** 2 + (py - bot.y) ** 2 <= (JACK_R + 6) ** 2) {
      return { row: 'bottom', index: i };
    }
  }
  return null;
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
  pointer.x = px;
  pointer.y = py;
  pointer.has = true;
  const jack = pointerToJack(px, py);
  if (!jack) {
    // background tap cancels selection
    selectedCallId = null;
    return;
  }
  e.preventDefault();
  onJackClick(jack.row, jack.index);
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'playing') return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  pointer.y = ((e.clientY - rect.top) / rect.height) * canvas.height;
  pointer.has = true;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    startGame();
    return;
  }
  if (e.key === 'Escape') {
    selectedCallId = null;
    e.preventDefault();
    return;
  }
  if (state !== 'playing') return;
  const n = Number(e.key);
  if (!Number.isFinite(n) || n < 1 || n > LINES) return;
  e.preventDefault();
  const idx = n - 1;
  if (e.shiftKey) {
    onJackClick('bottom', idx);
  } else {
    onJackClick('top', idx);
  }
}

function loop(token: number, nowMs: number): void {
  if (!gen.isCurrent(token)) return;
  if (state !== 'playing') return;

  const dt = lastFrameMs === 0 ? 16 : Math.min(64, nowMs - lastFrameMs);
  lastFrameMs = nowMs;
  elapsedMs += dt;

  // spawn calls
  if (elapsedMs >= nextSpawnMs) {
    spawnCall();
    nextSpawnMs = elapsedMs + spawnIntervalMs();
  }

  // expire calls
  for (const c of calls) {
    if (c.status === 'ringing') {
      const age = elapsedMs - c.bornMs;
      if (age >= c.patienceMs) {
        c.status = 'done';
        if (selectedCallId === c.id) selectedCallId = null;
        loseLife();
      }
    } else if (c.status === 'connected') {
      const age = elapsedMs - c.connectStartMs;
      if (age >= c.connectDurationMs) {
        c.status = 'done';
      }
    }
  }
  calls = calls.filter((c) => c.status !== 'done' || elapsedMs - c.bornMs < 1500);
  // (keep done calls briefly so any UI hint clears smoothly; trim after 1.5s)
  calls = calls.filter((c) => !(c.status === 'done' && elapsedMs - c.bornMs >= 1500));

  // trim error flashes older than 350ms
  errorFlashes = errorFlashes.filter((f) => elapsedMs - f.bornMs < 350);

  // time check
  if (elapsedMs >= endsAtMs) {
    endRoundByTime();
    draw();
    return;
  }

  draw();
  rafHandle = requestAnimationFrame((t) => loop(token, t));
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  // background
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#1a1410');
  bg.addColorStop(1, '#0c0907');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // wood panel suggestion
  ctx.strokeStyle = 'rgba(120, 80, 40, 0.25)';
  ctx.lineWidth = 1;
  for (let y = 0; y < h; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // row labels
  ctx.fillStyle = 'rgba(220, 200, 170, 0.55)';
  ctx.font = '600 12px ui-sans-serif, system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('ARAYAN', 16, jackPos('top', 0).y);
  ctx.fillText('HEDEF', 16, jackPos('bottom', 0).y);

  // jacks (top + bottom)
  for (const row of ['top', 'bottom'] as const) {
    for (let i = 0; i < LINES; i++) {
      const p = jackPos(row, i);
      const isCallerRinging =
        row === 'top' &&
        calls.some((c) => c.caller === i && c.status === 'ringing');
      const isCallerConnected =
        row === 'top' &&
        calls.some((c) => c.caller === i && c.status === 'connected');
      const isDestConnected =
        row === 'bottom' &&
        calls.some((c) => c.destination === i && c.status === 'connected');

      // outer brass ring
      ctx.beginPath();
      ctx.arc(p.x, p.y, JACK_R + 3, 0, Math.PI * 2);
      ctx.fillStyle = '#7a5a2a';
      ctx.fill();

      // inner hole
      const grad = ctx.createRadialGradient(
        p.x - 3,
        p.y - 3,
        2,
        p.x,
        p.y,
        JACK_R,
      );
      grad.addColorStop(0, '#1a1208');
      grad.addColorStop(1, '#070403');
      ctx.beginPath();
      ctx.arc(p.x, p.y, JACK_R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // ringing pulse
      if (isCallerRinging) {
        const t = (elapsedMs % 600) / 600;
        const r = JACK_R + 6 + Math.sin(t * Math.PI * 2) * 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(245, 140, 80, 0.85)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      if (isCallerConnected || isDestConnected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, JACK_R + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(120, 230, 160, 0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // label
      ctx.fillStyle = 'rgba(220, 200, 170, 0.85)';
      ctx.font = '600 13px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelY = row === 'top' ? p.y - JACK_R - 14 : p.y + JACK_R + 14;
      ctx.fillText(String(i + 1), p.x, labelY);
    }
  }

  // ringing bubbles + patience bars
  for (const c of calls) {
    if (c.status !== 'ringing') continue;
    const p = jackPos('top', c.caller);
    // bubble above jack
    const bw = 36;
    const bh = 22;
    const by = p.y - JACK_R - 40;
    ctx.fillStyle = '#f4e9d8';
    ctx.strokeStyle = '#3a2a18';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    roundRect(ctx, p.x - bw / 2, by - bh / 2, bw, bh, 8);
    ctx.fill();
    ctx.stroke();
    // pointer tail
    ctx.beginPath();
    ctx.moveTo(p.x - 5, by + bh / 2 - 1);
    ctx.lineTo(p.x, by + bh / 2 + 6);
    ctx.lineTo(p.x + 5, by + bh / 2 - 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#3a2a18';
    ctx.font = '700 14px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('→' + (c.destination + 1), p.x, by);

    // patience bar (below jack toward middle)
    const age = elapsedMs - c.bornMs;
    const left = 1 - Math.min(1, age / c.patienceMs);
    const barW = 44;
    const barH = 5;
    const bx = p.x - barW / 2;
    const byb = p.y + JACK_R + 22;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(bx, byb, barW, barH);
    const col =
      left > 0.5 ? '#7ae28b' : left > 0.25 ? '#e8c265' : '#e8654a';
    ctx.fillStyle = col;
    ctx.fillRect(bx, byb, barW * left, barH);
  }

  // connected cables (curved bezier)
  for (const c of calls) {
    if (c.status !== 'connected') continue;
    const a = jackPos('top', c.caller);
    const b = jackPos('bottom', c.destination);
    drawCable(a.x, a.y, b.x, b.y, cableColor(c.id), 1);
  }

  // selected cable preview from caller to pointer
  if (selectedCallId !== null) {
    const call = calls.find((c) => c.id === selectedCallId);
    if (call && call.status === 'ringing') {
      const a = jackPos('top', call.caller);
      const tx = pointer.has ? pointer.x : a.x;
      const ty = pointer.has ? pointer.y : a.y + 100;
      drawCable(a.x, a.y, tx, ty, '#f5a065', 0.85);
      // selection ring around caller
      ctx.beginPath();
      ctx.arc(a.x, a.y, JACK_R + 9, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(245, 160, 100, 0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // error flashes
  for (const f of errorFlashes) {
    const age = elapsedMs - f.bornMs;
    const a = jackPos('top', f.caller);
    const b = jackPos('bottom', f.dest);
    const alpha = 1 - age / 350;
    drawCable(a.x, a.y, b.x, b.y, `rgba(232, 80, 70, ${alpha.toFixed(3)})`, 1);
  }

  // time bar at top
  const tLeft = Math.max(0, (endsAtMs - elapsedMs) / (ROUND_SECONDS * 1000));
  const tbW = w - 40;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(20, 16, tbW, 4);
  ctx.fillStyle = tLeft > 0.25 ? '#c2a26b' : '#e8654a';
  ctx.fillRect(20, 16, tbW * tLeft, 4);
}

function drawCable(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
): void {
  const midY = (y1 + y2) / 2 + 70;
  const cx1 = x1;
  const cy1 = midY;
  const cx2 = x2;
  const cy2 = midY;
  // shadow
  ctx.lineWidth = 4 * width;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.moveTo(x1, y1 + 2);
  ctx.bezierCurveTo(cx1, cy1 + 2, cx2, cy2 + 2, x2, y2 + 2);
  ctx.stroke();
  // wire
  ctx.lineWidth = 3 * width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
  ctx.stroke();
  // plug tips
  ctx.fillStyle = '#d8b16a';
  ctx.beginPath();
  ctx.arc(x1, y1, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x2, y2, 4, 0, Math.PI * 2);
  ctx.fill();
}

function cableColor(seed: number): string {
  const palette = [
    '#e8b664',
    '#7ab8e8',
    '#c87ae8',
    '#7ae28b',
    '#e87a8b',
    '#b6e87a',
    '#e8d164',
    '#9d7ae8',
  ];
  return palette[seed % palette.length]!;
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function startGame(): void {
  gen.bump();
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  state = 'playing';
  score = 0;
  streak = 0;
  lives = MAX_LIVES;
  calls = [];
  selectedCallId = null;
  errorFlashes = [];
  elapsedMs = 0;
  lastFrameMs = 0;
  nextCallId = 1;
  nextSpawnMs = 600; // first call ~0.6s in (visible feedback < 250ms via render)
  endsAtMs = ROUND_SECONDS * 1000;
  updateHud();
  hideOverlayEl(overlayEl);
  draw();
  const token = gen.current();
  if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  rafHandle = requestAnimationFrame((t) => loop(token, t));
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  streak = 0;
  lives = MAX_LIVES;
  calls = [];
  selectedCallId = null;
  errorFlashes = [];
  elapsedMs = 0;
  lastFrameMs = 0;
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  overlayTitleEl.textContent = 'Santral';
  overlayMsgEl.textContent =
    'Bir hat çaldığında üstteki jak titreşir; küçük balonda bağlanmak istediği numara yazar. Önce arayan jakı, sonra hedef jakı tıkla — kabloyu çek. Sabır şeridi tükenmeden ya da yanlış hedef seçmeden üç can yetsin.';
  overlayBtn.textContent = 'Başla';
  showOverlayEl(overlayEl);
  updateHud();
  draw();
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  streakEl = document.querySelector<HTMLElement>('#streak')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });
  overlayBtn.addEventListener('click', () => {
    startGame();
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', () => {
    pointer.has = false;
  });

  window.addEventListener('keydown', onKey);

  updateHud();
  draw();
}

export const game = defineGame({ init, reset });
