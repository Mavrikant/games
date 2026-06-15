import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

const STORAGE_BEST = 'lehim.best';

type State = 'ready' | 'soldering' | 'idle' | 'gameover';
type JointStatus = 'pending' | 'good' | 'cold' | 'bridge';

interface Joint {
  x: number;
  y: number;
  target: number;
  tolerance: number;
  current: number;
  status: JointStatus;
  bridgeTo: number | null;
}

interface Board {
  joints: Joint[];
  bridgeEdges: Array<[number, number]>;
  fillRate: number;
  time: number;
}

const PAD_RADIUS = 14;
const MIN_BRIDGE_DIST = 72;

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let boardNum = 1;
let timeLeft = 0;
let activeJoint = -1;
let lastTickMs = 0;
let raf = 0;

let board: Board = { joints: [], bridgeEdges: [], fillRate: 35, time: 30 };

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let boardEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function buildBoard(num: number): Board {
  const w = canvas.width;
  const h = canvas.height;
  const margin = 60;
  const count = Math.min(5 + num, 12);
  const tolerance = Math.max(3.5 - num * 0.25, 1.4);
  const fillRate = Math.min(28 + num * 6, 78);
  const time = Math.max(36 - num * 2, 18);

  const joints: Joint[] = [];
  let attempts = 0;
  while (joints.length < count && attempts < 400) {
    attempts++;
    const x = rand(margin, w - margin);
    const y = rand(margin, h - margin);
    let ok = true;
    for (const j of joints) {
      const d = Math.hypot(j.x - x, j.y - y);
      if (d < 52) { ok = false; break; }
    }
    if (!ok) continue;
    const target = rand(7, 18);
    joints.push({ x, y, target, tolerance, current: 0, status: 'pending', bridgeTo: null });
  }

  const bridgeEdges: Array<[number, number]> = [];
  for (let i = 0; i < joints.length; i++) {
    for (let k = i + 1; k < joints.length; k++) {
      const a = joints[i]!;
      const b = joints[k]!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < MIN_BRIDGE_DIST) bridgeEdges.push([i, k]);
    }
  }
  return { joints, bridgeEdges, fillRate, time };
}

function pendingCount(): number {
  let n = 0;
  for (const j of board.joints) if (j.status === 'pending') n++;
  return n;
}

function findJointAt(x: number, y: number): number {
  for (let i = 0; i < board.joints.length; i++) {
    const j = board.joints[i]!;
    if (j.status !== 'pending') continue;
    if (Math.hypot(j.x - x, j.y - y) <= PAD_RADIUS + 8) return i;
  }
  return -1;
}

function checkBridgeNeighbor(joint: Joint, idx: number): number {
  for (const [a, b] of board.bridgeEdges) {
    const other = a === idx ? b : b === idx ? a : -1;
    if (other === -1) continue;
    const o = board.joints[other]!;
    const d = Math.hypot(joint.x - o.x, joint.y - o.y);
    if (joint.current + PAD_RADIUS * 0.55 >= d - PAD_RADIUS * 0.6) return other;
  }
  return -1;
}

function settle(idx: number): void {
  const j = board.joints[idx]!;
  if (j.status !== 'pending') return;
  const delta = j.current - j.target;
  const bridge = checkBridgeNeighbor(j, idx);
  if (bridge !== -1) {
    j.status = 'bridge';
    j.bridgeTo = bridge;
  } else if (delta < -j.tolerance) {
    j.status = 'cold';
  } else if (delta > j.tolerance) {
    j.status = 'good';
    score += Math.max(1, Math.round(6 - Math.abs(delta)));
  } else {
    const closeness = 1 - Math.abs(delta) / j.tolerance;
    j.status = 'good';
    score += 10 + Math.round(closeness * 8);
  }
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  if (pendingCount() === 0) finishBoard();
}

function finishBoard(): void {
  score += Math.floor(timeLeft) * 2;
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  boardNum++;
  loadNextBoard();
  updateHud();
}

function loadNextBoard(): void {
  board = buildBoard(boardNum);
  timeLeft = board.time;
  activeJoint = -1;
}

function gameOver(reason: string): void {
  state = 'gameover';
  activeJoint = -1;
  gen.bump();
  cancelAnimationFrame(raf);
  raf = 0;
  overlayTitle.textContent = 'Vardiya bitti';
  overlayMsg.textContent = `${reason}\nSkor: ${score} · Rekor: ${best}\nYeni vardiya için Başla.`;
  overlayBtn.textContent = 'Yeniden başla';
  showOverlay(overlayEl);
}

function startRun(): void {
  gen.bump();
  state = 'idle';
  score = 0;
  boardNum = 1;
  activeJoint = -1;
  loadNextBoard();
  hideOverlay(overlayEl);
  lastTickMs = performance.now();
  raf = requestAnimationFrame(tick);
  updateHud();
}

function reset(): void {
  gen.bump();
  cancelAnimationFrame(raf);
  raf = 0;
  state = 'ready';
  activeJoint = -1;
  score = 0;
  boardNum = 1;
  board = buildBoard(1);
  timeLeft = board.time;
  overlayTitle.textContent = 'Lehim';
  overlayMsg.textContent =
    'Altlığa basılı tut, lehim damlası büyür. Halka kalınlığına ulaşınca bırak. Yetersiz → soğuk; çok → komşuya köprü.';
  overlayBtn.textContent = 'Başla';
  showOverlay(overlayEl);
  updateHud();
  draw();
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  boardEl.textContent = String(boardNum);
  timeEl.textContent = String(Math.max(0, Math.ceil(timeLeft)));
}

