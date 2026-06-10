import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

const STORAGE_BEST = 'olta.best';
const ROUND_MS = 90_000;

// Canvas design size — CSS scales width responsively.
const W = 480;
const H = 640;
const WATERLINE_Y = 130;
const BOAT_X = W / 2;

// Bait control.
const BAIT_MIN_Y = WATERLINE_Y + 16;
const BAIT_MAX_Y = H - 30;
const BAIT_SPEED = 0.32; // px/ms
const BAIT_X = BOAT_X; // line is straight down from boat

// Fight phase tuning.
const REEL_SPEED = 0.05; // stamina drain per ms while pulling
const RELAX_RECOVER = 0.018; // stamina regen per ms while idle
const TENSION_RISE = 0.07; // tension gain per ms while pulling
const TENSION_FALL = 0.11; // tension loss per ms while idle
const STRUGGLE_BURST = 18; // extra tension when fish jolts
const FIGHT_TIMEOUT_MS = 12_000; // total fight clock
const BITE_WINDOW_MS = 700; // press SPACE within this when fish bites

type Phase = 'idle' | 'bite' | 'fight' | 'landed' | 'snap';
type State = 'ready' | 'playing' | 'gameover';
type FishKind = 'small' | 'medium' | 'large' | 'jelly';

interface Fish {
  x: number;
  y: number;
  vx: number;
  kind: FishKind;
  size: number;
  color: string;
  points: number;
  staminaMax: number; // points->fight difficulty
  struggleEvery: number; // ms between struggles
  alive: boolean;
}

const gen = createGenToken();
let state: State = 'ready';
let phase: Phase = 'idle';
let score = 0;
let best = 0;
let timeLeftMs = ROUND_MS;
let lastTs = 0;
let rafHandle = 0;

let baitY = 220;
let upHeld = false;
let downHeld = false;
let spaceHeld = false;

let fishes: Fish[] = [];
let spawnTimerMs = 0;

// Bite state
let biteFish: Fish | null = null;
let biteWindowMs = 0;

// Fight state
let fightFish: Fish | null = null;
let fightStamina = 0; // remaining; reach 0 = land
let fightTension = 0; // 0..100; reach 100 = snap
let fightTimeMs = 0;
let fightNextStruggleMs = 0;

let lastResultMsg = '';
let lastResultUntil = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let timeEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let staminaFill!: HTMLElement;
let tensionFill!: HTMLElement;

const cssCache = new Map<string, string>();
function css(name: string, fallback = '#fff'): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cssCache.set(name, v || fallback);
  return cssCache.get(name)!;
}

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msg;
  showOverlayEl(overlayEl);
}
function hideOverlay(): void {
  hideOverlayEl(overlayEl);
}

function pickKind(): FishKind {
  const r = Math.random();
  if (r < 0.08) return 'jelly';
  if (r < 0.55) return 'small';
  if (r < 0.85) return 'medium';
  return 'large';
}

function makeFish(): Fish {
  const kind = pickKind();
  const leftToRight = Math.random() < 0.5;
  // Depth bands: small upper, medium mid, large/jelly deep — but with overlap.
  let yMin = WATERLINE_Y + 30;
  let yMax = H - 60;
  if (kind === 'small') {
    yMin = WATERLINE_Y + 30;
    yMax = WATERLINE_Y + 200;
  } else if (kind === 'medium') {
    yMin = WATERLINE_Y + 140;
    yMax = WATERLINE_Y + 320;
  } else if (kind === 'large') {
    yMin = WATERLINE_Y + 260;
    yMax = H - 60;
  } else {
    yMin = WATERLINE_Y + 180;
    yMax = H - 70;
  }
  const y = yMin + Math.random() * (yMax - yMin);
  const baseSpeed =
    kind === 'small' ? 0.11 : kind === 'medium' ? 0.075 : kind === 'large' ? 0.05 : 0.04;
  const speed = baseSpeed * (0.85 + Math.random() * 0.4);
  const vx = leftToRight ? speed : -speed;
  const x = leftToRight ? -40 : W + 40;
  const size =
    kind === 'small' ? 14 : kind === 'medium' ? 22 : kind === 'large' ? 34 : 24;
  const color =
    kind === 'small'
      ? css('--olta-fish-small', '#9bd6ff')
      : kind === 'medium'
        ? css('--olta-fish-medium', '#f97f4d')
        : kind === 'large'
          ? css('--olta-fish-large', '#f5c542')
          : css('--olta-jelly', '#d77bff');
  const points =
    kind === 'small' ? 1 : kind === 'medium' ? 3 : kind === 'large' ? 8 : -2;
  const staminaMax =
    kind === 'small' ? 70 : kind === 'medium' ? 130 : kind === 'large' ? 220 : 60;
  const struggleEvery =
    kind === 'small' ? 1400 : kind === 'medium' ? 1100 : kind === 'large' ? 850 : 700;
  return { x, y, vx, kind, size, color, points, staminaMax, struggleEvery, alive: true };
}

