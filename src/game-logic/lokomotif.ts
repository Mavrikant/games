import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Buharlı Lokomotif — yan görünüm tren işletme oyunu.
// Mekanik: Yatay raylar üzerinde lokomotifi yönet; gaz/fren ile her istasyonun
// peronundaki altın çizgide tam dur. Yakıt sınırlı, perfect duruşlar +30 yakıt
// ve +2 skor; iyi duruşlar +15 yakıt +1 skor; kaçırılan istasyonda can yanar.
//
// PITFALLS:
// - unguarded-storage: safeRead/safeWrite ile sarmalandı.
// - stale-async-callback: gen.bump() + loop early-return; tek RAF zinciri.
// - overlay-input-leak: state enum + her handler başında guard.
// - visual-vs-hitbox: tren ve istasyon boyutları tek sabit bloğunda.
// - frame-rate-dependent-physics: Fixed-timestep 1/120s, accumulator.
// - invisible-boot: reset() ilk frame'i çiziyor + ilk istasyon görünür alanda.

type State = 'ready' | 'playing' | 'gameover';

type Station = {
  worldX: number;          // peronun ortası (durulması gereken nokta)
  startX: number;          // peron sol kenarı (zone başlangıcı)
  endX: number;            // peron sağ kenarı (sağa geçince kaçırıldı sayar)
  name: string;
  status: 'pending' | 'served' | 'missed';
  resultLabel: string;     // "TAM!", "+1", "KAÇTI"
  resultColor: string;
  resultTimer: number;     // floating label için kalan saniye
};

type Particle = { x: number; y: number; vx: number; vy: number; life: number; size: number };

// ---------- Logical viewport ----------
const W = 720;
const H = 360;

// ---------- Physics ----------
const MAX_SPEED = 220;            // px/sec
const THROTTLE_ACCEL = 95;        // px/sec^2
const BRAKE_DECEL = 165;          // px/sec^2 (yetecek frenleme, oynaması mümkün)
const COAST_FRICTION = 16;        // px/sec^2 pasif sürtünme
const STOP_THRESHOLD = 4;         // px/sec; bu altı "durdu" sayılır
const FUEL_MAX = 100;
const FUEL_BURN_THROTTLE = 4;     // %/sec gaz basılıyken
const FUEL_BURN_IDLE = 0.35;      // %/sec sürekli (kazan)
const FUEL_REWARD_PERFECT = 28;
const FUEL_REWARD_GOOD = 14;

// ---------- Track / stations ----------
const TRAIN_LEN = 130;            // tren toplam uzunluğu (görsel = hitbox)
const TRAIN_HEIGHT = 56;
const TRAIN_SCREEN_X = W * 0.28;  // tren ön burnu ekranda bu x'te

const PLATFORM_WIDTH = 96;        // peron toplam genişliği
const PERFECT_ZONE = 9;           // ±px peron ortasından (TAM duruş)
const GOOD_ZONE = 30;             // ±px (kabul edilir duruş)

const STATION_GAP_BASE_MIN = 360;
const STATION_GAP_BASE_MAX = 540;
const STATION_GAP_MIN_FLOOR = 260;
const GAP_SHRINK_PER_LEVEL = 16;  // her 4 servis sonrası min/max'ten düşülür

const LIVES_MAX = 3;

// ---------- Loop ----------
const FIXED_DT = 1 / 120;
const MAX_FRAME_TIME = 0.1;

const STORAGE_BEST = 'lokomotif.best';

const NAMES = [
  'Haydarpaşa', 'Sirkeci', 'Pendik', 'İzmit', 'Adapazarı', 'Bilecik',
  'Eskişehir', 'Polatlı', 'Ankara', 'Kayseri', 'Sivas', 'Afyon',
  'Konya', 'İzmir', 'Aydın', 'Manisa', 'Edirne', 'Çankırı', 'Karaman',
];

// ---------- DOM ----------
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let fuelEl!: HTMLElement;
let speedEl!: HTMLElement;
let livesEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

