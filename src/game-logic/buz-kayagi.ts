import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';

// Buz Kayağı — kayan buz bulmacası.
//
// Mekanik (klon değil): oyuncuyu tek kare hareket ettirmezsin; bir yön
// seçince kayakçı buzda DURAMADAN o yöne kayar ve ancak bir duvara (veya
// sınıra) çarpınca, hemen önündeki karede durur. Amaç: kayış sırasında tüm
// kristalleri topla, sonra çıkışa ulaş. Çıkış yalnızca tüm kristaller
// toplandığında aktiftir; üzerinden geçince seviye biter.
//
// Notasyon:
//   #  = duvar/engel (kayışı durdurur)
//   ' '= buz (üstünde kayılır)
//   @  = oyuncu başlangıcı
//   *  = kristal
//   O  = çıkış
//
// State machine: playing → animating → playing
//                 playing → levelClear → (next) playing
//                                     \→ gameComplete (son seviye)
// pitfall: overlay-input-leak  → her handler state guard'lı.
// pitfall: stale-async-callback → animasyon gen-token'a bağlı; reset bump'lar.
// pitfall: visual-vs-hitbox    → çarpışma grid indeksleriyle; çizim aynı
//                                indeksleri RENDER sabitleriyle piksele çevirir.
// pitfall: invisible-boot      → loadLevel anında board çizilir, ilk feedback
//                                <250ms; per-seviye state (moves/collected) sıfırlanır.

type GameState = 'playing' | 'animating' | 'levelClear' | 'gameComplete';
type Dir = 'up' | 'down' | 'left' | 'right';

interface Pt {
  x: number;
  y: number;
}

interface LevelData {
  wall: boolean[][];
  player: Pt;
  exit: Pt;
  gems: Pt[];
  width: number;
  height: number;
}

interface MoveRecord {
  from: Pt;
  collected: number[]; // bu hamlede toplanan kristal indeksleri
}

const LEVELS: string[] = [
  ['#######', '#@  *O#', '#######'].join('\n'),
  ['########', '#  #   #', '#@   * #', '#      #', '#  O   #', '########'].join('\n'),
  ['########', '#@    O#', '#      #', '# #### #', '# *  * #', '########'].join('\n'),
  ['#########', '# ## O *#', '#   *@  #', '#  #    #', '##      #', '#########'].join('\n'),
  ['#########', '# ##  #*#', '#  *    #', '# #O   @#', '#      ##', '#########'].join('\n'),
  ['#########', '#     ###', '#O#*    #', '#   @*  #', '#       #', '#########'].join('\n'),
  ['#########', '## O    #', '#    ## #', '#   *  *#', '#*@    ##', '#########'].join('\n'),
  ['##########', '#@   #   #', '#  *   * #', '# #   #  #', '#   *    #', '#  O  #  #', '##########'].join('\n'),
  ['#########', '# ###  *#', '#      ##', '# *  *O #', '### @  *#', '#########'].join('\n'),
  ['##########', '#      O##', '# # #  * #', '#     @  #', '# *#*    #', '##########'].join('\n'),
];

const STORAGE_LEVEL = 'buz-kayagi.level';
const STORAGE_BEST_PREFIX = 'buz-kayagi.best.';

const CANVAS_W = 480;
const CANVAS_H = 480;
const SEG_MS = 60; // bir karelik kayma süresi

const DIR_DELTA: Record<Dir, Pt> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let movesEl!: HTMLElement;
let gemsEl!: HTMLElement;
let bestEl!: HTMLElement;
let undoBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let nextBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNextBtn!: HTMLButtonElement;
let touchButtons!: NodeListOf<HTMLButtonElement>;

let state: GameState = 'playing';
let levelIdx = 0;
let level: LevelData = parseLevel(LEVELS[0]!);
let collected: boolean[] = [];
let moves = 0;
let history: MoveRecord[] = [];

// animasyon durumu
let animPath: Pt[] = []; // başlangıç dahil waypoint listesi
let animCollect: number[] = []; // bu hamlede toplanacak kristal indeksleri
let animWin = false;
let animStart = 0;
let animReached = 0; // kaç waypoint'e (>0) görsel olarak ulaşıldı
let playerPx: Pt = { x: 0, y: 0 }; // grid-uzayında interpolasyon (kesirli)