function reset(): void {
  gen.bump();
  state = 'ready';
  phase = 'idle';
  score = 0;
  timeLeftMs = ROUND_MS;
  baitY = WATERLINE_Y + 60;
  upHeld = false;
  downHeld = false;
  spaceHeld = false;
  fishes = [];
  spawnTimerMs = 0;
  biteFish = null;
  biteWindowMs = 0;
  fightFish = null;
  fightStamina = 0;
  fightTension = 0;
  fightTimeMs = 0;
  fightNextStruggleMs = 0;
  lastResultMsg = '';
  lastResultUntil = 0;

  scoreEl.textContent = '0';
  timeEl.textContent = String(Math.ceil(ROUND_MS / 1000));
  bestEl.textContent = String(best);
  staminaFill.style.width = '0%';
  tensionFill.style.width = '0%';

  // Seed a few fish so the surface isn't empty on first frame (PITFALLS#invisible-boot).
  for (let i = 0; i < 3; i++) {
    const f = makeFish();
    f.x = 40 + Math.random() * (W - 80);
    fishes.push(f);
  }
  draw();
  showOverlay(
    'Olta',
    '↑/↓ ile oltayı indir-çıkar. Balık ısırınca <b>Boşluk</b>\'a bas, sonra tut/bırak ile gerilimi yönet.<br/>Boşluk veya tıklama ile başla.',
  );
}

function startPlaying(): void {
  if (state !== 'ready') return;
  state = 'playing';
  lastTs = performance.now();
  hideOverlay();
  rafHandle = requestAnimationFrame(loop);
}

function endRound(): void {
  state = 'gameover';
  cancelAnimationFrame(rafHandle);
  phase = 'idle';
  biteFish = null;
  fightFish = null;
  staminaFill.style.width = '0%';
  tensionFill.style.width = '0%';
  if (score > best) {
    best = score;
    bestEl.textContent = String(best);
    safeWrite(STORAGE_BEST, best);
  }
  showOverlay(
    'Süre doldu',
    `Skor: ${score}<br/>R veya Boşluk ile yeniden başla.`,
  );
}

function loop(ts: number): void {
  if (state !== 'playing') return;
  const dtRaw = ts - lastTs;
  lastTs = ts;
  const dt = Math.min(dtRaw, 50);

  step(dt);
  draw();

  timeLeftMs -= dtRaw;
  if (timeLeftMs <= 0) {
    timeLeftMs = 0;
    timeEl.textContent = '0';
    endRound();
    return;
  }
  timeEl.textContent = String(Math.ceil(timeLeftMs / 1000));

  rafHandle = requestAnimationFrame(loop);
}