function tick(now: number): void {
  const myGen = gen.current();
  const dt = Math.min(0.05, (now - lastTickMs) / 1000);
  lastTickMs = now;

  if (state !== 'gameover') {
    timeLeft -= dt;
    if (timeLeft <= 0) {
      timeLeft = 0;
      if (activeJoint !== -1) {
        const idx = activeJoint;
        activeJoint = -1;
        settle(idx);
      }
      gameOver('Zaman bitti.');
      draw();
      return;
    }
    if (state === 'soldering' && activeJoint !== -1) {
      const j = board.joints[activeJoint]!;
      j.current += board.fillRate * dt;
      if (j.current > j.target + j.tolerance + 28) {
        const idx = activeJoint;
        activeJoint = -1;
        state = 'idle';
        settle(idx);
      }
    }
    updateHud();
  }

  draw();
  if (gen.isCurrent(myGen) && state !== 'gameover') {
    raf = requestAnimationFrame(tick);
  }
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#0d3a26';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255,210,120,0.22)';
  ctx.lineWidth = 2;
  for (const [a, b] of board.bridgeEdges) {
    const ja = board.joints[a]!;
    const jb = board.joints[b]!;
    ctx.beginPath();
    ctx.moveTo(ja.x, ja.y);
    ctx.lineTo(jb.x, jb.y);
    ctx.stroke();
  }

  for (let i = 0; i < board.joints.length; i++) {
    const j = board.joints[i]!;

    ctx.beginPath();
    ctx.arc(j.x, j.y, PAD_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = '#b97a2e';
    ctx.fill();
    ctx.strokeStyle = '#5b3a14';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (j.status === 'pending') {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(120,220,255,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(j.x, j.y, PAD_RADIUS + j.target, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(120,220,255,0.25)';
      ctx.beginPath();
      ctx.arc(j.x, j.y, PAD_RADIUS + j.target - j.tolerance, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(j.x, j.y, PAD_RADIUS + j.target + j.tolerance, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (j.current > 0 && j.status === 'pending') {
      const grd = ctx.createRadialGradient(j.x - 3, j.y - 3, 1, j.x, j.y, PAD_RADIUS + j.current);
      grd.addColorStop(0, '#f6f7fb');
      grd.addColorStop(0.5, '#c2c7d2');
      grd.addColorStop(1, '#6a6f7d');
      ctx.beginPath();
      ctx.arc(j.x, j.y, PAD_RADIUS + j.current, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.strokeStyle = '#2b2f37';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (j.status === 'good') {
      const r = PAD_RADIUS + j.current;
      const grd = ctx.createRadialGradient(j.x - 3, j.y - 3, 1, j.x, j.y, r);
      grd.addColorStop(0, '#e8ebf3');
      grd.addColorStop(0.5, '#aab0bc');
      grd.addColorStop(1, '#555a64');
      ctx.beginPath();
      ctx.arc(j.x, j.y, r, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.strokeStyle = '#7fe39a';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    if (j.status === 'cold') {
      ctx.strokeStyle = '#5b6770';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(j.x, j.y, PAD_RADIUS + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#ff6b5a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(j.x - 8, j.y - 8);
      ctx.lineTo(j.x + 8, j.y + 8);
      ctx.moveTo(j.x + 8, j.y - 8);
      ctx.lineTo(j.x - 8, j.y + 8);
      ctx.stroke();
    }

    if (j.status === 'bridge' && j.bridgeTo !== null) {
      const other = board.joints[j.bridgeTo]!;
      ctx.strokeStyle = '#ff6b5a';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(j.x, j.y);
      ctx.lineTo(other.x, other.y);
      ctx.stroke();
      ctx.fillStyle = '#ff6b5a';
      ctx.beginPath();
      ctx.arc(j.x, j.y, PAD_RADIUS + 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (state === 'soldering' && activeJoint !== -1) {
    const j = board.joints[activeJoint]!;
    ctx.strokeStyle = '#ffdf6b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(j.x, j.y, PAD_RADIUS + j.current + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function pointerPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function onPointerDown(e: PointerEvent): void {
  if (state === 'ready' || state === 'gameover') return;
  const { x, y } = pointerPos(e);
  const idx = findJointAt(x, y);
  if (idx === -1) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  activeJoint = idx;
  state = 'soldering';
}

function onPointerUp(e: PointerEvent): void {
  if (state !== 'soldering' || activeJoint === -1) return;
  e.preventDefault();
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  const idx = activeJoint;
  activeJoint = -1;
  state = 'idle';
  settle(idx);
}

function onPointerCancel(): void {
  if (state !== 'soldering' || activeJoint === -1) return;
  const idx = activeJoint;
  activeJoint = -1;
  state = 'idle';
  settle(idx);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    reset();
  } else if ((e.key === ' ' || e.key === 'Enter') && (state === 'ready' || state === 'gameover')) {
    e.preventDefault();
    startRun();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  boardEl = document.querySelector<HTMLElement>('#board-num')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', (e) => {
    if (state === 'soldering' && !canvas.hasPointerCapture(e.pointerId)) onPointerCancel();
  });

  restartBtn.addEventListener('click', () => {
    if (state === 'ready') startRun();
    else reset();
  });
  overlayBtn.addEventListener('click', startRun);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
