import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Yörünge — yerçekimi kuyularını yerleştirip uyduyu hedefe sapla.
//
// Akış: ready → placing → simulating → (won|lost) → placing/next.
//   placing:    boş alana tıkla → kuyu ekle. Kuyu üstüne tıkla → kaldır.
//   simulating: Fırlat / Boşluk → uydu sabit hızla doğar, kuyular ters-kare
//               yasayla çekim uygular. Hedef halkasına girerse won.
//
// PITFALLS:
// - module-level-dom-access / unguarded-storage: tüm DOM ve storage init() içinde.
// - stale-async-callback: RAF loop generation token'a bağlı; reset() bump'lar.
// - visual-vs-hitbox: kuyu çekirdeği yarıçapı (CORE_R), hedef yarıçapı (GOAL_R),
//   uydu yarıçapı (SAT_R) tek const blokta; hem draw() hem fiziği aynı kaynaktan.
// - overlay-input-leak: state guard her input handler'ın başında.
// - missing-overlay-css: scaffold style.css'ten overlay bloğu korunuyor.

const STORAGE_BEST = 'yorunge.best';

type Phase = 'placing' | 'simulating' | 'won' | 'lost';

type Vec = { x: number; y: number };
type Well = Vec;
type Asteroid = { x: number; y: number; r: number };

type Level = {
  start: Vec;
  vel: Vec;              // başlangıç hız vektörü (px/sec)
  goal: Vec;             // hedef merkezi
  wells: number;         // kullanılabilir kuyu sayısı
  asteroids: Asteroid[]; // engeller
};

// ---------- Sabitler (visual = hitbox tek kaynak) ----------
const W = 360;
const H = 540;

const SAT_R = 5;          // uydu görsel + fizik yarıçapı
const GOAL_R = 22;        // hedef halkası — uydu merkezi bu mesafede olmalı
const WELL_RING_R = 14;   // çizilen halka yarıçapı (görsel)
const CORE_R = 9;         // ölümcül çekirdek (yakın geçişte çarpışma)
const MIN_PLACE_DIST = 18; // kuyuları birbirine ve uydu/hedefe yapıştırma

// G ve hız dengesi: sat ~80 px/s'lik bir hızda canvas'ı ~4 sn'de geçer; G=350000 ile
// r=60 px'de ivme ~97 px/s² → 0.5 sn'lik yakın geçişte vy ~50 px/s edinilir. Bu ölçek
// hem belirgin saptırma sağlar hem de orbital sapmaya yetecek yavaşlığı korur.
const G = 350000;
const MIN_DIST = 14;      // çekim formülünde min yarıçap (singularity guard; SAT_R+CORE_R'a yakın)
const SIM_TIMEOUT_S = 9;  // her fırlatma için max süre
const FIXED_DT = 1 / 120; // sabit timestep
const MAX_FRAME_DT = 1 / 30;
const TRAIL_MAX = 240;

const gen = createGenToken();

// ---------- DOM ----------
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let wellsEl!: HTMLElement;
let launchBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

// ---------- Oyun durumu ----------
let phase: Phase = 'placing';
let levelIdx = 0;
let bestLevel = 1;
let placed: Well[] = [];
let trail: Vec[] = [];

// simülasyon
let satPos: Vec = { x: 0, y: 0 };
let satVel: Vec = { x: 0, y: 0 };
let simAcc = 0;
let simElapsed = 0;
let lastFrameMs = 0;

