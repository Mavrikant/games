import { defineGame } from '@shared/game-module';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

// Hanoi Kuleleri — klasik 3 kule disk taşıma bulmacası.
//
// State machine: playing → solved (overlay açık)
// Tek input modeli: kule seç (kaynak) → kule seç (hedef). Aynı kule iki kez =
// deselect. Hatalı taşıma (büyük → küçük üstüne) no-op + kısa "shake" feedback.
//
// Visual = hitbox: tüm kule pozisyonları ve disk genişlikleri TOWER_GEOM
// içinden besleniyor; draw() ve picking aynı sabit setini kullanır.

type Tower = number[]; // her int = disk indexi (0 = en küçük). top: stack[end].
type GameState = 'playing' | 'solved';

const MIN_DISKS = 3;
const MAX_DISKS = 8;
const DEFAULT_DISKS = 4;
const DISK_OPTIONS = [3, 4, 5, 6, 7, 8] as const;

const STORAGE_DISKS = 'hanoi-kuleleri.disks';
const STORAGE_BEST_PREFIX = 'hanoi-kuleleri.best-';

// Global leaderboard tracks the default 4-disk board only — one fixed disk
// count so move totals are comparable. Lower moves is better.
const SCORE_DESC = { gameId: 'hanoi-kuleleri-4', storageKey: 'hanoi-kuleleri.best-4', direction: 'lower' as const };

const ANIM_MS = 220;
const SHAKE_MS = 280;
const SOLVED_DELAY_MS = 360;

// Tek sabit blok — hem draw hem hitbox bu sabitlerden besleniyor.
// pitfall: visual-vs-hitbox.
interface Geom {
  width: number;
  height: number;
  baseY: number; // tabanın üst kenarı (disklerin "yere" değdiği y)
  baseHeight: number;
  rodWidth: number;
  rodTopY: number; // çubuğun üst ucu
  towerCenters: [number, number, number]; // her kule için x merkezi
  towerHitWidth: number; // kule hitbox genişliği (her kule için sol/sağ tolerans)
  diskHeight: number;
  diskMaxWidth: number;
  diskMinWidth: number;
}

function computeGeom(canvasW: number, canvasH: number, disks: number): Geom {
  const baseHeight = 12;
  const baseY = canvasH - 40; // alttan 40px yukarı
  const rodTopY = 50;
  const rodWidth = 6;
  // Üç eşit aralıklı kule.
  const usableW = canvasW - 40;
  const slotW = usableW / 3;
  const towerCenters: [number, number, number] = [
    20 + slotW * 0.5,
    20 + slotW * 1.5,
    20 + slotW * 2.5,
  ];
  // Disk yükseklikleri: disk sayısı arttıkça kısalt ki hepsi sığsın.
  const stackHeight = baseY - rodTopY - 8;
  const diskHeight = Math.max(10, Math.min(26, Math.floor(stackHeight / (disks + 0.5))));
  const diskMaxWidth = Math.min(slotW * 0.92, 160);
  // En küçük disk en az 38 px (mobile tap-target).
  const diskMinWidth = Math.max(38, diskMaxWidth * 0.36);
  const towerHitWidth = slotW; // tüm slot tıklanabilir
  return {
    width: canvasW,
    height: canvasH,
    baseY,
    baseHeight,
    rodWidth,
    rodTopY,
    towerCenters,
    towerHitWidth,
    diskHeight,
    diskMaxWidth,
    diskMinWidth,
  };
}

