// Trafik Memuru — kavşak sinyal yönetimi
// Pitfalls:
//   - visual-vs-hitbox: tek `GEOM` bloğu hem çizim hem geçiş kontrolü için.
//   - overlay-input-leak: state enum + tek input handler.
//   - stale-async-callback: rAF loop generation token; sarı süresi state-machine.
//   - invisible-boot: ilk frame'de kavşak + sinyal + bekleyen arabalar çizilir.
//   - unguarded-storage: safeRead / safeWrite try/catch.
//   - duplicate-with-shared-layer: title/hint body'de yok.

type GameState = 'ready' | 'playing' | 'gameOver';
type SignalState = 'nsGreen' | 'ewGreen' | 'yellowToEW' | 'yellowToNS';
type Direction = 'N' | 'S' | 'E' | 'W';

interface Car {
  id: number;
  dir: Direction;
  // Position along its lane; 0 = far away from intersection, increases toward stop line.
  // We measure as the head-position (front bumper) in canvas pixels along the lane axis.
  pos: number;
  speed: number; // px/sec while moving
  patience: number; // seconds left
  totalPatience: number;
  isAmbulance: boolean;
  colorVar: string;
  passed: boolean; // already counted
}

// ─── Geometry (single source of truth) ─────────────────────────────
const GEOM = {
  W: 480,
  H: 480,
  // Road occupies the central band on each axis.
  ROAD_WIDTH: 90, // total road width (2 lanes wide each direction)
  // Intersection box is where N/S and E/W roads overlap.
  // Stop line is at the boundary of the intersection on each side.
  CAR_LEN: 26,
  CAR_WID: 16,
  // Lane offsets from the center axis (perpendicular to direction of travel).
  // Incoming N (heading down): right side of the road. Incoming S (heading up): left side.
  // Standard right-hand traffic: incoming cars stay on the "right" of their direction.
  LANE_OFFSET: 22,
  // How many pixels of "approach" before the stop line.
  APPROACH_LEN: 180,
};

const STOP_LINE_N = GEOM.H / 2 - GEOM.ROAD_WIDTH / 2; // top edge of intersection
const STOP_LINE_S = GEOM.H / 2 + GEOM.ROAD_WIDTH / 2; // bottom edge of intersection
const STOP_LINE_W = GEOM.W / 2 - GEOM.ROAD_WIDTH / 2;
const STOP_LINE_E = GEOM.W / 2 + GEOM.ROAD_WIDTH / 2;
const CENTER_X = GEOM.W / 2;
const CENTER_Y = GEOM.H / 2;

const YELLOW_MS = 500;
const STORAGE_BEST = 'trafik-memuru.best';
const CAR_BASE_SPEED = 90; // px/sec
const CAR_GAP = 6; // gap between cars in queue (px)

const COLOR_VARS = [
  '--traffic-car-1',
  '--traffic-car-2',
  '--traffic-car-3',
  '--traffic-car-4',
  '--traffic-car-5',
];

// ─── DOM ───────────────────────────────────────────────────────────
const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
const ctx = canvas.getContext('2d')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const bestEl = document.querySelector<HTMLElement>('#best')!;
const signalEl = document.querySelector<HTMLElement>('#signal')!;
const toggleBtn = document.querySelector<HTMLButtonElement>('#toggle')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
const overlay = document.querySelector<HTMLElement>('#overlay')!;
const overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
const overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

// ─── State ─────────────────────────────────────────────────────────
let state: GameState = 'ready';
let signal: SignalState = 'nsGreen';
let yellowEndsAt = 0; // wall-clock ms when yellow ends
let pendingSignalAfterYellow: SignalState = 'nsGreen';
let score = 0;
let best = 0;
let cars: Car[] = [];
let nextCarId = 1;
let spawnTimerMs = 0;
let lastFrameTime = 0;
let loopToken = 0; // generation token to invalidate stale rAF callbacks
// Wall-clock ms of the last state transition (ready→playing or gameOver→playing).
// A short cooldown after such a transition swallows extra taps so a spam-tap
// to restart doesn't immediately toggle the signal on the fresh game.
let lastTransitionAt = 0;
const TRANSITION_COOLDOWN_MS = 150;