function parseLevel(text: string): LevelData {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const wall: boolean[][] = [];
  let player: Pt = { x: 0, y: 0 };
  let exit: Pt = { x: 0, y: 0 };
  const gems: Pt[] = [];
  for (let y = 0; y < height; y++) {
    const row: boolean[] = [];
    const line = rows[y]!;
    for (let x = 0; x < width; x++) {
      const ch = x < line.length ? line[x]! : ' ';
      row.push(ch === '#');
      if (ch === '@') player = { x, y };
      if (ch === 'O') exit = { x, y };
      if (ch === '*') gems.push({ x, y });
    }
    wall.push(row);
  }
  return { wall, player, exit, gems, width, height };
}

function isWall(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return true;
  return level.wall[y]![x]!;
}

function gemIndexAt(x: number, y: number): number {
  for (let i = 0; i < level.gems.length; i++) {
    const g = level.gems[i]!;
    if (g.x === x && g.y === y) return i;
  }
  return -1;
}

function collectedCount(): number {
  let c = 0;
  for (const v of collected) if (v) c++;
  return c;
}

// -------------------- Kayma hesabı --------------------

interface SlideResult {
  path: Pt[]; // başlangıçtan SONRAKİ kareler (en az 1 ⇒ geçerli hamle)
  collect: number[]; // bu kayışta yeni toplanan kristal indeksleri (sırayla)
  win: boolean;
}

function computeSlide(dir: Dir): SlideResult {
  const d = DIR_DELTA[dir];
  const total = level.gems.length;
  const already = collectedCount();
  let x = level.player.x;
  let y = level.player.y;
  const path: Pt[] = [];
  const collect: number[] = [];
  let win = false;
  while (true) {
    const nx = x + d.x;
    const ny = y + d.y;
    if (isWall(nx, ny)) break;
    x = nx;
    y = ny;
    path.push({ x, y });
    const gi = gemIndexAt(x, y);
    if (gi >= 0 && !collected[gi] && !collect.includes(gi)) {
      collect.push(gi);
    }
    const have = already + collect.length;
    if (x === level.exit.x && y === level.exit.y && have === total) {
      win = true;
      break; // çıkışta dur; sonrası önemli değil
    }
  }
  return { path, collect, win };
}

// -------------------- Hamle + animasyon --------------------

function move(dir: Dir): void {
  if (state !== 'playing') return; // overlay-input-leak guard
  const res = computeSlide(dir);
  if (res.path.length === 0) return; // duvara dayalı: geçersiz, sayma

  history.push({ from: { x: level.player.x, y: level.player.y }, collected: res.collect });
  moves++;

  animPath = [{ x: level.player.x, y: level.player.y }, ...res.path];
  animCollect = res.collect;
  animWin = res.win;
  animReached = 0;
  animStart = performance.now();
  playerPx = { x: level.player.x, y: level.player.y };
  state = 'animating';
  updateHud();

  const myGen = gen.current();
  requestAnimationFrame(function frame(now) {
    if (!gen.isCurrent(myGen)) return; // stale-async-callback guard
    if (state !== 'animating') return;
    stepAnim(now);
    draw();
    if (state === 'animating') {
      requestAnimationFrame(frame);
    }
  });
}

function stepAnim(now: number): void {
  const elapsed = now - animStart;
  const segCount = animPath.length - 1;
  let seg = Math.floor(elapsed / SEG_MS);
  if (seg < 0) seg = 0;

  // ulaşılan waypoint'lerde kristalleri topla
  const reachedNow = Math.min(seg, segCount);
  while (animReached < reachedNow) {
    animReached++;
    const cell = animPath[animReached]!;
    const gi = gemIndexAt(cell.x, cell.y);
    if (gi >= 0 && animCollect.includes(gi)) collected[gi] = true;
  }

  if (seg >= segCount) {
    finishAnim();
    return;
  }

  const a = animPath[seg]!;
  const b = animPath[seg + 1]!;
  const frac = (elapsed - seg * SEG_MS) / SEG_MS;
  playerPx = { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac };
  updateHud();
}

function finishAnim(): void {
  const last = animPath[animPath.length - 1]!;
  level.player = { x: last.x, y: last.y };
  playerPx = { x: last.x, y: last.y };
  for (const gi of animCollect) collected[gi] = true;

  if (animWin) {
    handleLevelClear();
  } else {
    state = 'playing';
  }
  updateHud();
  draw();
}

function undo(): void {
  if (state !== 'playing') return;
  const last = history.pop();
  if (!last) return;
  for (const gi of last.collected) collected[gi] = false;
  level.player = { x: last.from.x, y: last.from.y };
  playerPx = { x: last.from.x, y: last.from.y };
  moves = Math.max(0, moves - 1);
  updateHud();
  draw();
}