interface AnimState {
  diskIdx: number;
  fromTower: number;
  toTower: number;
  startMs: number;
  // Yola çıkış noktası ve hedef. Anim 3 fazlı: yukarı, yana, aşağı.
  fromCenter: [number, number]; // diskin merkezi (anim başlangıç)
  toCenter: [number, number]; // anim bitişi
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let movesEl!: HTMLElement;
let optimalEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let diskBarEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayRestartBtn!: HTMLButtonElement;

let diskCount: number = DEFAULT_DISKS;
let towers: [Tower, Tower, Tower] = [[], [], []];
let moves = 0;
let state: GameState = 'playing';
let selectedTower: number | null = null;
let animation: AnimState | null = null;
let shakeTower: number | null = null;
let shakeUntil = 0;
let bestByDisks: Record<number, number> = {};
let rafHandle: number | null = null;
const gen = createGenToken();
let geom!: Geom;

// ---------- Storage helpers (unguarded-storage pitfall) ----------

function safeReadInt(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function safeWriteInt(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore — private mode, disabled, full disk, etc. */
  }
}

function bestKey(n: number): string {
  return `${STORAGE_BEST_PREFIX}${n}`;
}

function loadBest(n: number): number | null {
  return safeReadInt(bestKey(n));
}

function saveBest(n: number, value: number): void {
  safeWriteInt(bestKey(n), value);
}

function loadAllBest(): void {
  bestByDisks = {};
  for (const n of DISK_OPTIONS) {
    const v = loadBest(n);
    if (v !== null) bestByDisks[n] = v;
  }
}

function loadSavedDiskCount(): number {
  const v = safeReadInt(STORAGE_DISKS);
  if (v === null) return DEFAULT_DISKS;
  if (v < MIN_DISKS || v > MAX_DISKS) return DEFAULT_DISKS;
  return v;
}

function persistDiskCount(): void {
  safeWriteInt(STORAGE_DISKS, diskCount);
}

// ---------- Game state ----------

function optimalMoves(n: number): number {
  // 2^n - 1
  return (1 << n) - 1;
}

function newGame(n: number): void {
  // Bump generation so any pending async callback bails.
  gen.bump();
  cancelAnimation();
  diskCount = n;
  geom = computeGeom(canvas.width, canvas.height, n);
  towers = [[], [], []];
  // En büyük disk en altta (disk indeksi = boyut sırası, 0 = en küçük).
  // İlk kuleye en büyükten en küçüğe sırayla koy: stack top = en küçük.
  for (let i = n - 1; i >= 0; i--) {
    towers[0].push(i);
  }
  moves = 0;
  selectedTower = null;
  shakeTower = null;
  state = 'playing';
  persistDiskCount();
  renderHud();
  renderDiskBar();
  hideOverlay();
  scheduleDraw();
}

function tryMove(from: number, to: number): boolean {
  if (state !== 'playing') return false;
  if (animation !== null) return false;
  if (from === to) return false;
  const src = towers[from]!;
  const dst = towers[to]!;
  if (src.length === 0) return false;
  const movingDisk = src[src.length - 1]!;
  const topDst = dst.length === 0 ? Infinity : dst[dst.length - 1]!;
  if (movingDisk >= topDst) {
    // İllegal — büyük diski küçüğün üstüne koyma teşebbüsü.
    triggerShake(to);
    return false;
  }
  // Animasyonu başlat — state mutate animasyon bitiminde.
  const fromCenter = topCenter(from, src.length - 1);
  const toCenter = topCenter(to, dst.length);
  animation = {
    diskIdx: movingDisk,
    fromTower: from,
    toTower: to,
    startMs: performance.now(),
    fromCenter,
    toCenter,
  };
  // Source stack'ten POP HEMEN — bu sayede draw() sırasında "uçan" disk
  // ile statik stack ayrı; ama yeniden yerleştirme animasyon bittiğinde
  // hedefe push olarak yapılır.
  src.pop();
  scheduleDraw();
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return; // stale-async-callback guard
    if (!animation) return;
    // State mutate.
    towers[to].push(movingDisk);
    animation = null;
    moves++;
    renderHud();
    scheduleDraw();
    // Çözüm tespiti: tüm diskler 3. kulede mi?
    if (towers[2].length === diskCount && state === 'playing') {
      const winMoves = moves;
      state = 'solved';
      const winGen = gen.current();
      window.setTimeout(() => {
        if (!gen.isCurrent(winGen)) return;
        showSolved(winMoves);
      }, SOLVED_DELAY_MS);
    }
  }, ANIM_MS);
  return true;
}

function cancelAnimation(): void {
  animation = null;
  shakeTower = null;
  shakeUntil = 0;
}

function triggerShake(towerIdx: number): void {
  shakeTower = towerIdx;
  shakeUntil = performance.now() + SHAKE_MS;
  scheduleDraw();
}

