import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite (try/catch built in).
// - stale-async-callback: gen.bump() on reset; rAF guard via state enum.
// - overlay-input-leak: explicit `state` enum + guard at top of handlers;
//   isMoving forced false unless state === 'playing'.
// - module-level-dom-access: every DOM lookup is inside init().
// - unreachable-start-state: overlay has a button AND Space/Enter/click start.
// - invisible-boot: every round starts in 'closed' (safe) phase, so the
//   first key-press in a round always produces visible motion.
// - hud-counter-synced-only-at-lifecycle-edges: score/lives written to DOM
//   the same instant they change (updateHUD()), not only on game-over.

const STORAGE_BEST = 'heykel.best';
const CANVAS_W = 480;
const CANVAS_H = 520;
const START_Y = 470;
const FINISH_Y = 168;
const PLAYER_RADIUS = 14;
const MOVE_SPEED = 0.12; // px / ms

type Phase = 'closed' | 'tell' | 'open';
type State = 'ready' | 'playing' | 'caught' | 'gameover';

interface RoundConfig {
  closedMin: number;
  closedMax: number;
  tell: number;
  openMin: number;
  openMax: number;
}

const gen = createGenToken();
let state: State = 'ready';
let phase: Phase = 'closed';
let phaseEndsAt = 0;
let score = 0;
let best = 0;
let lives = 3;
let playerY = START_Y;
let isMoving = false;
let lastFrameTs = 0;
let caughtUntil = 0;
let winFlashUntil = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let statusEl!: HTMLElement;

const pressedKeys = new Set<string>();
let pointerDown = false;