// -------------------- Seviye yönetimi --------------------

function bestKey(idx: number): string {
  return STORAGE_BEST_PREFIX + idx;
}

function loadLevel(idx: number): void {
  gen.bump(); // bekleyen animasyonu iptal et
  if (idx < 0) idx = 0;
  if (idx >= LEVELS.length) idx = LEVELS.length - 1;
  levelIdx = idx;
  safeWrite(STORAGE_LEVEL, levelIdx);
  level = parseLevel(LEVELS[idx]!);
  collected = level.gems.map(() => false);
  moves = 0;
  history = [];
  animPath = [];
  playerPx = { x: level.player.x, y: level.player.y };
  state = 'playing';
  hideOverlay();
  updateHud();
  draw(); // anında görsel feedback (invisible-boot)
}

function restartLevel(): void {
  loadLevel(levelIdx);
}

function nextLevel(): void {
  if (levelIdx + 1 < LEVELS.length) loadLevel(levelIdx + 1);
  else loadLevel(0);
}

function handleLevelClear(): void {
  const prevBest = safeRead<number>(bestKey(levelIdx), 0);
  if (prevBest === 0 || moves < prevBest) {
    safeWrite(bestKey(levelIdx), moves);
  }
  if (levelIdx + 1 >= LEVELS.length) {
    state = 'gameComplete';
    showOverlay('Tüm seviyeler bitti!', `Son seviye ${moves} hamlede tamam. Baştan oynamak için Sonraki.`);
  } else {
    state = 'levelClear';
    const b = safeRead<number>(bestKey(levelIdx), 0);
    const bestTxt = b > 0 ? ` · en iyin ${b}` : '';
    showOverlay('Seviye tamam!', `${moves} hamle${bestTxt} · Seviye ${levelIdx + 1}/${LEVELS.length}`);
  }
  updateHud();
}

// -------------------- Overlay --------------------

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('bk-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
  overlayNextBtn.textContent = state === 'gameComplete' ? 'Baştan oyna' : 'Sonraki seviye';
}

function hideOverlay(): void {
  overlay.classList.add('bk-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// -------------------- HUD --------------------

function updateHud(): void {
  levelEl.textContent = `${levelIdx + 1}/${LEVELS.length}`;
  movesEl.textContent = String(moves);
  gemsEl.textContent = `${collectedCount()}/${level.gems.length}`;
  const b = safeRead<number>(bestKey(levelIdx), 0);
  bestEl.textContent = b > 0 ? String(b) : '—';
  undoBtn.disabled = history.length === 0 || state !== 'playing';
  undoBtn.setAttribute('aria-disabled', undoBtn.disabled ? 'true' : 'false');
  nextBtn.disabled = state === 'playing' || state === 'animating';
  nextBtn.setAttribute('aria-disabled', nextBtn.disabled ? 'true' : 'false');
}

// -------------------- Çizim --------------------

interface RenderInfo {
  cell: number;
  ox: number;
  oy: number;
}

function renderInfo(): RenderInfo {
  const cell = Math.max(8, Math.min(Math.floor(CANVAS_W / level.width), Math.floor(CANVAS_H / level.height)));
  const ox = Math.floor((CANVAS_W - cell * level.width) / 2);
  const oy = Math.floor((CANVAS_H - cell * level.height) / 2);
  return { cell, ox, oy };
}

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined && cached !== '') return cached;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) {
      cssCache.set(name, v);
      return v;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function draw(): void {
  const { cell, ox, oy } = renderInfo();
  const surface = getCss('--surface', '#1e2230');
  const ice = getCss('--bk-ice', '#22304a');
  const ice2 = getCss('--bk-ice-2', '#1b2740');
  const wall = getCss('--bk-wall', '#0d1426');
  const gemCol = getCss('--bk-gem', '#38bdf8');
  const exitActive = getCss('--bk-exit', '#34d399');
  const exitIdle = getCss('--bk-exit-idle', '#475569');
  const skater = getCss('--bk-player', '#f8fafc');
  const skaterEdge = getCss('--bk-player-edge', '#0ea5e9');

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const px = ox + x * cell;
      const py = oy + y * cell;
      if (level.wall[y]![x]!) {
        ctx.fillStyle = wall;
        ctx.fillRect(px, py, cell, cell);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);
      } else {
        // buz: hafif damalı + parlak çizgi hissi
        ctx.fillStyle = (x + y) % 2 === 0 ? ice : ice2;
        ctx.fillRect(px, py, cell, cell);
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + cell * 0.15, py + cell * 0.78);
        ctx.lineTo(px + cell * 0.6, py + cell * 0.32);
        ctx.stroke();
      }
    }
  }

  // çıkış
  const allDone = collectedCount() === level.gems.length;
  drawExit(ox + level.exit.x * cell, oy + level.exit.y * cell, cell, allDone ? exitActive : exitIdle, allDone);

  // kristaller
  for (let i = 0; i < level.gems.length; i++) {
    if (collected[i]) continue;
    const g = level.gems[i]!;
    drawGem(ox + g.x * cell, oy + g.y * cell, cell, gemCol);
  }

  // oyuncu (kesirli konumla — kayma sırasında akıcı)
  drawSkater(ox + playerPx.x * cell, oy + playerPx.y * cell, cell, skater, skaterEdge);
}

