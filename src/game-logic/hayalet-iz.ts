import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Hayalet İz — geçtiğin yol 2 sn sonra kırmızıya döner, 1.5 sn ölümcül kalır.
//
// PITFALLS guarded here (docs/PITFALLS.md):
// - module-level-dom-access: tüm DOM/storage erişimi init() içinde.
// - unguarded-storage: safeRead/safeWrite.
// - stale-async-callback: RAF generation token'a bağlı; reset() bump'lar.
// - overlay-input-leak: state guard her input handler'ın başında.
// - visual-vs-hitbox: hayalet/oyuncu/orb yarıçapları tek const bloktan;
//   hem draw() hem collide() aynı sabitleri kullanır.
// - missing-overlay-css: .overlay / .overlay--hidden hayalet-iz.css'te tanımlı.
// - invisible-boot: ilk yön tuşunda anında hareket başlar (<250ms).
// - unreachable-start-state: Space/yön tuşları ready'den çıkarır + restart btn.

type Dir = 'up' | 'down' | 'left' | 'right';
type State = 'ready' | 'playing' | 'gameover';
type Vec = { x: number; y: number };
type TrailSample = { x: number; y: number; born: number };
type Orb = { x: number; y: number };

// --- Sabitler (görsel = hitbox tek kaynak) ---
const W = 480;
const H = 480;
const PLAYER_R = 7;
const GHOST_R = 5;
const ORB_R = 9;
const WALL_PAD = 2;            // arena iç sınırı (duvar çarpışması için)
const BASE_SPEED = 130;        // px/sec
const SPEED_PER_5 = 0.06;      // her 5 skorda hız +6%
const SAMPLE_MS = 45;          // iz örnekleme aralığı
const BASE_DELAY_MS = 2000;    // izin görünür hale gelme gecikmesi
const MIN_DELAY_MS = 1200;     // gecikmenin düşeceği taban
const DELAY_PER_10 = 80;       // her 10 skorda gecikme -80ms
const GHOST_LIFE_MS = 1500;    // hayaletin ölümcül kalma süresi
const TICK_FIXED_DT = 1 / 240; // fizik için sabit timestep
const MAX_FRAME_DT = 1 / 30;   // büyük frame atlamalarını kıs
const STORAGE_BEST = 'hayalet-iz.best';
const SCORE_DESC = { gameId: 'hayalet-iz', storageKey: STORAGE_BEST, direction: 'higher' as const };
const ORB_MIN_DIST_FROM_PLAYER = 80;
const ORB_MIN_DIST_FROM_GHOST = 24;
const ORB_PLACE_TRIES = 40;

// --- DOM ---
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

// --- Oyun durumu ---
const gen = createGenToken();
let state: State = 'ready';
let pos: Vec = { x: 0, y: 0 };
let dir: Dir = 'right';
let queuedDir: Dir | null = null;
let trail: TrailSample[] = [];
let orb: Orb = { x: 0, y: 0 };
let score = 0;
let best = 0;
let lastSampleAt = 0;
let lastFrameMs = 0;
let now = 0; // ms since reset (monotonic for trail timing)

