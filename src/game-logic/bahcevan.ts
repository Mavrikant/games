// ---------------------------------------------------------------------------
// Bahçevan — bitki büyüme yönetimi
// Mekanik: 6 parselde tohum dik → sula → meyveyi topla.
// Phases: empty → seedling → growing → harvest (her phase 1 sulama gerektirir,
// fruit ortaya çıkana kadar). Susama bar'ı 0 olunca bitki kurur (parsel boş).
//
// State machine: ready | playing | gameover
// Pitfalls addressed:
//   - visual-vs-hitbox: parsel hücre boyutu CSS grid; click hitbox = parsel
//     button alanı. Görsel öğeler (bitki, bar) pointer-events: none.
//   - overlay-input-leak: state enum; ready/gameover'da parsel tıklama
//     mutate etmez, sadece overlay-btn/restart yeni oyun başlatır.
//   - stale-async-callback: rAF loop bir `gen` token'a bağlı; reset gen++.
//   - invisible-boot: ilk frame 6 boş parsel + skor 0 + best görünür. Resmen
//     ready overlay açık ama altı görünür (semi-transparent değil; "Başla"
//     ile gizlenince hemen 6 parsel boş ve seçilebilir.)
//   - unguarded-storage: safeRead/safeWrite try/catch.
//   - duplicate-with-shared-layer: body'de title/hint yok; layout veriyor.
// ---------------------------------------------------------------------------

type GameState = 'ready' | 'playing' | 'gameover';
type Phase = 'empty' | 'seedling' | 'growing' | 'harvest';
type FruitKind = 'weed' | 'apple' | 'gold';

interface Plot {
  phase: Phase;
  /** Thirst bar 0..1. 1 = full (just watered). 0 = dries up. */
  thirst: number;
  /** Speed at which thirst decreases per second (varies per plot). */
  thirstRate: number;
  /** Fruit kind, only known once we hit harvest phase. */
  fruit: FruitKind;
  /** DOM refs */
  cell: HTMLButtonElement;
  bar: HTMLDivElement;
  sprite: HTMLDivElement;
  label: HTMLDivElement;
}

// ── Constants ───────────────────────────────────────────────────────────────
const PLOT_COUNT = 6;
const STORAGE_KEY = 'bahcevan.best';
const STORAGE_DRIED_KEY = 'bahcevan.dried';

// Thirst dynamics
const WATER_REFILL = 1.0;
// Range of thirst decay (per second). Plots get random rates → multi-tasking.
const THIRST_RATE_MIN = 0.045;
const THIRST_RATE_MAX = 0.085;

// Phase progression: tap on empty plants; each successful watering bumps phase
// (seedling → growing → harvest). Two waterings between plant and harvest.

// Game-over: soft cap — when this many plants dry up in one run.
const DRIED_LIMIT = 5;

// Score per fruit
const SCORE_WEED = 5;
const SCORE_APPLE = 15;
const SCORE_GOLD = 50;

// Fruit drop probabilities (sums to 1)
const P_GOLD = 0.08;
const P_APPLE = 0.42;
// remaining 0.5 weed

// ── DOM refs ────────────────────────────────────────────────────────────────
const garden = document.querySelector<HTMLDivElement>('#garden')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const driedEl = document.querySelector<HTMLElement>('#dried')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

// ── Safe storage ────────────────────────────────────────────────────────────
function safeRead(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore (private mode, disabled, etc.) */
  }
}

// ── Sprites ─────────────────────────────────────────────────────────────────
function emptySpriteSvg(): string {
  // empty soil with a faint plus marker
  return `
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <g opacity="0.55">
        <circle cx="50" cy="50" r="10" fill="none" stroke="var(--bc-soil-dim)" stroke-width="2" stroke-dasharray="3 3" />
        <path d="M50 42 L50 58 M42 50 L58 50" stroke="var(--bc-soil-dim)" stroke-width="2" stroke-linecap="round" />
      </g>
    </svg>
  `;
}

