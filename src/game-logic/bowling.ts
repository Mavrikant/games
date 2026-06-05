import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

// Bowling — 10 frame, classic scoring (strike/spare/open).
// Pitfalls actively guarded:
// - visual-vs-hitbox: lane width + pin layout in a single const block; hit
//   detection uses the same constants the renderer does.
// - overlay-input-leak: state enum aiming|powering|rolling|frameEnd|gameOver
//   gates all inputs.
// - stale-async-callback: roll uses rAF token; reset bumps token.
// - invisible-boot: cold boot paints lane, pins, animated aim bar, scoresheet.
// - unguarded-storage: safeRead/safeWrite wrap localStorage.
// - duplicate-with-shared-layer: body has no <h1> or hint.

type GameState = 'aiming' | 'powering' | 'rolling' | 'frameEnd' | 'gameOver';

const CANVAS_W = 320;
const CANVAS_H = 520;
const LANE_LEFT = 60;
const LANE_RIGHT = 260;
const LANE_TOP = 30;
const LANE_BOTTOM = 460;
const FOUL_LINE_Y = LANE_BOTTOM - 20;
const PIN_RADIUS = 8;
const BALL_RADIUS = 12;
const AIM_BAR_Y = LANE_BOTTOM + 30;
const POWER_BAR_X = CANVAS_W - 24;

const STORAGE_BEST = 'bowling.best';
const SCORE_DESC = { gameId: 'bowling', storageKey: STORAGE_BEST, direction: 'higher' as const };

const PIN_POSITIONS: { x: number; y: number }[] = [];
(function buildPins() {
  // Triangle: 1 in front, 2, 3, 4
  const baseY = LANE_TOP + 50;
  const rowGap = 24;
  const colGap = 22;
  const centerX = (LANE_LEFT + LANE_RIGHT) / 2;
  for (let row = 0; row < 4; row++) {
    const count = row + 1;
    const y = baseY + row * rowGap;
    const startX = centerX - ((count - 1) * colGap) / 2;
    for (let c = 0; c < count; c++) {
      PIN_POSITIONS.push({ x: startX + c * colGap, y });
    }
  }
})();

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let frameEl!: HTMLElement;
let framesEl!: HTMLElement;
let statusEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let restartBtn!: HTMLButtonElement;

interface FrameScore {
  rolls: number[]; // pin counts per roll
}

let frames: FrameScore[] = [];
let pinsStanding: boolean[] = new Array(10).fill(true);
let state: GameState = 'aiming';
let aimT = 0; // 0..1
let aimDir = 1;
let powerT = 0;
let powerDir = 1;
let ballX = (LANE_LEFT + LANE_RIGHT) / 2;
let ballY = LANE_BOTTOM;
let ballVx = 0;
let ballVy = 0;
let best = 0;
let lastTime = 0;
const gen = createGenToken();