function drawExit(x: number, y: number, size: number, color: string, active: boolean): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.34;
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  if (active) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawGem(x: number, y: number, size: number, color: string): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.26;
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = Math.max(1, size * 0.03);
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.8, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r * 0.8, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawSkater(x: number, y: number, size: number, fill: string, edge: string): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.32;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(2, size * 0.07);
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.fillStyle = edge;
  const eyeR = Math.max(1, size * 0.045);
  ctx.beginPath();
  ctx.arc(cx - r * 0.35, cy - r * 0.12, eyeR, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.35, cy - r * 0.12, eyeR, 0, Math.PI * 2);
  ctx.fill();
}

// -------------------- Input --------------------

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  s: 'down',
  a: 'left',
  d: 'right',
};

function advanceFromOverlay(): void {
  if (state === 'gameComplete') loadLevel(0);
  else if (state === 'levelClear') nextLevel();
}

function handleKeyDown(e: KeyboardEvent): void {
  const k = e.key;
  const kl = k.length === 1 ? k.toLowerCase() : k;

  // R her durumda seviyeyi sıfırlar (loadLevel gen.bump'lar → animasyon iptal).
  if (kl === 'r') {
    restartLevel();
    e.preventDefault();
    return;
  }

  if (state === 'levelClear' || state === 'gameComplete') {
    if (k === 'Enter' || k === ' ' || kl === 'n') {
      advanceFromOverlay();
      e.preventDefault();
      return;
    }
    if (k.startsWith('Arrow')) e.preventDefault();
    return;
  }

  if (state !== 'playing') {
    // animating: kayma sürerken yeni yön/undo kabul etme (yarış önleme).
    if (k.startsWith('Arrow')) e.preventDefault();
    return;
  }

  const dir = KEY_DIR[kl] ?? KEY_DIR[k];
  if (dir) {
    move(dir);
    e.preventDefault();
    return;
  }
  if (kl === 'z') {
    undo();
    e.preventDefault();
  }
}

let touchStart: { x: number; y: number } | null = null;

function wireInput(): void {
  for (const btn of Array.from(touchButtons)) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const dir = btn.dataset.dir as Dir | undefined;
      if (dir && state === 'playing') move(dir);
    });
  }

  undoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    undo();
  });
  restartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    restartLevel();
  });
  nextBtn.addEventListener('click', (e) => {
    e.preventDefault();
    advanceFromOverlay();
  });
  overlayNextBtn.addEventListener('click', (e) => {
    e.preventDefault();
    advanceFromOverlay();
  });

  window.addEventListener('keydown', handleKeyDown);

  // kaydırma (mobil): kanvasta swipe ⇒ yön
  canvas.addEventListener('pointerdown', (e) => {
    touchStart = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!touchStart) return;
    const dx = e.clientX - touchStart.x;
    const dy = e.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return;
    let dir: Dir;
    if (Math.abs(dx) > Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else dir = dy > 0 ? 'down' : 'up';
    if (state === 'playing') move(dir);
  });
}

// -------------------- Init --------------------

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  gemsEl = document.querySelector<HTMLElement>('#gems')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#undo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  nextBtn = document.querySelector<HTMLButtonElement>('#next')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNextBtn = document.querySelector<HTMLButtonElement>('#overlay-next')!;
  touchButtons = document.querySelectorAll<HTMLButtonElement>('.bk-touch__btn');

  wireInput();

  const stored = safeRead<number>(STORAGE_LEVEL, 0);
  const start = Number.isFinite(stored) && stored >= 0 && stored < LEVELS.length ? Math.floor(stored) : 0;
  loadLevel(start);
}

export const game = defineGame({ init, reset: restartLevel });