function showSolved(winMoves: number): void {
  const optimal = optimalMoves(diskCount);
  const prevBest = bestByDisks[diskCount];
  const isNewBest = prevBest === undefined || winMoves < prevBest;
  if (isNewBest) {
    bestByDisks[diskCount] = winMoves;
    saveBest(diskCount, winMoves);
  }
  if (diskCount === DEFAULT_DISKS) reportGameOver(SCORE_DESC, winMoves, { label: 'Hamle' });
  const isOptimal = winMoves === optimal;
  overlayTitleEl.textContent = isOptimal
    ? 'Mükemmel çözüm!'
    : isNewBest
      ? 'Yeni rekor!'
      : 'Çözüldü!';
  const bestStr = String(bestByDisks[diskCount]!);
  overlayMsgEl.textContent = isOptimal
    ? `${diskCount} disk · ${winMoves} hamle (optimal)`
    : `${diskCount} disk · ${winMoves} hamle · en iyi: ${bestStr} · optimal: ${optimal}`;
  overlayEl.classList.remove('hk-overlay--hidden');
  overlayEl.setAttribute('aria-hidden', 'false');
  renderHud();
  // Move focus to "yeni oyun" so Enter restarts.
  overlayRestartBtn.focus({ preventScroll: true });
  scheduleDraw();
}

function hideOverlay(): void {
  overlayEl.classList.add('hk-overlay--hidden');
  overlayEl.setAttribute('aria-hidden', 'true');
}

// ---------- Geometry helpers ----------

function diskWidth(diskIdx: number): number {
  // diskIdx 0 = en küçük; en büyük = diskCount - 1.
  if (diskCount === 1) return geom.diskMaxWidth;
  const t = diskIdx / (diskCount - 1); // 0..1
  return geom.diskMinWidth + (geom.diskMaxWidth - geom.diskMinWidth) * t;
}

function topCenter(towerIdx: number, stackPos: number): [number, number] {
  // stackPos: alttan üste sayılı slot (0 = en alt). y, ilgili katmanın merkez y'si.
  const cx = geom.towerCenters[towerIdx]!;
  const cy = geom.baseY - geom.diskHeight * (stackPos + 0.5);
  return [cx, cy];
}

function towerHitTest(x: number): number | null {
  // En yakın kuleye yapıştır; tıklanabilir alan tüm slot genişliği.
  let nearest = -1;
  let nearestDist = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(x - geom.towerCenters[i]!);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = i;
    }
  }
  if (nearest < 0) return null;
  // Hit width check.
  if (nearestDist > geom.towerHitWidth / 2) return null;
  return nearest;
}

// ---------- Rendering ----------