// ─── Storage helpers ───────────────────────────────────────────────
function safeRead(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

// ─── CSS color cache ───────────────────────────────────────────────
const cssCache = new Map<string, string>();
function getCss(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim() || '#ffffff';
  cssCache.set(name, v);
  return v;
}

// ─── Difficulty curve ──────────────────────────────────────────────
function spawnIntervalForScore(s: number): number {
  if (s < 5) return 2200;
  if (s < 15) return 1800;
  if (s < 30) return 1450;
  if (s < 50) return 1150;
  return 950;
}

function patienceForScore(s: number): number {
  if (s < 10) return 18;
  if (s < 25) return 15;
  if (s < 45) return 13;
  return 11;
}

function ambulanceChance(s: number): number {
  if (s < 8) return 0;
  if (s < 20) return 0.08;
  if (s < 40) return 0.12;
  return 0.16;
}

// ─── Overlay helpers ───────────────────────────────────────────────
function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  overlay.classList.remove('overlay--hidden');
}
function hideOverlay(): void {
  overlay.classList.add('overlay--hidden');
}

function updateSignalLabel(): void {
  let label = 'NS';
  if (signal === 'ewGreen') label = 'EW';
  else if (signal === 'yellowToEW' || signal === 'yellowToNS') label = '!!';
  else if (signal === 'nsGreen') label = 'NS';
  signalEl.textContent = label;
}

// ─── Car geometry ──────────────────────────────────────────────────
// For each car: head-position along its travel axis (canvas coords).
// We return the front bumper's projected canvas coordinate (x or y).
function carHeadCoord(c: Car): number {
  // pos goes from 0 (far away) up to its current value;
  // we encode pos so that "pos = APPROACH_LEN" means the front bumper has reached the stop line.
  // For dir N (heading south, +Y direction): bumper y = STOP_LINE_N - (APPROACH_LEN - pos)
  // For dir S (heading north, -Y direction): bumper y = STOP_LINE_S + (APPROACH_LEN - pos)
  // For dir W (heading east, +X direction): bumper x = STOP_LINE_W - (APPROACH_LEN - pos)
  // For dir E (heading west, -X direction): bumper x = STOP_LINE_E + (APPROACH_LEN - pos)
  const d = GEOM.APPROACH_LEN - c.pos;
  switch (c.dir) {
    case 'N': return STOP_LINE_N - d;
    case 'S': return STOP_LINE_S + d;
    case 'W': return STOP_LINE_W - d;
    case 'E': return STOP_LINE_E + d;
  }
}

// Lane center (perpendicular axis) for a given direction.
function laneCenter(dir: Direction): number {
  // N: incoming from top moving down → right lane of vertical road from driver's POV
  //    drivers stay on right side, so center X is to the right of CENTER_X.
  // S: incoming from bottom moving up → on the right (their right), which is the LEFT of CENTER_X.
  // W: incoming from left moving right → right lane is the bottom half (Y > CENTER_Y is "south")
  //    actually right-hand traffic: incoming from west moves east, their right is +Y (south),
  //    so lane center is below CENTER_Y. Wait — drivers stay on their right side of road.
  //    Heading east, their right is south (greater Y), so lane center is CENTER_Y + LANE_OFFSET.
  // E: incoming from right moving left, their right is north (smaller Y) → CENTER_Y - LANE_OFFSET.
  switch (dir) {
    case 'N': return CENTER_X + GEOM.LANE_OFFSET; // moving south, stays on driver's right
    case 'S': return CENTER_X - GEOM.LANE_OFFSET; // moving north, stays on driver's right
    case 'W': return CENTER_Y + GEOM.LANE_OFFSET; // moving east
    case 'E': return CENTER_Y - GEOM.LANE_OFFSET; // moving west
  }
}

// Returns true if car axis is N/S (vertical movement).
function isVertical(dir: Direction): boolean {
  return dir === 'N' || dir === 'S';
}