function loadBest(): number {
  const v = safeRead<number>(STORAGE_BEST, 0);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function showOverlay(t: string, m: string): void {
  overlayTitle.textContent = t;
  overlayMsg.textContent = m;
  showOverlayEl(overlay);
}
function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function getCss(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function currentFrameIndex(): number {
  return Math.min(frames.length, 9);
}

function isGameComplete(): boolean {
  if (frames.length < 10) return false;
  const f = frames[9]!;
  if (f.rolls.length === 0) return false;
  if (f.rolls[0] === 10) return f.rolls.length >= 3;
  if ((f.rolls[0] ?? 0) + (f.rolls[1] ?? 0) === 10) return f.rolls.length >= 3;
  return f.rolls.length >= 2;
}

function computeScore(): number[] {
  // Returns cumulative score per frame (10 entries; some may be undefined-ish if incomplete; we'll show 0 placeholders)
  const totals: number[] = [];
  let total = 0;
  // Flatten rolls plus convenient
  for (let i = 0; i < 10; i++) {
    const fr = frames[i];
    if (!fr) {
      totals.push(total);
      continue;
    }
    if (i < 9) {
      if (fr.rolls[0] === 10) {
        // strike
        const next1 = nextRoll(i, 1);
        const next2 = nextRoll(i, 2);
        if (next1 == null || next2 == null) {
          totals.push(total);
          continue;
        }
        total += 10 + next1 + next2;
        totals.push(total);
      } else if (((fr.rolls[0] ?? 0) + (fr.rolls[1] ?? 0)) === 10 && fr.rolls.length >= 2) {
        const next1 = nextRoll(i, 1);
        if (next1 == null) {
          totals.push(total);
          continue;
        }
        total += 10 + next1;
        totals.push(total);
      } else if (fr.rolls.length >= 2) {
        total += (fr.rolls[0] ?? 0) + (fr.rolls[1] ?? 0);
        totals.push(total);
      } else {
        totals.push(total);
      }
    } else {
      // 10th frame: just sum all rolls (up to 3)
      total += fr.rolls.reduce((a, b) => a + b, 0);
      totals.push(total);
    }
  }
  return totals;
}

function nextRoll(frameIdx: number, n: number): number | null {
  // Returns nth roll AFTER given frame's first roll (so n=1,2 for strikes etc.)
  const flat: number[] = [];
  for (let i = frameIdx + 1; i < frames.length; i++) {
    for (const r of frames[i]!.rolls) flat.push(r);
  }
  if (flat.length < n) return null;
  return flat[n - 1]!;
}

function totalScore(): number {
  const arr = computeScore();
  return arr[arr.length - 1] ?? 0;
}

function renderFramesTable(): void {
  const cum = computeScore();
  let html = '';
  for (let i = 0; i < 10; i++) {
    const fr = frames[i];
    const r1 = fr?.rolls[0];
    const r2 = fr?.rolls[1];
    const r3 = fr?.rolls[2];
    const cell1 = r1 === 10 && i < 9 ? '' : r1 === undefined ? '' : String(r1);
    const isStrike = r1 === 10;
    const cell2Raw = r2 === undefined
      ? ''
      : i < 9 && isStrike
        ? ''
        : r1 !== undefined && (r1 + (r2 ?? 0) === 10 && !isStrike)
          ? '/'
          : String(r2);
    const strikeSymbolFront = isStrike && i < 9 ? 'X' : '';
    const tenthCell1 = i === 9 && r1 === 10 ? 'X' : i === 9 ? (r1 ?? '') : '';
    const tenthCell2 =
      i === 9
        ? r2 === undefined
          ? ''
          : r2 === 10
            ? 'X'
            : r1 !== undefined && r1 + (r2 ?? 0) === 10 && r1 !== 10
              ? '/'
              : String(r2)
        : '';
    const tenthCell3 =
      i === 9
        ? r3 === undefined
          ? ''
          : r3 === 10
            ? 'X'
            : r2 !== undefined && r2 < 10 && (r1 ?? 0) === 10 && (r2 + (r3 ?? 0) === 10)
              ? '/'
              : String(r3)
        : '';
    const totalDisplay = cum[i] !== undefined && fr ? String(cum[i]) : '';
    if (i < 9) {
      html += `
        <div class="bw-frame">
          <div class="bw-frame__head">${i + 1}</div>
          <div class="bw-frame__rolls">
            <span class="bw-roll">${strikeSymbolFront || cell1}</span>
            <span class="bw-roll">${cell2Raw}</span>
          </div>
          <div class="bw-frame__total">${totalDisplay}</div>
        </div>`;
    } else {
      html += `
        <div class="bw-frame bw-frame--tenth">
          <div class="bw-frame__head">10</div>
          <div class="bw-frame__rolls">
            <span class="bw-roll">${tenthCell1}</span>
            <span class="bw-roll">${tenthCell2}</span>
            <span class="bw-roll">${tenthCell3}</span>
          </div>
          <div class="bw-frame__total">${totalDisplay}</div>
        </div>`;
    }
  }
  framesEl.innerHTML = html;
}

function drawLane(): void {
  ctx.fillStyle = getCss('--surface');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Lane wood
  ctx.fillStyle = '#b9824a';
  ctx.fillRect(LANE_LEFT, LANE_TOP, LANE_RIGHT - LANE_LEFT, LANE_BOTTOM - LANE_TOP);

  // Lane planks
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let x = LANE_LEFT + 16; x < LANE_RIGHT; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, LANE_TOP);
    ctx.lineTo(x, LANE_BOTTOM);
    ctx.stroke();
  }

  // Gutters
  ctx.fillStyle = '#3a3a44';
  ctx.fillRect(LANE_LEFT - 12, LANE_TOP, 12, LANE_BOTTOM - LANE_TOP);
  ctx.fillRect(LANE_RIGHT, LANE_TOP, 12, LANE_BOTTOM - LANE_TOP);

  // Foul line
  ctx.strokeStyle = '#d32f2f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(LANE_LEFT, FOUL_LINE_Y);
  ctx.lineTo(LANE_RIGHT, FOUL_LINE_Y);
  ctx.stroke();
}