function step(dt: number): void {
  // Bait vertical control (active in idle and bite phases, locked in fight).
  if (phase === 'idle' || phase === 'bite') {
    if (upHeld) baitY -= BAIT_SPEED * dt;
    if (downHeld) baitY += BAIT_SPEED * dt;
    if (baitY < BAIT_MIN_Y) baitY = BAIT_MIN_Y;
    if (baitY > BAIT_MAX_Y) baitY = BAIT_MAX_Y;
  }

  // Move fish; cull off-screen.
  for (const f of fishes) {
    if (!f.alive) continue;
    f.x += f.vx * dt;
    // Mild vertical drift so they feel alive.
    f.y += Math.sin((performance.now() + f.x) * 0.003) * 0.15;
  }
  fishes = fishes.filter((f) => f.alive && f.x > -80 && f.x < W + 80);

  // Spawn new fish over time (cap concurrent count).
  spawnTimerMs -= dt;
  if (spawnTimerMs <= 0 && fishes.length < 6) {
    fishes.push(makeFish());
    spawnTimerMs = 600 + Math.random() * 900;
  }

  // Phase-specific logic.
  if (phase === 'idle') {
    // Check for bite: any non-jelly fish within bait collision radius.
    for (const f of fishes) {
      if (!f.alive) continue;
      const dx = f.x - BAIT_X;
      const dy = f.y - baitY;
      const r = f.size + 8;
      if (dx * dx + dy * dy <= r * r) {
        if (f.kind === 'jelly') {
          // Jelly contact: instant minor penalty, no bite.
          score = Math.max(0, score + f.points);
          scoreEl.textContent = String(score);
          f.alive = false;
          flashResult('Denizanası! ' + f.points + ' puan');
          continue;
        }
        biteFish = f;
        biteWindowMs = BITE_WINDOW_MS;
        phase = 'bite';
        // Bait locks; fish slows next to bait.
        f.vx *= 0.25;
        break;
      }
    }
  } else if (phase === 'bite') {
    biteWindowMs -= dt;
    if (!biteFish || !biteFish.alive) {
      phase = 'idle';
      biteFish = null;
    } else if (biteWindowMs <= 0) {
      // Missed bite window — fish escapes.
      biteFish.vx = biteFish.vx >= 0 ? Math.abs(biteFish.vx) * 4 + 0.15 : -(Math.abs(biteFish.vx) * 4 + 0.15);
      flashResult('Kaçırdın!');
      biteFish = null;
      phase = 'idle';
    } else {
      // Visually wobble bait near fish; keep fish close.
      biteFish.x += (BAIT_X - biteFish.x) * Math.min(1, dt * 0.005);
    }
  } else if (phase === 'fight') {
    fightTimeMs += dt;
    if (!fightFish) {
      phase = 'idle';
    } else {
      // Fish stays near bait while hooked.
      fightFish.x += (BAIT_X - fightFish.x) * Math.min(1, dt * 0.004);
      fightFish.y += (baitY - fightFish.y) * Math.min(1, dt * 0.0015);

      if (spaceHeld) {
        fightStamina -= REEL_SPEED * dt;
        fightTension += TENSION_RISE * dt;
        // Pulling slowly raises bait toward boat.
        baitY -= 0.04 * dt;
        if (baitY < WATERLINE_Y + 20) baitY = WATERLINE_Y + 20;
      } else {
        fightStamina += RELAX_RECOVER * dt;
        if (fightStamina > fightFish.staminaMax) fightStamina = fightFish.staminaMax;
        fightTension -= TENSION_FALL * dt;
        if (fightTension < 0) fightTension = 0;
      }
      // Fish struggles periodically — sudden tension spike.
      fightNextStruggleMs -= dt;
      if (fightNextStruggleMs <= 0) {
        fightTension += STRUGGLE_BURST;
        fightNextStruggleMs = fightFish.struggleEvery * (0.7 + Math.random() * 0.6);
      }

      if (fightTension >= 100) {
        // Snap — line breaks.
        flashResult('Misina koptu!');
        fightFish.vx = 0.18 * (Math.random() < 0.5 ? -1 : 1);
        fightFish.alive = true; // swims away naturally
        fightFish = null;
        phase = 'idle';
        baitY = WATERLINE_Y + 50;
        staminaFill.style.width = '0%';
        tensionFill.style.width = '0%';
      } else if (fightStamina <= 0) {
        // Landed — score.
        score += fightFish.points;
        scoreEl.textContent = String(score);
        flashResult(`+${fightFish.points} puan!`);
        fightFish.alive = false;
        fightFish = null;
        phase = 'idle';
        baitY = WATERLINE_Y + 50;
        staminaFill.style.width = '0%';
        tensionFill.style.width = '0%';
      } else if (fightTimeMs >= FIGHT_TIMEOUT_MS) {
        // Fish tired you out — escapes.
        flashResult('Balık kurtuldu!');
        if (fightFish) {
          fightFish.vx = 0.15 * (Math.random() < 0.5 ? -1 : 1);
        }
        fightFish = null;
        phase = 'idle';
        baitY = WATERLINE_Y + 50;
        staminaFill.style.width = '0%';
        tensionFill.style.width = '0%';
      }

      if (fightFish) {
        const pct = Math.max(0, Math.min(1, fightStamina / fightFish.staminaMax));
        staminaFill.style.width = (pct * 100).toFixed(1) + '%';
        const tpct = Math.max(0, Math.min(1, fightTension / 100));
        tensionFill.style.width = (tpct * 100).toFixed(1) + '%';
        tensionFill.style.background =
          tpct > 0.8
            ? css('--olta-tension-hot', '#ff5252')
            : tpct > 0.5
              ? css('--olta-tension-warn', '#f5b54a')
              : css('--olta-tension-ok', '#5ee29a');
      }
    }
  }

  if (lastResultUntil > 0) {
    lastResultUntil -= dt;
    if (lastResultUntil <= 0) lastResultMsg = '';
  }
}

