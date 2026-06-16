import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Zar Pist — bir 6 yüzlü zarı kareli pistte yuvarlayarak hedef hücrelerdeki
// değerleri zarın üst yüzüyle eşle. Zar her hareketinde TAKLA atar; üst yüze
// gelen sayı, hangi yöne (E/W/N/S) yuvarlandığına ve mevcut konfigürasyona
// bağlıdır. Karşı yüzler her zaman 7'ye tamamlanır (1-6, 2-5, 3-4).
//
// PITFALLS guarded here:
// - unguarded-storage: safeRead/safeWrite ile localStorage.
// - stale-async-callback: animasyonu generation token + transitionend yerine
//   sade interpolasyon ile sürüyoruz; reset gen.bump() ile in-flight kareleri
//   iptal eder.
// - overlay-input-leak: state ∈ {playing,levelWin,gameWin}; her handler en
//   tepede guard eder. levelWin overlay açıkken WASD/Ok pisti hareket ettirmez.
// - module-level side effects: tüm DOM/storage erişimi init() içinde.
// - visual-vs-hitbox: render ve hareket-doğrulama aynı cell-px ve grid
//   koordinatlarını paylaşır (computeGeom).

interface Die {
  x: number;
  y: number;
  top: number;
  north: number;
  east: number;
}

interface Target {
  x: number;
  y: number;
  value: number;
  done: boolean;
}

interface LevelDef {
  w: number;
  h: number;
  start: [number, number];
  targets: Array<[number, number, number]>;
  walls?: Array<[number, number]>;
  hint?: string;
}

const LEVELS: LevelDef[] = [
  {
    w: 3, h: 1, start: [0, 0],
    targets: [[2, 0, 6]],
    hint: 'Sağa iki yuvarla. Üst yüz nasıl değişiyor?',
  },
  {
    w: 2, h: 2, start: [0, 0],
    targets: [[1, 1, 4]],
    hint: 'Sıralama önemli — önce aşağı, sonra sağa dene.',
  },
  {
    w: 3, h: 3, start: [0, 0],
    targets: [[2, 2, 5]],
    hint: 'Tek yönlü değil, dönüşümlü yuvarla.',
  },
  {
    w: 4, h: 3, start: [0, 0],
    targets: [[3, 2, 3]],
    walls: [[1, 1]],
    hint: 'Duvar köşeden dolaşmaya zorluyor.',
  },
  {
    w: 4, h: 4, start: [0, 0],
    targets: [[3, 0, 3], [3, 3, 5]],
    hint: 'İki hedef — uygun sıra hepsini eşler.',
  },
  {
    w: 4, h: 4, start: [0, 0],
    targets: [[3, 3, 5]],
    walls: [[1, 1], [2, 2]],
    hint: 'Köşegen duvarlar düz hattı kısıyor.',
  },
  {
    w: 5, h: 5, start: [0, 0],
    targets: [[4, 4, 1]],
    walls: [[2, 2]],
    hint: 'Tek hedef ama uzun pist; tek yüzde kalmak için dikkatli yuvarla.',
  },
  {
    w: 5, h: 5, start: [0, 0],
    targets: [[4, 0, 1], [4, 4, 1], [0, 4, 1]],
    hint: 'Köşeleri turla. Yön sırası kritik.',
  },
];

const STORAGE_BEST = 'zar-pist.best';

type State = 'playing' | 'levelWin' | 'gameWin';

interface Snapshot {
  die: Die;
  moves: number;
  totalMoves: number;
  targetsDone: boolean[];
}

const gen = createGenToken();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let levelEl!: HTMLElement;
let movesEl!: HTMLElement;
let totalEl!: HTMLElement;
let bestEl!: HTMLElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let undoBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let touchBtns!: NodeListOf<HTMLButtonElement>;

let state: State = 'playing';
let levelIdx = 0;
let die: Die = { x: 0, y: 0, top: 1, north: 2, east: 3 };
let targets: Target[] = [];
let walls: Set<string> = new Set();
let moves = 0;
let totalMoves = 0;
let bestTotal = 0;
let history: Snapshot[] = [];

// Animasyon: hareket sırasında "from" pozisyonundan "to" pozisyonuna t∈[0,1]
// yumuşat. Animasyon bitince to pozisyonu sabit kalır.
let animFrom: { x: number; y: number } | null = null;
let animTo: { x: number; y: number } | null = null;
let animStart = 0;
const ANIM_MS = 140;

