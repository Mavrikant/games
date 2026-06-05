import { defineGame } from '@shared/game-module';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

// Sky Jump — sonsuz dikey tırmanış (Doodle Jump tarzı).
// - Karakter platforma değdiğinde otomatik zıplar (sabit zıplama gücü).
// - Yatay kontrol: sol/sağ ok, A/D, veya mobil ekranın sol/sağ yarısına tap-and-hold.
// - Yan kenar wrap (sol kenardan çıkan sağdan girer — Doodle Jump kuralı).
// - 3 platform tipi: Normal (gri), Hareketli (mavi, yatay osilasyon), Kırılgan (kahverengi).
// - Skor = en yüksek tırmanılan metre. localStorage'da `sky-jump.bestHeight`.
//
// PITFALLS hatırlatması:
// - visual-vs-hitbox: tüm boyutlar tek const bloğunda; draw() ve collide() aynı kaynaktan.
// - frame-rate-dependent-physics: Fixed-timestep simulation (FIXED_DT = 1/120 s).
// - stale-async-callback: Yok — RAF tek loop, generation token reset() ile bump ediliyor.
// - invisible-boot: İlk draw() module-init sonunda; karakter ilk frame'de görünür alanda spawn.
// - unguarded-storage: safeRead/safeWrite helper'ları.

type State = 'ready' | 'playing' | 'gameover';
type PlatformType = 'normal' | 'moving' | 'fragile';

type Platform = {
  x: number;        // sol kenar (logical px)
  y: number;        // dünya koordinatlarında y (yukarı = yüksek değer; top = scroll)
  w: number;        // genişlik
  type: PlatformType;
  vx: number;       // hareketli için yatay hız (px/sec)
  used: boolean;    // kırılgan: bir kez zıplandı mı
  brokenAt: number; // kırılgan: kırılma zamanı (performance.now()/1000)
  broken: boolean;  // kırıldı mı (artık görünmez)
};

// ---------- DOM ----------
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

// ---------- Sabitler ----------
// Logical viewport (mantıksal piksel). Canvas backing store DPR ile ölçeklenir.
const W = 360;
const H = 600;

// Karakter (görsel + hitbox aynı sabitlerden — visual-vs-hitbox pitfall'a karşı).
const PLAYER_BODY_W = 28;     // gövde genişliği (oval karakter)
const PLAYER_BODY_H = 32;     // gövde yüksekliği
const PLAYER_HX = PLAYER_BODY_W / 2;  // hitbox yarı-genişliği
const PLAYER_HY = PLAYER_BODY_H / 2;  // hitbox yarı-yüksekliği
const PLAYER_MAX_VX = 380;    // px/sec yatay max hız
const PLAYER_ACCEL = 1800;    // px/sec^2 yatay ivme
const PLAYER_FRICTION = 1400; // tuş bırakınca yavaşlama (px/sec^2)

// Fizik (dünyada yukarı pozitif y → pvy > 0 yukarı, pvy < 0 düşüyor)
const GRAVITY = 1400;         // px/sec^2 (aşağı çeker — pvy'den düşülür)
const JUMP_VY = 750;          // zıplama hızı (pozitif = yukarı)
// Maksimum zıplama yüksekliği: vy^2 / (2g) = 750^2 / 2800 ≈ 200 px ≈ ~3 platform aralığı (VGAP=70).
const MAX_FALL_VY = 900;      // düşüş hız kapağı (mutlak değer)

// Platform
const PLATFORM_W_BASE = 64;
const PLATFORM_H = 12;
const PLATFORM_VGAP = 70;     // dikey ortalama aralık (px). 4 aralık ≈ 280 px ≤ 200 px değil; ama dengelemek için
// ↑ JUMP_VY tabandan ~200 px yükselir; aralık 70 px → max ~3 atlayışta tepe.
// Doodle Jump dengesi: zıplama tepesi en az 1 platform üstünü yakalayabilmeli.
const PLATFORM_VGAP_VAR = 40; // varyasyon ±