function scheduleDraw(): void {
  if (rafHandle !== null) return;
  rafHandle = window.requestAnimationFrame(() => {
    rafHandle = null;
    draw();
    // Animasyon veya shake aktifse yeniden zamanla.
    const now = performance.now();
    const shakeActive = shakeTower !== null && now < shakeUntil;
    if (animation !== null || shakeActive) {
      scheduleDraw();
    } else if (shakeTower !== null && now >= shakeUntil) {
      shakeTower = null;
      // Bir kez daha çiz ki kalıntı kalmasın.
      window.requestAnimationFrame(() => draw());
    }
  });
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Arka plan dolgu: temaya uyumlu.
  ctx.fillStyle = css('--hk-bg', '#0e1117');
  ctx.fillRect(0, 0, w, h);

  // Taban — uzun yatay düzlem.
  const baseColor = css('--hk-base', '#3a4150');
  const baseShadow = css('--hk-base-shadow', '#262b34');
  ctx.fillStyle = baseShadow;
  ctx.fillRect(20, geom.baseY + geom.baseHeight, w - 40, 4);
  ctx.fillStyle = baseColor;
  roundedRect(20, geom.baseY, w - 40, geom.baseHeight, 4);
  ctx.fill();

  // 3 çubuk + tabanın slot etiketleri.
  const rodColor = css('--hk-rod', '#4a5260');
  for (let i = 0; i < 3; i++) {
    const cx = geom.towerCenters[i]!;
    let dx = 0;
    if (shakeTower === i) {
      const t = (shakeUntil - performance.now()) / SHAKE_MS; // 1→0
      const amp = 6 * Math.max(0, t);
      dx = Math.sin((1 - t) * Math.PI * 6) * amp;
    }
    ctx.fillStyle = rodColor;
    roundedRect(
      cx + dx - geom.rodWidth / 2,
      geom.rodTopY,
      geom.rodWidth,
      geom.baseY - geom.rodTopY,
      3,
    );
    ctx.fill();
    // Çubuğun tepesi yumuşak başlık.
    ctx.beginPath();
    ctx.arc(cx + dx, geom.rodTopY, geom.rodWidth / 2 + 1, 0, Math.PI * 2);
    ctx.fill();

    // Slot vurgulu mu (seçili kaynak)?
    if (selectedTower === i && state === 'playing') {
      ctx.fillStyle = css('--hk-slot-hi', 'rgba(129, 140, 248, 0.10)');
      const slotW = geom.towerHitWidth - 16;
      const slotX = cx + dx - slotW / 2;
      const slotY = geom.rodTopY - 8;
      const slotH = geom.baseY - slotY;
      roundedRect(slotX, slotY, slotW, slotH, 10);
      ctx.fill();
      // Çerçeve.
      ctx.strokeStyle = css('--hk-slot-hi-edge', 'rgba(129, 140, 248, 0.55)');
      ctx.lineWidth = 2;
      roundedRect(slotX, slotY, slotW, slotH, 10);
      ctx.stroke();
    }
  }

  // Disk renkleri — disk indeksine göre HSL.
  // En küçük (0): pembe; en büyük: deep violet.
  const drawDiskAt = (diskIdx: number, cx: number, cy: number, selected: boolean): void => {
    const w0 = diskWidth(diskIdx);
    const h0 = geom.diskHeight;
    const hue = 270 - (diskIdx / Math.max(1, diskCount - 1)) * 220; // 270 → 50
    const sat = 70;
    const light = 56;
    ctx.fillStyle = `hsl(${hue.toFixed(0)}, ${sat}%, ${light}%)`;
    const x = cx - w0 / 2;
    const y = cy - h0 / 2;
    roundedRect(x, y, w0, h0, Math.min(h0 / 2, 10));
    ctx.fill();
    // İç gölge.
    ctx.fillStyle = `hsla(${hue.toFixed(0)}, ${sat}%, ${Math.max(20, light - 26)}%, 0.45)`;
    roundedRect(x, y + h0 * 0.55, w0, h0 * 0.45, Math.min(h0 / 2, 10));
    ctx.fill();
    // Highlight çizgi.
    ctx.fillStyle = `hsla(${hue.toFixed(0)}, ${sat}%, ${Math.min(96, light + 18)}%, 0.55)`;
    ctx.fillRect(x + 6, y + 2, Math.max(0, w0 - 12), 1);
    // Eğer seçili kuledeki en üst disk ise vurgu.
    if (selected) {
      ctx.strokeStyle = css('--hk-disk-sel', '#f5f6f8');
      ctx.lineWidth = 2;
      roundedRect(x - 1, y - 1, w0 + 2, h0 + 2, Math.min(h0 / 2 + 1, 11));
      ctx.stroke();
    }
  };

  for (let t = 0; t < 3; t++) {
    const stack = towers[t]!;
    for (let pos = 0; pos < stack.length; pos++) {
      const diskIdx = stack[pos]!;
      const [cx, cy] = topCenter(t, pos);
      const isTop = pos === stack.length - 1;
      const isSelectedTop = isTop && selectedTower === t && state === 'playing';
      drawDiskAt(diskIdx, cx, cy, isSelectedTop);
    }
  }

  // Uçan disk (animasyon).
  if (animation !== null) {
    const now = performance.now();
    const t = Math.min(1, (now - animation.startMs) / ANIM_MS);
    // 3 fazlı: 0..0.33 yukarı, 0.33..0.66 yana, 0.66..1 aşağı.
    const [fx, fy] = animation.fromCenter;
    const [tx, ty] = animation.toCenter;
    const arcY = geom.rodTopY - geom.diskHeight; // çubuk tepesinin üstünde
    let cx: number;
    let cy: number;
    if (t < 0.33) {
      const u = t / 0.33;
      cx = fx;
      cy = fy + (arcY - fy) * u;
    } else if (t < 0.66) {
      const u = (t - 0.33) / 0.33;
      cx = fx + (tx - fx) * u;
      cy = arcY;
    } else {
      const u = (t - 0.66) / 0.34;
      cx = tx;
      cy = arcY + (ty - arcY) * u;
    }
    drawDiskAt(animation.diskIdx, cx, cy, false);
  }
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

const cssCache = new Map<string, string>();
function css(varName: string, fallback: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached || fallback;
  try {
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue(varName)
      .trim();
    cssCache.set(varName, val);
    return val || fallback;
  } catch {
    return fallback;
  }
}

// ---------- HUD / Disk bar ----------

function renderHud(): void {
  movesEl.textContent = String(moves);
  optimalEl.textContent = String(optimalMoves(diskCount));
  const best = bestByDisks[diskCount];
  bestEl.textContent = best === undefined ? '—' : String(best);
}

function renderDiskBar(): void {
  diskBarEl.innerHTML = '';
  for (const n of DISK_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hk-disk-bar__btn' + (n === diskCount ? ' hk-disk-bar__btn--active' : '');
    btn.textContent = String(n);
    btn.setAttribute('aria-label', `${n} disk`);
    btn.setAttribute('aria-pressed', n === diskCount ? 'true' : 'false');
    btn.addEventListener('click', () => {
      if (n === diskCount && state === 'playing' && moves === 0) {
        // Aynı sayıya tıklamak no-op (zaten başlangıçta).
        return;
      }
      newGame(n);
    });
    diskBarEl.appendChild(btn);
  }
}

// ---------- Input ----------

function canvasToLogical(clientX: number, clientY: number): [number, number] {
  const rect = canvas.getBoundingClientRect();
  // canvas might be CSS-scaled; map from client px to logical px.
  const x = ((clientX - rect.left) / rect.width) * canvas.width;
  const y = ((clientY - rect.top) / rect.height) * canvas.height;
  return [x, y];
}

function onCanvasPointer(e: PointerEvent): void {
  // overlay-input-leak: solved iken oyun alanı tıklaması no-op.
  if (state !== 'playing') return;
  if (animation !== null) return;
  const [x] = canvasToLogical(e.clientX, e.clientY);
  const tower = towerHitTest(x);
  if (tower === null) return;
  handleTowerClick(tower);
}

function handleTowerClick(tower: number): void {
  if (state !== 'playing') return;
  if (animation !== null) return;
  if (selectedTower === null) {
    // Boş kule kaynak olamaz.
    if (towers[tower]!.length === 0) {
      triggerShake(tower);
      return;
    }
    selectedTower = tower;
    scheduleDraw();
    return;
  }
  if (selectedTower === tower) {
    // Aynı kuleye tekrar tıkla → deselect.
    selectedTower = null;
    scheduleDraw();
    return;
  }
  const from = selectedTower;
  selectedTower = null;
  const moved = tryMove(from, tower);
  if (!moved) {
    // Geçersiz: hedefi yeni kaynak yapma; sadece deselect (already done).
    scheduleDraw();
  }
}

function _wireListeners(): void {
canvas.addEventListener('pointerdown', onCanvasPointer);

restartBtn.addEventListener('click', () => newGame(diskCount));
overlayRestartBtn.addEventListener('click', () => newGame(diskCount));

window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    newGame(diskCount);
    e.preventDefault();
    return;
  }
  if (k === 'n' || k === 'N') {
    // Disk sayısını çevrimsel artır.
    const idx = DISK_OPTIONS.indexOf(diskCount as (typeof DISK_OPTIONS)[number]);
    const nextIdx = (idx + 1) % DISK_OPTIONS.length;
    const next = DISK_OPTIONS[nextIdx]!;
    newGame(next);
    e.preventDefault();
    return;
  }
  // Doğrudan rakam tuşu ile disk sayısı (3-8).
  if (k >= '3' && k <= '8') {
    const n = Number(k);
    if (n >= MIN_DISKS && n <= MAX_DISKS) {
      newGame(n);
      e.preventDefault();
      return;
    }
  }
  // Sol/Orta/Sağ kule shortcut: 1-2-3 (Q-W-E olarak da kabul et).
  if (state === 'playing' && animation === null) {
    let towerKey: number | null = null;
    if (k === '1' || k === 'q' || k === 'Q') towerKey = 0;
    else if (k === '2' || k === 'w' || k === 'W') towerKey = 1;
    else if (k === '0' || k === 'e' || k === 'E') towerKey = 2;
    if (towerKey !== null) {
      handleTowerClick(towerKey);
      e.preventDefault();
      return;
    }
  }
  if (k === 'Enter' && state === 'solved') {
    newGame(diskCount);
    e.preventDefault();
  }
  if (k === 'Escape' && selectedTower !== null && state === 'playing') {
    selectedTower = null;
    scheduleDraw();
    e.preventDefault();
  }
});
}

// ---------- Init ----------

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  optimalEl = document.querySelector<HTMLElement>('#optimal')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  diskBarEl = document.querySelector<HTMLElement>('#disk-bar')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayRestartBtn = document.querySelector<HTMLButtonElement>('#overlay-restart')!;

  _wireListeners();

  loadAllBest();
  diskCount = loadSavedDiskCount();
  newGame(diskCount);
}

export const game = defineGame({ init, reset: () => newGame(diskCount) });