// ---------- Bölümler ----------
// Tasarım notu: ilk birkaç bölüm tek kuyuyla çözülebilir; ilerleyince hem
// hedef daha uzak hem engel sayısı artar; kuyu sayısı 1→3 arası değişir.
const LEVELS: Level[] = [
  // 1: yatay yol; hedef sat'ın doğal yolunun altında. Kuyuyu yolun ilerisine
  // ve hedefin az ötesine koy → cazibe sat'ı aşağı büker, hedefte buluşur.
  {
    start: { x: 30, y: 120 },
    vel: { x: 85, y: 0 },
    goal: { x: 300, y: 340 },
    wells: 1,
    asteroids: [],
  },
  // 2: aşağı çapraz başla → karşı köşeye yukarı bük.
  {
    start: { x: 30, y: 460 },
    vel: { x: 90, y: -30 },
    goal: { x: 310, y: 120 },
    wells: 1,
    asteroids: [],
  },
  // 3: hafif aşağı çapraz; tam orta hatta engel.
  {
    start: { x: 30, y: 200 },
    vel: { x: 90, y: 20 },
    goal: { x: 310, y: 380 },
    wells: 1,
    asteroids: [{ x: 175, y: 280, r: 24 }],
  },
  // 4: yatay yol; iki asteroit zikzaklı koridor.
  {
    start: { x: 30, y: 270 },
    vel: { x: 90, y: 0 },
    goal: { x: 310, y: 270 },
    wells: 2,
    asteroids: [
      { x: 150, y: 240, r: 22 },
      { x: 240, y: 300, r: 22 },
    ],
  },
  // 5: çapraz yol; iki asteroit dirsekli güzergah.
  {
    start: { x: 30, y: 100 },
    vel: { x: 90, y: 20 },
    goal: { x: 310, y: 440 },
    wells: 2,
    asteroids: [
      { x: 150, y: 200, r: 22 },
      { x: 240, y: 360, r: 22 },
    ],
  },
  // 6: dar koridor — dört engel arasında ince çizgi.
  {
    start: { x: 30, y: 270 },
    vel: { x: 100, y: 0 },
    goal: { x: 310, y: 270 },
    wells: 3,
    asteroids: [
      { x: 130, y: 210, r: 18 },
      { x: 130, y: 330, r: 18 },
      { x: 235, y: 210, r: 18 },
      { x: 235, y: 330, r: 18 },
    ],
  },
  // 7: ters S yörüngesi; üç asteroit etrafında dolaş.
  {
    start: { x: 30, y: 120 },
    vel: { x: 90, y: 30 },
    goal: { x: 30, y: 440 },
    wells: 3,
    asteroids: [
      { x: 170, y: 270, r: 26 },
      { x: 290, y: 180, r: 18 },
      { x: 290, y: 380, r: 18 },
    ],
  },
];

function currentLevel(): Level {
  return LEVELS[levelIdx % LEVELS.length]!;
}

// ---------- Tema renkleri (CSS değişken cache) ----------
const cssCache = new Map<string, string>();
function getCss(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const out = val || fallback;
  cssCache.set(varName, out);
  return out;
}

// ---------- HUD ----------
function updateHud(): void {
  scoreEl.textContent = String(levelIdx + 1);
  bestEl.textContent = String(bestLevel);
  const lvl = currentLevel();
  wellsEl.textContent = `${placed.length}/${lvl.wells}`;
  launchBtn.disabled = phase !== 'placing' || placed.length === 0;
}

// ---------- Çizim ----------
function clear(): void {
  ctx.fillStyle = getCss('--surface', '#11131a');
  ctx.fillRect(0, 0, W, H);
}