// ---------- Runtime ----------
const gen = createGenToken();
let state: State = 'ready';
let trainPos = 0;            // dünya x'i, trenin ön burnu (sağ uç)
let trainSpeed = 0;
let fuel = FUEL_MAX;
let lives = LIVES_MAX;
let score = 0;
let best = 0;
let nextStationSpawnX = 0;
let stations: Station[] = [];
let throttleHeld = false;
let brakeHeld = false;
let lastFrame = 0;
let accumulator = 0;
let rafId = 0;
let smoke: Particle[] = [];
let whistleTimer = 0;        // basit görsel düdük flash
let servedCount = 0;         // zorluk skalası için

const cssCache = new Map<string, string>();
function css(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const out = v || fallback;
  cssCache.set(varName, out);
  return out;
}

function rand(min: number, max: number): number { return min + Math.random() * (max - min); }
function pickName(): string { return NAMES[Math.floor(Math.random() * NAMES.length)]!; }

function currentGapRange(): [number, number] {
  const tier = Math.floor(servedCount / 4);
  const lo = Math.max(STATION_GAP_MIN_FLOOR, STATION_GAP_BASE_MIN - tier * GAP_SHRINK_PER_LEVEL);
  const hi = Math.max(lo + 80, STATION_GAP_BASE_MAX - tier * GAP_SHRINK_PER_LEVEL);
  return [lo, hi];
}

function spawnNextStation(): void {
  const [lo, hi] = currentGapRange();
  const gap = rand(lo, hi);
  const wx = nextStationSpawnX + gap;
  nextStationSpawnX = wx;
  stations.push({
    worldX: wx,
    startX: wx - PLATFORM_WIDTH / 2,
    endX: wx + PLATFORM_WIDTH / 2,
    name: pickName(),
    status: 'pending',
    resultLabel: '',
    resultColor: '',
    resultTimer: 0,
  });
}

function ensureStationsAhead(): void {
  while (stations.filter((s) => s.status === 'pending').length < 3) spawnNextStation();
}

