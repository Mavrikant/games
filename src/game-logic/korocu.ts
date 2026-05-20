// ---------------------------------------------------------------------------
// Korocu — Choir conductor rhythm game
// Mechanic: 4 lanes (Soprano / Alto / Tenor / Bas) — beat markers fall from
// the top; press the right key (A/S/D/F or 1/2/3/4) when a marker enters its
// hit zone. Correct timing scores points; misses & wrong-key strikes reset
// combo. Combo speeds up the song. 5 fouls → game over.
//
// State machine: ready | playing | gameOver
// Pitfalls actively guarded:
//   - visual-vs-hitbox: marker Y geometry and zone Y geometry share the
//     SAME constants (ZONE_*); draw() and checkHit() never duplicate numbers.
//   - overlay-input-leak: explicit state enum, single handleInput() switch,
//     default case returns; gameOver overlay swallows hit keys (A/S/D/F).
//   - stale-async-callback: rAF loop carries a `gen` token; reset() bumps.
//   - invisible-boot: ready overlay & 4 lanes & zone bar & score 0 visible
//     in first frame (no spawned markers yet).
//   - unguarded-storage: safeRead/safeWrite try/catch.
//   - duplicate-with-shared-layer: body only contains canvas/HUD; no title or
//     hint paragraph (layout supplies them).
// ---------------------------------------------------------------------------
export {};

type State = 'ready' | 'playing' | 'gameOver';
type HitGrade = 'perfect' | 'great' | 'good';

interface Marker {
  lane: number;        // 0..3
  y: number;           // canvas-space center Y
  state: 'falling' | 'hit' | 'miss';
  flash: number;       // frames of hit/miss flash remaining
  grade: HitGrade | null;
}

// ── Canvas geometry ─────────────────────────────────────────────────────────
const CANVAS_W = 480;
const CANVAS_H = 540;

const LANES = 4 as const;
const LANE_W = CANVAS_W / LANES;                  // 120

// Hit zone geometry — these constants are the SINGLE SOURCE OF TRUTH for
// both rendering and collision. Do not hard-code these numbers anywhere
// else in this file.
const ZONE_CENTER_Y = CANVAS_H - 90;              // center of hit line
const ZONE_PERFECT_HALF = 14;                     // ±px around center
const ZONE_GREAT_HALF   = 30;
const ZONE_GOOD_HALF    = 50;                     // outside this → miss when player presses
const MARKER_RADIUS = 30;                         // visual radius; collision uses center
const FLOOR_Y = ZONE_CENTER_Y + ZONE_GOOD_HALF + MARKER_RADIUS; // missed if center passes this without hit

// ── Game tuning ─────────────────────────────────────────────────────────────
const BASE_FALL_PX_PER_FRAME = 2.6;
const FALL_COMBO_BOOST = 0.05;       // px/frame added per 5-combo step
const FALL_MAX = 6.2;
const BASE_SPAWN_FRAMES = 56;        // frames between spawns at start
const SPAWN_MIN_FRAMES = 22;         // minimum gap at high tempo
const SPAWN_COMBO_DECAY = 1.4;       // frames removed per 5-combo step
const FIRST_SPAWN_DELAY = 14;        // immediate first-spawn frame budget after start
const MAX_FOULS = 5;
const FLASH_FRAMES = 18;
const STORAGE_KEY = 'korocu.best';

// Points per grade — combo bonus also adds (combo / 5 floored).
const POINTS: Record<HitGrade, number> = { perfect: 100, great: 60, good: 30 };

// ── Lane palette & labels ───────────────────────────────────────────────────
const LANE_COLORS = ['#f472b6', '#fbbf24', '#34d399', '#60a5fa'];
const LANE_LABELS = ['Soprano', 'Alto', 'Tenor', 'Bas'];
const LANE_KEY_HINTS = ['A', 'S', 'D', 'F'];

// Accepted hit keys per lane (lower-cased, both letter and digit alternates).
const LANE_KEYS: string[][] = [
  ['a', '1'],
  ['s', '2'],
  ['d', '3'],
  ['f', '4'],
];