const CANVAS_W = 480;
const CANVAS_H = 480;

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
    /* private mode */
  }
  return fallback;
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function showOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlayBtn.textContent = btn;
  showOverlayEl(overlayEl);
}

function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function loadLevel(idx: number): void {
  const lvl = LEVELS[idx];
  if (!lvl) return;
  levelIdx = idx;
  die = {
    x: lvl.start[0],
    y: lvl.start[1],
    top: 1,
    north: 2,
    east: 3,
  };
  targets = lvl.targets.map(([x, y, v]) => ({ x, y, value: v, done: false }));
  walls = new Set((lvl.walls ?? []).map(([x, y]) => key(x, y)));
  moves = 0;
  history = [];
  state = 'playing';
  animFrom = null;
  animTo = null;
  hideOverlay();
  renderHud();
  draw();
}

function renderHud(): void {
  levelEl.textContent = `${levelIdx + 1}/${LEVELS.length}`;
  movesEl.textContent = String(moves);
  totalEl.textContent = String(totalMoves);
  bestEl.textContent = bestTotal > 0 ? String(bestTotal) : '—';
  undoBtn.disabled = history.length === 0 || state !== 'playing';
  undoBtn.setAttribute('aria-disabled', undoBtn.disabled ? 'true' : 'false');
}

function snapshot(): Snapshot {
  return {
    die: { ...die },
    moves,
    totalMoves,
    targetsDone: targets.map((t) => t.done),
  };
}

function applyTumble(dx: number, dy: number): void {
  const oldTop = die.top;
  const oldNorth = die.north;
  const oldEast = die.east;
  if (dx === 1) {
    die.top = 7 - oldEast;
    die.east = oldTop;
  } else if (dx === -1) {
    die.top = oldEast;
    die.east = 7 - oldTop;
  } else if (dy === -1) {
    die.top = 7 - oldNorth;
    die.north = oldTop;
  } else if (dy === 1) {
    die.top = oldNorth;
    die.north = 7 - oldTop;
  }
}

function tryMove(dx: number, dy: number): void {
  if (state !== 'playing') return;
  const nx = die.x + dx;
  const ny = die.y + dy;
  const lvl = LEVELS[levelIdx]!;
  if (nx < 0 || nx >= lvl.w || ny < 0 || ny >= lvl.h) return;
  if (walls.has(key(nx, ny))) return;

  history.push(snapshot());
  if (history.length > 200) history.shift();

  const from = { x: die.x, y: die.y };
  applyTumble(dx, dy);
  die.x = nx;
  die.y = ny;
  moves++;
  totalMoves++;
  animFrom = from;
  animTo = { x: nx, y: ny };
  animStart = performance.now();
  scheduleAnimFrame();

  const t = targets.find((t) => !t.done && t.x === die.x && t.y === die.y);
  if (t && die.top === t.value) {
    t.done = true;
  }
  renderHud();
  // draw triggered by anim loop; also draw once now for instant pip update
  draw();
  if (targets.every((t) => t.done)) {
    finishLevel();
  }
}

function scheduleAnimFrame(): void {
  const myGen = gen.current();
  requestAnimationFrame(function step() {
    if (!gen.isCurrent(myGen)) return;
    draw();
    if (animFrom && animTo) {
      const t = (performance.now() - animStart) / ANIM_MS;
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        animFrom = null;
        animTo = null;
        draw();
      }
    }
  });
}

function undo(): void {
  if (state !== 'playing') return;
  if (history.length === 0) return;
  const s = history.pop()!;
  die = s.die;
  moves = s.moves;
  totalMoves = s.totalMoves;
  s.targetsDone.forEach((d, i) => {
    const tgt = targets[i];
    if (tgt) tgt.done = d;
  });
  animFrom = null;
  animTo = null;
  renderHud();
  draw();
}

function finishLevel(): void {
  if (levelIdx + 1 < LEVELS.length) {
    state = 'levelWin';
    showOverlay(
      `Bölüm ${levelIdx + 1} tamam`,
      `${moves} hamleyle bitirdin.\nDevam için Enter / Boşluk veya butona dokun.`,
      'Sonraki bölüm',
    );
  } else {
    state = 'gameWin';
    if (bestTotal === 0 || totalMoves < bestTotal) {
      bestTotal = totalMoves;
      safeWrite(STORAGE_BEST, bestTotal);
    }
    renderHud();
    showOverlay(
      'Tüm pisti tamamladın!',
      `Toplam ${totalMoves} hamle. En iyi: ${bestTotal}.\nYeniden başlamak için Enter veya R.`,
      'Yeniden başla',
    );
  }
  renderHud();
}