function pruneStationsBehind(cameraX: number): void {
  stations = stations.filter((s) => s.endX + 240 > cameraX);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function reset(): void {
  gen.bump();
  state = 'ready';
  trainPos = 60;             // dünya başında biraz ileri
  trainSpeed = 0;
  fuel = FUEL_MAX;
  lives = LIVES_MAX;
  score = 0;
  servedCount = 0;
  throttleHeld = false;
  brakeHeld = false;
  whistleTimer = 0;
  nextStationSpawnX = 240;   // ilk peron biraz ileride, görünür
  stations = [];
  smoke = [];
  ensureStationsAhead();
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  lastFrame = 0;
  accumulator = 0;
  updateHud();
  draw();
  showOverlay(
    'Buharlı Lokomotif',
    '↑/W gaz · ↓/S fren · Boşluk düdük\nPeronun ortasındaki altın çizgide DUR.\nGaz/fren tuşuna bas: sefer başlar.',
  );
}

function startIfNeeded(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideOverlay();
  if (rafId === 0) {
    lastFrame = performance.now();
    accumulator = 0;
    const myGen = gen.current();
    const tick = (now: number): void => {
      if (!gen.isCurrent(myGen) || state !== 'playing') {
        rafId = 0;
        return;
      }
      rafId = requestAnimationFrame(tick);
      const dt = Math.min((now - lastFrame) / 1000, MAX_FRAME_TIME);
      lastFrame = now;
      accumulator += dt;
      while (accumulator >= FIXED_DT) {
        step(FIXED_DT);
        accumulator -= FIXED_DT;
        if (state !== 'playing') break;
      }
      draw();
      updateHud();
    };
    rafId = requestAnimationFrame(tick);
  }
}

function gameOver(reasonMsg: string): void {
  state = 'gameover';
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  draw();
  showOverlay('Sefer Bitti', `${reasonMsg}\nSkor: ${score}  ·  En iyi: ${best}\nR ile yeniden başla`);
}

function step(dt: number): void {
  // Throttle / brake / coast
  if (throttleHeld && fuel > 0) {
    trainSpeed = Math.min(trainSpeed + THROTTLE_ACCEL * dt, MAX_SPEED);
    fuel = Math.max(fuel - FUEL_BURN_THROTTLE * dt, 0);
    if (Math.random() < 0.5) emitSmoke(true);
  } else if (brakeHeld) {
    trainSpeed = Math.max(trainSpeed - BRAKE_DECEL * dt, 0);
  } else {
    trainSpeed = Math.max(trainSpeed - COAST_FRICTION * dt, 0);
    if (trainSpeed > 6 && Math.random() < 0.05) emitSmoke(false);
  }
  fuel = Math.max(fuel - FUEL_BURN_IDLE * dt, 0);

  trainPos += trainSpeed * dt;

  // Smoke update
  for (const p of smoke) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    p.size += 10 * dt;
  }
  smoke = smoke.filter((p) => p.life > 0);

  if (whistleTimer > 0) whistleTimer = Math.max(0, whistleTimer - dt);

  // Station evaluation
  for (const s of stations) {
    if (s.resultTimer > 0) {
      s.resultTimer = Math.max(0, s.resultTimer - dt);
      if (s.resultTimer === 0) s.resultLabel = '';
    }
    if (s.status !== 'pending') continue;

    const inZone = trainPos >= s.startX && trainPos <= s.endX;
    const stopped = trainSpeed <= STOP_THRESHOLD;

    if (inZone && stopped) {
      const dist = Math.abs(trainPos - s.worldX);
      if (dist <= PERFECT_ZONE) {
        s.status = 'served';
        s.resultLabel = 'TAM ORTA! +2';
        s.resultColor = css('--loko-zone-perfect', '#f5c542');
        s.resultTimer = 1.6;
        score += 2;
        fuel = Math.min(fuel + FUEL_REWARD_PERFECT, FUEL_MAX);
        servedCount++;
      } else if (dist <= GOOD_ZONE) {
        s.status = 'served';
        s.resultLabel = '+1';
        s.resultColor = '#86efac';
        s.resultTimer = 1.6;
        score += 1;
        fuel = Math.min(fuel + FUEL_REWARD_GOOD, FUEL_MAX);
        servedCount++;
      }
      // dist > GOOD_ZONE: zone içinde ama çok kenarda durdu — kaçırma sayma,
      // oyuncu gaz basarak ileri kayabilir; sağa geçince zaten endX trigger'ı çalışır.
    }

    if (trainPos > s.endX && s.status === 'pending') {
      s.status = 'missed';
      s.resultLabel = 'KAÇTI -1';
      s.resultColor = '#fca5a5';
      s.resultTimer = 1.6;
      lives--;
      if (lives <= 0) {
        gameOver('Üç istasyon kaçırdın, sefer iptal.');
        return;
      }
    }
  }

  ensureStationsAhead();
  pruneStationsBehind(trainPos - TRAIN_SCREEN_X);

  if (fuel <= 0 && trainSpeed <= STOP_THRESHOLD) {
    gameOver('Yakıt bitti, lokomotif durdu.');
    return;
  }
}

function emitSmoke(active: boolean): void {
  const baseY = -TRAIN_HEIGHT - 12;
  smoke.push({
    x: trainPos - TRAIN_LEN + 24 + (Math.random() - 0.5) * 6,
    y: baseY,
    vx: -22 - Math.random() * 14,
    vy: -28 - Math.random() * 16,
    life: active ? 1.6 : 1.0,
    size: active ? 6 + Math.random() * 3 : 4 + Math.random() * 2,
  });
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  fuelEl.textContent = `${Math.round(fuel)}%`;
  speedEl.textContent = String(Math.round(trainSpeed));
  const filled = Math.max(0, lives);
  livesEl.textContent = '★'.repeat(filled) + '☆'.repeat(LIVES_MAX - filled);
}

// ---------- Draw ----------
function draw(): void {
  ctx.clearRect(0, 0, W, H);
  const cameraX = trainPos - TRAIN_SCREEN_X;
  const groundY = H * 0.72;     // raylar burada

  drawMountains(cameraX, groundY);
  drawGround(groundY, cameraX);
  drawStations(cameraX, groundY);
  drawSmoke(cameraX, groundY);
  drawTrain(cameraX, groundY);
  drawDirectionalHints(cameraX, groundY);
}

function drawMountains(cameraX: number, groundY: number): void {
  // Uzak sıra (yavaş parallax)
  ctx.fillStyle = css('--loko-mountain-far', '#2a4055');
  drawMountainStrip(cameraX * 0.2, groundY - 30, 110, 60);
  // Yakın sıra
  ctx.fillStyle = css('--loko-mountain-near', '#1f2f3d');
  drawMountainStrip(cameraX * 0.45, groundY - 8, 80, 90);
}

