// Canvas particle engine — first particle system in the repo.
// 400-slot preallocated pool, requestAnimationFrame only while active > 0.
// DPR-aware, respects reduced-motion via factor multipliers.

const POOL_SIZE = 400;

interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  shape: 'circle' | 'star' | 'square';
  rotation: number;
  rotSpeed: number;
  alpha: number;
}

const pool: Particle[] = [];
let canvas: HTMLCanvasElement | null = null;
let cctx: CanvasRenderingContext2D | null = null;
let activeCount = 0;
let rafId = 0;
let lastTs = 0;
let dpr = 1;
let intensityFactor = 1; // 0..1 for reduced motion

for (let i = 0; i < POOL_SIZE; i++) {
  pool.push({
    active: false, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0,
    life: 0, maxLife: 0, size: 0, color: '#fff', shape: 'circle',
    rotation: 0, rotSpeed: 0, alpha: 1,
  });
}

export function bindCanvas(c: HTMLCanvasElement): void {
  canvas = c;
  cctx = c.getContext('2d');
  resize();
}

export function setIntensity(factor: number): void {
  intensityFactor = Math.max(0, Math.min(1, factor));
}

export function resize(): void {
  if (!canvas) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  if (cctx) cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function obtain(): Particle | null {
  for (let i = 0; i < POOL_SIZE; i++) {
    const p = pool[i]!;
    if (!p.active) return p;
  }
  return null;
}

function startLoop(): void {
  if (rafId) return;
  lastTs = performance.now();
  rafId = requestAnimationFrame(tick);
}

function tick(ts: number): void {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  if (!cctx || !canvas) {
    rafId = 0;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  cctx.clearRect(0, 0, rect.width, rect.height);
  let live = 0;
  for (let i = 0; i < POOL_SIZE; i++) {
    const p = pool[i]!;
    if (!p.active) continue;
    p.life -= dt;
    if (p.life <= 0) {
      p.active = false;
      continue;
    }
    p.vx += p.ax * dt;
    p.vy += p.ay * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rotation += p.rotSpeed * dt;
    const tnorm = p.life / p.maxLife;
    p.alpha = Math.max(0, Math.min(1, tnorm * 1.4));
    draw(p);
    live += 1;
  }
  activeCount = live;
  if (live > 0) rafId = requestAnimationFrame(tick);
  else rafId = 0;
}

function draw(p: Particle): void {
  if (!cctx) return;
  cctx.save();
  cctx.globalAlpha = p.alpha;
  cctx.translate(p.x, p.y);
  cctx.rotate(p.rotation);
  cctx.fillStyle = p.color;
  if (p.shape === 'circle') {
    cctx.beginPath();
    cctx.arc(0, 0, p.size, 0, Math.PI * 2);
    cctx.fill();
  } else if (p.shape === 'square') {
    cctx.fillRect(-p.size, -p.size, p.size * 2, p.size * 2);
  } else if (p.shape === 'star') {
    drawStar(cctx, p.size);
  }
  cctx.restore();
}

function drawStar(g: CanvasRenderingContext2D, r: number): void {
  g.beginPath();
  const spikes = 5;
  const outer = r;
  const inner = r * 0.45;
  for (let i = 0; i < spikes * 2; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = (i * Math.PI) / spikes - Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
}

interface BurstOpts {
  x: number; y: number;
  count: number;
  color: string | ((i: number) => string);
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  spread?: { angle: number; arc: number };
  gravity?: number;
  shape?: 'circle' | 'star' | 'square';
  rotSpeed?: [number, number];
}

function emit(opts: BurstOpts): void {
  if (!canvas) return;
  const count = Math.max(1, Math.floor(opts.count * intensityFactor));
  const colorFn = typeof opts.color === 'function' ? opts.color : () => opts.color as string;
  const baseAngle = opts.spread?.angle ?? 0;
  const arc = opts.spread?.arc ?? Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const p = obtain();
    if (!p) return;
    const ang = baseAngle + (i / count) * arc + (Math.random() - 0.5) * arc * 0.1;
    const sp = lerp(opts.speed[0], opts.speed[1], Math.random());
    const life = lerp(opts.life[0], opts.life[1], Math.random()) * (intensityFactor < 1 ? 0.5 : 1);
    p.active = true;
    p.x = opts.x;
    p.y = opts.y;
    p.vx = Math.cos(ang) * sp;
    p.vy = Math.sin(ang) * sp;
    p.ax = 0;
    p.ay = opts.gravity ?? 0;
    p.life = life;
    p.maxLife = life;
    p.size = lerp(opts.size[0], opts.size[1], Math.random());
    p.color = colorFn(i);
    p.shape = opts.shape ?? 'circle';
    p.rotation = Math.random() * Math.PI * 2;
    p.rotSpeed = opts.rotSpeed ? lerp(opts.rotSpeed[0], opts.rotSpeed[1], Math.random()) : 0;
    p.alpha = 1;
  }
  startLoop();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ────────────── Public emitters ──────────────

export function matchBurst(x: number, y: number, color: string): void {
  emit({
    x, y, count: 10, color,
    speed: [60, 220], life: [0.4, 0.85], size: [3, 7],
    gravity: 380, shape: 'circle',
  });
}

export function stripedFireSparks(x: number, y: number, color: string, axis: 'h' | 'v'): void {
  emit({
    x, y, count: 24, color,
    speed: [120, 320], life: [0.3, 0.6], size: [2, 5],
    spread: axis === 'h' ? { angle: 0, arc: Math.PI * 0.25 } : { angle: -Math.PI / 2, arc: Math.PI * 0.25 },
    gravity: 50, shape: 'circle',
  });
  emit({
    x, y, count: 24, color,
    speed: [120, 320], life: [0.3, 0.6], size: [2, 5],
    spread: axis === 'h' ? { angle: Math.PI, arc: Math.PI * 0.25 } : { angle: Math.PI / 2, arc: Math.PI * 0.25 },
    gravity: 50, shape: 'circle',
  });
}

export function wrappedExplosion(x: number, y: number, color: string): void {
  emit({
    x, y, count: 36, color,
    speed: [80, 280], life: [0.5, 1.0], size: [4, 9],
    gravity: 200, shape: 'circle',
  });
  emit({
    x, y, count: 8, color: '#fff7c2',
    speed: [120, 240], life: [0.5, 0.9], size: [5, 9],
    shape: 'star', rotSpeed: [-6, 6], gravity: 100,
  });
}

const CANDY_PALETTE = ['#ff3b6b', '#ffd400', '#25d366', '#29b6ff', '#b14bff', '#ff8a00', '#ff66ce'];

export function colorBombClear(x: number, y: number): void {
  emit({
    x, y, count: 56,
    color: (i) => CANDY_PALETTE[i % CANDY_PALETTE.length]!,
    speed: [120, 360], life: [0.6, 1.2], size: [3, 8],
    gravity: 280, shape: 'circle',
  });
}

export function cascadeConfetti(depth: number): void {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  emit({
    x: rect.width / 2, y: -10,
    count: 12 + depth * 6,
    color: (i) => CANDY_PALETTE[i % CANDY_PALETTE.length]!,
    speed: [60, 180], life: [1.2, 2.0], size: [3, 7],
    spread: { angle: Math.PI / 2, arc: Math.PI * 0.9 },
    gravity: 260, shape: 'square', rotSpeed: [-8, 8],
  });
}

export function levelCompleteCannon(): void {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const corners: [number, number, number][] = [
    [0, rect.height, -Math.PI / 4],
    [rect.width, rect.height, Math.PI + Math.PI / 4],
    [0, 0, Math.PI / 4],
    [rect.width, 0, Math.PI - Math.PI / 4],
  ];
  for (const [cx, cy, ang] of corners) {
    emit({
      x: cx, y: cy, count: 20,
      color: (i) => CANDY_PALETTE[i % CANDY_PALETTE.length]!,
      speed: [240, 460], life: [0.9, 1.6], size: [3, 8],
      spread: { angle: ang, arc: Math.PI * 0.5 },
      gravity: 300, shape: 'square', rotSpeed: [-6, 6],
    });
  }
}

export function starEarnedSparkle(x: number, y: number): void {
  emit({
    x, y, count: 14, color: '#fff3b0',
    speed: [60, 180], life: [0.6, 1.1], size: [3, 6],
    gravity: 0, shape: 'star', rotSpeed: [-10, 10],
  });
}

export function ingredientCelebrate(x: number, y: number): void {
  emit({
    x, y, count: 16, color: '#ff5566',
    speed: [60, 200], life: [0.5, 0.9], size: [3, 6],
    gravity: -120, shape: 'star',
  });
}

export function getActiveCount(): number {
  return activeCount;
}

export function dispose(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  for (const p of pool) p.active = false;
  activeCount = 0;
  if (cctx && canvas) {
    const rect = canvas.getBoundingClientRect();
    cctx.clearRect(0, 0, rect.width, rect.height);
  }
}