function advance(): void {
  if (state === 'levelWin') {
    gen.bump();
    loadLevel(levelIdx + 1);
  } else if (state === 'gameWin') {
    gen.bump();
    levelIdx = 0;
    totalMoves = 0;
    loadLevel(0);
  }
}

function restartLevel(): void {
  gen.bump();
  if (state === 'gameWin') {
    levelIdx = 0;
    totalMoves = 0;
    loadLevel(0);
    return;
  }
  totalMoves -= moves;
  loadLevel(levelIdx);
}

interface Geom {
  cell: number;
  ox: number;
  oy: number;
}

function computeGeom(): Geom {
  const lvl = LEVELS[levelIdx]!;
  const maxByW = Math.floor((CANVAS_W - 24) / lvl.w);
  const maxByH = Math.floor((CANVAS_H - 24) / lvl.h);
  const cell = Math.max(20, Math.min(96, Math.min(maxByW, maxByH)));
  const ox = Math.floor((CANVAS_W - cell * lvl.w) / 2);
  const oy = Math.floor((CANVAS_H - cell * lvl.h) / 2);
  return { cell, ox, oy };
}

function draw(): void {
  const lvl = LEVELS[levelIdx]!;
  const { cell, ox, oy } = computeGeom();

  const bg = getCss('--surface', '#1e2230');
  const cellCol = getCss('--zp-cell', '#262b39');
  const cellEdge = getCss('--zp-cell-edge', '#1a1f2c');
  const wallCol = getCss('--zp-wall', '#3a4256');
  const targetRing = getCss('--zp-target', '#6366f1');
  const targetDone = getCss('--zp-target-done', '#22c55e');
  const targetText = getCss('--zp-target-text', '#e6e8ef');
  const dieFill = getCss('--zp-die', '#f8fafc');
  const dieEdge = getCss('--zp-die-edge', '#94a3b8');
  const pipCol = getCss('--zp-pip', '#0f172a');
  const dieShadow = 'rgba(0,0,0,0.35)';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // pist hücreleri
  for (let y = 0; y < lvl.h; y++) {
    for (let x = 0; x < lvl.w; x++) {
      const px = ox + x * cell;
      const py = oy + y * cell;
      const isWall = walls.has(key(x, y));
      if (isWall) {
        ctx.fillStyle = wallCol;
        roundRect(px + 2, py + 2, cell - 4, cell - 4, 6);
        ctx.fill();
        // hatched lines
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        for (let i = -cell; i < cell; i += 8) {
          ctx.beginPath();
          ctx.moveTo(px + i, py);
          ctx.lineTo(px + i + cell, py + cell);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = cellCol;
        roundRect(px + 2, py + 2, cell - 4, cell - 4, 6);
        ctx.fill();
        ctx.strokeStyle = cellEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // hedefler
  for (const t of targets) {
    const px = ox + t.x * cell;
    const py = oy + t.y * cell;
    const cx = px + cell / 2;
    const cy = py + cell / 2;
    if (t.done) {
      ctx.fillStyle = targetDone;
      ctx.globalAlpha = 0.28;
      roundRect(px + 4, py + 4, cell - 8, cell - 8, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = targetDone;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = targetDone;
      ctx.font = `bold ${Math.floor(cell * 0.42)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✓', cx, cy);
    } else {
      ctx.strokeStyle = targetRing;
      ctx.lineWidth = 3;
      roundRect(px + 4, py + 4, cell - 8, cell - 8, 6);
      ctx.stroke();
      ctx.fillStyle = targetText;
      ctx.font = `bold ${Math.floor(cell * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(t.value), cx, cy);
    }
  }

  // zar
  let dx = die.x;
  let dy = die.y;
  let rolling = 0;
  let rollDir: { dx: number; dy: number } = { dx: 0, dy: 0 };
  if (animFrom && animTo) {
    const t = Math.min(1, (performance.now() - animStart) / ANIM_MS);
    dx = animFrom.x + (animTo.x - animFrom.x) * t;
    dy = animFrom.y + (animTo.y - animFrom.y) * t;
    rolling = t;
    rollDir = { dx: animTo.x - animFrom.x, dy: animTo.y - animFrom.y };
  }
  const dpx = ox + dx * cell + cell / 2;
  const dpy = oy + dy * cell + cell / 2;
  const dsize = cell * 0.78;

  // hafif "takla" eğimi: hareket sırasında dik açıya doğru yatır
  const tilt = rolling > 0 && rolling < 1 ? Math.sin(rolling * Math.PI) * 0.18 : 0;
  ctx.save();
  ctx.translate(dpx, dpy);
  if (rolling > 0 && rolling < 1) {
    const angle = tilt * (rollDir.dx !== 0 ? rollDir.dx : -rollDir.dy);
    ctx.rotate(angle);
  }
  // gölge
  ctx.fillStyle = dieShadow;
  roundRect(-dsize / 2 + 2, -dsize / 2 + 4, dsize, dsize, 8);
  ctx.fill();
  // zar gövdesi
  ctx.fillStyle = dieFill;
  roundRect(-dsize / 2, -dsize / 2, dsize, dsize, 8);
  ctx.fill();
  ctx.strokeStyle = dieEdge;
  ctx.lineWidth = 2;
  ctx.stroke();
  // pips for top face
  drawPips(0, 0, dsize, die.top, pipCol);
  ctx.restore();
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.min(w, h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function drawPips(cx: number, cy: number, size: number, value: number, color: string): void {
  const r = Math.max(2, size * 0.07);
  const off = size * 0.22;
  ctx.fillStyle = color;
  const positions: Array<[number, number]> = (() => {
    switch (value) {
      case 1:
        return [[0, 0]];
      case 2:
        return [[-off, -off], [off, off]];
      case 3:
        return [[-off, -off], [0, 0], [off, off]];
      case 4:
        return [[-off, -off], [off, -off], [-off, off], [off, off]];
      case 5:
        return [[-off, -off], [off, -off], [0, 0], [-off, off], [off, off]];
      case 6:
        return [[-off, -off], [off, -off], [-off, 0], [off, 0], [-off, off], [off, off]];
      default:
        return [];
    }
  })();
  for (const [px, py] of positions) {
    ctx.beginPath();
    ctx.arc(cx + px, cy + py, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function handleKey(e: KeyboardEvent): void {
  const k = e.key;
  const kl = k.toLowerCase();
  if (state !== 'playing') {
    if (k === 'Enter' || k === ' ') {
      advance();
      e.preventDefault();
      return;
    }
    if (kl === 'r') {
      // levelWin sırasında R: aynı bölümü sıfırlamak yerine, oyun bitti ise yeniden başla
      if (state === 'gameWin') {
        gen.bump();
        levelIdx = 0;
        totalMoves = 0;
        loadLevel(0);
      } else {
        // levelWin: zaten bitti, sıfırlama no-op (sonraki bölüme git)
        advance();
      }
      e.preventDefault();
      return;
    }
    // overlay-input-leak: yön tuşları arka pisti hareket ettirmez
    if (
      k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' ||
      kl === 'w' || kl === 'a' || kl === 's' || kl === 'd' || kl === 'z'
    ) {
      e.preventDefault();
    }
    return;
  }
  if (k === 'ArrowUp' || kl === 'w') {
    tryMove(0, -1);
    e.preventDefault();
  } else if (k === 'ArrowDown' || kl === 's') {
    tryMove(0, 1);
    e.preventDefault();
  } else if (k === 'ArrowLeft' || kl === 'a') {
    tryMove(-1, 0);
    e.preventDefault();
  } else if (k === 'ArrowRight' || kl === 'd') {
    tryMove(1, 0);
    e.preventDefault();
  } else if (kl === 'z') {
    undo();
    e.preventDefault();
  } else if (kl === 'r') {
    restartLevel();
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#zp-board')!;
  ctx = canvas.getContext('2d')!;
  levelEl = document.querySelector<HTMLElement>('#zp-level')!;
  movesEl = document.querySelector<HTMLElement>('#zp-moves')!;
  totalEl = document.querySelector<HTMLElement>('#zp-total')!;
  bestEl = document.querySelector<HTMLElement>('#zp-best')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  undoBtn = document.querySelector<HTMLButtonElement>('#zp-undo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#zp-restart')!;
  touchBtns = document.querySelectorAll<HTMLButtonElement>('.zp-touch__btn');

  bestTotal = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', handleKey);

  touchBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const d = btn.dataset.dir;
      if (state !== 'playing') return;
      if (d === 'up') tryMove(0, -1);
      else if (d === 'down') tryMove(0, 1);
      else if (d === 'left') tryMove(-1, 0);
      else if (d === 'right') tryMove(1, 0);
    });
  });

  undoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    undo();
  });
  restartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    restartLevel();
  });
  overlayBtn.addEventListener('click', (e) => {
    e.preventDefault();
    advance();
  });

  loadLevel(0);
}

export const game = defineGame({ init, reset: restartLevel });