// Hareketli platform
const MOVING_VX = 90;         // px/sec yatay

// Kırılgan platform
const FRAGILE_BREAK_DELAY = 0.25; // saniye — zıplama sonrası kırılma

// Dünya
const SCROLL_TRIGGER_Y = H * 0.4; // karakter ekranın üst %40'ına çıkınca scroll

// Fixed-timestep simulation: oyunun hızı frame-rate'ten bağımsız.
const FIXED_DT = 1 / 120;
const MAX_FRAME_TIME = 0.1;

// ---------- Renkler (CSS variable cache) ----------
const cssCache = new Map<string, string>();
function css(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  const out = val || fallback;
  cssCache.set(varName, out);
  return out;
}

// ---------- Storage (safe) ----------
const STORAGE_KEY = 'sky-jump.bestHeight';
// Leaderboard tracks metres (what the HUD shows), not the raw px stored above —
// so it uses its own key. recordScore keeps 'sky-jump.best' (metres) in sync.
const SCORE_DESC = { gameId: 'sky-jump', storageKey: 'sky-jump.best', direction: 'higher' as const };
function safeReadBest(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}
function safeWriteBest(v: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.floor(v)));
  } catch {
    /* ignore */
  }
}

// ---------- State ----------
let state: State = 'ready';
const generation = createGenToken();
let dpr = 1;

// Karakter durumu (dünya koordinatları)
let px = W / 2;            // logical px (yatay)
let py = 0;                // dünya y (yukarı arttıkça pozitif "height" hissi için)
// Görsel y için: dünyada platformlar farklı y değerlerinde duruyor.
// scrollY = dünya kaydırma offset'i. Bir platform ekranda görünür y = (worldY - scrollY).
// Karakter ekrandaki y'si: py - scrollY (canvas üst = 0, alt = H)
let pvx = 0;
let pvy = 0;
let leftHeld = false;
let rightHeld = false;
let scrollY = 0;           // dünyada en alttaki görünür y (canvas alt kenarı)
let highestY = 0;          // şimdiye kadarki en yüksek py (=skor)

let platforms: Platform[] = [];
let bestHeight = 0;
let lastTs = 0;
let physicsAccum = 0;
let rafHandle = 0;

// ---------- Yardımcılar ----------
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateHud(): void {
  scoreEl.textContent = String(Math.floor(highestY / 10)); // 10 px = 1 metre
  bestEl.textContent = String(Math.floor(bestHeight / 10));
}

// ---------- Platform üretimi ----------
function platformWidthFor(type: PlatformType): number {
  if (type === 'fragile') return PLATFORM_W_BASE - 6;
  return PLATFORM_W_BASE;
}

// Yüksekliğe göre platform tipi seç: yukarı çıktıkça zorlaşır.
function pickPlatformType(worldY: number): PlatformType {
  // İlk 600 px tamamen normal (öğrenme).
  if (worldY < 600) return 'normal';

  const heightFactor = Math.min(1, worldY / 6000); // 6000 px sonra max zorluk
  const r = Math.random();
  // Normal payı 100% → 50%; moving 0% → 30%; fragile 0% → 20%.
  const normalP = 1 - 0.5 * heightFactor;
  const movingP = 0.3 * heightFactor;
  // (fragileP = 0.2 * heightFactor)
  if (r < normalP) return 'normal';
  if (r < normalP + movingP) return 'moving';
  return 'fragile';
}

function makePlatform(worldY: number, type?: PlatformType): Platform {
  const ptype = type ?? pickPlatformType(worldY);
  const w = platformWidthFor(ptype);
  const x = rand(8, W - w - 8);
  const vx = ptype === 'moving' ? (Math.random() < 0.5 ? -MOVING_VX : MOVING_VX) : 0;
  return {
    x,
    y: worldY,
    w,
    type: ptype,
    vx,
    used: false,
    brokenAt: 0,
    broken: false,
  };
}