function drawMountainStrip(offset: number, baseY: number, period: number, peak: number): void {
  const start = -((offset % period) + period) % period;
  ctx.beginPath();
  ctx.moveTo(start - period, baseY + peak);
  for (let x = start - period; x < W + period; x += period) {
    ctx.lineTo(x + period / 2, baseY - peak * 0.5);
    ctx.lineTo(x + period, baseY + peak);
  }
  ctx.lineTo(W + period, baseY + peak);
  ctx.lineTo(start - period, baseY + peak);
  ctx.closePath();
  ctx.fill();
}

function drawGround(groundY: number, cameraX: number): void {
  ctx.fillStyle = css('--loko-ground', '#4e342e');
  ctx.fillRect(0, groundY, W, H - groundY);
  // İki ray çizgisi
  ctx.strokeStyle = css('--loko-rail', '#1c1c1c');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY - 5);
  ctx.lineTo(W, groundY - 5);
  ctx.moveTo(0, groundY - 15);
  ctx.lineTo(W, groundY - 15);
  ctx.stroke();
  // Travers (sleepers) parallax
  const gap = 28;
  const offset = ((-cameraX) % gap + gap) % gap;
  ctx.fillStyle = css('--loko-sleeper', '#2d1b13');
  for (let x = -offset; x < W + gap; x += gap) {
    ctx.fillRect(x, groundY - 3, 18, 6);
  }
}

function drawStations(cameraX: number, groundY: number): void {
  for (const s of stations) {
    const xMid = s.worldX - cameraX;
    if (xMid + 200 < 0 || xMid - 200 > W) continue;

    const platTop = groundY - 28;
    const platLeft = s.startX - cameraX;
    const platRight = s.endX - cameraX;

    // Iyi zone (yumuşak yeşil bant)
    ctx.fillStyle = css('--loko-zone-good', 'rgba(120,200,80,0.32)');
    ctx.fillRect(xMid - GOOD_ZONE, groundY - 5, GOOD_ZONE * 2, 5);

    // Mükemmel orta çizgi
    ctx.fillStyle = css('--loko-zone-perfect', '#f5c542');
    ctx.fillRect(xMid - PERFECT_ZONE, groundY - 5, PERFECT_ZONE * 2, 5);

    // Peron (raise platform behind rail)
    ctx.fillStyle = css('--loko-platform', '#cfa674');
    ctx.fillRect(platLeft, platTop, platRight - platLeft, 28);

    // Peron çatısı (üst)
    ctx.fillStyle = css('--loko-platform-roof', '#5d3a1f');
    ctx.fillRect(platLeft - 6, platTop - 26, platRight - platLeft + 12, 6);
    // Çatı sütunları
    ctx.fillRect(platLeft + 4, platTop - 24, 4, 24);
    ctx.fillRect(platRight - 8, platTop - 24, 4, 24);

    // İstasyon tabelası (orta üst)
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1c1c1c';
    ctx.lineWidth = 1;
    const tagW = Math.max(60, s.name.length * 8);
    const tagX = xMid - tagW / 2;
    const tagY = platTop - 46;
    ctx.fillRect(tagX, tagY, tagW, 16);
    ctx.strokeRect(tagX, tagY, tagW, 16);
    ctx.fillStyle = '#1c1c1c';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.name, xMid, tagY + 8);

    // Status badge (served = ✓, missed = ✗)
    if (s.status === 'served') {
      ctx.fillStyle = '#16a34a';
      ctx.font = 'bold 16px system-ui';
      ctx.fillText('✓', xMid, tagY - 12);
    } else if (s.status === 'missed') {
      ctx.fillStyle = '#dc2626';
      ctx.font = 'bold 16px system-ui';
      ctx.fillText('✗', xMid, tagY - 12);
    }

    // Floating result label
    if (s.resultTimer > 0 && s.resultLabel) {
      const t = s.resultTimer / 1.6;
      ctx.globalAlpha = Math.max(0, Math.min(1, t * 1.3));
      ctx.fillStyle = s.resultColor;
      ctx.font = 'bold 18px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(s.resultLabel, xMid, platTop - 60 - (1 - t) * 20);
      ctx.globalAlpha = 1;
    }
  }
}