function seedlingSpriteSvg(): string {
  // tiny sprout
  return `
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <ellipse cx="50" cy="78" rx="14" ry="3" fill="var(--bc-soil-deep)" />
      <path d="M50 78 L50 60" stroke="var(--bc-stem)" stroke-width="3" stroke-linecap="round" />
      <ellipse cx="44" cy="62" rx="6" ry="4" fill="var(--bc-leaf)" transform="rotate(-30 44 62)" />
      <ellipse cx="56" cy="60" rx="6" ry="4" fill="var(--bc-leaf-light)" transform="rotate(28 56 60)" />
    </svg>
  `;
}

function growingSpriteSvg(): string {
  // bushier plant, no fruit yet
  return `
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <ellipse cx="50" cy="80" rx="18" ry="3" fill="var(--bc-soil-deep)" />
      <path d="M50 80 L50 42" stroke="var(--bc-stem)" stroke-width="3.5" stroke-linecap="round" />
      <ellipse cx="38" cy="58" rx="9" ry="5" fill="var(--bc-leaf)" transform="rotate(-26 38 58)" />
      <ellipse cx="62" cy="55" rx="9" ry="5" fill="var(--bc-leaf-light)" transform="rotate(26 62 55)" />
      <ellipse cx="35" cy="46" rx="8" ry="4.5" fill="var(--bc-leaf-light)" transform="rotate(-15 35 46)" />
      <ellipse cx="65" cy="44" rx="8" ry="4.5" fill="var(--bc-leaf)" transform="rotate(15 65 44)" />
      <ellipse cx="50" cy="40" rx="7" ry="4" fill="var(--bc-leaf-light)" />
    </svg>
  `;
}

function harvestSpriteSvg(fruit: FruitKind): string {
  // plant with fruit visible at the top
  const stem = `
    <ellipse cx="50" cy="82" rx="20" ry="3" fill="var(--bc-soil-deep)" />
    <path d="M50 82 L50 36" stroke="var(--bc-stem)" stroke-width="4" stroke-linecap="round" />
    <ellipse cx="34" cy="60" rx="11" ry="5.5" fill="var(--bc-leaf)" transform="rotate(-26 34 60)" />
    <ellipse cx="66" cy="58" rx="11" ry="5.5" fill="var(--bc-leaf-light)" transform="rotate(26 66 58)" />
    <ellipse cx="32" cy="46" rx="10" ry="5" fill="var(--bc-leaf-light)" transform="rotate(-15 32 46)" />
    <ellipse cx="68" cy="44" rx="10" ry="5" fill="var(--bc-leaf)" transform="rotate(15 68 44)" />
  `;
  switch (fruit) {
    case 'weed':
      // simple yellowish patchy leaves — low value
      return `
        <svg viewBox="0 0 100 100" aria-hidden="true">
          ${stem}
          <ellipse cx="50" cy="38" rx="14" ry="9" fill="var(--bc-weed)" />
          <ellipse cx="50" cy="34" rx="9" ry="5" fill="var(--bc-weed-light)" opacity="0.85" />
          <text x="50" y="26" text-anchor="middle" font-size="10" font-weight="700" fill="var(--bc-weed-dark)">~</text>
        </svg>
      `;
    case 'apple':
      return `
        <svg viewBox="0 0 100 100" aria-hidden="true">
          ${stem}
          <circle cx="50" cy="36" r="14" fill="var(--bc-apple)" />
          <circle cx="50" cy="36" r="14" fill="none" stroke="var(--bc-apple-dark)" stroke-width="1.5" opacity="0.5" />
          <ellipse cx="44" cy="30" rx="4" ry="2.5" fill="var(--bc-apple-light)" opacity="0.85" />
          <path d="M52 22 Q56 18 60 22" stroke="var(--bc-stem-dark)" stroke-width="2" fill="none" stroke-linecap="round" />
          <ellipse cx="60" cy="22" rx="3" ry="1.5" fill="var(--bc-leaf)" transform="rotate(35 60 22)" />
        </svg>
      `;
    case 'gold':
      return `
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <radialGradient id="bc-gold-grad" cx="0.4" cy="0.3" r="0.7">
              <stop offset="0%" stop-color="#fff8d6" />
              <stop offset="60%" stop-color="var(--bc-gold)" />
              <stop offset="100%" stop-color="var(--bc-gold-dark)" />
            </radialGradient>
          </defs>
          ${stem}
          <g transform="translate(50 36)">
            <path d="M0 -16 L4 -5 L15 -5 L6 2 L9 13 L0 6 L-9 13 L-6 2 L-15 -5 L-4 -5 Z"
                  fill="url(#bc-gold-grad)"
                  stroke="var(--bc-gold-dark)"
                  stroke-width="1" />
            <circle cx="0" cy="0" r="3" fill="#fff8d6" opacity="0.9" />
          </g>
          <text x="22" y="22" font-size="8" fill="#fff" opacity="0.85" font-weight="700">★</text>
          <text x="74" y="56" font-size="6" fill="#fff" opacity="0.75" font-weight="700">✦</text>
        </svg>
      `;
  }
}