function spawnInitialPlatforms(): void {
  platforms = [];
  // Karakterin altında zemin platformu (oyun başlangıcı garantili).
  platforms.push({
    x: W / 2 - PLATFORM_W_BASE / 2,
    y: 0,
    w: PLATFORM_W_BASE,
    type: 'normal',
    vx: 0,
    used: false,
    brokenAt: 0,
    broken: false,
  });
  // Yukarı doğru ~25 platform — ekranın 2 katı kadar buffer.
  let y = PLATFORM_VGAP;
  for (let i = 0; i < 25; i++) {
    platforms.push(makePlatform(y, i < 4 ? 'normal' : undefined));
    y += rand(PLATFORM_VGAP - PLATFORM_VGAP_VAR, PLATFORM_VGAP + PLATFORM_VGAP_VAR);
  }
}

function topPlatformY(): number {
  let top = 0;
  for (const p of platforms) if (p.y > top) top = p.y;
  return top;
}

function ensurePlatformsAbove(): void {
  // En yüksek platform, görünür ekranın üstünden VGAP*3 daha yukarı olana kadar üret.
  const visibleTop = scrollY + H; // dünyada görünür alanın "yukarı" sınırı
  const needTop = visibleTop + PLATFORM_VGAP * 3;
  let top = topPlatformY();
  while (top < needTop) {
    top += rand(PLATFORM_VGAP - PLATFORM_VGAP_VAR, PLATFORM_VGAP + PLATFORM_VGAP_VAR);
    platforms.push(makePlatform(top));
  }
}

function pruneOffscreenPlatforms(): void {
  // Karakterin çok altında kalan (ekranın alt kenarından 200 px aşağı) platformları sil.
  const cutoff = scrollY - 200;
  platforms = platforms.filter((p) => p.y > cutoff);
}

// ---------- Reset ----------
function reset(): void {
  generation.bump();
  state = 'ready';
  spawnInitialPlatforms();
  px = W / 2;
  py = PLATFORM_H + PLAYER_HY + 2; // ilk platform üstünde
  pvx = 0;
  pvy = JUMP_VY; // pozitif = yukarı — başlangıçta zıplıyor (invisible-boot pitfall'a karşı görsel feedback)
  scrollY = 0;
  highestY = 0;
  leftHeld = false;
  rightHeld = false;
  physicsAccum = 0;
  lastTs = 0;
  updateHud();
  showOverlay('Sky Jump', 'Sol/sağ ok ya da ekranın yan tarafına bas — yukarı tırman.');
  draw();
}

function startIfReady(): void {
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
    lastTs = 0;
    physicsAccum = 0;
  }
}

function gameOver(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  if (highestY > bestHeight) {
    bestHeight = highestY;
    safeWriteBest(bestHeight);
    updateHud();
  }
  const m = Math.floor(highestY / 10);
  reportGameOver(SCORE_DESC, m, { label: 'Yükseklik', unit: 'm' });
  const b = Math.floor(bestHeight / 10);
  showOverlay('Düştün!', `${m} m · en iyi ${b} m · tekrar denemek için R ya da Yeniden başla.`);
}

