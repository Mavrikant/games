// Domino — double-six, 2 player (human vs greedy AI), block dominoes variant.
// Pitfalls guarded:
// - state machine (playerTurn | aiTurn | gameOver) gates inputs
// - generation token bumps on reset → stale ai-setTimeout no-op
// - safeRead/safeWrite around localStorage
// - body has no <h1>/hint (layout owns them)

interface Tile {
  a: number;
  b: number;
  id: string; // canonical
}

interface PlacedTile {
  a: number;
  b: number;
  id: string;
}

type GameState = 'playerTurn' | 'aiTurn' | 'gameOver';

const KEY_WINS = 'domino.wins';
const KEY_LOSSES = 'domino.losses';

const winsEl = document.querySelector<HTMLElement>('#wins')!;
const lossesEl = document.querySelector<HTMLElement>('#losses')!;
const boneyardEl = document.querySelector<HTMLElement>('#boneyard')!;
const aiCountEl = document.querySelector<HTMLElement>('#ai-count')!;
const playerCountEl = document.querySelector<HTMLElement>('#player-count')!;
const chainEl = document.querySelector<HTMLElement>('#chain')!;
const aiHandEl = document.querySelector<HTMLElement>('#ai-hand')!;
const playerHandEl = document.querySelector<HTMLElement>('#player-hand')!;
const leftEndBtn = document.querySelector<HTMLButtonElement>('#left-end')!;
const rightEndBtn = document.querySelector<HTMLButtonElement>('#right-end')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const drawBtn = document.querySelector<HTMLButtonElement>('#draw')!;
const passBtn = document.querySelector<HTMLButtonElement>('#pass')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

let deck: Tile[] = [];
let playerHand: Tile[] = [];
let aiHand: Tile[] = [];
let chain: PlacedTile[] = [];
let state: GameState = 'playerTurn';
let wins = 0;
let losses = 0;
let selectedTileId: string | null = null;
let gen = 0;

function safeRead(key: string): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function safeWrite(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

function buildDeck(): Tile[] {
  const tiles: Tile[] = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) {
      tiles.push({ a, b, id: `${a}-${b}` });
    }
  }
  return tiles;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

function chainLeftEnd(): number | null {
  if (chain.length === 0) return null;
  return chain[0]!.a;
}
function chainRightEnd(): number | null {
  if (chain.length === 0) return null;
  return chain[chain.length - 1]!.b;
}

function canPlay(tile: Tile, side: 'L' | 'R'): boolean {
  if (chain.length === 0) return true;
  if (side === 'L') {
    const left = chainLeftEnd()!;
    return tile.a === left || tile.b === left;
  } else {
    const right = chainRightEnd()!;
    return tile.a === right || tile.b === right;
  }
}

function anyPlayable(hand: Tile[]): boolean {
  if (chain.length === 0) return hand.length > 0;
  for (const t of hand) {
    if (canPlay(t, 'L') || canPlay(t, 'R')) return true;
  }
  return false;
}

function placeTile(hand: Tile[], tile: Tile, side: 'L' | 'R'): void {
  const idx = hand.findIndex((t) => t.id === tile.id);
  if (idx < 0) return;
  hand.splice(idx, 1);
  if (chain.length === 0) {
    chain.push({ a: tile.a, b: tile.b, id: tile.id });
    return;
  }
  if (side === 'L') {
    const left = chainLeftEnd()!;
    // Place so that touching side equals left
    if (tile.b === left) {
      chain.unshift({ a: tile.a, b: tile.b, id: tile.id });
    } else {
      // tile.a === left → flip
      chain.unshift({ a: tile.b, b: tile.a, id: tile.id });
    }
  } else {
    const right = chainRightEnd()!;
    if (tile.a === right) {
      chain.push({ a: tile.a, b: tile.b, id: tile.id });
    } else {
      // tile.b === right → flip
      chain.push({ a: tile.b, b: tile.a, id: tile.id });
    }
  }
}

function startGame(): void {
  gen += 1;
  deck = shuffle(buildDeck());
  playerHand = deck.splice(0, 7);
  aiHand = deck.splice(0, 7);
  chain = [];
  selectedTileId = null;

  // Find highest double across both hands → that player goes first.
  let highestDouble = -1;
  let starter: 'player' | 'ai' | null = null;
  let starterTile: Tile | null = null;
  for (const t of playerHand) {
    if (t.a === t.b && t.a > highestDouble) {
      highestDouble = t.a;
      starter = 'player';
      starterTile = t;
    }
  }
  for (const t of aiHand) {
    if (t.a === t.b && t.a > highestDouble) {
      highestDouble = t.a;
      starter = 'ai';
      starterTile = t;
    }
  }

  if (!starter || !starterTile) {
    // No doubles in either hand (rare). First player who has highest pip total.
    const pp = playerHand.reduce((s, t) => s + t.a + t.b, 0);
    const ap = aiHand.reduce((s, t) => s + t.a + t.b, 0);
    starter = pp >= ap ? 'player' : 'ai';
    starterTile = (starter === 'player' ? playerHand : aiHand)[0]!;
  }

  // Place starting tile.
  if (starter === 'player') {
    placeTile(playerHand, starterTile, 'R');
    state = 'aiTurn';
    setStatus(`İlk taş: ${starterTile.id}. Sıra rakipte.`);
    syncAll();
    scheduleAi();
  } else {
    placeTile(aiHand, starterTile, 'R');
    state = 'playerTurn';
    setStatus(`Rakip başladı: ${starterTile.id}. Sıra sende.`);
    syncAll();
  }
}