function flashResult(msg: string): void {
  lastResultMsg = msg;
  lastResultUntil = 1100;
}

function hookFish(): void {
  if (phase !== 'bite' || !biteFish) return;
  fightFish = biteFish;
  fightStamina = biteFish.staminaMax;
  fightTension = 25; // start with some initial tension so it feels alive
  fightTimeMs = 0;
  fightNextStruggleMs = biteFish.struggleEvery * 0.6;
  biteFish = null;
  phase = 'fight';
}

function draw(): void {
  // Sky.
  const skyGrad = ctx.createLinearGradient(0, 0, 0, WATERLINE_Y);
  skyGrad.addColorStop(0, css('--olta-sky-top', '#1a2238'));
  skyGrad.addColorStop(1, css('--olta-sky-bot', '#2d3a5a'));
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, WATERLINE_Y);

  // Water gradient (deeper = darker).
  const waterGrad = ctx.createLinearGradient(0, WATERLINE_Y, 0, H);
  waterGrad.addColorStop(0, css('--olta-water-top', '#2a5a82'));
  waterGrad.addColorStop(1, css('--olta-water-bot', '#0e2438'));
  ctx.fillStyle = waterGrad;
  ctx.fillRect(0, WATERLINE_Y, W, H - WATERLINE_Y);

  // Surface line with subtle wave.
  ctx.strokeStyle = css('--olta-surface-line', '#7ec3e8');
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  const t = performance.now() * 0.003;
  for (let x = 0; x <= W; x += 8) {
    const y = WATERLINE_Y + Math.sin(t + x * 0.04) * 2.5;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Depth zone markers — subtle horizontal lines.
  ctx.strokeStyle = css('--olta-zone-line', '#6a8fb0');
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1;
  for (const y of [WATERLINE_Y + 200, WATERLINE_Y + 380]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Boat — simple hull + cabin + rod.
  drawBoat();

  // Fish.
  for (const f of fishes) {
    if (!f.alive) continue;
    drawFish(f);
  }

  // Fishing line.
  ctx.strokeStyle = css('--olta-line', '#e8e8e8');
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(BOAT_X + 28, WATERLINE_Y - 18); // rod tip
  // Slight sag toward bait when fighting.
  const sag = phase === 'fight' ? Math.sin(performance.now() * 0.02) * 6 : 0;
  ctx.quadraticCurveTo(BOAT_X + 14 + sag, (WATERLINE_Y + baitY) / 2, BAIT_X, baitY);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Bait.
  ctx.fillStyle = phase === 'bite' ? css('--olta-bait-hot', '#ffe14a') : css('--olta-bait', '#e76a3c');
  ctx.beginPath();
  ctx.arc(BAIT_X, baitY, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Bite indicator — pulsing ring + "!".
  if (phase === 'bite') {
    const pulse = 1 + 0.4 * Math.sin(performance.now() * 0.02);
    ctx.strokeStyle = css('--olta-bait-hot', '#ffe14a');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(BAIT_X, baitY, 14 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('!', BAIT_X, baitY - 16);
    ctx.textAlign = 'left';
  }

  // Result flash text.
  if (lastResultUntil > 0 && lastResultMsg) {
    const alpha = Math.min(1, lastResultUntil / 600);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(lastResultMsg, W / 2, WATERLINE_Y + 50);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}

function drawBoat(): void {
  ctx.save();
  ctx.translate(BOAT_X, WATERLINE_Y);
  // Hull
  ctx.fillStyle = css('--olta-boat', '#6f3d1e');
  ctx.beginPath();
  ctx.moveTo(-44, 0);
  ctx.lineTo(44, 0);
  ctx.lineTo(34, 18);
  ctx.lineTo(-34, 18);
  ctx.closePath();
  ctx.fill();
  // Cabin
  ctx.fillStyle = css('--olta-boat-cabin', '#bfa46b');
  ctx.fillRect(-18, -16, 36, 16);
  // Rod (angled)
  ctx.strokeStyle = css('--olta-rod', '#222');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(8, -2);
  ctx.lineTo(28, -18);
  ctx.stroke();
  ctx.restore();
}

function drawFish(f: Fish): void {
  ctx.save();
  ctx.translate(f.x, f.y);
  if (f.kind === 'jelly') {
    // Bell + tentacles.
    ctx.fillStyle = f.color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(0, 0, f.size * 0.6, Math.PI, 2 * Math.PI);
    ctx.fill();
    ctx.beginPath();
    ctx.rect(-f.size * 0.6, 0, f.size * 1.2, f.size * 0.1);
    ctx.fill();
    ctx.strokeStyle = f.color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5;
    const wob = Math.sin(performance.now() * 0.008 + f.x) * 3;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 6, 2);
      ctx.quadraticCurveTo(i * 6 + wob, 12, i * 6 - wob, 22);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else {
    const dir = f.vx >= 0 ? 1 : -1;
    ctx.scale(dir, 1);
    ctx.fillStyle = f.color;
    // Body ellipse.
    ctx.beginPath();
    ctx.ellipse(0, 0, f.size, f.size * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tail.
    ctx.beginPath();
    ctx.moveTo(-f.size, 0);
    ctx.lineTo(-f.size - f.size * 0.6, -f.size * 0.5);
    ctx.lineTo(-f.size - f.size * 0.6, f.size * 0.5);
    ctx.closePath();
    ctx.fill();
    // Eye.
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(f.size * 0.55, -f.size * 0.15, f.size * 0.13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(f.size * 0.6, -f.size * 0.15, f.size * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.repeat && e.key !== ' ' && e.key !== 'Spacebar') {
    // allow repeat to keep space held; arrows track via keydown/up
  }
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') {
    upHeld = true;
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    downHeld = true;
    e.preventDefault();
  } else if (k === ' ' || k === 'spacebar' || k === 'enter') {
    if (state === 'ready') {
      startPlaying();
    } else if (state === 'gameover') {
      reset();
    } else if (state === 'playing') {
      if (phase === 'bite') {
        hookFish();
      }
      spaceHeld = true;
    }
    e.preventDefault();
  } else if (k === 'r') {
    reset();
    e.preventDefault();
  }
}

function handleKeyUp(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w') {
    upHeld = false;
    e.preventDefault();
  } else if (k === 'arrowdown' || k === 's') {
    downHeld = false;
    e.preventDefault();
  } else if (k === ' ' || k === 'spacebar') {
    spaceHeld = false;
    e.preventDefault();
  }
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  staminaFill = document.querySelector<HTMLElement>('#stamina-fill')!;
  tensionFill = document.querySelector<HTMLElement>('#tension-fill')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => {
    cancelAnimationFrame(rafHandle);
    reset();
  });

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  // Touch controls.
  document.querySelectorAll<HTMLButtonElement>('.touch__btn').forEach((btn) => {
    const act = btn.dataset.act;
    if (!act) return;
    btn.addEventListener('pointerdown', (e) => {
      if (act === 'up') upHeld = true;
      else if (act === 'down') downHeld = true;
      else if (act === 'hook') {
        if (state === 'ready') startPlaying();
        else if (state === 'gameover') reset();
        else if (state === 'playing') {
          if (phase === 'bite') hookFish();
          spaceHeld = true;
        }
      }
      e.preventDefault();
    });
    const release = (e: Event): void => {
      if (act === 'up') upHeld = false;
      else if (act === 'down') downHeld = false;
      else if (act === 'hook') spaceHeld = false;
      e.preventDefault();
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });

  overlayEl.addEventListener('click', () => {
    if (state === 'ready') startPlaying();
    else if (state === 'gameover') reset();
  });

  reset();
}

export const game = defineGame({ init, reset });