// ── DOM ─────────────────────────────────────────────────────────────────────
const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const comboEl = document.querySelector<HTMLElement>('#combo')!;
const foulsEl = document.querySelector<HTMLElement>('#fouls')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const hitButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.korocu-pad'));

// ── Safe storage ───────────────────────────────────────────────────────────
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
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

// ── CSS var cache ──────────────────────────────────────────────────────────
const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const c = cssCache.get(name);
  if (c !== undefined) return c;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v);
  return v;
}

// ── Game state ─────────────────────────────────────────────────────────────
let state: State = 'ready';
let markers: Marker[] = [];
let score = 0;
let best = 0;
let combo = 0;
let bestCombo = 0;
let fouls = 0;
let hitsTotal = 0;
let lastGrade: HitGrade | null = null;
let gradeFlash = 0;
let gen = 0;                     // generation token for stale-async guard
let rafId: number | null = null;
let frame = 0;
let spawnCountdown = FIRST_SPAWN_DELAY;
let lastLaneSpawned = -1;

// ── Helpers ────────────────────────────────────────────────────────────────
function currentFallSpeed(): number {
  return Math.min(FALL_MAX, BASE_FALL_PX_PER_FRAME + FALL_COMBO_BOOST * Math.floor(combo / 5));
}
function currentSpawnInterval(): number {
  return Math.max(SPAWN_MIN_FRAMES, BASE_SPAWN_FRAMES - SPAWN_COMBO_DECAY * Math.floor(combo / 5));
}
function comboBonus(): number {
  return Math.floor(combo / 5);
}

function pickLane(): number {
  // Discourage three-in-a-row in same lane.
  let lane = Math.floor(Math.random() * LANES);
  if (lane === lastLaneSpawned && Math.random() < 0.7) {
    lane = (lane + 1 + Math.floor(Math.random() * (LANES - 1))) % LANES;
  }
  lastLaneSpawned = lane;
  return lane;
}

function spawnMarker(): void {
  const lane = pickLane();
  markers.push({
    lane,
    y: -MARKER_RADIUS,
    state: 'falling',
    flash: 0,
    grade: null,
  });
}

function gradeFromDistance(dist: number): HitGrade | null {
  if (dist <= ZONE_PERFECT_HALF) return 'perfect';
  if (dist <= ZONE_GREAT_HALF) return 'great';
  if (dist <= ZONE_GOOD_HALF) return 'good';
  return null;
}

// Returns index of best candidate marker in lane (closest to zone), still
// active, within GOOD zone — or -1 if none.
function findHitCandidate(lane: number): number {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    if (m.lane !== lane || m.state !== 'falling') continue;
    const dist = Math.abs(m.y - ZONE_CENTER_Y);
    if (dist <= ZONE_GOOD_HALF && dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function tryHitLane(lane: number): void {
  if (state !== 'playing') return;

  const idx = findHitCandidate(lane);
  if (idx === -1) {
    // Wrong timing / wrong key — fault
    registerFault('wrong');
    return;
  }
  const m = markers[idx]!;
  const grade = gradeFromDistance(Math.abs(m.y - ZONE_CENTER_Y))!;
  m.state = 'hit';
  m.flash = FLASH_FRAMES;
  m.grade = grade;
  combo += 1;
  if (combo > bestCombo) bestCombo = combo;
  lastGrade = grade;
  gradeFlash = FLASH_FRAMES;
  hitsTotal += 1;
  const gained = POINTS[grade] + comboBonus();
  score += gained;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_KEY, best);
  }
  updateHud();
}

function registerFault(_kind: 'miss' | 'wrong'): void {
  combo = 0;
  fouls += 1;
  lastGrade = null;
  gradeFlash = FLASH_FRAMES;
  updateHud();
  if (fouls >= MAX_FOULS) {
    endGame();
  }
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  comboEl.textContent = String(combo);
  // Render fouls as N/MAX
  foulsEl.textContent = `${fouls}/${MAX_FOULS}`;
}