// ---------- Simulation step ----------
// Koordinat sistemi: dünyada yukarı pozitif y. Karakter yukarı çıkıyor → py artıyor, pvy > 0.
// Düşüyor → pvy < 0. Yer çekimi her tick pvy'den çekiyor (dpvy/dt = -GRAVITY).
function step(dt: number): void {
  if (state !== 'playing') return;

  // Yatay kontrol.
  if (leftHeld && !rightHeld) {
    pvx -= PLAYER_ACCEL * dt;
    if (pvx < -PLAYER_MAX_VX) pvx = -PLAYER_MAX_VX;
  } else if (rightHeld && !leftHeld) {
    pvx += PLAYER_ACCEL * dt;
    if (pvx > PLAYER_MAX_VX) pvx = PLAYER_MAX_VX;
  } else {
    // friction
    if (pvx > 0) {
      pvx -= PLAYER_FRICTION * dt;
      if (pvx < 0) pvx = 0;
    } else if (pvx < 0) {
      pvx += PLAYER_FRICTION * dt;
      if (pvx > 0) pvx = 0;
    }
  }

  // Yatay konum + wrap.
  px += pvx * dt;
  if (px < -PLAYER_HX) px = W + PLAYER_HX; // sol kenardan çıktıysa sağdan gir
  else if (px > W + PLAYER_HX) px = -PLAYER_HX;

  // pvy > 0 = yukarı; pvy < 0 = aşağı. Yer çekimi her tick pvy'yi azaltır.
  pvy -= GRAVITY * dt;
  if (pvy < -MAX_FALL_VY) pvy = -MAX_FALL_VY;

  const prevPy = py;
  py += pvy * dt;

  // Hareketli platformları güncelle.
  for (const p of platforms) {
    if (p.type === 'moving' && !p.broken) {
      p.x += p.vx * dt;
      if (p.x < 0) {
        p.x = 0;
        p.vx = Math.abs(p.vx);
      } else if (p.x + p.w > W) {
        p.x = W - p.w;
        p.vx = -Math.abs(p.vx);
      }
    }
  }

  // Kırılgan platform kırılma timer'ı.
  const now = performance.now() / 1000;
  for (const p of platforms) {
    if (p.type === 'fragile' && p.used && !p.broken && now - p.brokenAt >= FRAGILE_BREAK_DELAY) {
      p.broken = true;
    }
  }

  // Çarpışma: SADECE düşerken (pvy < 0) ve karakter ayağı bir platformun üst yüzeyinden geçtiyse.
  // Karakter alt kenar (dünya y): py - PLAYER_HY.
  // Platform üst yüzey (dünya y): p.y + PLATFORM_H (platform p.y..p.y+PLATFORM_H arasında).
  // Bir önceki frame'de karakter alt kenarı platform üstünün üzerindeydi (>= p.y + PLATFORM_H)
  // ve şimdi platform üstünün altına geçti (<=).
  if (pvy < 0) {
    const prevFoot = prevPy - PLAYER_HY;
    const curFoot = py - PLAYER_HY;
    let landed: Platform | null = null;
    for (const p of platforms) {
      if (p.broken) continue;
      const top = p.y + PLATFORM_H;
      // Frame'de aşağı geçiş kontrolü.
      if (prevFoot >= top && curFoot <= top) {
        // Yatay örtüşme.
        if (px + PLAYER_HX > p.x && px - PLAYER_HX < p.x + p.w) {
          landed = p;
          break;
        }
      }
    }
    if (landed) {
      // Karakter platforma oturdu, otomatik yukarı zıplat.
      py = landed.y + PLATFORM_H + PLAYER_HY;
      pvy = JUMP_VY; // pozitif = yukarı
      // Kırılgan platform: ilk zıplama timer'ı başlatır.
      if (landed.type === 'fragile' && !landed.used) {
        landed.used = true;
        landed.brokenAt = now;
      }
    }
  }

  // Scroll: karakter ekranın üst %40'ına çıktıysa dünya aşağı kayar.
  // Karakterin ekran y'si: H - (py - scrollY). Ekran üst = 0.
  // Karakter ekran y'si < SCROLL_TRIGGER_Y olduğunda dünya kayar.
  // Yani: H - (py - scrollY) < SCROLL_TRIGGER_Y → py - scrollY > H - SCROLL_TRIGGER_Y.
  const playerScreenFromBottom = py - scrollY;
  const triggerFromBottom = H - SCROLL_TRIGGER_Y;
  if (playerScreenFromBottom > triggerFromBottom) {
    scrollY = py - triggerFromBottom;
  }

  // Yükseklik (skor).
  if (py > highestY) {
    highestY = py;
    updateHud();
  }

  // Yeni platformlar üret + eski platformları temizle.
  ensurePlatformsAbove();
  pruneOffscreenPlatforms();

  // Düşme kontrolü: karakter ekran alt kenarının altına geçtiyse (px ekran y > H).
  // Karakter dünya y < scrollY (yani ekran alt çizgisi).
  if (py + PLAYER_HY < scrollY) {
    gameOver();
  }
}