function getRoundConfig(round: number): RoundConfig {
  const r = Math.max(0, round - 1);
  const closedMin = Math.max(900, 2400 - r * 160);
  const closedMax = Math.max(1300, 3200 - r * 200);
  const openMin = Math.min(2400, 1100 + r * 80);
  const openMax = Math.min(3200, 1700 + r * 100);
  const tell = Math.max(260, 600 - r * 28);
  return { closedMin, closedMax, tell, openMin, openMax };
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function setPhase(now: number, next: Phase): void {
  const cfg = getRoundConfig(score + 1);
  phase = next;
  if (next === 'closed') {
    phaseEndsAt = now + rand(cfg.closedMin, cfg.closedMax);
    setStatus('Kapalı — koş!', 'safe');
  } else if (next === 'tell') {
    phaseEndsAt = now + cfg.tell;
    setStatus('Dikkat... açılıyor!', 'warn');
  } else {
    phaseEndsAt = now + rand(cfg.openMin, cfg.openMax);
    setStatus('AÇIK — heykel ol!', 'danger');
  }
}

function setStatus(text: string, kind?: 'safe' | 'warn' | 'danger'): void {
  statusEl.textContent = text;
  statusEl.classList.remove('status-safe', 'status-warn', 'status-danger');
  if (kind === 'safe') statusEl.classList.add('status-safe');
  else if (kind === 'warn') statusEl.classList.add('status-warn');
  else if (kind === 'danger') statusEl.classList.add('status-danger');
}

function updateHUD(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = String(Math.max(0, lives));
}

function updateMoving(): void {
  isMoving = state === 'playing' && (pressedKeys.size > 0 || pointerDown);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  lives = 3;
  playerY = START_Y;
  phase = 'closed';
  phaseEndsAt = 0;
  caughtUntil = 0;
  winFlashUntil = 0;
  pressedKeys.clear();
  pointerDown = false;
  updateMoving();
  overlayTitle.textContent = 'Heykel';
  overlayMsg.textContent =
    'Gözcü kapalıyken (yeşil) ilerle, açıldığında (kırmızı) heykel ol. Boşluk/W/↑ basılı tut: koş, bırak: dur.';
  startBtn.textContent = 'Başla';
  showOverlayEl(overlay);
  setStatus('Başlamak için Başla\'ya bas veya Boşluk\'a dokun.');
  updateHUD();
}

function startGame(): void {
  gen.bump();
  score = 0;
  lives = 3;
  playerY = START_Y;
  pressedKeys.clear();
  pointerDown = false;
  state = 'playing';
  hideOverlayEl(overlay);
  setPhase(performance.now(), 'closed');
  updateMoving();
  updateHUD();
}

function endGame(): void {
  state = 'gameover';
  pressedKeys.clear();
  pointerDown = false;
  updateMoving();
  overlayTitle.textContent = 'Yakalandın';
  overlayMsg.textContent = `Tur: ${score}\nRekor: ${best}`;
  startBtn.textContent = 'Tekrar oyna';
  showOverlayEl(overlay);
  setStatus('Üç can bitti — tekrar dene.');
}

function getCaught(now: number): void {
  state = 'caught';
  lives -= 1;
  caughtUntil = now + 900;
  // Stop ongoing movement; player has to re-press to resume.
  pressedKeys.clear();
  pointerDown = false;
  updateMoving();
  setStatus('Yakalandın! Başa dönüyorsun...', 'danger');
  updateHUD();
}

function winRound(now: number): void {
  score += 1;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHUD();
  winFlashUntil = now + 520;
  playerY = START_Y;
  // Leave pressedKeys/pointerDown untouched: if the player is still holding
  // the run key when they cross the finish, they keep moving into the new
  // round (which always opens in 'closed' phase, so it's safe).
  setPhase(now, 'closed');
  setStatus(`Tur ${score} tamam! Kapalı — koş!`, 'safe');
}

function frame(ts: number): void {
  const dt = lastFrameTs === 0 ? 16 : Math.min(60, ts - lastFrameTs);
  lastFrameTs = ts;

  if (state === 'playing') {
    // Phase transitions.
    if (ts >= phaseEndsAt) {
      if (phase === 'closed') setPhase(ts, 'tell');
      else if (phase === 'tell') setPhase(ts, 'open');
      else setPhase(ts, 'closed');
    }

    // Player movement.
    if (isMoving) {
      playerY = Math.max(FINISH_Y, playerY - MOVE_SPEED * dt);
    }

    // Catch condition: moving while open.
    if (phase === 'open' && isMoving) {
      getCaught(ts);
    } else if (playerY <= FINISH_Y) {
      winRound(ts);
    }
  } else if (state === 'caught') {
    if (ts >= caughtUntil) {
      if (lives <= 0) {
        endGame();
      } else {
        playerY = START_Y;
        state = 'playing';
        setPhase(ts, 'closed');
        updateMoving();
      }
    }
  }

  draw(ts);
  requestAnimationFrame(frame);
}

function draw(ts: number): void {
  // Background.
  ctx.fillStyle = '#0c1118';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Subtle vertical track lines.
  ctx.strokeStyle = 'rgba(120, 160, 200, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 6; i++) {
    const x = (CANVAS_W / 6) * i;
    ctx.moveTo(x, FINISH_Y);
    ctx.lineTo(x, START_Y + 30);
  }
  ctx.stroke();

  // Path band.
  ctx.fillStyle = 'rgba(120, 160, 200, 0.04)';
  ctx.fillRect(40, FINISH_Y - 6, CANVAS_W - 80, START_Y - FINISH_Y + 36);
  ctx.strokeStyle = 'rgba(160, 200, 220, 0.10)';
  ctx.lineWidth = 1;
  ctx.strokeRect(40, FINISH_Y - 6, CANVAS_W - 80, START_Y - FINISH_Y + 36);

  // Finish line.
  const finishFlash = winFlashUntil > ts;
  const finishAlpha = finishFlash ? 1 : 0.55;
  ctx.strokeStyle = `rgba(101, 224, 166, ${finishAlpha})`;
  ctx.lineWidth = finishFlash ? 4 : 2;
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  ctx.moveTo(40, FINISH_Y);
  ctx.lineTo(CANVAS_W - 40, FINISH_Y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Start line.
  ctx.strokeStyle = 'rgba(150, 160, 170, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const startLineY = START_Y + PLAYER_RADIUS + 6;
  ctx.moveTo(40, startLineY);
  ctx.lineTo(CANVAS_W - 40, startLineY);
  ctx.stroke();
  ctx.fillStyle = 'rgba(150, 160, 170, 0.45)';
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('BAŞLANGIÇ', 44, startLineY + 14);
  ctx.textAlign = 'right';
  ctx.fillText('BAŞLANGIÇ', CANVAS_W - 44, startLineY + 14);

  // Finish label.
  ctx.fillStyle = `rgba(101, 224, 166, ${finishAlpha})`;
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('BİTİŞ', 44, FINISH_Y - 8);
  ctx.textAlign = 'right';
  ctx.fillText('BİTİŞ', CANVAS_W - 44, FINISH_Y - 8);

  // Win flash particles.
  if (finishFlash) {
    const t = 1 - (winFlashUntil - ts) / 520;
    const ringR = 12 + t * 80;
    ctx.strokeStyle = `rgba(101, 224, 166, ${(1 - t) * 0.7})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(CANVAS_W / 2, FINISH_Y, ringR, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawWatcher(ts);
  drawPlayer(ts);
}

function phaseColor(): { ring: string; body: string; status: string } {
  if (state !== 'playing') {
    return { ring: '#4d5d68', body: '#1a232c', status: '#9bb8c4' };
  }
  if (phase === 'closed') return { ring: '#65e0a6', body: '#1f3a2c', status: '#65e0a6' };
  if (phase === 'tell') return { ring: '#ffc847', body: '#3a3520', status: '#ffc847' };
  return { ring: '#ff7a7a', body: '#3a2020', status: '#ff7a7a' };
}

function drawWatcher(ts: number): void {
  const cx = CANVAS_W / 2;
  const cy = 70;
  const colors = phaseColor();

  // Outer aura ring (most visible cue, peripheral-friendly).
  const auraR =
    state === 'playing' && phase === 'open'
      ? 78 + Math.sin(ts / 80) * 3
      : state === 'playing' && phase === 'tell'
        ? 72 + Math.sin(ts / 60) * 2
        : 70;
  const grd = ctx.createRadialGradient(cx, cy, 38, cx, cy, auraR);
  grd.addColorStop(0, withAlpha(colors.ring, 0.42));
  grd.addColorStop(1, withAlpha(colors.ring, 0));
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(cx, cy, auraR, 0, Math.PI * 2);
  ctx.fill();

  // Body.
  ctx.fillStyle = colors.body;
  ctx.strokeStyle = colors.ring;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Eye open progress (0 closed → 1 fully open).
  let eyeOpen = 0.05;
  if (state === 'playing') {
    if (phase === 'closed') eyeOpen = 0.05;
    else if (phase === 'tell') {
      const cfg = getRoundConfig(score + 1);
      const remaining = phaseEndsAt - ts;
      const t = Math.max(0, Math.min(1, 1 - remaining / cfg.tell));
      eyeOpen = 0.05 + 0.55 * t;
    } else eyeOpen = 1;
  } else if (state === 'caught') {
    eyeOpen = 1;
  } else if (state === 'ready' || state === 'gameover') {
    eyeOpen = 0.45;
  }

  // Eye white.
  const eyeW = 30;
  const eyeH = 22 * eyeOpen;
  if (eyeOpen > 0.08) {
    ctx.fillStyle = '#e8f5f8';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 2, eyeW, eyeH, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Pupil tracks the player when eye is sufficiently open.
  if (eyeOpen > 0.35) {
    const dx = CANVAS_W / 2 - cx;
    const dy = playerY - cy;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const px = cx + (dx / dist) * Math.min(8, eyeW * 0.3);
    const py = cy + 2 + (dy / dist) * Math.min(eyeH * 0.6, 8);

    ctx.fillStyle = '#0a0f14';
    ctx.beginPath();
    ctx.arc(px, py, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px - 2, py - 2, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Eyelid line (when closed).
  if (eyeOpen <= 0.1) {
    ctx.strokeStyle = '#3a4751';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 28, cy + 2);
    ctx.quadraticCurveTo(cx, cy + 6, cx + 28, cy + 2);
    ctx.stroke();
  }

  // Mini "Z" floating up when watcher is closed (cute sleepy hint).
  if (state === 'playing' && phase === 'closed') {
    const zT = (ts / 900) % 1;
    const zY = cy - 30 - zT * 18;
    const zX = cx + 38 + Math.sin(zT * Math.PI * 2) * 4;
    ctx.fillStyle = `rgba(101, 224, 166, ${0.7 * (1 - zT)})`;
    ctx.font = 'bold 14px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('z', zX, zY);
  }

  // Phase label below watcher.
  ctx.fillStyle = colors.status;
  ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  const label =
    state !== 'playing'
      ? 'GÖZCÜ'
      : phase === 'closed'
        ? 'KAPALI'
        : phase === 'tell'
          ? 'UYANIYOR'
          : 'AÇIK';
  ctx.fillText(label, cx, cy + 64);
}

function drawPlayer(ts: number): void {
  const cx = CANVAS_W / 2;
  const cy = playerY;

  // Shadow.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + PLAYER_RADIUS + 2, PLAYER_RADIUS * 0.8, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  let bodyColor = '#4dd0e1';
  let stroke = '#0a0b0e';
  let label: string | null = null;

  if (state === 'caught') {
    const t = 1 - Math.max(0, (caughtUntil - ts) / 900);
    bodyColor = t < 0.5 ? '#ff7a7a' : '#ff9090';
    stroke = '#600';
    label = '!';
  } else if (state === 'playing' && !isMoving) {
    // Frozen pose.
    bodyColor = phase === 'open' ? '#dde5e8' : '#a8c0cc';
    stroke = '#0a0b0e';
  } else if (state === 'playing' && isMoving) {
    bodyColor = phase === 'open' ? '#ff9a3c' : '#4dd0e1';
  }

  // Walking bob.
  const bob =
    state === 'playing' && isMoving ? Math.sin(ts / 80) * 1.8 : 0;

  ctx.fillStyle = bodyColor;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy + bob, PLAYER_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (label) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + bob + 1);
    ctx.textBaseline = 'alphabetic';
  } else if (state === 'playing' && !isMoving) {
    // Tiny "frozen" sparkle to make heykel pose obvious.
    ctx.strokeStyle = 'rgba(220, 240, 250, 0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + PLAYER_RADIUS + 3, cy - 6);
    ctx.lineTo(cx + PLAYER_RADIUS + 9, cy - 6);
    ctx.moveTo(cx + PLAYER_RADIUS + 6, cy - 9);
    ctx.lineTo(cx + PLAYER_RADIUS + 6, cy - 3);
    ctx.stroke();
  }
}

function withAlpha(hex: string, alpha: number): string {
  // hex like "#65e0a6" — assume 6-char hex.
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function isMovementKey(key: string): boolean {
  return (
    key === ' ' ||
    key === 'Spacebar' ||
    key === 'w' ||
    key === 'W' ||
    key === 'ArrowUp'
  );
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (state === 'ready' || state === 'gameover') {
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
      e.preventDefault();
      startGame();
    }
    return;
  }
  if (state !== 'playing') return;
  if (isMovementKey(e.key)) {
    e.preventDefault();
    pressedKeys.add(e.key);
    updateMoving();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (isMovementKey(e.key)) {
    pressedKeys.delete(e.key);
    updateMoving();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (state !== 'playing') return;
  e.preventDefault();
  pointerDown = true;
  if (e.pointerId !== undefined && canvas.setPointerCapture) {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore — capture is a hint, not required.
    }
  }
  updateMoving();
}

function onPointerEnd(): void {
  pointerDown = false;
  updateMoving();
}

function onVisibilityChange(): void {
  if (document.hidden) {
    pressedKeys.clear();
    pointerDown = false;
    updateMoving();
  } else {
    lastFrameTs = 0;
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  statusEl = document.querySelector<HTMLElement>('#status-line')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });
  startBtn.addEventListener('click', () => {
    startGame();
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('pointerleave', onPointerEnd);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('blur', onPointerEnd);

  document.addEventListener('visibilitychange', onVisibilityChange);

  reset();
  requestAnimationFrame(frame);
}

export const game = defineGame({ init, reset });
