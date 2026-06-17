import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import {
  showOverlay as showOverlayEl,
  hideOverlay as hideOverlayEl,
} from '@shared/overlay';

// Okçu — William-Tell varyantı:
// - Yardımcı sağda dikilir, kafasında elma. Yardımcı yatayda sinüsoidal hareket eder.
// - Sol altta okçu sabit; ok ucundan rüzgar + yerçekimi etkisiyle parabolik uçar.
// - SPACE basılı tut → güç şarjı dolar; bırak → ok fırlar.
// - ↑ / ↓: nişan açısı (yukarı/aşağı yön). Fare hareketi de açı verir.
// - Elmaya isabet +1; başa isabet → oyun biter (kahramanlığın bedeli).
// - 5 atış hakkı; her elma vuruşu skoru artırır, isabetsiz atış skor vermez ama
//   atış hakkından düşer; başa isabet ekstra atış vermeden anında bitirir.
// PITFALLS riayeti:
// - module-level-dom-access: tüm DOM/storage init() içinde.
// - unguarded-storage: @shared/storage.
// - stale-async-callback: tek RAF zinciri + gen token reset ile iptal.
// - overlay-input-leak: state machine her input handler'ın başında guard.
// - missing-overlay-css: per-game CSS .overlay--hidden tanımlı.

const STORAGE_BEST = 'okcu.best';
const SHOTS_PER_ROUND = 5;

type State = 'aiming' | 'flying' | 'flash' | 'gameover';

// Saha boyutları (canvas iç koordinatları)
const W = 640;
const H = 400;
const GROUND_Y = 340;
// Okçu konumu (yay ucu)
const ARCHER_X = 70;
const ARCHER_Y = GROUND_Y - 60;
// Yardımcının yatay salınımı
const HELPER_X_MIN = 420;
const HELPER_X_MAX = 580;
// Yardımcı boyutları
const HEAD_R = 14;
const APPLE_R = 9;
// Fizik
const GRAVITY = 380; // px / s^2
const POWER_MIN = 280;
const POWER_MAX = 720;
const POWER_RAMP_PER_S = 540; // şarj hızı
// Hedef ayar açısı sınırları (yukarı pozitif)
const AIM_MIN = -0.05; // hafif aşağı (yatayın biraz altı)
const AIM_MAX = 1.05; // dikleştir
const AIM_DEFAULT = 0.55;
const AIM_STEP = 0.04;

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let shotsEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

let state: State = 'aiming';
let score = 0;
let best = 0;
let shotsLeft = SHOTS_PER_ROUND;

// Aim/charge
let aim = AIM_DEFAULT;
let charging = false;
let power = POWER_MIN;

// Wind: pixels per second, sabit yön - tur başlangıcında yeniden seçilir
let wind = 0;

// Helper bob
let helperT = 0; // seconds
let helperSpeed = 0.7; // rad/s
let helperPhase = 0;

// Arrow
let arrowX = 0;
let arrowY = 0;
let arrowVX = 0;
let arrowVY = 0;
let arrowAngle = 0;
let arrowFlashMs = 0; // sonuç parlaması ms cinsi
let lastResult: 'apple' | 'head' | 'miss' | null = null;

// Loop bookkeeping
let lastTs = 0;
let rafRunning = false;

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function helperX(now: number): number {
  const mid = (HELPER_X_MIN + HELPER_X_MAX) / 2;
  const amp = (HELPER_X_MAX - HELPER_X_MIN) / 2;
  return mid + Math.sin(now * helperSpeed + helperPhase) * amp;
}

function helperHeadCenter(now: number): { x: number; y: number } {
  return { x: helperX(now), y: GROUND_Y - 80 };
}

function applePos(now: number): { x: number; y: number } {
  const h = helperHeadCenter(now);
  return { x: h.x, y: h.y - HEAD_R - APPLE_R - 2 };
}