// ─── Signal logic ──────────────────────────────────────────────────
function effectiveSignalGreen(): 'NS' | 'EW' | null {
  if (signal === 'nsGreen') return 'NS';
  if (signal === 'ewGreen') return 'EW';
  return null; // yellow → no one passes
}

function canDirGo(dir: Direction): boolean {
  // Ambulance check is at car-level (overrides). Here just signal-vs-direction.
  const g = effectiveSignalGreen();
  if (g === null) return false;
  if (g === 'NS') return dir === 'N' || dir === 'S';
  return dir === 'E' || dir === 'W';
}

function toggleSignal(): void {
  if (state !== 'playing') return;
  // No-op if already in yellow transition.
  if (signal === 'yellowToEW' || signal === 'yellowToNS') return;
  if (signal === 'nsGreen') {
    signal = 'yellowToEW';
    pendingSignalAfterYellow = 'ewGreen';
  } else {
    signal = 'yellowToNS';
    pendingSignalAfterYellow = 'nsGreen';
  }
  yellowEndsAt = performance.now() + YELLOW_MS;
  updateSignalLabel();
}

function tickYellow(nowMs: number): void {
  if (signal === 'yellowToEW' || signal === 'yellowToNS') {
    if (nowMs >= yellowEndsAt) {
      signal = pendingSignalAfterYellow;
      updateSignalLabel();
    }
  }
}

// ─── Spawning ──────────────────────────────────────────────────────
function spawnCar(forcedDir?: Direction, forcedAmbulance?: boolean): void {
  const dirs: Direction[] = ['N', 'S', 'E', 'W'];
  const dir = forcedDir ?? dirs[Math.floor(Math.random() * dirs.length)]!;
  // Avoid spawning if there's already a car near pos=0 in same lane (overlap).
  const minSpawnGap = GEOM.CAR_LEN + CAR_GAP + 4;
  for (const c of cars) {
    if (c.dir !== dir) continue;
    if (c.pos < minSpawnGap) return; // skip this spawn cycle to avoid stacking
  }
  const isAmbulance = forcedAmbulance ?? (Math.random() < ambulanceChance(score));
  const total = patienceForScore(score) * (isAmbulance ? 0.85 : 1);
  const color = isAmbulance
    ? '--traffic-ambulance'
    : COLOR_VARS[Math.floor(Math.random() * COLOR_VARS.length)]!;
  cars.push({
    id: nextCarId++,
    dir,
    pos: 0,
    speed: CAR_BASE_SPEED,
    patience: total,
    totalPatience: total,
    isAmbulance,
    colorVar: color,
    passed: false,
  });
}

// ─── Car physics ───────────────────────────────────────────────────
// For each direction, compute the desired stopping position for queue.
// A car must stop at stop line (pos == APPROACH_LEN) OR behind the previous car
// in its lane (with CAR_GAP).
function computeStopPos(c: Car): number {
  // Find the closest car ahead of this one in the same lane.
  let aheadStop = GEOM.APPROACH_LEN; // stop at line by default
  for (const other of cars) {
    if (other === c) continue;
    if (other.dir !== c.dir) continue;
    if (other.passed) continue;
    if (other.pos <= c.pos) continue; // not ahead
    const candidate = other.pos - GEOM.CAR_LEN - CAR_GAP;
    if (candidate < aheadStop) aheadStop = candidate;
  }
  return aheadStop;
}

