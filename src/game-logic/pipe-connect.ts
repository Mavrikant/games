import { defineGame } from '@shared/game-module';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

// Pipe Connect — boru döndürme puzzle.
// Hedef: kaynak (sol kenar) ile çıkış (sağ kenar) arasında geçerli akışı tamamla.
// Her tıklama bir hücreyi 90° saat yönünde döndürür.

// ---------- Sabitler & yardımcılar ----------

// Yön bitmask: N=1, E=2, S=4, W=8 (saat yönüyle).
const N = 1;
const E = 2;
const S = 4;
const W = 8;

// Bir hücrenin sahip olduğu bağlantı yönleri (rotasyon 0 için baz şekil).
// Rotasyon 1 = 90° saat yönünde; bit-rotate uygulanır.
const BASE: Record<PieceKind, number> = {
  empty: 0,
  // Düz boru: doğu-batı.
  straight: E | W,
  // Dirsek: kuzey-doğu.
  elbow: N | E,
  // T: kuzey + doğu + güney (yani batı kapalı).
  tee: N | E | S,
  // Kaynak: sadece doğu açık (saat yönünde döndürülmez — sabit yön).
  source: E,
  // Çıkış: sadece batı açık (sabit yön).
  end: W,
};

type PieceKind = 'empty' | 'straight' | 'elbow' | 'tee' | 'source' | 'end';

interface Piece {
  kind: PieceKind;
  // Görsel rotasyon adımı (0..3). Her adım 90°.
  rot: number;
  // Endpoint pieces (source/end) sabit; tıklamayla dönmezler.
  fixed: boolean;
}

interface State {
  rows: number;
  cols: number;
  grid: Piece[];
  sourceIdx: number;
  endIdx: number;
  // Bağlı hücreler (akışın ulaştığı hücre indexleri).
  connected: Set<number>;
  moves: number;
  won: boolean;
}

const STORAGE_BEST = 'pipe-connect.bestMoves';
const STORAGE_LEVEL = 'pipe-connect.level';
// Global leaderboard tracks level 1 only — one fixed level so move counts are
// comparable. Fewer moves is better.
const SCORE_DESC = { gameId: 'pipe-connect-1', storageKey: `${STORAGE_BEST}.1`, direction: 'lower' as const };

// ---------- DOM bindings ----------

let boardEl!: HTMLElement;
let levelEl!: HTMLElement;
let movesEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayNextBtn!: HTMLButtonElement;