function setStatus(s: string): void {
  statusEl.textContent = s;
}

function renderTile(t: { a: number; b: number }, opts: { facedown?: boolean; selected?: boolean; vertical?: boolean } = {}): string {
  if (opts.facedown) {
    return `<span class="dm-tile dm-tile--back"></span>`;
  }
  const cls = `dm-tile${opts.selected ? ' dm-tile--selected' : ''}${opts.vertical ? ' dm-tile--v' : ''}`;
  const pipsA = renderPips(t.a);
  const pipsB = renderPips(t.b);
  return `<span class="${cls}"><span class="dm-tile__half">${pipsA}</span><span class="dm-tile__half">${pipsB}</span></span>`;
}

function renderPips(n: number): string {
  // Generate a 3x3 pips grid using dot positions
  // positions: 1: center; 2: top-left, bottom-right; 3: tl,c,br; 4: tl,tr,bl,br; 5: tl,tr,c,bl,br; 6: tl,tr,ml,mr,bl,br
  const grid: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const place = (r: number, c: number): void => { grid[r]![c] = 1; };
  switch (n) {
    case 0:
      break;
    case 1:
      place(1, 1);
      break;
    case 2:
      place(0, 0); place(2, 2);
      break;
    case 3:
      place(0, 0); place(1, 1); place(2, 2);
      break;
    case 4:
      place(0, 0); place(0, 2); place(2, 0); place(2, 2);
      break;
    case 5:
      place(0, 0); place(0, 2); place(1, 1); place(2, 0); place(2, 2);
      break;
    case 6:
      place(0, 0); place(0, 2); place(1, 0); place(1, 2); place(2, 0); place(2, 2);
      break;
  }
  let html = '<span class="dm-pips">';
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      html += `<span class="${grid[r]![c] === 1 ? 'dm-pip dm-pip--on' : 'dm-pip'}"></span>`;
    }
  }
  html += '</span>';
  return html;
}

function renderHands(): void {
  // Player hand
  let html = '';
  for (const t of playerHand) {
    const selected = t.id === selectedTileId;
    html += `<button class="dm-tile-btn${selected ? ' dm-tile-btn--selected' : ''}" data-id="${t.id}" type="button">${renderTile(t, { selected })}</button>`;
  }
  playerHandEl.innerHTML = html;

  // AI hand (facedown)
  let aiHtml = '';
  for (let i = 0; i < aiHand.length; i++) {
    aiHtml += `<span class="dm-tile-btn dm-tile-btn--facedown">${renderTile({ a: 0, b: 0 }, { facedown: true })}</span>`;
  }
  aiHandEl.innerHTML = aiHtml;
}

function renderChain(): void {
  let html = '';
  for (const p of chain) {
    html += renderTile(p);
  }
  chainEl.innerHTML = html;
  const leftEnabled = selectedTileId !== null && state === 'playerTurn' && (() => {
    const tile = playerHand.find((t) => t.id === selectedTileId);
    return !!tile && canPlay(tile, 'L');
  })();
  const rightEnabled = selectedTileId !== null && state === 'playerTurn' && (() => {
    const tile = playerHand.find((t) => t.id === selectedTileId);
    return !!tile && canPlay(tile, 'R');
  })();
  leftEndBtn.disabled = !leftEnabled;
  rightEndBtn.disabled = !rightEnabled;
  leftEndBtn.classList.toggle('dm__end--active', leftEnabled);
  rightEndBtn.classList.toggle('dm__end--active', rightEnabled);
}

function syncAll(): void {
  winsEl.textContent = String(wins);
  lossesEl.textContent = String(losses);
  boneyardEl.textContent = String(deck.length);
  playerCountEl.textContent = String(playerHand.length);
  aiCountEl.textContent = String(aiHand.length);
  renderHands();
  renderChain();
  drawBtn.disabled = state !== 'playerTurn' || deck.length === 0 || anyPlayable(playerHand);
  passBtn.disabled = state !== 'playerTurn' || anyPlayable(playerHand) || deck.length > 0;
}