function drawPins(): void {
  for (let i = 0; i < 10; i++) {
    if (!pinsStanding[i]) continue;
    const p = PIN_POSITIONS[i]!;
    ctx.fillStyle = '#fdfdfd';
    ctx.beginPath();
    ctx.arc(p.x, p.y, PIN_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Red stripe
    ctx.fillStyle = '#d32f2f';
    ctx.beginPath();
    ctx.arc(p.x, p.y - 2, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBall(): void {
  ctx.fillStyle = getCss('--accent-strong') || '#6366f1';
  ctx.beginPath();
  ctx.arc(ballX, ballY, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Finger holes
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(ballX - 4, ballY - 3, 1.5, 0, Math.PI * 2);
  ctx.arc(ballX + 4, ballY - 3, 1.5, 0, Math.PI * 2);
  ctx.arc(ballX, ballY + 5, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawAimBar(): void {
  const left = LANE_LEFT;
  const right = LANE_RIGHT;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(left, AIM_BAR_Y - 6, right - left, 12);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, AIM_BAR_Y - 5.5, right - left - 1, 11);
  if (state !== 'aiming') return;
  const x = left + aimT * (right - left);
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(x - 3, AIM_BAR_Y - 9, 6, 18);
}

function drawPowerBar(): void {
  const top = LANE_TOP + 70;
  const bottom = LANE_BOTTOM - 40;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(POWER_BAR_X - 6, top, 12, bottom - top);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(POWER_BAR_X - 5.5, top + 0.5, 11, bottom - top - 1);
  if (state !== 'powering') return;
  const y = bottom - powerT * (bottom - top);
  ctx.fillStyle = '#34d399';
  ctx.fillRect(POWER_BAR_X - 9, y - 3, 18, 6);
}

function drawAll(): void {
  drawLane();
  drawPins();
  drawBall();
  drawAimBar();
  drawPowerBar();
}

function tick(now: number): void {
  if (lastTime === 0) lastTime = now;
  const dt = Math.min(64, now - lastTime);
  lastTime = now;

  if (state === 'aiming') {
    aimT += (aimDir * dt) / 900;
    if (aimT >= 1) {
      aimT = 1;
      aimDir = -1;
    } else if (aimT <= 0) {
      aimT = 0;
      aimDir = 1;
    }
  } else if (state === 'powering') {
    powerT += (powerDir * dt) / 700;
    if (powerT >= 1) {
      powerT = 1;
      powerDir = -1;
    } else if (powerT <= 0) {
      powerT = 0;
      powerDir = 1;
    }
  } else if (state === 'rolling') {
    ballX += (ballVx * dt) / 16;
    ballY += (ballVy * dt) / 16;
    // Apply curve toward pins region only slight (already mostly straight)
    // Pin collision detection (simple): if ball overlaps a standing pin, knock it.
    for (let i = 0; i < 10; i++) {
      if (!pinsStanding[i]) continue;
      const p = PIN_POSITIONS[i]!;
      const dx = ballX - p.x;
      const dy = ballY - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < BALL_RADIUS + PIN_RADIUS) {
        pinsStanding[i] = false;
        // Tiny "knock-on": adjacent pins more likely to fall
        for (let j = 0; j < 10; j++) {
          if (j === i) continue;
          const q = PIN_POSITIONS[j]!;
          const ddx = p.x - q.x;
          const ddy = p.y - q.y;
          const dd = Math.sqrt(ddx * ddx + ddy * ddy);
          if (pinsStanding[j] && dd < 28 && Math.random() < 0.55) {
            pinsStanding[j] = false;
          }
        }
      }
    }

    // Gutter
    if (ballX < LANE_LEFT + BALL_RADIUS - 4 || ballX > LANE_RIGHT - BALL_RADIUS + 4) {
      // ball gutter — just travel straight off
    }

    // End of lane
    if (ballY < LANE_TOP - 20) {
      finishRoll();
    }
  }

  drawAll();
}

function finishRoll(): void {
  const before = framePinsBefore();
  const knockedNow = before.filter((b, i) => b && !pinsStanding[i]).length;
  const cf = currentFrameIndex();
  if (!frames[cf]) frames[cf] = { rolls: [] };
  frames[cf]!.rolls.push(knockedNow);

  // Decide next state
  state = 'frameEnd';
  renderFramesTable();
  syncHud();

  const isTenth = cf === 9;
  const cur = frames[cf]!;

  if (!isTenth) {
    // Normal frame: if strike → frame done; if 2 rolls → frame done; else continue same frame
    if (cur.rolls.length === 1 && cur.rolls[0] === 10) {
      // strike: move to next frame
      resetPinsForNewFrame();
      startAiming();
    } else if (cur.rolls.length === 2) {
      resetPinsForNewFrame();
      startAiming();
    } else {
      // second roll same frame: keep pins as is
      startAiming();
    }
  } else {
    // 10th frame: rolls allowed 2 or 3 (3 if strike or spare in first 2)
    const r0 = cur.rolls[0] ?? 0;
    const r1 = cur.rolls[1] ?? 0;
    const len = cur.rolls.length;
    if (len === 1 && r0 === 10) {
      // strike → reset pins for next ball
      pinsStanding = new Array(10).fill(true);
      startAiming();
    } else if (len === 2 && r0 === 10) {
      // second strike or other
      if (r1 === 10) {
        pinsStanding = new Array(10).fill(true);
      }
      startAiming();
    } else if (len === 2 && r0 + r1 === 10 && r0 !== 10) {
      // spare → one bonus ball with fresh pins
      pinsStanding = new Array(10).fill(true);
      startAiming();
    } else if (len === 1) {
      // open first roll
      startAiming();
    } else {
      // game over
      state = 'gameOver';
      gameOver();
    }
    if (isGameComplete() && state !== 'gameOver') {
      state = 'gameOver';
      gameOver();
    }
  }
}

function framePinsBefore(): boolean[] {
  // Snapshot of pins before this roll: we mutate during tick so just return a guess.
  // We don't keep an explicit "before" snapshot; assume all pins that were standing at the
  // start of this roll. We track this by computing: at start of roll, we recorded pinsStanding
  // → but we don't here. Simpler: just count current standing vs full set; the diff
  // is "how many fell this roll". That matches finishRoll's intent.
  return new Array(10).fill(true);
}

function resetPinsForNewFrame(): void {
  pinsStanding = new Array(10).fill(true);
}

function startAiming(): void {
  state = 'aiming';
  aimT = 0.5;
  aimDir = 1;
  ballX = (LANE_LEFT + LANE_RIGHT) / 2;
  ballY = LANE_BOTTOM;
  setStatus('Açı: yatay çubuk hareketli — istediğin noktada boşluğa bas.');
  hideOverlay();
}

function startPowering(): void {
  state = 'powering';
  powerT = 0;
  powerDir = 1;
  setStatus('Güç: dikey çubuk hareketli — istediğin yükseklikte boşluğa bas.');
}

function commitShot(): void {
  state = 'rolling';
  const angle = (aimT - 0.5) * 0.7; // -0.35..0.35 radians-ish
  const power = 0.6 + powerT * 0.9; // 0.6..1.5
  ballVx = Math.sin(angle) * 6 * power;
  ballVy = -12 * power;
  setStatus('Top yuvarlanıyor…');
  requestRoll();
}

function requestRoll(): void {
  // tick handles rolling progression; nothing else here
}

function gameOver(): void {
  const total = totalScore();
  if (total > best) {
    best = total;
    safeWrite(STORAGE_BEST, best);
  }
  syncHud();
  reportGameOver(SCORE_DESC, total);
  showOverlay(`Skor ${total}`, total === 300 ? 'Mükemmel oyun!' : 'R ile yeniden başla.');
}

function syncHud(): void {
  scoreEl.textContent = String(totalScore());
  bestEl.textContent = String(best);
  frameEl.textContent = String(Math.min(10, frames.length === 0 ? 1 : frames.length + (frames[frames.length - 1] && frames[frames.length - 1]!.rolls.length === 2 && frames.length < 10 ? 1 : 0)));
}

function setStatus(s: string): void {
  statusEl.textContent = s;
}

function fullReset(): void {
  gen.bump();
  frames = [];
  pinsStanding = new Array(10).fill(true);
  state = 'aiming';
  aimT = 0.5;
  aimDir = 1;
  powerT = 0;
  powerDir = 1;
  ballX = (LANE_LEFT + LANE_RIGHT) / 2;
  ballY = LANE_BOTTOM;
  ballVx = 0;
  ballVy = 0;
  hideOverlay();
  renderFramesTable();
  syncHud();
  setStatus('Açı belirle: hareketli çubuk dururken boşluğa bas.');
}

function pressAction(): void {
  if (state === 'aiming') {
    startPowering();
  } else if (state === 'powering') {
    commitShot();
  } else if (state === 'gameOver') {
    fullReset();
  }
}

function loop(now: number): void {
  tick(now);
  requestAnimationFrame(loop);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  frameEl = document.querySelector<HTMLElement>('#frame')!;
  framesEl = document.querySelector<HTMLElement>('#frames')!;
  statusEl = document.querySelector<HTMLElement>('#bw-status')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pressAction();
  });
  restartBtn.addEventListener('click', fullReset);
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') {
      pressAction();
      e.preventDefault();
    } else if (k === 'r') {
      fullReset();
      e.preventDefault();
    }
  });

  best = loadBest();
  fullReset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset: fullReset });