function drawStars(): void {
  // Sabit tohumla pseudo-random yıldız serpilmesi (her frame aynı).
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  let seed = 1337;
  for (let i = 0; i < 60; i++) {
    seed = (seed * 16807) % 2147483647;
    const x = (seed % 1000) / 1000 * W;
    seed = (seed * 16807) % 2147483647;
    const y = (seed % 1000) / 1000 * H;
    seed = (seed * 16807) % 2147483647;
    const r = ((seed % 1000) / 1000) * 0.8 + 0.3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWell(w: Well): void {
  // Dış çekim halkası — sarı/turuncu degrade.
  const grd = ctx.createRadialGradient(w.x, w.y, CORE_R, w.x, w.y, WELL_RING_R + 16);
  grd.addColorStop(0, 'rgba(255,170,40,0.55)');
  grd.addColorStop(1, 'rgba(255,170,40,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(w.x, w.y, WELL_RING_R + 16, 0, Math.PI * 2);
  ctx.fill();

  // Halka çizgisi
  ctx.strokeStyle = 'rgba(255,200,90,0.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(w.x, w.y, WELL_RING_R, 0, Math.PI * 2);
  ctx.stroke();

  // Çekirdek (ölümcül)
  ctx.fillStyle = '#ffb43a';
  ctx.beginPath();
  ctx.arc(w.x, w.y, CORE_R * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(w.x, w.y, CORE_R, 0, Math.PI * 2);
  ctx.stroke();
}

function drawGoal(): void {
  const lvl = currentLevel();
  ctx.save();
  // İç dolgu
  ctx.fillStyle = 'rgba(60,200,120,0.18)';
  ctx.beginPath();
  ctx.arc(lvl.goal.x, lvl.goal.y, GOAL_R, 0, Math.PI * 2);
  ctx.fill();
  // Halka
  ctx.strokeStyle = 'rgba(80,220,140,0.95)';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.arc(lvl.goal.x, lvl.goal.y, GOAL_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawAsteroids(): void {
  const lvl = currentLevel();
  for (const a of lvl.asteroids) {
    ctx.fillStyle = '#3a1f24';
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e24a4a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawSatellite(): void {
  ctx.fillStyle = '#7ad3ff';
  ctx.beginPath();
  ctx.arc(satPos.x, satPos.y, SAT_R, 0, Math.PI * 2);
  ctx.fill();
  // glow
  ctx.strokeStyle = 'rgba(122,211,255,0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(satPos.x, satPos.y, SAT_R + 3, 0, Math.PI * 2);
  ctx.stroke();
}

function drawTrail(): void {
  if (trail.length < 2) return;
  ctx.strokeStyle = 'rgba(122,211,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const p0 = trail[0]!;
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < trail.length; i++) {
    const p = trail[i]!;
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawStartArrow(): void {
  if (phase !== 'placing') return;
  const lvl = currentLevel();
  const s = lvl.start;
  const v = lvl.vel;
  const len = Math.hypot(v.x, v.y);
  if (len < 1) return;
  const ux = v.x / len;
  const uy = v.y / len;
  const tipX = s.x + ux * 32;
  const tipY = s.y + uy * 32;
  ctx.strokeStyle = 'rgba(122,211,255,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  // ok başı
  const ang = Math.atan2(uy, ux);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - 7 * Math.cos(ang - 0.4), tipY - 7 * Math.sin(ang - 0.4));
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - 7 * Math.cos(ang + 0.4), tipY - 7 * Math.sin(ang + 0.4));
  ctx.stroke();
  // başlangıç noktası
  ctx.fillStyle = '#7ad3ff';
  ctx.beginPath();
  ctx.arc(s.x, s.y, SAT_R, 0, Math.PI * 2);
  ctx.fill();
}

function render(): void {
  clear();
  drawStars();
  drawAsteroids();
  drawGoal();
  for (const w of placed) drawWell(w);
  drawTrail();
  if (phase === 'placing') {
    drawStartArrow();
  } else {
    drawSatellite();
  }
}

// ---------- Yerleştirme ----------
function pointInCanvas(p: Vec): boolean {
  return p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
}

function distSq(a: Vec, b: Vec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function findWellNear(p: Vec): number {
  // Mevcut bir kuyuya yeterince yakın mı? (tıkla → kaldır)
  for (let i = 0; i < placed.length; i++) {
    if (distSq(placed[i]!, p) <= (WELL_RING_R + 4) ** 2) return i;
  }
  return -1;
}

function canPlaceAt(p: Vec): boolean {
  if (!pointInCanvas(p)) return false;
  const lvl = currentLevel();
  // Başlangıç noktasına ve hedef merkezine fazla yakın olmasın
  if (distSq(p, lvl.start) < (GOAL_R + MIN_PLACE_DIST) ** 2) return false;
  if (distSq(p, lvl.goal) < (GOAL_R + MIN_PLACE_DIST) ** 2) return false;
  // Diğer kuyulara çok yakın olmasın
  for (const w of placed) {
    if (distSq(p, w) < (WELL_RING_R * 2 + 4) ** 2) return false;
  }
  // Asteroitlere değmesin (yerleşim aşaması)
  for (const a of lvl.asteroids) {
    if (distSq(p, a) < (a.r + CORE_R) ** 2) return false;
  }
  return true;
}

function placeOrToggle(p: Vec): void {
  if (phase !== 'placing') return;
  const lvl = currentLevel();
  const idx = findWellNear(p);
  if (idx >= 0) {
    placed.splice(idx, 1);
    updateHud();
    render();
    return;
  }
  if (placed.length >= lvl.wells) return;
  if (!canPlaceAt(p)) return;
  placed.push({ x: p.x, y: p.y });
  updateHud();
  render();
}

// ---------- Simülasyon ----------
function startSimulation(): void {
  if (phase !== 'placing') return;
  if (placed.length === 0) return;
  const lvl = currentLevel();
  satPos = { x: lvl.start.x, y: lvl.start.y };
  satVel = { x: lvl.vel.x, y: lvl.vel.y };
  trail = [{ x: satPos.x, y: satPos.y }];
  simAcc = 0;
  simElapsed = 0;
  phase = 'simulating';
  hideOverlayEl(overlay);
  updateHud();
  const myGen = gen.current();
  lastFrameMs = performance.now();
  requestAnimationFrame(function loop(t: number) {
    if (myGen !== gen.current()) return;
    if (phase !== 'simulating') return;
    let dt = (t - lastFrameMs) / 1000;
    lastFrameMs = t;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    simAcc += dt;
    while (simAcc >= FIXED_DT) {
      step(FIXED_DT);
      simAcc -= FIXED_DT;
      if (phase !== 'simulating') break;
    }
    render();
    if (phase === 'simulating') requestAnimationFrame(loop);
  });
}

function step(dt: number): void {
  // Tüm kuyuların kuvvetlerini topla.
  let ax = 0;
  let ay = 0;
  for (const w of placed) {
    const dx = w.x - satPos.x;
    const dy = w.y - satPos.y;
    let r2 = dx * dx + dy * dy;
    if (r2 < MIN_DIST * MIN_DIST) r2 = MIN_DIST * MIN_DIST;
    const r = Math.sqrt(r2);
    const f = G / r2;
    ax += (dx / r) * f;
    ay += (dy / r) * f;
  }
  satVel.x += ax * dt;
  satVel.y += ay * dt;
  satPos.x += satVel.x * dt;
  satPos.y += satVel.y * dt;
  simElapsed += dt;

  trail.push({ x: satPos.x, y: satPos.y });
  if (trail.length > TRAIL_MAX) trail.shift();

  const lvl = currentLevel();

  // Hedef? (uydu hedef halkasına dokunduğunda — overlap eşiği).
  // Touch threshold (GOAL_R + SAT_R) hızlı geçen uydu için adil; fully-inside
  // (GOAL_R - SAT_R) çok dar bir basin yaratıyordu.
  if (distSq(satPos, lvl.goal) <= (GOAL_R + SAT_R) ** 2) {
    win();
    return;
  }
  // Kuyu çekirdeğine çarpma
  for (const w of placed) {
    if (distSq(satPos, w) <= (CORE_R + SAT_R) ** 2) {
      lose('Uydun kuyunun çekirdeğine çekildi.');
      return;
    }
  }
  // Asteroit
  for (const a of lvl.asteroids) {
    if (distSq(satPos, a) <= (a.r + SAT_R) ** 2) {
      lose('Asteroite çarptın.');
      return;
    }
  }
  // Ekran dışı
  if (
    satPos.x < -10 ||
    satPos.x > W + 10 ||
    satPos.y < -10 ||
    satPos.y > H + 10
  ) {
    lose('Uydun yörüngeden çıktı.');
    return;
  }
  // Zaman aşımı
  if (simElapsed > SIM_TIMEOUT_S) {
    lose('Süre doldu.');
    return;
  }
}

function win(): void {
  phase = 'won';
  if (levelIdx + 1 > bestLevel) {
    bestLevel = levelIdx + 1;
    safeWrite(STORAGE_BEST, bestLevel);
  }
  overlayTitle.textContent = 'Bölüm Tamam!';
  const nextIdx = (levelIdx + 1) % LEVELS.length;
  const lap = Math.floor((levelIdx + 1) / LEVELS.length);
  const note = lap > 0 && nextIdx === 0 ? ' (yeniden döngü)' : '';
  overlayMsg.textContent = `Bölüm ${levelIdx + 1} bitti. Sonraki bölüm: ${nextIdx + 1}${note}. Devam için Boşluk / N veya Fırlat.`;
  showOverlayEl(overlay);
  updateHud();
}

function lose(reason: string): void {
  phase = 'lost';
  overlayTitle.textContent = 'Yeniden Dene';
  overlayMsg.textContent = `${reason} Kuyularını ayarla, Fırlat'a tekrar bas. (R: sıfırla)`;
  showOverlayEl(overlay);
  // Kullanıcının kuyularını koru ki ince ayar yapsın.
  updateHud();
}

// ---------- Geçişler ----------
function setupLevel(idx: number, opts: { keepWells?: boolean } = {}): void {
  gen.bump();
  levelIdx = ((idx % LEVELS.length) + LEVELS.length) % LEVELS.length;
  phase = 'placing';
  if (!opts.keepWells) placed = [];
  trail = [];
  const lvl = currentLevel();
  satPos = { x: lvl.start.x, y: lvl.start.y };
  satVel = { x: lvl.vel.x, y: lvl.vel.y };
  overlayTitle.textContent = `Bölüm ${levelIdx + 1}`;
  overlayMsg.textContent = `${lvl.wells} kuyu kullanabilirsin. Boş alana dokunarak yerleştir, Fırlat'a bas.`;
  showOverlayEl(overlay);
  updateHud();
  render();
}

function reset(): void {
  // Tüm oyunu sıfırlama: ilk bölüme dön, kuyuları sil.
  setupLevel(0, { keepWells: false });
}

function nextLevel(): void {
  setupLevel(levelIdx + 1, { keepWells: false });
}

function retryLevel(): void {
  // Aynı bölüme dön, kuyuları koru.
  setupLevel(levelIdx, { keepWells: true });
}

// ---------- Input ----------
function canvasPointFromEvent(e: PointerEvent): Vec {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * W;
  const y = ((e.clientY - rect.top) / rect.height) * H;
  return { x, y };
}

function onCanvasPointer(e: PointerEvent): void {
  if (phase === 'placing') {
    const p = canvasPointFromEvent(e);
    placeOrToggle(p);
  } else if (phase === 'won' || phase === 'lost') {
    // Overlay tıklaması: oyuncu rahat hissetsin diye devam tetikleyici
    e.preventDefault();
    if (phase === 'won') nextLevel();
    else retryLevel();
  }
}

function onOverlayPointer(e: PointerEvent): void {
  e.preventDefault();
  if (phase === 'won') {
    nextLevel();
    return;
  }
  if (phase === 'lost') {
    retryLevel();
    return;
  }
  if (phase === 'placing') {
    // Overlay placing fazında bilgilendirme — tıklama hem overlay'i gizler
    // hem de tıklanan noktayı bir kuyu yerleştirme denemesi olarak iletir.
    // Aksi halde kullanıcı iki kez tıklamak zorunda kalırdı (UX leak).
    hideOverlayEl(overlay);
    placeOrToggle(canvasPointFromEvent(e));
  }
}

function onLaunch(): void {
  if (phase === 'placing') {
    startSimulation();
  } else if (phase === 'won') {
    nextLevel();
  } else if (phase === 'lost') {
    retryLevel();
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.repeat) return;
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    onLaunch();
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    if (phase === 'placing' || phase === 'lost') {
      // bir sonraki bölümü atla
      nextLevel();
    } else if (phase === 'won') {
      nextLevel();
    }
  }
}

// ---------- init ----------
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  wellsEl = document.querySelector<HTMLElement>('#wells')!;
  launchBtn = document.querySelector<HTMLButtonElement>('#launch')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  const storedBest = safeRead<number>(STORAGE_BEST, 1);
  bestLevel = typeof storedBest === 'number' && storedBest >= 1 ? storedBest : 1;

  canvas.addEventListener('pointerdown', onCanvasPointer);
  overlay.addEventListener('pointerdown', onOverlayPointer);
  launchBtn.addEventListener('click', onLaunch);
  restartBtn.addEventListener('click', reset);
  window.addEventListener('keydown', onKey);

  setupLevel(0, { keepWells: false });
}

export const game = defineGame({ init, reset });