function buildSpriteHtml(p: Plot): string {
  switch (p.phase) {
    case 'empty':
      return emptySpriteSvg();
    case 'seedling':
      return seedlingSpriteSvg();
    case 'growing':
      return growingSpriteSvg();
    case 'harvest':
      return harvestSpriteSvg(p.fruit);
  }
}

function actionLabel(p: Plot): string {
  switch (p.phase) {
    case 'empty':
      return 'Dik';
    case 'seedling':
    case 'growing':
      return p.thirst < 0.5 ? 'Sula!' : 'Sula';
    case 'harvest':
      return 'Topla';
  }
}

// ── Game state ──────────────────────────────────────────────────────────────
let state: GameState = 'ready';
let score = 0;
let best = 0;
let driedCount = 0;
let plots: Plot[] = [];
let gen = 0; // generation token — bumped on every reset()
let rafId = 0;
let lastTick = 0;

// ── RNG ─────────────────────────────────────────────────────────────────────
function rng(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function pickFruit(): FruitKind {
  const r = Math.random();
  if (r < P_GOLD) return 'gold';
  if (r < P_GOLD + P_APPLE) return 'apple';
  return 'weed';
}

function fruitScore(f: FruitKind): number {
  switch (f) {
    case 'weed':
      return SCORE_WEED;
    case 'apple':
      return SCORE_APPLE;
    case 'gold':
      return SCORE_GOLD;
  }
}

// ── DOM build ───────────────────────────────────────────────────────────────
function buildGarden(): void {
  garden.innerHTML = '';
  plots = [];

  for (let i = 0; i < PLOT_COUNT; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'plot';
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', `Parsel ${i + 1}`);
    cell.dataset.index = String(i);

    const ring = document.createElement('div');
    ring.className = 'plot__ring';
    cell.appendChild(ring);

    const sprite = document.createElement('div');
    sprite.className = 'plot__sprite';
    cell.appendChild(sprite);

    const bar = document.createElement('div');
    bar.className = 'plot__bar';
    const fill = document.createElement('div');
    fill.className = 'plot__bar-fill';
    bar.appendChild(fill);
    cell.appendChild(bar);

    const label = document.createElement('div');
    label.className = 'plot__label';
    cell.appendChild(label);

    garden.appendChild(cell);

    const plot: Plot = {
      phase: 'empty',
      thirst: 0,
      thirstRate: rng(THIRST_RATE_MIN, THIRST_RATE_MAX),
      fruit: 'weed',
      cell,
      bar: fill,
      sprite,
      label,
    };
    plots.push(plot);

    // pointerdown is faster than click on touch and prevents 300ms delay.
    cell.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onPlotTap(i);
    });
    cell.addEventListener('click', (e) => {
      // already handled by pointerdown
      e.preventDefault();
    });
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────
function renderPlot(p: Plot): void {
  p.sprite.innerHTML = buildSpriteHtml(p);
  p.label.textContent = actionLabel(p);

  // bar visible only when there's a plant
  if (p.phase === 'empty' || p.phase === 'harvest') {
    p.bar.style.transform = 'scaleX(0)';
    p.bar.style.opacity = '0';
  } else {
    p.bar.style.opacity = '1';
    p.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, p.thirst))})`;
  }

  // phase classes
  p.cell.classList.remove(
    'plot--empty',
    'plot--seedling',
    'plot--growing',
    'plot--harvest',
    'plot--thirsty',
    'plot--ripe-weed',
    'plot--ripe-apple',
    'plot--ripe-gold',
  );
  p.cell.classList.add(`plot--${p.phase}`);
  if ((p.phase === 'seedling' || p.phase === 'growing') && p.thirst < 0.33) {
    p.cell.classList.add('plot--thirsty');
  }
  if (p.phase === 'harvest') {
    p.cell.classList.add(`plot--ripe-${p.fruit}`);
  }
}

function renderHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  driedEl.textContent = `${driedCount}/${DRIED_LIMIT}`;
}

function renderAll(): void {
  renderHud();
  for (const p of plots) renderPlot(p);
}

// ── Overlay ─────────────────────────────────────────────────────────────────
function showOverlay(title: string, msgHtml: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msgHtml;
  overlayBtn.textContent = btnLabel;
  overlay.classList.remove('overlay--hidden');
  overlayBtn.focus({ preventScroll: true });
}

function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
}

// ── Plot interactions ───────────────────────────────────────────────────────
function onPlotTap(idx: number): void {
  if (state !== 'playing') return; // overlay-input-leak guard
  const p = plots[idx];
  if (!p) return;

  switch (p.phase) {
    case 'empty':
      // plant a seed
      p.phase = 'seedling';
      // thirst starts moderately high so player has a window
      p.thirst = 0.75;
      // new random thirst rate each life cycle → multi-tasking
      p.thirstRate = rng(THIRST_RATE_MIN, THIRST_RATE_MAX);
      // fruit decided up-front but hidden until harvest
      p.fruit = pickFruit();
      pulse(p);
      renderPlot(p);
      break;
    case 'seedling':
    case 'growing': {
      // water it (only meaningful if thirst < 1; but we always refill)
      p.thirst = WATER_REFILL;
      // advance phase
      if (p.phase === 'seedling') {
        // seedling → growing → harvest (after 1 more water)
        p.phase = 'growing';
      } else {
        // growing watered → ripens to harvest
        p.phase = 'harvest';
      }
      pulse(p);
      renderPlot(p);
      break;
    }
    case 'harvest': {
      // collect fruit
      const gained = fruitScore(p.fruit);
      score += gained;
      if (score > best) {
        best = score;
        safeWrite(STORAGE_KEY, best);
      }
      spawnFloat(p, `+${gained}`, p.fruit);
      p.phase = 'empty';
      p.thirst = 0;
      renderPlot(p);
      renderHud();
      break;
    }
  }
}

// ── Visual feedback ─────────────────────────────────────────────────────────
function pulse(p: Plot): void {
  p.cell.classList.remove('plot--pulse');
  void p.cell.offsetHeight;
  p.cell.classList.add('plot--pulse');
}

function spawnFloat(p: Plot, text: string, fruit: FruitKind): void {
  const float = document.createElement('div');
  float.className = `plot__float plot__float--${fruit}`;
  float.textContent = text;
  p.cell.appendChild(float);
  // remove after animation (700ms) — independent of gen token; if reset
  // happens we still want the leaf to leave the DOM.
  const myGen = gen;
  window.setTimeout(() => {
    if (myGen !== gen) {
      float.remove();
      return;
    }
    float.remove();
  }, 750);
}

// ── Game loop ───────────────────────────────────────────────────────────────
function tick(dt: number): void {
  if (state !== 'playing') return;
  let dryThis = 0;
  for (const p of plots) {
    if (p.phase === 'seedling' || p.phase === 'growing') {
      p.thirst -= p.thirstRate * dt;
      if (p.thirst <= 0) {
        p.thirst = 0;
        p.phase = 'empty';
        // pick new random rate next cycle
        p.thirstRate = rng(THIRST_RATE_MIN, THIRST_RATE_MAX);
        dryThis++;
        // shake the plot
        p.cell.classList.remove('plot--dried');
        void p.cell.offsetHeight;
        p.cell.classList.add('plot--dried');
      }
    }
  }
  if (dryThis > 0) {
    driedCount += dryThis;
    safeWrite(STORAGE_DRIED_KEY, driedCount);
    renderHud();
    if (driedCount >= DRIED_LIMIT) {
      endGame();
      return;
    }
  }
  // update plot bars
  for (const p of plots) renderPlot(p);
}

function loop(now: number): void {
  const myGen = gen;
  if (lastTick === 0) lastTick = now;
  const dt = Math.min(0.1, (now - lastTick) / 1000); // clamp dt for tab-bg catch-up
  lastTick = now;
  tick(dt);
  if (myGen !== gen) return; // stale callback guard
  if (state === 'playing') {
    rafId = window.requestAnimationFrame(loop);
  }
}

// ── State transitions ───────────────────────────────────────────────────────
function startGame(): void {
  gen++; // invalidate any stale RAF/timeouts
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  score = 0;
  driedCount = 0;
  for (const p of plots) {
    p.phase = 'empty';
    p.thirst = 0;
    p.thirstRate = rng(THIRST_RATE_MIN, THIRST_RATE_MAX);
    p.fruit = 'weed';
    p.cell.classList.remove('plot--dried', 'plot--pulse');
    // also remove any leftover float
    const stale = p.cell.querySelectorAll('.plot__float');
    stale.forEach((el) => el.remove());
  }
  state = 'playing';
  hideOverlay();
  renderAll();
  lastTick = 0;
  rafId = window.requestAnimationFrame(loop);
}

function endGame(): void {
  if (state === 'gameover') return;
  state = 'gameover';
  gen++; // invalidate
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  showOverlay(
    'Bahçe kurudu!',
    `Skor: <strong>${score}</strong> · En iyi: ${best}<br>` +
      `<small>${DRIED_LIMIT} bitki kurudu. Tekrar denemek için "Yeniden başla" veya R.</small>`,
    'Tekrar oyna',
  );
}

function resetToReady(): void {
  gen++;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  state = 'ready';
  score = 0;
  driedCount = 0;
  for (const p of plots) {
    p.phase = 'empty';
    p.thirst = 0;
    p.thirstRate = rng(THIRST_RATE_MIN, THIRST_RATE_MAX);
    p.fruit = 'weed';
    p.cell.classList.remove('plot--dried', 'plot--pulse');
    const stale = p.cell.querySelectorAll('.plot__float');
    stale.forEach((el) => el.remove());
  }
  renderAll();
  showOverlay(
    'Bahçevan',
    'Tıkla: <strong>boş parsel</strong> → tohum dik · ' +
      '<strong>filiz</strong> → sula · <strong>meyveli bitki</strong> → topla.<br>' +
      `<small>Susama bar’ı 0 olursa bitki kurur. ${DRIED_LIMIT} kuruma sonrası oyun biter.</small>`,
    'Başla',
  );
}

// ── Input handlers ──────────────────────────────────────────────────────────
overlayBtn.addEventListener('click', () => {
  startGame();
});

restartBtn.addEventListener('click', () => {
  // direct restart from any state
  startGame();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    startGame();
    return;
  }
  if (state !== 'playing') {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startGame();
    }
  }
});

// ── Init ────────────────────────────────────────────────────────────────────
best = safeRead(STORAGE_KEY, 0);
buildGarden();
resetToReady();