// ---------- Storage helpers (Safari private-mode safe) ----------

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function loadLevel(): number {
  const raw = safeRead(STORAGE_LEVEL);
  const n = raw === null ? 1 : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function loadBest(level: number): number | null {
  const raw = safeRead(`${STORAGE_BEST}.${level}`);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function saveBest(level: number, moves: number): void {
  safeWrite(`${STORAGE_BEST}.${level}`, String(moves));
}

function saveLevel(level: number): void {
  safeWrite(STORAGE_LEVEL, String(level));
}

// ---------- Bit-rotation: bir bitmask'i `r` adım 90° saat yönünde döndür ----------
// N(1)->E(2)->S(4)->W(8)->N(1). Bir sağa shift; en yüksek bit (W) en alta sarar.
function rotateBits(mask: number, r: number): number {
  const steps = ((r % 4) + 4) % 4;
  let m = mask & 0xf;
  for (let i = 0; i < steps; i++) {
    // (m << 1) içinde W bit'i 0x10'a kayar → 0x10'dan tekrar N(1)'e indir.
    const shifted = (m << 1) & 0xf;
    const wrap = (m & W) !== 0 ? N : 0;
    m = shifted | wrap;
  }
  return m;
}

function connectionsOf(piece: Piece): number {
  return rotateBits(BASE[piece.kind], piece.rot);
}

// ---------- Level → grid boyutu ----------

function gridSizeFor(level: number): { rows: number; cols: number } {
  // Level 1-2: 4x4, 3-4: 5x5, 5-6: 6x6, 7+: 7x7 (max). Mobil görüntü için her
  // boyutta touch target ≥40px korunmalı; 7x7 üstü daraltıyor.
  let size = 4;
  if (level >= 3) size = 5;
  if (level >= 5) size = 6;
  if (level >= 7) size = 7;
  return { rows: size, cols: size };
}

// ---------- Solvable puzzle generation ----------
// Strateji: kaynaktan çıkışa rastgele yürüyüş (DFS) ile çözüm yolu üret.
// Yol boyunca her hücreye geçtiği yönlere göre doğru parça yerleştir, sonra
// (kaynak/çıkış hariç) rastgele rotasyon ile görsel olarak boz.
// Yola dahil olmayan hücreleri rastgele çöp borularla doldur.

interface Cell {
  r: number;
  c: number;
}

function inBounds(rows: number, cols: number, r: number, c: number): boolean {
  return r >= 0 && r < rows && c >= 0 && c < cols;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

// (dr, dc) yön delta'sından bitmask'e çevirme.
function dirMask(dr: number, dc: number): number {
  if (dr === -1 && dc === 0) return N;
  if (dr === 0 && dc === 1) return E;
  if (dr === 1 && dc === 0) return S;
  if (dr === 0 && dc === -1) return W;
  return 0;
}

function opposite(mask: number): number {
  let out = 0;
  if (mask & N) out |= S;
  if (mask & E) out |= W;
  if (mask & S) out |= N;
  if (mask & W) out |= E;
  return out;
}

// Random DFS path: source → end. Her hücreyi en fazla bir kez ziyaret eder.
// Source piece sadece doğuya açık; end sadece batıya açık. Bu kısıtlamayı:
// - source'tan ilk adım doğuya zorunlu (eğer mümkünse).
// - end'e son adım batıdan gelmeli (yani end'in solundaki hücreden ulaşılmalı).
// Performans: maxSteps ile recursion derinliği sınırlandırılır — büyük gridlerde
// Hamiltonian-yakını arama kombinatorial patlamayı önler. Şişko yol gerekmiyor;
// çözüm yolu kısa olabilir.
function generatePath(
  rows: number,
  cols: number,
  source: Cell,
  end: Cell,
  maxSteps: number,
): Cell[] | null {
  const visited: boolean[] = new Array(rows * cols).fill(false);
  const path: Cell[] = [];

  function dfs(r: number, c: number): boolean {
    visited[r * cols + c] = true;
    path.push({ r, c });
    if (r === end.r && c === end.c) {
      // Son adım batıdan mı geldi? (path[-2]'nin sütunu end.c-1 ve satırı end.r olmalı).
      const prev = path[path.length - 2];
      if (prev && prev.r === end.r && prev.c === end.c - 1) return true;
      // Yanlış yönden geldi — geri al.
      visited[r * cols + c] = false;
      path.pop();
      return false;
    }
    if (path.length >= maxSteps) {
      visited[r * cols + c] = false;
      path.pop();
      return false;
    }
    // Source'tayken (path uzunluğu 1) sadece doğuya git.
    let dirs: Array<[number, number]>;
    if (path.length === 1) {
      dirs = [[0, 1]];
    } else {
      dirs = shuffle([
        [-1, 0],
        [0, 1],
        [1, 0],
        [0, -1],
      ]);
    }
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(rows, cols, nr, nc)) continue;
      if (visited[nr * cols + nc]) continue;
      if (dfs(nr, nc)) return true;
    }
    visited[r * cols + c] = false;
    path.pop();
    return false;
  }

  return dfs(source.r, source.c) ? path : null;
}

// Bir piece kind + rotasyon kombinasyonu bul → desired bitmask'e match.
// Match olan ilk (kind, rot)'u dön; yoksa null.
function findPieceFor(desired: number): { kind: PieceKind; rot: number } | null {
  const candidates: PieceKind[] = ['straight', 'elbow', 'tee'];
  for (const kind of candidates) {
    const base = BASE[kind];
    // Doğru bit sayısı uyumu için hızlı pre-filter (popcount).
    const desiredBits = bitCount(desired);
    const baseBits = bitCount(base);
    if (desiredBits !== baseBits) continue;
    for (let r = 0; r < 4; r++) {
      if (rotateBits(base, r) === desired) return { kind, rot: r };
    }
  }
  return null;
}

function bitCount(n: number): number {
  let c = 0;
  let v = n;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  return c;
}

function buildPuzzle(level: number): State {
  const { rows, cols } = gridSizeFor(level);
  const source: Cell = { r: Math.floor(Math.random() * rows), c: 0 };
  const end: Cell = { r: Math.floor(Math.random() * rows), c: cols - 1 };

  // DFS bazen başarısız olabilir; birkaç deneme. maxSteps level'a göre büyür ama
  // exponential-blowup'ı kesmek için sınırlı.
  const baseSteps = Math.max(cols + rows + 2, 8);
  let path: Cell[] | null = null;
  for (let attempt = 0; attempt < 12 && !path; attempt++) {
    // Her denemede biraz daha uzun yol denenebilir; ama erken stop için kontrollü.
    const maxSteps = baseSteps + attempt * 2;
    path = generatePath(rows, cols, source, end, maxSteps);
  }
  if (!path) {
    // Fallback: aynı satırda düz yol (her zaman çözülebilir, çıkışın satırı da düzelir).
    path = [];
    const r = source.r;
    for (let c = 0; c < cols; c++) path.push({ r, c });
    end.r = r;
  }

  // Her hücre için yol bağlantı bitmask'i hesapla.
  const grid: Piece[] = new Array(rows * cols)
    .fill(null)
    .map(() => ({ kind: 'empty', rot: 0, fixed: false }));

  for (let i = 0; i < path.length; i++) {
    const cell = path[i]!;
    let mask = 0;
    if (i > 0) {
      const prev = path[i - 1]!;
      mask |= dirMask(prev.r - cell.r, prev.c - cell.c);
    }
    if (i < path.length - 1) {
      const nxt = path[i + 1]!;
      mask |= dirMask(nxt.r - cell.r, nxt.c - cell.c);
    }
    const idx = cell.r * cols + cell.c;
    const piece = grid[idx]!;
    if (i === 0) {
      // Source: sadece doğu (path'in ilk adımı zaten doğuya gider — kaynak sol kenarda).
      piece.kind = 'source';
      piece.rot = 0;
      piece.fixed = true;
    } else if (i === path.length - 1) {
      piece.kind = 'end';
      piece.rot = 0;
      piece.fixed = true;
    } else {
      const found = findPieceFor(mask);
      if (found) {
        piece.kind = found.kind;
        piece.rot = found.rot;
        piece.fixed = false;
      }
    }
  }

  // Yola dahil olmayan boş hücreleri rastgele çöp borularla doldur (level >= 2'den itibaren).
  if (level >= 2) {
    const junkProb = Math.min(0.35 + level * 0.05, 0.7);
    for (let i = 0; i < grid.length; i++) {
      const p = grid[i]!;
      if (p.kind !== 'empty') continue;
      if (Math.random() > junkProb) continue;
      const choices: PieceKind[] = ['straight', 'elbow'];
      if (level >= 3) choices.push('tee');
      const kind = choices[Math.floor(Math.random() * choices.length)]!;
      p.kind = kind;
      p.rot = Math.floor(Math.random() * 4);
    }
  }

  // Çözüm yolundaki (endpoint olmayan) hücreleri rastgele rotasyona kaydır.
  // Önemli: 0 rotasyon ile başlamayalım, kullanıcı görsel olarak puzzle hissetmeli.
  for (const piece of grid) {
    if (piece.fixed || piece.kind === 'empty') continue;
    piece.rot = Math.floor(Math.random() * 4);
  }

  return {
    rows,
    cols,
    grid,
    sourceIdx: source.r * cols + source.c,
    endIdx: end.r * cols + end.c,
    connected: new Set<number>(),
    moves: 0,
    won: false,
  };
}

// ---------- Flow / connectivity ----------

function computeConnected(state: State): Set<number> {
  const { rows, cols, grid, sourceIdx } = state;
  const reached = new Set<number>();
  reached.add(sourceIdx);
  const stack: number[] = [sourceIdx];
  while (stack.length > 0) {
    const i = stack.pop()!;
    const r = Math.floor(i / cols);
    const c = i % cols;
    const piece = grid[i]!;
    const conn = connectionsOf(piece);
    // Her yönü kontrol et: o yönde komşu var mı, komşunun karşı bağlantısı açık mı?
    const dirs: Array<[number, number, number]> = [
      [-1, 0, N],
      [0, 1, E],
      [1, 0, S],
      [0, -1, W],
    ];
    for (const [dr, dc, mask] of dirs) {
      if ((conn & mask) === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(rows, cols, nr, nc)) continue;
      const ni = nr * cols + nc;
      if (reached.has(ni)) continue;
      const nb = grid[ni]!;
      if (nb.kind === 'empty') continue;
      const nbConn = connectionsOf(nb);
      if ((nbConn & opposite(mask)) === 0) continue;
      reached.add(ni);
      stack.push(ni);
    }
  }
  return reached;
}

// ---------- Render ----------

let state: State;
let cellEls: HTMLButtonElement[] = [];

function buildBoard(): void {
  boardEl.innerHTML = '';
  boardEl.style.setProperty('--pc-cols', String(state.cols));
  boardEl.style.setProperty('--pc-rows', String(state.rows));
  cellEls = [];
  for (let i = 0; i < state.grid.length; i++) {
    const piece = state.grid[i]!;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pc-cell';
    btn.dataset.i = String(i);
    btn.setAttribute('role', 'gridcell');
    const r = Math.floor(i / state.cols);
    const c = i % state.cols;
    btn.setAttribute('aria-label', `Hücre satır ${r + 1}, sütun ${c + 1}`);
    if (piece.fixed) btn.classList.add('pc-cell--fixed');
    if (piece.kind === 'source') btn.classList.add('pc-cell--source');
    if (piece.kind === 'end') btn.classList.add('pc-cell--end');
    if (piece.kind === 'empty') btn.classList.add('pc-cell--empty');
    btn.innerHTML = renderPieceSVG(piece);
    btn.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(btn);
    cellEls.push(btn);
  }
}

// Her parça için ortada SVG render. Rotation, .pc-piece üzerinde CSS variable.
function renderPieceSVG(piece: Piece): string {
  if (piece.kind === 'empty') {
    return '<span class="pc-piece pc-piece--empty" aria-hidden="true"></span>';
  }
  const rotDeg = piece.rot * 90;
  // Source / end için özel ikon.
  if (piece.kind === 'source') {
    return (
      `<span class="pc-piece pc-piece--endpoint" style="transform:rotate(${rotDeg}deg)" aria-hidden="true">` +
      `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">` +
      // Source: dolu kutu (sol-orta), pipe stub doğuya doğru.
      `<rect class="pc-svg-src" x="14" y="30" width="40" height="40" rx="8" />` +
      `<rect class="pc-svg-pipe" x="50" y="42" width="50" height="16" />` +
      `<circle class="pc-svg-drop" cx="34" cy="50" r="9" />` +
      `</svg>` +
      `</span>`
    );
  }
  if (piece.kind === 'end') {
    return (
      `<span class="pc-piece pc-piece--endpoint" style="transform:rotate(${rotDeg}deg)" aria-hidden="true">` +
      `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">` +
      // End: pipe doğudan giriyor, sağ tarafta hedef halkası.
      `<rect class="pc-svg-pipe" x="0" y="42" width="50" height="16" />` +
      `<circle class="pc-svg-end-outer" cx="68" cy="50" r="22" />` +
      `<circle class="pc-svg-end-inner" cx="68" cy="50" r="10" />` +
      `</svg>` +
      `</span>`
    );
  }
  // Normal pipes.
  const inner = pipeShapeSVG(piece.kind);
  return (
    `<span class="pc-piece" style="transform:rotate(${rotDeg}deg)" aria-hidden="true">` +
    `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">${inner}</svg>` +
    `</span>`
  );
}

function pipeShapeSVG(kind: PieceKind): string {
  // Her şekil rotation 0 (BASE) için çiziliyor.
  // straight: E+W → yatay çubuk.
  // elbow: N+E → kuzeyden doğuya dirsek.
  // tee: N+E+S → kuzey-doğu-güney T.
  // Pipe gövdesi (pc-svg-pipe sınıfı) bağlı/bağlı değil rengini CSS'ten alır.
  // Akan su ayrı bir overlay path (pc-svg-flow) — daha açık ton.
  const pipeColor = 'pc-svg-pipe';
  const flowColor = 'pc-svg-flow';
  if (kind === 'straight') {
    return (
      `<rect class="${pipeColor}" x="0" y="42" width="100" height="16" />` +
      `<rect class="${flowColor}" x="0" y="46" width="100" height="8" />`
    );
  }
  if (kind === 'elbow') {
    // N+E dirsek: yukarıdan ortaya, sonra ortadan sağa.
    // Path: M50 0 V58 H100 — pipe genişliği 16; kullanılan tasarım: iki rect + corner circle.
    return (
      `<rect class="${pipeColor}" x="42" y="0" width="16" height="58" />` +
      `<rect class="${pipeColor}" x="42" y="42" width="58" height="16" />` +
      `<rect class="${flowColor}" x="46" y="0" width="8" height="54" />` +
      `<rect class="${flowColor}" x="46" y="46" width="54" height="8" />`
    );
  }
  if (kind === 'tee') {
    // N+E+S T: dikey çubuk + sağa doğru dal.
    return (
      `<rect class="${pipeColor}" x="42" y="0" width="16" height="100" />` +
      `<rect class="${pipeColor}" x="42" y="42" width="58" height="16" />` +
      `<rect class="${flowColor}" x="46" y="0" width="8" height="100" />` +
      `<rect class="${flowColor}" x="46" y="46" width="54" height="8" />`
    );
  }
  return '';
}

// ---------- Game flow ----------

function onCellClick(i: number): void {
  if (state.won) return;
  const piece = state.grid[i];
  if (!piece || piece.fixed || piece.kind === 'empty') return;
  piece.rot = (piece.rot + 1) % 4;
  state.moves++;
  movesEl.textContent = String(state.moves);
  applyRotation(i);
  // Connectivity hesaplaması rotasyon animasyonu boyunca ya da hemen yapılabilir.
  // UX: anında hesapla — kullanıcı görsel feedback ile akışı görsün.
  refreshConnections();
  if (state.connected.has(state.endIdx)) {
    winCurrentLevel();
  }
}

function applyRotation(i: number): void {
  const el = cellEls[i];
  const piece = state.grid[i];
  if (!el || !piece) return;
  const inner = el.querySelector<HTMLElement>('.pc-piece');
  if (!inner) return;
  inner.style.transform = `rotate(${piece.rot * 90}deg)`;
}

function refreshConnections(): void {
  state.connected = computeConnected(state);
  for (let i = 0; i < cellEls.length; i++) {
    const el = cellEls[i]!;
    el.classList.toggle('pc-cell--connected', state.connected.has(i));
  }
  // End hücresi bağlıysa görsel "akış tamamlandı" işareti.
  const endEl = cellEls[state.endIdx];
  if (endEl) {
    endEl.classList.toggle(
      'pc-cell--end-lit',
      state.connected.has(state.endIdx),
    );
  }
}

function winCurrentLevel(): void {
  state.won = true;
  const level = currentLevel;
  const prevBest = loadBest(level);
  let isBest = false;
  if (prevBest === null || state.moves < prevBest) {
    isBest = true;
    saveBest(level, state.moves);
  }
  if (level === 1) reportGameOver(SCORE_DESC, state.moves, { label: 'Hamle' });
  bestEl.textContent = String(loadBest(level) ?? state.moves);
  overlayTitle.textContent = isBest
    ? `Yeni rekor! · Seviye ${level}`
    : `Akış tamamlandı! · Seviye ${level}`;
  const bestText = prevBest === null ? '' : ` · Önceki rekor ${prevBest}`;
  overlayMsg.textContent = `${state.moves} hamlede tamamladın${bestText}`;
  // Kısa bekleme: kullanıcı akışın sona ulaştığını görsün, sonra overlay.
  // Module-level generation token — restart bumps it; deferred callback bails out.
  const myGen = generation.current();
  window.setTimeout(() => {
    if (!generation.isCurrent(myGen)) return;
    overlayEl.classList.remove('pc-overlay--hidden');
  }, 350);
}

function hideOverlay(): void {
  overlayEl.classList.add('pc-overlay--hidden');
}

// ---------- Level/puzzle yaşam döngüsü ----------

let currentLevel = 1;
// Module-level generation counter — her newPuzzle çağrısı bump eder.
// Win sonrası 350ms overlay timeout'u bu generation'ı yakalar; restart
// generation'ı değiştirdiyse overlay açılmaz (stale-async-callback önlemi).
const generation = createGenToken();

function newPuzzle(level: number): void {
  hideOverlay();
  currentLevel = level;
  saveLevel(level);
  state = buildPuzzle(level);
  generation.bump();
  levelEl.textContent = String(level);
  movesEl.textContent = '0';
  const b = loadBest(level);
  bestEl.textContent = b === null ? '—' : String(b);
  buildBoard();
  refreshConnections();
}

function nextLevel(): void {
  newPuzzle(currentLevel + 1);
}

function restartCurrent(): void {
  newPuzzle(currentLevel);
}

function init(): void {
  boardEl = document.querySelector<HTMLElement>('#board')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  movesEl = document.querySelector<HTMLElement>('#moves')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayNextBtn = document.querySelector<HTMLButtonElement>('#overlay-next')!;

  restartBtn.addEventListener('click', restartCurrent);
  overlayNextBtn.addEventListener('click', nextLevel);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
    }
    if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      restartCurrent();
    } else if (e.key === 'Enter' && state.won) {
      e.preventDefault();
      nextLevel();
    }
  });

  newPuzzle(loadLevel());
}

export const game = defineGame({ init, reset: restartCurrent });