// ── Loop ───────────────────────────────────────────────────────────────────
function loop(token: number): void {
  if (token !== gen) return;          // stale guard
  if (state !== 'playing') return;
  rafId = requestAnimationFrame(() => loop(token));
  frame++;

  spawnCountdown--;
  if (spawnCountdown <= 0) {
    spawnMarker();
    spawnCountdown = currentSpawnInterval();
  }

  const speed = currentFallSpeed();

  // Move + check misses
  const surviving: Marker[] = [];
  let endedThisFrame = false;
  for (const m of markers) {
    if (endedThisFrame) {
      // Game just ended — keep remaining markers so the final frame shows them
      surviving.push(m);
      continue;
    }
    if (m.state === 'falling') {
      m.y += speed;
      if (m.y - MARKER_RADIUS > FLOOR_Y) {
        // Missed — passed the goodzone bottom without being hit
        m.state = 'miss';
        m.flash = FLASH_FRAMES;
        m.grade = null;
        registerFault('miss');
        surviving.push(m);
        if (state !== 'playing') {
          endedThisFrame = true;
        }
        continue;
      }
      surviving.push(m);
    } else {
      // flash fade
      m.flash--;
      if (m.flash > 0) surviving.push(m);
    }
  }
  markers = surviving;

  if (gradeFlash > 0) gradeFlash--;
  if (gradeFlash === 0) lastGrade = null;

  draw();
}

// ── Render ─────────────────────────────────────────────────────────────────
function draw(): void {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Background
  ctx.fillStyle = getCss('--surface') || '#10131a';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Lane backgrounds and dividers
  for (let i = 0; i < LANES; i++) {
    const x = i * LANE_W;
    const color = LANE_COLORS[i]!;
    // soft tint
    ctx.fillStyle = color + '18'; // ~9% alpha
    ctx.fillRect(x + 2, 0, LANE_W - 4, CANVAS_H);
    // bright top strip
    ctx.fillStyle = color + 'aa';
    ctx.fillRect(x + 2, 0, LANE_W - 4, 6);
  }
  ctx.strokeStyle = getCss('--border') || '#2a2f3a';
  ctx.lineWidth = 1;
  for (let i = 1; i < LANES; i++) {
    ctx.beginPath();
    ctx.moveTo(i * LANE_W, 0);
    ctx.lineTo(i * LANE_W, CANVAS_H);
    ctx.stroke();
  }

  // Hit zone (using SAME constants as collision detection)
  // Outer "good" band
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(0, ZONE_CENTER_Y - ZONE_GOOD_HALF, CANVAS_W, ZONE_GOOD_HALF * 2);
  // Inner "great" band
  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.fillRect(0, ZONE_CENTER_Y - ZONE_GREAT_HALF, CANVAS_W, ZONE_GREAT_HALF * 2);
  // Center "perfect" line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, ZONE_CENTER_Y);
  ctx.lineTo(CANVAS_W, ZONE_CENTER_Y);
  ctx.stroke();

  // Perfect zone borders
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, ZONE_CENTER_Y - ZONE_PERFECT_HALF);
  ctx.lineTo(CANVAS_W, ZONE_CENTER_Y - ZONE_PERFECT_HALF);
  ctx.moveTo(0, ZONE_CENTER_Y + ZONE_PERFECT_HALF);
  ctx.lineTo(CANVAS_W, ZONE_CENTER_Y + ZONE_PERFECT_HALF);
  ctx.stroke();

  // Lane labels above zone
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < LANES; i++) {
    const cx = i * LANE_W + LANE_W / 2;
    ctx.fillStyle = LANE_COLORS[i]! + 'cc';
    ctx.fillText(LANE_LABELS[i]!, cx, ZONE_CENTER_Y + 28);
    // key hint above the label
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(LANE_KEY_HINTS[i]!, cx, ZONE_CENTER_Y + 50);
    ctx.font = 'bold 14px system-ui, sans-serif';
  }

  // Markers
  for (const m of markers) {
    const cx = m.lane * LANE_W + LANE_W / 2;
    const color = LANE_COLORS[m.lane]!;
    if (m.state === 'falling') {
      // outer
      ctx.fillStyle = color + 'ee';
      ctx.beginPath();
      ctx.arc(cx, m.y, MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      // inner ring (gives depth)
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, m.y, MARKER_RADIUS - 6, 0, Math.PI * 2);
      ctx.stroke();
    } else if (m.state === 'hit') {
      const alpha = m.flash / FLASH_FRAMES;
      const radius = MARKER_RADIUS * (1 + (1 - alpha) * 0.9);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, m.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      // miss
      const alpha = m.flash / FLASH_FRAMES;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(cx, m.y, MARKER_RADIUS * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Grade feedback (last hit) at zone center
  if (lastGrade && gradeFlash > 0) {
    const alpha = gradeFlash / FLASH_FRAMES;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const palette: Record<HitGrade, string> = {
      perfect: '#fde047',
      great: '#86efac',
      good: '#93c5fd',
    };
    ctx.fillStyle = palette[lastGrade];
    const txt = lastGrade === 'perfect' ? 'BRAVO!' : lastGrade === 'great' ? 'iyi!' : 'tut!';
    ctx.fillText(txt, CANVAS_W / 2, ZONE_CENTER_Y - 50);
    ctx.restore();
  } else if (lastGrade === null && gradeFlash > 0) {
    // Fault flash
    const alpha = gradeFlash / FLASH_FRAMES;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f87171';
    ctx.fillText('akort kaçtı!', CANVAS_W / 2, ZONE_CENTER_Y - 50);
    ctx.restore();
  }
}

// ── State transitions ──────────────────────────────────────────────────────
function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  overlay.classList.remove('overlay--hidden');
}
function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
}