function showMsg(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideMsg(): void {
  hideOverlayEl(overlay);
}

function currentSpeed(): number {
  return BASE_SPEED * (1 + Math.floor(score / 5) * SPEED_PER_5);
}

function currentDelayMs(): number {
  const reduced = BASE_DELAY_MS - Math.floor(score / 10) * DELAY_PER_10;
  return Math.max(MIN_DELAY_MS, reduced);
}

function dirVec(d: Dir): Vec {
  if (d === 'up') return { x: 0, y: -1 };
  if (d === 'down') return { x: 0, y: 1 };
  if (d === 'left') return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

function opposite(a: Dir, b: Dir): boolean {
  return (
    (a === 'up' && b === 'down') ||
    (a === 'down' && b === 'up') ||
    (a === 'left' && b === 'right') ||
    (a === 'right' && b === 'left')
  );
}

function placeOrb(): void {
  // Oyuncudan ve aktif (kırmızı) hayaletlerden uzak bir nokta seç.
  const delay = currentDelayMs();
  const minBorn = now - delay - GHOST_LIFE_MS;
  const maxBorn = now - delay;

  for (let i = 0; i < ORB_PLACE_TRIES; i++) {
    const x = WALL_PAD + ORB_R + 4 + Math.random() * (W - 2 * (WALL_PAD + ORB_R + 4));
    const y = WALL_PAD + ORB_R + 4 + Math.random() * (H - 2 * (WALL_PAD + ORB_R + 4));

    // Oyuncuya yakın olmasın.
    const dxP = x - pos.x;
    const dyP = y - pos.y;
    if (dxP * dxP + dyP * dyP < ORB_MIN_DIST_FROM_PLAYER * ORB_MIN_DIST_FROM_PLAYER) {
      continue;
    }

    // Aktif hayaletlere yakın olmasın.
    let nearGhost = false;
    for (const s of trail) {
      if (s.born >= minBorn && s.born <= maxBorn) {
        const dx = x - s.x;
        const dy = y - s.y;
        if (dx * dx + dy * dy < ORB_MIN_DIST_FROM_GHOST * ORB_MIN_DIST_FROM_GHOST) {
          nearGhost = true;
          break;
        }
      }
    }
    if (nearGhost) continue;

    orb = { x, y };
    return;
  }
  // Geçerli yer bulamadık — yine de bir yere koy ki orb mevcut olsun.
  orb = { x: W / 2, y: H / 2 };
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);

  pos = { x: W / 2, y: H / 2 };
  dir = 'right';
  queuedDir = null;
  trail = [];
  now = 0;
  lastSampleAt = 0;
  lastFrameMs = 0;

  placeOrb();
  draw();
  showMsg('Hayalet İz', 'Bir yön tuşuna bas. Geçtiğin yol 2 saniye sonra kırmızıya döner — kendine değme.');

  startLoop();
}

function startLoop(): void {
  const myGen = gen.current();
  function frame(ts: number): void {
    if (!gen.isCurrent(myGen)) return;
    if (lastFrameMs === 0) lastFrameMs = ts;
    let dt = (ts - lastFrameMs) / 1000;
    lastFrameMs = ts;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;

    if (state === 'playing') {
      // Sabit timestep ile fizik güncelle (hassas çarpışma için).
      const steps = Math.max(1, Math.ceil(dt / TICK_FIXED_DT));
      const stepDt = dt / steps;
      for (let i = 0; i < steps; i++) {
        if (state !== 'playing') break;
        stepPhysics(stepDt);
      }
    } else if (state === 'ready') {
      // Ready'de oyuncu durur; iz biriktirmez. Yine de zaman akışı için now sabit.
    }

    pruneTrail();
    draw();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function stepPhysics(dt: number): void {
  // Kuyruktan bekleyen yönü uygula (ters yön değilse).
  if (queuedDir && !opposite(dir, queuedDir)) {
    dir = queuedDir;
    queuedDir = null;
  } else if (queuedDir && opposite(dir, queuedDir)) {
    // Ters yön zaten kuyrukta birikmiş olsa atla.
    queuedDir = null;
  }

  // İlerle.
  const v = dirVec(dir);
  const speed = currentSpeed();
  pos.x += v.x * speed * dt;
  pos.y += v.y * speed * dt;
  now += dt * 1000;

  // İz örnekleme.
  if (now - lastSampleAt >= SAMPLE_MS) {
    trail.push({ x: pos.x, y: pos.y, born: now });
    lastSampleAt = now;
  }

  // Duvar kontrolü.
  if (
    pos.x < WALL_PAD + PLAYER_R ||
    pos.x > W - WALL_PAD - PLAYER_R ||
    pos.y < WALL_PAD + PLAYER_R ||
    pos.y > H - WALL_PAD - PLAYER_R
  ) {
    return die('duvara çarptın');
  }

  // Hayalet çarpışma kontrolü (aktif olanlar).
  const delay = currentDelayMs();
  const ghostMaxBorn = now - delay;
  const ghostMinBorn = now - delay - GHOST_LIFE_MS;
  const collideR = PLAYER_R + GHOST_R;
  const collideR2 = collideR * collideR;
  for (let i = 0; i < trail.length; i++) {
    const s = trail[i]!;
    if (s.born < ghostMinBorn) continue;
    if (s.born > ghostMaxBorn) break; // born artar, geriye bak gerek yok
    const dx = pos.x - s.x;
    const dy = pos.y - s.y;
    if (dx * dx + dy * dy <= collideR2) {
      return die('kendi hayaletine değdin');
    }
  }

  // Orb topla.
  {
    const dx = pos.x - orb.x;
    const dy = pos.y - orb.y;
    const rr = (PLAYER_R + ORB_R) * (PLAYER_R + ORB_R);
    if (dx * dx + dy * dy <= rr) {
      score++;
      scoreEl.textContent = String(score);
      if (score > best) {
        best = score;
        bestEl.textContent = String(best);
        safeWrite(STORAGE_BEST, best);
      }
      placeOrb();
    }
  }
}

function pruneTrail(): void {
  // Aktif penceresi geçmiş örnekleri at.
  const delay = currentDelayMs();
  const cutoff = now - delay - GHOST_LIFE_MS;
  // Trail born artıyor, ilk geçerli noktaya kadar sil.
  let cutIdx = 0;
  while (cutIdx < trail.length && trail[cutIdx]!.born < cutoff) cutIdx++;
  if (cutIdx > 0) trail.splice(0, cutIdx);
}

function die(reason: string): void {
  if (state !== 'playing') return;
  state = 'gameover';
  reportGameOver(SCORE_DESC, score);
  showMsg('Bitti', `Skor: ${score} — ${reason}. Boşluk veya R ile yeniden başla.`);
  draw();
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  hideMsg();
}

// --- Çizim ---
function draw(): void {
  // Arka plan + grid noktalar.
  ctx.fillStyle = getCss('--hi-bg');
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = getCss('--hi-grid');
  const cell = 40;
  for (let gx = cell; gx < W; gx += cell) {
    for (let gy = cell; gy < H; gy += cell) {
      ctx.fillRect(gx - 1, gy - 1, 2, 2);
    }
  }

  // Orb.
  drawOrb();

  // Hayaletler (aktif iz).
  const delay = currentDelayMs();
  const ghostMaxBorn = now - delay;
  const ghostMinBorn = now - delay - GHOST_LIFE_MS;

  const ghostCol = getCss('--hi-ghost');
  const ghostGlow = getCss('--hi-ghost-glow');
  for (const s of trail) {
    if (s.born >= ghostMinBorn && s.born <= ghostMaxBorn) {
      const age = now - delay - s.born; // 0 (taze ölümcül) → GHOST_LIFE_MS (sönecek)
      const t = age / GHOST_LIFE_MS;
      // Yaşam ortasında en parlak; başta ve sonda sönük.
      const alpha = Math.max(0.25, Math.min(1, 1 - Math.abs(t - 0.25) * 1.0));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = ghostGlow;
      ctx.shadowBlur = 10;
      ctx.fillStyle = ghostCol;
      ctx.beginPath();
      ctx.arc(s.x, s.y, GHOST_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Çıkmak üzere olan iz (henüz görünür değil) — minimal hint çizgisi
  // (pre-warning) çiz: önümüzdeki 350ms içinde görünür olacak olanları soluk göster.
  const previewWindow = 350;
  const previewMaxBorn = now - delay + previewWindow;
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = ghostCol;
  for (const s of trail) {
    if (s.born > ghostMaxBorn && s.born <= previewMaxBorn) {
      const t = (previewMaxBorn - s.born) / previewWindow; // 0 (yeni) → 1 (yakında ölümcül)
      ctx.globalAlpha = 0.05 + 0.18 * t;
      ctx.beginPath();
      ctx.arc(s.x, s.y, GHOST_R * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // Oyuncu.
  drawPlayer();
}

function drawOrb(): void {
  const col = getCss('--hi-orb');
  const glow = getCss('--hi-orb-glow');
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = 14;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(orb.x, orb.y, ORB_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(): void {
  const col = getCss('--hi-player');
  const glow = getCss('--hi-player-glow');
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = 16;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, PLAYER_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Yön ucu (küçük üçgen) — yönü göstermek için
  const v = dirVec(dir);
  const tipX = pos.x + v.x * (PLAYER_R + 5);
  const tipY = pos.y + v.y * (PLAYER_R + 5);
  ctx.save();
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(tipX, tipY, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// --- CSS değişken cache ---
const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

// --- Input ---
function trySetDir(next: Dir): void {
  if (state === 'gameover') return;
  if (state === 'ready') {
    if (opposite(dir, next)) {
      // Ters yön ready'den çıkarmasın? Geri-180 yapmak yerine direkt o yöne dön.
      // Burada ready'de oyuncu durduğu için ters yön mantıklı olabilir; izin ver.
      dir = next;
    } else {
      dir = next;
    }
    startPlaying();
    return;
  }
  if (state === 'playing') {
    if (opposite(dir, next)) return;
    queuedDir = next;
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  if (typeof best !== 'number' || !Number.isFinite(best) || best < 0) best = 0;

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowup' || k === 'w') {
      trySetDir('up');
      e.preventDefault();
    } else if (k === 'arrowdown' || k === 's') {
      trySetDir('down');
      e.preventDefault();
    } else if (k === 'arrowleft' || k === 'a') {
      trySetDir('left');
      e.preventDefault();
    } else if (k === 'arrowright' || k === 'd') {
      trySetDir('right');
      e.preventDefault();
    } else if (k === ' ') {
      if (state === 'gameover') reset();
      else if (state === 'ready') startPlaying();
      e.preventDefault();
    } else if (k === 'r') {
      reset();
      e.preventDefault();
    } else if (k === 'enter') {
      if (state === 'gameover') reset();
      else if (state === 'ready') startPlaying();
      e.preventDefault();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.dir as Dir | undefined;
      if (d) trySetDir(d);
    });
  });

  restartBtn.addEventListener('click', () => reset());

  reset();
}

export const game = defineGame({ init, reset });