// ---------- Drawing ----------
function resizeCanvas(): void {
  const next = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || W;
  const cssH = (cssW * H) / W;
  const targetW = Math.round(cssW * next);
  const targetH = Math.round(cssH * next);
  if (canvas.width === targetW && canvas.height === targetH && dpr === next) return;
  dpr = next;
  canvas.width = targetW;
  canvas.height = targetH;
  // Tüm çizim logical W x H koordinatlarında; backing store DPR-ölçekli.
  ctx.setTransform(targetW / W, 0, 0, targetH / H, 0, 0);
  ctx.imageSmoothingEnabled = true;
  draw();
}

function worldToScreenY(worldY: number): number {
  // Dünya yukarı pozitif y; ekran üst = 0. Karakter ekran y = H - (worldY - scrollY).
  return H - (worldY - scrollY);
}

function drawBackground(): void {
  // Gradient: yukarı çıktıkça daha koyu mavi (uzaya doğru) hissi.
  const elevation = Math.min(1, highestY / 8000);
  const top = `rgb(${Math.round(40 + 10 * (1 - elevation))}, ${Math.round(80 + 60 * (1 - elevation))}, ${Math.round(180 - 60 * elevation)})`;
  const bot = `rgb(${Math.round(140 + 40 * (1 - elevation))}, ${Math.round(200 + 30 * (1 - elevation))}, ${Math.round(240)})`;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bot);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Bulutlar — basit parallax (scroll'a göre yavaş kayar).
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const cloudOffset = (scrollY * 0.18) % 220;
  for (let i = 0; i < 4; i++) {
    const cy = 80 + i * 160 - cloudOffset;
    const cy2 = ((cy % (H + 220)) + (H + 220)) % (H + 220) - 60;
    const cx = (i * 97) % W;
    // ufak bulut
    ctx.beginPath();
    ctx.ellipse(cx, cy2, 36, 10, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 22, cy2 - 4, 22, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Yıldızlar (yüksekte parlasın).
  if (elevation > 0.3) {
    ctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, (elevation - 0.3) * 1.5)})`;
    const seed = Math.floor(scrollY / 200);
    for (let i = 0; i < 18; i++) {
      const sx = ((i * 73 + seed * 41) % W);
      const sy = ((i * 113 + seed * 17) % H);
      ctx.fillRect(sx, sy, 2, 2);
    }
  }
}

function drawPlatform(p: Platform): void {
  if (p.broken) return;
  const sy = worldToScreenY(p.y + PLATFORM_H); // platform üst yüzey ekran y
  if (sy < -PLATFORM_H || sy > H + PLATFORM_H) return; // viewport dışı cull

  let fill: string;
  let stroke: string;
  if (p.type === 'moving') {
    fill = css('--sky-platform-moving', '#3b82f6');
    stroke = '#1d4ed8';
  } else if (p.type === 'fragile') {
    fill = p.used ? '#7c4a1a' : css('--sky-platform-fragile', '#a16207');
    stroke = '#6b3a0a';
  } else {
    fill = css('--sky-platform-normal', '#cbd5e1');
    stroke = '#94a3b8';
  }

  // Yuvarlak köşeli platform.
  const r = 5;
  ctx.fillStyle = fill;
  ctx.beginPath();
  const x = p.x;
  const y = sy;
  const w = p.w;
  const h = PLATFORM_H;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Hareketli platform için ok ipucu.
  if (p.type === 'moving' && !p.broken) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const cx = p.x + p.w / 2;
    const cy = sy + h / 2;
    if (p.vx > 0) {
      ctx.beginPath();
      ctx.moveTo(cx + 6, cy);
      ctx.lineTo(cx, cy - 4);
      ctx.lineTo(cx, cy + 4);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy);
      ctx.lineTo(cx, cy - 4);
      ctx.lineTo(cx, cy + 4);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Kırılgan platform için çatlak deseni.
  if (p.type === 'fragile') {
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x + p.w * 0.3, sy + 1);
    ctx.lineTo(p.x + p.w * 0.4, sy + h - 1);
    ctx.moveTo(p.x + p.w * 0.65, sy + 1);
    ctx.lineTo(p.x + p.w * 0.55, sy + h - 1);
    ctx.stroke();
  }
}

function drawPlayer(): void {
  const sx = px;
  // Karakter ayak ekran y'si = worldToScreenY(py - PLAYER_HY).
  // Karakter merkezi ekran y'si = sx (yok), sy_center = H - (py - scrollY).
  const cy = H - (py - scrollY);
  // Gövde (yumuşak yuvarlak karakter — emoji DEĞİL).
  ctx.save();
  ctx.translate(sx, cy);

  // Gölge (zemin hissi)
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(0, PLAYER_HY + 2, PLAYER_HX * 0.9, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Gövde: vertikal oval — şirin bir "kabarcık karakter".
  const grad = ctx.createLinearGradient(0, -PLAYER_HY, 0, PLAYER_HY);
  grad.addColorStop(0, '#fef08a');
  grad.addColorStop(1, '#f59e0b');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(0, 0, PLAYER_HX, PLAYER_HY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#7c3a06';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Kulaklar (yan)
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.moveTo(-PLAYER_HX + 2, -PLAYER_HY * 0.6);
  ctx.lineTo(-PLAYER_HX - 4, -PLAYER_HY * 0.9);
  ctx.lineTo(-PLAYER_HX + 4, -PLAYER_HY * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(PLAYER_HX - 2, -PLAYER_HY * 0.6);
  ctx.lineTo(PLAYER_HX + 4, -PLAYER_HY * 0.9);
  ctx.lineTo(PLAYER_HX - 4, -PLAYER_HY * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Gözler
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(-4, -4, 4, 5, 0, 0, Math.PI * 2);
  ctx.ellipse(5, -4, 4, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1f2937';
  // Bakış yönü hıza göre.
  const eyeDx = pvx > 60 ? 1.5 : pvx < -60 ? -1.5 : 0;
  ctx.beginPath();
  ctx.arc(-4 + eyeDx, -3, 2, 0, Math.PI * 2);
  ctx.arc(5 + eyeDx, -3, 2, 0, Math.PI * 2);
  ctx.fill();

  // Gülen ağız — zıplarken büyür.
  ctx.strokeStyle = '#7c3a06';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const mouthY = 6;
  const mouthCurve = pvy > 0 ? 4 : 2; // yukarı çıkarken daha mutlu
  ctx.moveTo(-5, mouthY);
  ctx.quadraticCurveTo(0, mouthY + mouthCurve, 5, mouthY);
  ctx.stroke();

  ctx.restore();

  // Wrap göstergesi — karakter kenara yakınsa karşı kenarda da çiz (ipucu).
  if (sx < PLAYER_HX) {
    drawPlayerGhost(sx + W, cy);
  } else if (sx > W - PLAYER_HX) {
    drawPlayerGhost(sx - W, cy);
  }
}

function drawPlayerGhost(gx: number, gy: number): void {
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.translate(gx, gy);
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.ellipse(0, 0, PLAYER_HX, PLAYER_HY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function draw(): void {
  drawBackground();
  for (const p of platforms) drawPlatform(p);
  drawPlayer();
}

// ---------- Loop ----------
function frame(ts: number): void {
  if (!lastTs) lastTs = ts;
  let frameTime = (ts - lastTs) / 1000;
  if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME;
  lastTs = ts;

  if (state === 'playing') {
    physicsAccum += frameTime;
    if (physicsAccum > MAX_FRAME_TIME) physicsAccum = MAX_FRAME_TIME;
    while (physicsAccum >= FIXED_DT) {
      step(FIXED_DT);
      physicsAccum -= FIXED_DT;
      if (state !== 'playing') break;
    }
  }

  draw();
  rafHandle = requestAnimationFrame(frame);
}

// ---------- Inputs ----------
function _wire(): void {
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') {
    e.preventDefault();
    // GameOver'da sol/sağ ok da restart tetiklesin (overlay-input-leak önlemi).
    if (state === 'gameover') {
      reset();
      return;
    }
    leftHeld = true;
    startIfReady();
  } else if (k === 'arrowright' || k === 'd') {
    e.preventDefault();
    if (state === 'gameover') {
      reset();
      return;
    }
    rightHeld = true;
    startIfReady();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  } else if (e.code === 'Space') {
    // Space: ready'den başlatma veya gameover'dan restart.
    if (state === 'gameover') {
      reset();
    } else {
      startIfReady();
    }
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') leftHeld = false;
  else if (k === 'arrowright' || k === 'd') rightHeld = false;
});

// Touch / pointer: ekranın sol/sağ yarısına basılı tut.
// Pointer ID -> "left" | "right" tracking (çoklu touch güvenli).
const pointerSide = new Map<number, 'left' | 'right'>();
function recomputeHeld(): void {
  let l = false;
  let r = false;
  for (const v of pointerSide.values()) {
    if (v === 'left') l = true;
    else r = true;
  }
  leftHeld = l;
  rightHeld = r;
}

function sideFor(clientX: number): 'left' | 'right' {
  const rect = canvas.getBoundingClientRect();
  return clientX - rect.left < rect.width / 2 ? 'left' : 'right';
}

canvas.addEventListener(
  'pointerdown',
  (e) => {
    e.preventDefault();
    if (state === 'gameover') {
      reset();
      return;
    }
    pointerSide.set(e.pointerId, sideFor(e.clientX));
    recomputeHeld();
    startIfReady();
    // pointercapture sayesinde el dışarı çıksa bile event'leri alıyoruz.
    canvas.setPointerCapture(e.pointerId);
  },
  { passive: false },
);

canvas.addEventListener(
  'pointermove',
  (e) => {
    if (!pointerSide.has(e.pointerId)) return;
    pointerSide.set(e.pointerId, sideFor(e.clientX));
    recomputeHeld();
  },
  { passive: false },
);

function endPointer(e: PointerEvent): void {
  if (!pointerSide.has(e.pointerId)) return;
  pointerSide.delete(e.pointerId);
  recomputeHeld();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => {
  // Pointer canvas dışına çıkarsa bırak. (setPointerCapture genelde tutar ama emniyet.)
  // Sadece pointer canvas üzerinde değilse bırak.
  if (e.buttons === 0) endPointer(e);
});

// Yan tarafa dokunma için iOS Safari'de double-tap zoom önlemi: touchstart preventDefault.
canvas.addEventListener(
  'touchstart',
  (e) => {
    e.preventDefault();
  },
  { passive: false },
);

// Restart butonu
restartBtn.addEventListener('click', (e) => {
  e.preventDefault();
  reset();
});

// Resize
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => requestAnimationFrame(resizeCanvas));
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(resizeCanvas).observe(canvas);
}

// Tab gizli → loop pause + accumulator reset (catch-up frame patlamasını önle).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    lastTs = 0;
    physicsAccum = 0;
  }
});
}

// ---------- Init ----------
function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  bestHeight = safeReadBest();
  _wire();

  resizeCanvas();
  reset();
  cancelAnimationFrame(rafHandle);
  lastTs = 0;
  rafHandle = requestAnimationFrame(frame);
}

export const game = defineGame({ init, reset });