function tick(dt: number, nowMs: number): void {
  if (state !== 'playing') return;
  tickYellow(nowMs);

  // Move cars
  const dtSec = dt / 1000;

  // First, identify whether an ambulance is in queue: ambulance can pass even on red,
  // but only if it's the lead car in its lane AND not in yellow transition.
  // To keep it fair, ambulance only ignores red, not yellow.
  for (const c of cars) {
    if (c.passed) {
      // Already passed: continue moving off-screen.
      c.pos += c.speed * dtSec;
      continue;
    }
    const stopPos = computeStopPos(c);
    const allowedBySignal = canDirGo(c.dir);
    // Ambulance priority: can ignore red but must respect yellow.
    const inYellow = signal === 'yellowToEW' || signal === 'yellowToNS';
    // A car that has already crossed the stop line must finish clearing the
    // intersection regardless of signal — stopping it mid-junction would lock
    // it in place AND let cross-axis cars drive through it once their light
    // turns green. Strict `>` so a car parked exactly at the stop line still
    // respects a yellow/red turn.
    const alreadyCrossing = c.pos > GEOM.APPROACH_LEN;
    const allowed = allowedBySignal || (c.isAmbulance && !inYellow) || alreadyCrossing;

    // Determine the effective target position this frame.
    // If allowed and we're the lead (stopPos == APPROACH_LEN, no car ahead),
    // we can roll past APPROACH_LEN and through the intersection.
    let targetPos: number;
    if (allowed) {
      // Lead car: can pass through the intersection. Set target so the bumper
      // can keep going beyond stop line.
      // Other cars: still need to follow the car ahead (computeStopPos).
      if (stopPos >= GEOM.APPROACH_LEN - 0.5) {
        targetPos = GEOM.APPROACH_LEN + 200; // arbitrarily far
      } else {
        targetPos = stopPos;
      }
    } else {
      // Must respect stop line / car ahead.
      targetPos = stopPos;
    }

    const maxMove = c.speed * dtSec;
    if (c.pos < targetPos) {
      c.pos = Math.min(c.pos + maxMove, targetPos);
    }

    // Drain patience only while waiting (not moving freely).
    // A car is "waiting" if it's blocked from reaching its desired target
    // (either by signal or by car ahead).
    const isWaiting =
      Math.abs(targetPos - c.pos) < 0.5 && c.pos < GEOM.APPROACH_LEN + 5;
    if (isWaiting && !c.passed) {
      c.patience -= dtSec;
      if (c.patience <= 0) {
        gameOver();
        return;
      }
    }

    // Mark passed when bumper crosses the far end of the intersection.
    if (!c.passed) {
      const head = carHeadCoord(c);
      let isPast = false;
      if (c.dir === 'N') isPast = head >= STOP_LINE_S + GEOM.CAR_LEN;
      else if (c.dir === 'S') isPast = head <= STOP_LINE_N - GEOM.CAR_LEN;
      else if (c.dir === 'W') isPast = head >= STOP_LINE_E + GEOM.CAR_LEN;
      else if (c.dir === 'E') isPast = head <= STOP_LINE_W - GEOM.CAR_LEN;
      if (isPast) {
        c.passed = true;
        score += 1;
        scoreEl.textContent = String(score);
        if (score > best) {
          best = score;
          bestEl.textContent = String(best);
          safeWrite(STORAGE_BEST, best);
        }
      }
    }
  }

  // Remove cars that are fully off-screen.
  cars = cars.filter((c) => {
    if (!c.passed) return true;
    const head = carHeadCoord(c);
    if (head < -GEOM.CAR_LEN * 2 || head > GEOM.W + GEOM.CAR_LEN * 2) return false;
    return true;
  });

  // Spawn timer
  spawnTimerMs -= dt;
  if (spawnTimerMs <= 0) {
    spawnCar();
    spawnTimerMs = spawnIntervalForScore(score);
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────
function reset(): void {
  state = 'ready';
  signal = 'nsGreen';
  pendingSignalAfterYellow = 'nsGreen';
  yellowEndsAt = 0;
  score = 0;
  cars = [];
  nextCarId = 1;
  spawnTimerMs = 0;
  lastFrameTime = 0;
  best = safeRead(STORAGE_BEST, 0);
  scoreEl.textContent = '0';
  bestEl.textContent = String(best);
  updateSignalLabel();
  // Spawn initial visible cars so cold-boot has feedback within first frame.
  spawnCar('N');
  spawnCar('W');
  showOverlay(
    'Trafik Memuru',
    'Sinyali değiştirmek için boşluğa bas veya kavşağa dokun. NS yeşil ile başla.',
  );
  draw();
  // Bump generation token to invalidate any in-flight rAF callbacks.
  loopToken++;
  startLoop();
}

function startPlaying(): void {
  if (state === 'gameOver') {
    reset();
    // After reset state is 'ready' — fall through to start.
  }
  if (state === 'ready') {
    state = 'playing';
    hideOverlay();
    spawnTimerMs = spawnIntervalForScore(0);
  }
}

function gameOver(): void {
  if (state === 'gameOver') return;
  state = 'gameOver';
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  showOverlay('Sabırlar tükendi', `Skor: ${score} · Bir tık veya R ile yeniden başla.`);
}

// ─── Rendering ─────────────────────────────────────────────────────
function drawRoads(): void {
  // Grass background already from canvas BG; draw roads.
  ctx.fillStyle = getCss('--traffic-road');
  // Vertical road
  ctx.fillRect(CENTER_X - GEOM.ROAD_WIDTH / 2, 0, GEOM.ROAD_WIDTH, GEOM.H);
  // Horizontal road
  ctx.fillRect(0, CENTER_Y - GEOM.ROAD_WIDTH / 2, GEOM.W, GEOM.ROAD_WIDTH);

  // Intersection square (slightly different shade)
  ctx.fillStyle = getCss('--traffic-intersection');
  ctx.fillRect(
    STOP_LINE_W,
    STOP_LINE_N,
    GEOM.ROAD_WIDTH,
    GEOM.ROAD_WIDTH,
  );

  // Lane center dashes (outside intersection)
  ctx.strokeStyle = getCss('--traffic-road-line');
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 1.5;
  // Vertical center line — top half
  ctx.beginPath();
  ctx.moveTo(CENTER_X, 0);
  ctx.lineTo(CENTER_X, STOP_LINE_N);
  ctx.stroke();
  // Vertical center line — bottom half
  ctx.beginPath();
  ctx.moveTo(CENTER_X, STOP_LINE_S);
  ctx.lineTo(CENTER_X, GEOM.H);
  ctx.stroke();
  // Horizontal center line — left half
  ctx.beginPath();
  ctx.moveTo(0, CENTER_Y);
  ctx.lineTo(STOP_LINE_W, CENTER_Y);
  ctx.stroke();
  // Horizontal center line — right half
  ctx.beginPath();
  ctx.moveTo(STOP_LINE_E, CENTER_Y);
  ctx.lineTo(GEOM.W, CENTER_Y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Stop lines at edges of intersection (solid white)
  ctx.strokeStyle = '#e4e4ed';
  ctx.lineWidth = 2;
  // N approach: cars come from top, stop line at STOP_LINE_N (just below cars)
  ctx.beginPath();
  ctx.moveTo(CENTER_X, STOP_LINE_N);
  ctx.lineTo(CENTER_X + GEOM.ROAD_WIDTH / 2, STOP_LINE_N);
  ctx.stroke();
  // S approach: cars come from bottom going up, stop line at STOP_LINE_S
  ctx.beginPath();
  ctx.moveTo(CENTER_X - GEOM.ROAD_WIDTH / 2, STOP_LINE_S);
  ctx.lineTo(CENTER_X, STOP_LINE_S);
  ctx.stroke();
  // W approach: cars come from left, stop line at STOP_LINE_W
  ctx.beginPath();
  ctx.moveTo(STOP_LINE_W, CENTER_Y);
  ctx.lineTo(STOP_LINE_W, CENTER_Y + GEOM.ROAD_WIDTH / 2);
  ctx.stroke();
  // E approach: cars from right going left, stop line at STOP_LINE_E
  ctx.beginPath();
  ctx.moveTo(STOP_LINE_E, CENTER_Y - GEOM.ROAD_WIDTH / 2);
  ctx.lineTo(STOP_LINE_E, CENTER_Y);
  ctx.stroke();
}

function drawSignals(): void {
  // Show two signal lights: one for NS axis, one for EW axis.
  // Place them at corners of the intersection box.
  const lightRadius = 9;
  const margin = 14;

  // NS light: near top-left corner of intersection
  const nsX = STOP_LINE_W - margin;
  const nsY = STOP_LINE_N - margin;
  drawLight(nsX, nsY, lightRadius, signalForAxis('NS'));

  // EW light: near bottom-right corner of intersection
  const ewX = STOP_LINE_E + margin;
  const ewY = STOP_LINE_S + margin;
  drawLight(ewX, ewY, lightRadius, signalForAxis('EW'));

  // Labels
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.fillStyle = getCss('--text-dim');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('NS', nsX, nsY - lightRadius - 9);
  ctx.fillText('EW', ewX, ewY + lightRadius + 9);
}

function signalForAxis(axis: 'NS' | 'EW'): 'green' | 'yellow' | 'red' {
  if (signal === 'yellowToEW' || signal === 'yellowToNS') return 'yellow';
  if (signal === 'nsGreen') return axis === 'NS' ? 'green' : 'red';
  if (signal === 'ewGreen') return axis === 'EW' ? 'green' : 'red';
  return 'red';
}

function drawLight(
  x: number,
  y: number,
  r: number,
  color: 'green' | 'yellow' | 'red',
): void {
  ctx.fillStyle = '#0a0b0e';
  ctx.beginPath();
  ctx.arc(x, y, r + 2, 0, Math.PI * 2);
  ctx.fill();
  let fill = getCss('--traffic-red');
  if (color === 'green') fill = getCss('--traffic-green');
  else if (color === 'yellow') fill = getCss('--traffic-yellow');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawCar(c: Car): void {
  const head = carHeadCoord(c);
  const lane = laneCenter(c.dir);
  // Compute car rectangle.
  const vertical = isVertical(c.dir);
  let cx: number; let cy: number; let w: number; let h: number;
  if (vertical) {
    cx = lane - GEOM.CAR_WID / 2;
    w = GEOM.CAR_WID;
    h = GEOM.CAR_LEN;
    // For dir N (heading south), head is the front (south side), tail is north.
    // For dir S (heading north), head is the front (north side), tail is south.
    if (c.dir === 'N') cy = head - GEOM.CAR_LEN; // car body extends from head upward
    else cy = head; // S: head is at top
  } else {
    cy = lane - GEOM.CAR_WID / 2;
    h = GEOM.CAR_WID;
    w = GEOM.CAR_LEN;
    if (c.dir === 'W') cx = head - GEOM.CAR_LEN; // body extends west
    else cx = head; // E
  }
  // Body
  ctx.fillStyle = getCss(c.colorVar);
  ctx.fillRect(cx, cy, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx + 0.5, cy + 0.5, w - 1, h - 1);

  // Ambulance stripe
  if (c.isAmbulance) {
    ctx.fillStyle = getCss('--traffic-ambulance-stripe');
    if (vertical) {
      ctx.fillRect(cx, cy + h / 2 - 2, w, 4);
    } else {
      ctx.fillRect(cx + w / 2 - 2, cy, 4, h);
    }
    // Plus sign
    ctx.fillStyle = '#0a0b0e';
    const px = cx + w / 2;
    const py = cy + h / 2;
    ctx.fillRect(px - 4, py - 1, 8, 2);
    ctx.fillRect(px - 1, py - 4, 2, 8);
  }

  // Patience bar — only show if car is not yet past
  if (!c.passed) {
    const ratio = Math.max(0, Math.min(1, c.patience / c.totalPatience));
    const barLen = 22;
    const barThick = 3;
    // Position bar above (for N/S) or beside (for E/W) the car.
    let bx: number; let by: number; let bw: number; let bh: number;
    if (vertical) {
      bx = lane - barLen / 2;
      bw = barLen;
      bh = barThick;
      by = c.dir === 'N' ? cy - 6 : cy + h + 3;
    } else {
      by = lane - barLen / 2;
      bh = barLen;
      bw = barThick;
      bx = c.dir === 'W' ? cx - 6 : cx + w + 3;
    }
    ctx.fillStyle = getCss('--border');
    ctx.fillRect(bx, by, bw, bh);
    const fillColor =
      ratio < 0.25
        ? getCss('--traffic-red')
        : ratio < 0.55
          ? getCss('--traffic-yellow')
          : getCss('--traffic-green');
    ctx.fillStyle = fillColor;
    if (vertical) {
      ctx.fillRect(bx, by, bw * ratio, bh);
    } else {
      // For horizontal cars, drain bar from top.
      ctx.fillRect(bx, by, bw, bh * ratio);
    }
  }
}

function draw(): void {
  ctx.clearRect(0, 0, GEOM.W, GEOM.H);
  // Grass
  ctx.fillStyle = getCss('--traffic-grass');
  ctx.fillRect(0, 0, GEOM.W, GEOM.H);
  drawRoads();
  drawSignals();
  // Sort cars: draw passed/in-intersection on top so they look natural.
  const sorted = [...cars].sort((a, b) => Number(a.passed) - Number(b.passed));
  for (const c of sorted) drawCar(c);
}

// ─── Game loop with generation token ──────────────────────────────
function startLoop(): void {
  const myToken = loopToken;
  function frame(now: number): void {
    if (myToken !== loopToken) return; // stale callback after reset
    if (lastFrameTime === 0) lastFrameTime = now;
    const dt = Math.min(64, now - lastFrameTime);
    lastFrameTime = now;
    tick(dt, now);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ─── Input handling (state machine) ────────────────────────────────
function handleSignalAction(): void {
  if (state === 'ready') {
    startPlaying();
    lastTransitionAt = performance.now();
    return;
  }
  if (state === 'playing') {
    // Swallow taps that arrive within the cooldown after a state transition,
    // so spam-tapping to restart doesn't immediately toggle the signal.
    if (performance.now() - lastTransitionAt < TRANSITION_COOLDOWN_MS) return;
    toggleSignal();
    return;
  }
  if (state === 'gameOver') {
    reset();
    // Single tap: restart and immediately go to playing.
    startPlaying();
    lastTransitionAt = performance.now();
    return;
  }
}

function handleRestart(): void {
  // Consistent with canvas/space: dropping back into 'ready' would leave the
  // user stuck behind the cold-boot overlay and require an extra tap.
  reset();
  startPlaying();
  lastTransitionAt = performance.now();
}

// Click on canvas: toggle signal (or start/restart).
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  handleSignalAction();
});

toggleBtn.addEventListener('click', (e) => {
  e.preventDefault();
  handleSignalAction();
});

restartBtn.addEventListener('click', (e) => {
  e.preventDefault();
  handleRestart();
});

window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === ' ' || k === 'Spacebar') {
    handleSignalAction();
    e.preventDefault();
    return;
  }
  if (k.toLowerCase() === 'r') {
    handleRestart();
    e.preventDefault();
  }
});

// ─── Boot ──────────────────────────────────────────────────────────
reset();

// Headless test hook: expose internals for /tmp/trafik-test.mjs.
// In browser this is harmless; in headless DOM mock it's read by the harness.
declare global {
  interface Window {
    __trafik?: unknown;
  }
}
window.__trafik = {
  // State accessors
  getState: (): GameState => state,
  getSignal: (): SignalState => signal,
  getScore: (): number => score,
  getBest: (): number => best,
  getCars: (): Car[] => cars,
  getOverlayHidden: (): boolean => overlay.classList.contains('overlay--hidden'),
  // Actions
  start: (): void => startPlaying(),
  toggle: (): void => toggleSignal(),
  reset: (): void => reset(),
  signalAction: (): void => handleSignalAction(),
  // Direct injectors for test scenarios
  forceSpawn: (dir: Direction, amb?: boolean): void => spawnCar(dir, amb ?? false),
  advance: (dt: number, now: number): void => tick(dt, now),
  setNow: (ms: number): void => { yellowEndsAt = ms + YELLOW_MS; },
  // Geometry exposure for test verification
  geom: GEOM,
  stopLines: { N: STOP_LINE_N, S: STOP_LINE_S, W: STOP_LINE_W, E: STOP_LINE_E },
};