function selectTile(id: string): void {
  if (state !== 'playerTurn') return;
  const tile = playerHand.find((t) => t.id === id);
  if (!tile) return;
  selectedTileId = selectedTileId === id ? null : id;
  syncAll();
}

function playSelected(side: 'L' | 'R'): void {
  if (state !== 'playerTurn') return;
  if (!selectedTileId) return;
  const tile = playerHand.find((t) => t.id === selectedTileId);
  if (!tile) return;
  if (!canPlay(tile, side)) return;
  placeTile(playerHand, tile, side);
  selectedTileId = null;
  setStatus(`Sen ${tile.id} oynadın.`);
  if (playerHand.length === 0) {
    endGame('player');
    return;
  }
  state = 'aiTurn';
  syncAll();
  scheduleAi();
}

function playerDraw(): void {
  if (state !== 'playerTurn') return;
  if (deck.length === 0) return;
  if (anyPlayable(playerHand)) return;
  const t = deck.pop()!;
  playerHand.push(t);
  setStatus(`Çektin: ${t.id}.`);
  syncAll();
  if (!anyPlayable(playerHand) && deck.length === 0) {
    // Force pass
    setStatus('Çekecek taş yok ve oynayamıyorsun. "Pas" tuşuna bas.');
  }
}

function playerPass(): void {
  if (state !== 'playerTurn') return;
  if (anyPlayable(playerHand)) return;
  if (deck.length > 0) return;
  setStatus('Pas geçtin. Sıra rakipte.');
  state = 'aiTurn';
  syncAll();
  scheduleAi();
}

function scheduleAi(): void {
  const myGen = gen;
  window.setTimeout(() => {
    if (myGen !== gen) return;
    if (state !== 'aiTurn') return;
    aiPlay();
  }, 580);
}

function aiPlay(): void {
  // Find any playable tile; prefer one with most pips.
  while (true) {
    let bestIdx = -1;
    let bestSide: 'L' | 'R' = 'L';
    let bestScore = -1;
    for (let i = 0; i < aiHand.length; i++) {
      const t = aiHand[i]!;
      for (const side of ['L', 'R'] as const) {
        if (canPlay(t, side)) {
          const score = t.a + t.b;
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
            bestSide = side;
          }
        }
      }
    }
    if (bestIdx >= 0) {
      const tile = aiHand[bestIdx]!;
      placeTile(aiHand, tile, bestSide);
      setStatus(`Rakip ${tile.id} oynadı.`);
      if (aiHand.length === 0) {
        endGame('ai');
        return;
      }
      state = 'playerTurn';
      syncAll();
      // After AI plays, if player can't play and boneyard empty, allow pass UI
      return;
    }
    // No play; try draw.
    if (deck.length > 0) {
      const t = deck.pop()!;
      aiHand.push(t);
      // try again
      continue;
    }
    // No play, no draw → AI passes
    setStatus('Rakip pas geçti.');
    state = 'playerTurn';
    syncAll();
    if (!anyPlayable(playerHand) && deck.length === 0) {
      // Both stuck → game over by point comparison
      endGame(null);
    }
    return;
  }
}

function pipSum(hand: Tile[]): number {
  return hand.reduce((s, t) => s + t.a + t.b, 0);
}

function endGame(winner: 'player' | 'ai' | null): void {
  state = 'gameOver';
  if (winner === 'player') {
    wins += 1;
    setStatus(`Kazandın! Tüm taşlarını oynadın.`);
  } else if (winner === 'ai') {
    losses += 1;
    setStatus('Rakip taşları bitirdi. Kaybettin.');
  } else {
    // Compare pip sums
    const ps = pipSum(playerHand);
    const as_ = pipSum(aiHand);
    if (ps < as_) {
      wins += 1;
      setStatus(`Bloke! Senin ${ps} < rakip ${as_} — kazandın.`);
    } else if (ps > as_) {
      losses += 1;
      setStatus(`Bloke! Senin ${ps} > rakip ${as_} — kaybettin.`);
    } else {
      setStatus(`Bloke! Eşit puan (${ps} - ${as_}). Berabere.`);
    }
  }
  safeWrite(KEY_WINS, wins);
  safeWrite(KEY_LOSSES, losses);
  syncAll();
}

playerHandEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest('.dm-tile-btn') as HTMLElement | null;
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (!id) return;
  selectTile(id);
});

leftEndBtn.addEventListener('click', () => playSelected('L'));
rightEndBtn.addEventListener('click', () => playSelected('R'));
drawBtn.addEventListener('click', playerDraw);
passBtn.addEventListener('click', playerPass);
restartBtn.addEventListener('click', () => {
  startGame();
});

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r') {
    startGame();
    e.preventDefault();
  }
});

wins = safeRead(KEY_WINS);
losses = safeRead(KEY_LOSSES);
startGame();