function startGame(): void {
  if (state === 'playing') return;
  state = 'playing';
  hideOverlay();
  // Reset run state (fresh hand)
  markers = [];
  score = 0;
  combo = 0;
  fouls = 0;
  hitsTotal = 0;
  bestCombo = 0;
  lastGrade = null;
  gradeFlash = 0;
  frame = 0;
  spawnCountdown = FIRST_SPAWN_DELAY;
  lastLaneSpawned = -1;
  updateHud();
  draw();
  const token = ++gen; // bump generation, capture
  rafId = requestAnimationFrame(() => loop(token));
}

function endGame(): void {
  state = 'gameOver';
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  showOverlay(
    'Konser bitti!',
    `Skor: <b>${score}</b> · En yüksek kombo: <b>${bestCombo}</b><br>` +
    `<small>Boşluk / R ile yeni konser</small>`,
  );
}

function reset(): void {
  // Bump generation FIRST — any in-flight rAF callback will short-circuit
  gen++;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  state = 'ready';
  markers = [];
  score = 0;
  combo = 0;
  fouls = 0;
  hitsTotal = 0;
  bestCombo = 0;
  lastGrade = null;
  gradeFlash = 0;
  frame = 0;
  spawnCountdown = FIRST_SPAWN_DELAY;
  lastLaneSpawned = -1;
  best = safeRead(STORAGE_KEY, 0);
  updateHud();
  draw();
  showOverlay(
    'Korocu',
    'Düşen notalar zon çizgisine gelince ilgili tuşa bas.<br>' +
    '<b>A S D F</b> veya <b>1 2 3 4</b> · 5 yanlış = konser biter.<br>' +
    '<small>Başlatmak için boşluk / Enter</small>',
  );
}

// ── Input ──────────────────────────────────────────────────────────────────
function handleInput(key: string): void {
  const k = key.toLowerCase();

  // Universal restart
  if (k === 'r') {
    reset();
    return;
  }

  if (state === 'ready') {
    if (k === ' ' || k === 'spacebar' || k === 'enter') {
      startGame();
    }
    // any other key in ready is ignored — no board mutation
    return;
  }

  if (state === 'gameOver') {
    if (k === ' ' || k === 'spacebar' || k === 'enter') {
      // Tek-tap restart: ready → playing directly (no extra ready overlay)
      reset();
      startGame();
    }
    // gameOver swallows hit keys (A/S/D/F, 1-4) — they must NOT mutate board
    return;
  }

  // state === 'playing'
  for (let lane = 0; lane < LANE_KEYS.length; lane++) {
    if (LANE_KEYS[lane]!.includes(k)) {
      tryHitLane(lane);
      return;
    }
  }
  // unknown key → no-op
}

window.addEventListener('keydown', (e) => {
  // Don't preventDefault on browser shortcuts (Ctrl/Meta combos)
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  // Recognized keys consume default to avoid scroll / focus moves.
  const lower = k.toLowerCase();
  const accepted =
    lower === 'r' ||
    lower === ' ' ||
    lower === 'spacebar' ||
    lower === 'enter' ||
    'asdf1234'.includes(lower);
  if (accepted) e.preventDefault();
  handleInput(k);
});