function drawSmoke(cameraX: number, groundY: number): void {
  for (const p of smoke) {
    const alpha = Math.max(0, Math.min(1, p.life / 1.6));
    ctx.fillStyle = `rgba(220,220,220,${alpha * 0.65})`;
    ctx.beginPath();
    ctx.arc(p.x - cameraX, groundY + p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTrain(cameraX: number, groundY: number): void {
  // trainPos = trenin ön burnu (sağ uç) dünya x
  const noseX = trainPos - cameraX;
  const tailX = noseX - TRAIN_LEN;
  const bodyTop = groundY - TRAIN_HEIGHT - 4;
  const bodyBot = groundY - 4;

  // Cowcatcher (ön kar süpürgesi)
  ctx.fillStyle = css('--loko-train-cabin', '#4a1e1e');
  ctx.beginPath();
  ctx.moveTo(noseX, bodyBot);
  ctx.lineTo(noseX, bodyBot - 14);
  ctx.lineTo(noseX - 18, bodyBot);
  ctx.closePath();
  ctx.fill();

  // Boiler (silindirik gövde)
  const boilerLeft = tailX + 38;
  const boilerRight = noseX - 6;
  const boilerH = 38;
  const boilerTop = bodyBot - boilerH;
  ctx.fillStyle = css('--loko-train-body', '#b71c1c');
  ctx.fillRect(boilerLeft, boilerTop, boilerRight - boilerLeft, boilerH);
  // Boiler bantları (altın trim)
  ctx.fillStyle = css('--loko-train-trim', '#f5d76e');
  ctx.fillRect(boilerLeft, boilerTop, boilerRight - boilerLeft, 3);
  ctx.fillRect(boilerLeft, boilerTop + boilerH - 3, boilerRight - boilerLeft, 3);
  // Smokebox (ön daire)
  ctx.fillStyle = css('--loko-train-cabin', '#4a1e1e');
  ctx.beginPath();
  ctx.arc(noseX - 8, boilerTop + boilerH / 2, boilerH / 2, -Math.PI / 2, Math.PI / 2);
  ctx.fill();
  ctx.fillStyle = css('--loko-train-trim', '#f5d76e');
  ctx.beginPath();
  ctx.arc(noseX - 12, boilerTop + boilerH / 2, 5, 0, Math.PI * 2);
  ctx.fill();
  // Chimney
  const chimX = boilerLeft + 18;
  ctx.fillStyle = css('--loko-train-cabin', '#4a1e1e');
  ctx.fillRect(chimX - 7, boilerTop - 18, 14, 20);
  ctx.fillStyle = css('--loko-train-trim', '#f5d76e');
  ctx.fillRect(chimX - 9, boilerTop - 22, 18, 4);
  // Steam dome
  ctx.fillStyle = css('--loko-train-trim', '#f5d76e');
  ctx.beginPath();
  ctx.arc(boilerLeft + 50, boilerTop - 4, 6, Math.PI, 2 * Math.PI);
  ctx.fill();

  // Cabin (arka kabin)
  const cabinLeft = tailX;
  const cabinRight = boilerLeft;
  const cabinTop = bodyBot - boilerH - 12;
  ctx.fillStyle = css('--loko-train-cabin', '#4a1e1e');
  ctx.fillRect(cabinLeft, cabinTop, cabinRight - cabinLeft, bodyBot - cabinTop);
  // Cabin window
  ctx.fillStyle = '#cfa674';
  ctx.fillRect(cabinLeft + 8, cabinTop + 6, cabinRight - cabinLeft - 16, 12);
  // Cabin trim
  ctx.fillStyle = css('--loko-train-trim', '#f5d76e');
  ctx.fillRect(cabinLeft, cabinTop, cabinRight - cabinLeft, 3);

  // Wheels (3 büyük, 1 küçük öncü)
  const wheelY = bodyBot;
  const bigR = 11;
  const smallR = 6;
  ctx.fillStyle = '#1c1c1c';
  ctx.strokeStyle = css('--loko-train-trim', '#f5d76e');
  ctx.lineWidth = 2;
  const wheels: Array<[number, number]> = [
    [noseX - 30, smallR],
    [cabinLeft + 14, bigR],
    [cabinLeft + 42, bigR],
    [cabinLeft + 70, bigR],
  ];
  // Wheel rotation: dünya pozisyonuna göre
  const rot = (trainPos / 30) * Math.PI;
  for (const [wx, r] of wheels) {
    ctx.beginPath();
    ctx.arc(wx, wheelY - r, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(wx, wheelY - r, r - 2, 0, Math.PI * 2);
    ctx.stroke();
    // Spoke
    ctx.save();
    ctx.translate(wx, wheelY - r);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(-r + 2, 0);
    ctx.lineTo(r - 2, 0);
    ctx.stroke();
    ctx.restore();
  }

  // Connecting rod (büyük tekerlekleri bağlayan çubuk)
  ctx.strokeStyle = css('--loko-train-trim', '#f5d76e');
  ctx.lineWidth = 3;
  const rodOffsetY = Math.sin(rot) * 3;
  ctx.beginPath();
  ctx.moveTo(cabinLeft + 14, wheelY - bigR + rodOffsetY);
  ctx.lineTo(cabinLeft + 70, wheelY - bigR + rodOffsetY);
  ctx.stroke();

  // Whistle flash
  if (whistleTimer > 0) {
    const a = whistleTimer / 0.4;
    ctx.fillStyle = `rgba(245,215,110,${a * 0.6})`;
    ctx.beginPath();
    ctx.arc(chimX, boilerTop - 24, 18 + (1 - a) * 14, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawDirectionalHints(cameraX: number, groundY: number): void {
  // Next pending station distance indicator (top-left corner)
  const next = stations.find((s) => s.status === 'pending');
  if (!next) return;
  const dist = next.worldX - trainPos;
  const labelY = 22;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(`→ ${next.name}: ${Math.max(0, Math.round(dist))} m`, 12, labelY);

  // Arrow at top if station is offscreen to right
  const nextScreenX = next.worldX - cameraX;
  if (nextScreenX > W - 20) {
    ctx.fillStyle = '#f5c542';
    ctx.beginPath();
    ctx.moveTo(W - 18, 36);
    ctx.lineTo(W - 8, 30);
    ctx.lineTo(W - 18, 24);
    ctx.closePath();
    ctx.fill();
  }
}

// ---------- Input ----------
function handleKey(e: KeyboardEvent, down: boolean): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') {
    if (state === 'ready' && down) startIfNeeded();
    throttleHeld = down;
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    if (state === 'ready' && down) startIfNeeded();
    brakeHeld = down;
    e.preventDefault();
  } else if (k === ' ' && down) {
    if (state === 'ready') startIfNeeded();
    if (state === 'playing') whistleTimer = 0.4;
    e.preventDefault();
  } else if (k === 'r' && down) {
    reset();
    e.preventDefault();
  } else if ((k === 'enter') && down) {
    if (state === 'gameover') reset();
  }
}

function bindTouchButton(btn: HTMLButtonElement, action: 'throttle' | 'brake' | 'whistle'): void {
  const onDown = (e: Event): void => {
    e.preventDefault();
    if (state === 'gameover') return;
    if (state === 'ready') startIfNeeded();
    if (action === 'throttle') throttleHeld = true;
    else if (action === 'brake') brakeHeld = true;
    else if (action === 'whistle') whistleTimer = 0.4;
  };
  const onUp = (e: Event): void => {
    e.preventDefault();
    if (action === 'throttle') throttleHeld = false;
    else if (action === 'brake') brakeHeld = false;
  };
  btn.addEventListener('pointerdown', onDown);
  btn.addEventListener('pointerup', onUp);
  btn.addEventListener('pointercancel', onUp);
  btn.addEventListener('pointerleave', onUp);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  fuelEl = document.querySelector<HTMLElement>('#fuel')!;
  speedEl = document.querySelector<HTMLElement>('#speed')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', (e) => handleKey(e, true));
  window.addEventListener('keyup', (e) => handleKey(e, false));

  restartBtn.addEventListener('click', reset);

  document.querySelectorAll<HTMLButtonElement>('.loko-touch__btn').forEach((btn) => {
    const action = btn.dataset.action as 'throttle' | 'brake' | 'whistle' | undefined;
    if (action) bindTouchButton(btn, action);
  });

  reset();
}

export const game = defineGame({ init, reset });