function pickWindAndHelper(): void {
  // Rüzgar: -120..+120 px/s; küçük zorluk her atışta artar
  const base = 60 + score * 12;
  const cap = Math.min(base, 180);
  wind = (Math.random() * 2 - 1) * cap;
  // Yardımcı hızı: skorla artar
  helperSpeed = 0.55 + Math.min(score * 0.08, 0.9);
  helperPhase = Math.random() * Math.PI * 2;
}

function nextShot(): void {
  state = 'aiming';
  charging = false;
  power = POWER_MIN;
  lastResult = null;
  pickWindAndHelper();
  updateHud();
  hideOverlay();
}

function reset(): void {
  gen.bump();
  state = 'aiming';
  score = 0;
  shotsLeft = SHOTS_PER_ROUND;
  aim = AIM_DEFAULT;
  charging = false;
  power = POWER_MIN;
  helperT = 0;
  lastResult = null;
  arrowFlashMs = 0;
  pickWindAndHelper();
  updateHud();
  hideOverlay();
  startLoop();
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  shotsEl.textContent = String(shotsLeft);
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function fireArrow(): void {
  // Şarj power'ı kullan; angle pozitif yukarı
  const angle = aim;
  arrowX = ARCHER_X;
  arrowY = ARCHER_Y;
  arrowVX = Math.cos(angle) * power;
  arrowVY = -Math.sin(angle) * power;
  arrowAngle = Math.atan2(arrowVY, arrowVX);
  state = 'flying';
}

function endRound(reason: 'shots' | 'tragedy'): void {
  state = 'gameover';
  commitBest();
  if (reason === 'tragedy') {
    showOverlay(
      'Trajedi!',
      `Yardımcına oku sapladın. Skor: ${score} · R ile yeniden.`,
    );
  } else {
    showOverlay(
      'Tur bitti',
      `Skor: ${score} · Rekor: ${best} · R ile yeniden başla`,
    );
  }
}

function consumeShot(result: 'apple' | 'head' | 'miss'): void {
  lastResult = result;
  arrowFlashMs = 600;
  // 'flying' → 'flash': fizik ve çarpışma kontrolünü dondur.
  state = 'flash';
  if (result === 'head') {
    // Anında trajedi — tur biter, skor sabit kalır
    endRound('tragedy');
    return;
  }
  if (result === 'apple') {
    score += 1;
    updateHud();
    commitBest();
  }
  shotsLeft -= 1;
  updateHud();
  if (shotsLeft <= 0) {
    endRound('shots');
    return;
  }
  // Sonraki atışa hazırlan: flash bittiğinde step() içinde nextShot çağırılır.
}

function step(now: number): void {
  if (lastTs === 0) lastTs = now;
  const dtRaw = (now - lastTs) / 1000;
  lastTs = now;
  const dt = Math.min(dtRaw, 0.05); // büyük frame atlamalarını klampla

  helperT += dt;

  if (state === 'aiming' && charging) {
    power = Math.min(POWER_MAX, power + POWER_RAMP_PER_S * dt);
  }

  if (state === 'flying') {
    // Hareket
    arrowVX += wind * dt;
    arrowVY += GRAVITY * dt;
    arrowX += arrowVX * dt;
    arrowY += arrowVY * dt;
    arrowAngle = Math.atan2(arrowVY, arrowVX);

    // Çarpışma kontrolü — okun ucu (yön vektörü boyunca son)
    const tipX = arrowX + Math.cos(arrowAngle) * 14;
    const tipY = arrowY + Math.sin(arrowAngle) * 14;

    const apple = applePos(helperT);
    const head = helperHeadCenter(helperT);

    const dxA = tipX - apple.x;
    const dyA = tipY - apple.y;
    const dxH = tipX - head.x;
    const dyH = tipY - head.y;

    if (dxA * dxA + dyA * dyA <= APPLE_R * APPLE_R) {
      consumeShot('apple');
    } else if (dxH * dxH + dyH * dyH <= HEAD_R * HEAD_R) {
      consumeShot('head');
    } else if (tipY >= GROUND_Y || tipX > W + 40 || tipX < -40 || tipY < -40) {
      // Yere düştü veya alandan çıktı
      consumeShot('miss');
    }
  }

  if (arrowFlashMs > 0) {
    arrowFlashMs -= dtRaw * 1000;
    if (arrowFlashMs <= 0 && state === 'flash') {
      nextShot();
    }
  }

  draw();
}

function loop(): void {
  if (!rafRunning) return;
  requestAnimationFrame((ts) => {
    step(ts);
    loop();
  });
}

function startLoop(): void {
  if (rafRunning) return;
  rafRunning = true;
  lastTs = 0;
  loop();
}

function getCss(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function draw(): void {
  // Arka plan
  const bg = getCss('--surface', '#0a0b0e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Gökyüzü gradyanı (üst)
  const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  grad.addColorStop(0, 'rgba(96, 165, 250, 0.08)');
  grad.addColorStop(1, 'rgba(96, 165, 250, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, GROUND_Y);

  // Zemin
  ctx.fillStyle = getCss('--okcu-ground', '#1a2030');
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  ctx.strokeStyle = getCss('--border', '#2b3142');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(W, GROUND_Y);
  ctx.stroke();

  // Rüzgar göstergesi (üst)
  drawWindIndicator();

  // Yardımcı + elma
  drawHelper();

  // Okçu
  drawArcher();

  // Ok (uçuyorsa veya flash anında çakılı kaldıysa) görsel
  if (state === 'flying' || state === 'flash') {
    drawArrow();
  }

  // Sonuç flaşı
  if (arrowFlashMs > 0 && lastResult !== null) {
    drawResultFlash();
  }
}

function drawWindIndicator(): void {
  ctx.save();
  const cx = W / 2;
  const cy = 28;
  ctx.fillStyle = getCss('--text-dim', '#9aa3b2');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('RÜZGÂR', cx, cy - 14);

  const dir = wind >= 0 ? 1 : -1;
  const strength = Math.min(Math.abs(wind) / 180, 1);
  const len = 30 + strength * 60;
  const y = cy;
  const startX = cx - dir * len / 2;
  const endX = cx + dir * len / 2;

  ctx.strokeStyle = getCss('--okcu-wind', '#f59e0b');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(startX, y);
  ctx.lineTo(endX, y);
  ctx.stroke();
  // Ok başı
  ctx.beginPath();
  ctx.moveTo(endX, y);
  ctx.lineTo(endX - dir * 8, y - 5);
  ctx.lineTo(endX - dir * 8, y + 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawArcher(): void {
  // Basit silüet
  ctx.save();
  const baseX = ARCHER_X;
  const baseY = ARCHER_Y;

  ctx.strokeStyle = getCss('--text', '#e5e7eb');
  ctx.fillStyle = getCss('--text', '#e5e7eb');
  ctx.lineWidth = 3;

  // Vücut
  ctx.beginPath();
  ctx.moveTo(baseX, baseY + 40);
  ctx.lineTo(baseX, baseY + 5);
  ctx.stroke();
  // Bacaklar
  ctx.beginPath();
  ctx.moveTo(baseX, baseY + 40);
  ctx.lineTo(baseX - 9, baseY + 60);
  ctx.moveTo(baseX, baseY + 40);
  ctx.lineTo(baseX + 9, baseY + 60);
  ctx.stroke();
  // Kafa
  ctx.beginPath();
  ctx.arc(baseX, baseY - 4, 7, 0, Math.PI * 2);
  ctx.fill();

  // Yay — aim açısına göre dönen yay
  const yayAng = aim;
  const cosA = Math.cos(yayAng);
  const sinA = Math.sin(yayAng);
  const yayLen = 38;
  const tipX = baseX + cosA * 18 - sinA * 0;
  const tipY = baseY + 8 - sinA * 18;

  // Yay yayı (arc) — okçunun ortasından
  ctx.strokeStyle = getCss('--okcu-bow', '#a78bfa');
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  // Yay merkezi okçunun göğsüne yakın
  const bowCx = baseX + cosA * 6;
  const bowCy = baseY + 8 - sinA * 6;
  ctx.save();
  ctx.translate(bowCx, bowCy);
  ctx.rotate(yayAng);
  ctx.beginPath();
  ctx.moveTo(0, -yayLen / 2);
  ctx.quadraticCurveTo(yayLen * 0.55, 0, 0, yayLen / 2);
  ctx.stroke();
  // Yayın gerili telini çiz
  ctx.strokeStyle = getCss('--text-dim', '#9aa3b2');
  ctx.lineWidth = 1;
  let chord = -8;
  if (state === 'aiming' && charging) {
    const t = (power - POWER_MIN) / (POWER_MAX - POWER_MIN);
    chord = -(8 + t * 18);
  }
  ctx.beginPath();
  ctx.moveTo(0, -yayLen / 2);
  ctx.lineTo(chord, 0);
  ctx.lineTo(0, yayLen / 2);
  ctx.stroke();

  // Çekili ok (aiming + charging değilse de görünür, doğrultuyu göster)
  if (state === 'aiming') {
    ctx.strokeStyle = getCss('--okcu-arrow', '#e5e7eb');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(chord, 0);
    ctx.lineTo(chord + 32, 0);
    ctx.stroke();
    // Ok ucu
    ctx.fillStyle = getCss('--okcu-arrow', '#e5e7eb');
    ctx.beginPath();
    ctx.moveTo(chord + 32, 0);
    ctx.lineTo(chord + 26, -3);
    ctx.lineTo(chord + 26, 3);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Power bar (okçunun yanında)
  if (state === 'aiming') {
    const barX = baseX - 28;
    const barY = baseY - 30;
    const barW = 56;
    const barH = 6;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(barX, barY, barW, barH);
    const t = (power - POWER_MIN) / (POWER_MAX - POWER_MIN);
    ctx.fillStyle = charging
      ? getCss('--okcu-power', '#f43f5e')
      : getCss('--text-dim', '#9aa3b2');
    ctx.fillRect(barX, barY, Math.max(2, barW * t), barH);
    // Çerçeve
    ctx.strokeStyle = getCss('--border', '#2b3142');
    ctx.lineWidth = 1;
    ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
  }

  ctx.restore();
  // Tutmadan kaçınma için tipX/tipY hesabı yapıldı — kullanılmıyor
  void tipX;
  void tipY;
}

function drawHelper(): void {
  const head = helperHeadCenter(helperT);
  const apple = applePos(helperT);

  ctx.save();
  // Vücut
  ctx.strokeStyle = getCss('--text', '#e5e7eb');
  ctx.fillStyle = getCss('--text', '#e5e7eb');
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(head.x, head.y + HEAD_R);
  ctx.lineTo(head.x, GROUND_Y);
  ctx.stroke();
  // Bacaklar
  ctx.beginPath();
  ctx.moveTo(head.x, GROUND_Y);
  ctx.lineTo(head.x - 10, GROUND_Y + 18);
  ctx.moveTo(head.x, GROUND_Y);
  ctx.lineTo(head.x + 10, GROUND_Y + 18);
  ctx.stroke();
  // Kollar (dik)
  ctx.beginPath();
  ctx.moveTo(head.x, head.y + HEAD_R + 8);
  ctx.lineTo(head.x - 14, head.y + HEAD_R + 30);
  ctx.moveTo(head.x, head.y + HEAD_R + 8);
  ctx.lineTo(head.x + 14, head.y + HEAD_R + 30);
  ctx.stroke();
  // Baş
  ctx.beginPath();
  ctx.arc(head.x, head.y, HEAD_R, 0, Math.PI * 2);
  ctx.fill();

  // Elma
  ctx.fillStyle = getCss('--okcu-apple', '#ef4444');
  ctx.beginPath();
  ctx.arc(apple.x, apple.y, APPLE_R, 0, Math.PI * 2);
  ctx.fill();
  // Sap
  ctx.strokeStyle = getCss('--okcu-stem', '#22c55e');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(apple.x, apple.y - APPLE_R);
  ctx.lineTo(apple.x + 2, apple.y - APPLE_R - 5);
  ctx.stroke();

  ctx.restore();
}

function drawArrow(): void {
  ctx.save();
  ctx.translate(arrowX, arrowY);
  ctx.rotate(arrowAngle);
  ctx.strokeStyle = getCss('--okcu-arrow', '#e5e7eb');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-14, 0);
  ctx.lineTo(14, 0);
  ctx.stroke();
  // Tüy
  ctx.beginPath();
  ctx.moveTo(-14, 0);
  ctx.lineTo(-18, -3);
  ctx.moveTo(-14, 0);
  ctx.lineTo(-18, 3);
  ctx.stroke();
  // Uç
  ctx.fillStyle = getCss('--okcu-arrow', '#e5e7eb');
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(8, -4);
  ctx.lineTo(8, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawResultFlash(): void {
  let text = '';
  let color = '#ffffff';
  if (lastResult === 'apple') {
    text = 'ELMA!';
    color = '#22c55e';
  } else if (lastResult === 'head') {
    text = 'KAFAYA İSABET';
    color = '#ef4444';
  } else if (lastResult === 'miss') {
    text = 'IŞTAH!';
    color = '#f59e0b';
  }
  const alpha = Math.min(1, arrowFlashMs / 320);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, H / 2 - 40);
  ctx.restore();
}

function onKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    reset();
    e.preventDefault();
    return;
  }
  if (state === 'gameover') return;
  if (k === 'ArrowUp' || k === 'w' || k === 'W') {
    if (state === 'aiming') aim = Math.min(AIM_MAX, aim + AIM_STEP);
    e.preventDefault();
    return;
  }
  if (k === 'ArrowDown' || k === 's' || k === 'S') {
    if (state === 'aiming') aim = Math.max(AIM_MIN, aim - AIM_STEP);
    e.preventDefault();
    return;
  }
  if (k === ' ' || k === 'Spacebar') {
    if (state === 'aiming' && !charging) {
      charging = true;
      power = POWER_MIN;
    }
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  const k = e.key;
  if (k === ' ' || k === 'Spacebar') {
    if (state === 'aiming' && charging) {
      charging = false;
      fireArrow();
    }
    e.preventDefault();
  }
}

function canvasToScene(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = (clientX - rect.left) * (W / rect.width);
  const sy = (clientY - rect.top) * (H / rect.height);
  return { x: sx, y: sy };
}

function updateAimFromPointer(clientX: number, clientY: number): void {
  const { x, y } = canvasToScene(clientX, clientY);
  const dx = x - ARCHER_X;
  const dy = ARCHER_Y - y;
  if (dx <= 0) return; // ileri doğru olmayan açı yok
  const ang = Math.atan2(dy, dx);
  aim = Math.max(AIM_MIN, Math.min(AIM_MAX, ang));
}

function onPointerMove(e: PointerEvent): void {
  if (state !== 'aiming') return;
  updateAimFromPointer(e.clientX, e.clientY);
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'gameover') return;
  if (state !== 'aiming') return;
  updateAimFromPointer(e.clientX, e.clientY);
  charging = true;
  power = POWER_MIN;
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerUp(e: PointerEvent): void {
  if (state !== 'aiming') return;
  if (!charging) return;
  charging = false;
  fireArrow();
  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
  e.preventDefault();
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  shotsEl = document.querySelector<HTMLElement>('#shots')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    reset();
  });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', (e) => {
    if (charging) charging = false;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