// Touch / on-screen pad
hitButtons.forEach((btn) => {
  const lane = Number(btn.dataset.lane);
  if (!Number.isInteger(lane) || lane < 0 || lane >= LANES) return;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready') {
      startGame();
      return;
    }
    if (state === 'gameOver') {
      reset();
      startGame();
      return;
    }
    tryHitLane(lane);
  });
});

restartBtn.addEventListener('click', () => {
  reset();
});

// Overlay tap: in ready / gameOver, tapping anywhere on the overlay starts
overlay.addEventListener('click', () => {
  if (state === 'ready') startGame();
  else if (state === 'gameOver') { reset(); startGame(); }
});

// ── Headless test hook ─────────────────────────────────────────────────────
// Expose a minimal internal API on globalThis only when a test harness sets a
// flag. In production browsers there is no hook (no surface, no risk).
interface KorocuTestApi {
  getState(): {
    state: State;
    score: number;
    best: number;
    combo: number;
    fouls: number;
    markersCount: number;
    markers: ReadonlyArray<Readonly<Marker>>;
    speed: number;
    spawnInterval: number;
  };
  start(): void;
  reset(): void;
  press(key: string): void;
  tickFrames(n: number): void;
  forceMarker(lane: number, y: number): void;
  constants(): {
    ZONE_CENTER_Y: number;
    ZONE_PERFECT_HALF: number;
    ZONE_GREAT_HALF: number;
    ZONE_GOOD_HALF: number;
    FLOOR_Y: number;
    MARKER_RADIUS: number;
    MAX_FOULS: number;
    LANES: number;
  };
}
declare global {
  interface Window {
    __korocuTest?: KorocuTestApi;
    __KOROCU_TEST_HOOK__?: boolean;
  }
}

if (typeof window !== 'undefined' && window.__KOROCU_TEST_HOOK__) {
  // Headless tick: advances game state without rAF (test only)
  const headlessTick = (): void => {
    if (state !== 'playing') return;
    frame++;
    spawnCountdown--;
    if (spawnCountdown <= 0) {
      spawnMarker();
      spawnCountdown = currentSpawnInterval();
    }
    const speed = currentFallSpeed();
    const surviving: Marker[] = [];
    let endedThisFrame = false;
    for (const m of markers) {
      if (endedThisFrame) {
        surviving.push(m);
        continue;
      }
      if (m.state === 'falling') {
        m.y += speed;
        if (m.y - MARKER_RADIUS > FLOOR_Y) {
          m.state = 'miss';
          m.flash = FLASH_FRAMES;
          m.grade = null;
          registerFault('miss');
          surviving.push(m);
          if (state !== 'playing') endedThisFrame = true;
          continue;
        }
        surviving.push(m);
      } else {
        m.flash--;
        if (m.flash > 0) surviving.push(m);
      }
    }
    markers = surviving;
    if (gradeFlash > 0) gradeFlash--;
    if (gradeFlash === 0) lastGrade = null;
  };

  window.__korocuTest = {
    getState: () => ({
      state,
      score,
      best,
      combo,
      fouls,
      markersCount: markers.length,
      markers: markers.map((m) => ({ ...m })),
      speed: currentFallSpeed(),
      spawnInterval: currentSpawnInterval(),
    }),
    start: () => startGame(),
    reset: () => reset(),
    press: (key: string) => handleInput(key),
    tickFrames: (n: number) => {
      for (let i = 0; i < n; i++) headlessTick();
    },
    forceMarker: (lane: number, y: number) => {
      markers.push({ lane, y, state: 'falling', flash: 0, grade: null });
    },
    constants: () => ({
      ZONE_CENTER_Y,
      ZONE_PERFECT_HALF,
      ZONE_GREAT_HALF,
      ZONE_GOOD_HALF,
      FLOOR_Y,
      MARKER_RADIUS,
      MAX_FOULS,
      LANES,
    }),
  };
}

// ── Init ───────────────────────────────────────────────────────────────────
reset();
