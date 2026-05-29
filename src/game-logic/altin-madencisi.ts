import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Altın Madencisi — claw/grapple oyunu.
// PITFALLS notları:
// - module-level-dom-access: tüm DOM erişimi init() içinde, defineGame ile.
// - unguarded-storage: safeRead/safeWrite ile localStorage sarmalandı.
// - overlay-input-leak / unreachable-start-state: explicit state enum +
//   overlay'de gerçek bir "action" butonu (klavye fallback ile).
// - hud-counter-synced-only-at-lifecycle-edges: para değişince anında DOM'a yazılır.
// - single rAF loop, state flag'leri ile guard edilir (stale-async gerekmez).

const W = 480;
const H = 600;
const ORIGIN = { x: 240, y: 70 }; // çengel pivotu
const GROUND_Y = 120; // toprak yüzeyi
const MAX_ANGLE = 1.4; // pivottan ±~80°
const ANG_SPEED = 1.75; // rad/s salınım
const EXTEND_SPEED = 400; // px/s
const EMPTY_RETRACT = 760; // px/s
const MIN_LEN = 22; // çengelin dinlenme uzunluğu
const CLAW_R = 9;
const LEVEL_TIME = 60; // saniye
const STORAGE_BEST = 'altin-madencisi.bestLevel';

type Kind = 'goldS' | 'goldM' | 'goldL' | 'diamond' | 'rock' | 'bag';
type State = 'ready' | 'playing' | 'levelclear' | 'gameover';
type HookState = 'swing' | 'extend' | 'retract';

interface Spec {
  value: number;
  radius: number;
  pull: number; // taşınırken çekme hızı (px/s) — ağır = yavaş
  color: string;
}

const SPECS: Record<Kind, Spec> = {
  goldS: { value: 60, radius: 13, pull: 330, color: '#ffcf3f' },
  goldM: { value: 130, radius: 19, pull: 220, color: '#ffc107' },
  goldL: { value: 320, radius: 29, pull: 120, color: '#ffb300' },
  diamond: { value: 650, radius: 13, pull: 360, color: '#7fe7ff' },
  rock: { value: 12, radius: 23, pull: 105, color: '#7a7f88' },
  bag: { value: 0, radius: 15, pull: 250, color: '#b9893f' }, // değer rastgele
};

interface Obj {
  kind: Kind;
  x: number;
  y: number;
  r: number;
  value: number;
  grabbed: boolean;
}

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let moneyEl!: HTMLElement;
let goalEl!: HTMLElement;
let timeEl!: HTMLElement;
let levelEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let actionBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let launchBtn!: HTMLButtonElement;

let state: State = 'ready';
let hookState: HookState = 'swing';
let objs: Obj[] = [];
let grabbed: Obj | null = null;

let angle = 0; // 0 = düz aşağı; +sağ
let angleDir = 1;
let len = MIN_LEN;
let retractSpeed = EMPTY_RETRACT;

let level = 1;
let money = 0;
let goal = 0;
let timeLeft = LEVEL_TIME;
let best = 0;

let lastTs = 0;

function goalFor(lv: number): number {
  return 300 + (lv - 1) * 250;
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function tipPos(): { x: number; y: number } {
  return {
    x: ORIGIN.x + Math.sin(angle) * len,
    y: ORIGIN.y + Math.cos(angle) * len,
  };
}

function showOverlay(title: string, msg: string, btn: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  actionBtn.textContent = btn;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function setMoney(v: number): void {
  money = v;
  moneyEl.textContent = String(money);
}

// --- Seviye üretimi -------------------------------------------------------

function overlaps(x: number, y: number, r: number): boolean {
  for (const o of objs) {
    const dx = o.x - x;
    const dy = o.y - y;
    if (Math.hypot(dx, dy) < o.r + r + 8) return true;
  }
  return false;
}

function place(kind: Kind): void {
  const spec = SPECS[kind];
  const r = spec.radius;
  for (let i = 0; i < 50; i++) {
    const x = rand(r + 14, W - r - 14);
    const y = rand(GROUND_Y + r + 40, H - r - 14);
    if (!overlaps(x, y, r)) {
      const value = kind === 'bag' ? Math.round(rand(20, 600) / 10) * 10 : spec.value;
      objs.push({ kind, x, y, r, value, grabbed: false });
      return;
    }
  }
}

function totalValue(): number {
  return objs.reduce((s, o) => s + o.value, 0);
}

function buildLevel(): void {
  objs = [];
  grabbed = null;
  // Temel dağılım — seviye arttıkça daha fazla nesne.
  const golds = 4 + Math.min(level, 4);
  for (let i = 0; i < golds; i++) {
    const roll = Math.random();
    place(roll < 0.45 ? 'goldS' : roll < 0.8 ? 'goldM' : 'goldL');
  }
  const rocks = 2 + Math.floor(level / 2);
  for (let i = 0; i < rocks; i++) place('rock');
  // Elmas ve para torbası — yüksek değerli, nadir.
  const diamonds = level >= 2 ? 1 + Math.floor((level - 1) / 2) : Math.random() < 0.6 ? 1 : 0;
  for (let i = 0; i < diamonds; i++) place('diamond');
  if (Math.random() < 0.7) place('bag');

  // Hedefe ulaşmak mümkün olsun: toplam değer hedefin en az 1.4 katı.
  let guard = 0;
  while (totalValue() < goal * 1.4 && guard < 12) {
    place(Math.random() < 0.5 ? 'goldM' : 'goldL');
    guard++;
  }
}

// --- Akış / state ---------------------------------------------------------

function startLevel(): void {
  goal = goalFor(level);
  setMoney(0);
  timeLeft = LEVEL_TIME;
  angle = 0;
  angleDir = 1;
  len = MIN_LEN;
  hookState = 'swing';
  grabbed = null;
  buildLevel();
  goalEl.textContent = String(goal);
  levelEl.textContent = String(level);
  timeEl.textContent = String(LEVEL_TIME);
  state = 'playing';
  hideOverlay();
}

function reset(): void {
  level = 1;
  state = 'ready';
  hookState = 'swing';
  angle = 0;
  angleDir = 1;
  len = MIN_LEN;
  grabbed = null;
  objs = [];
  goal = goalFor(1);
  setMoney(0);
  timeLeft = LEVEL_TIME;
  goalEl.textContent = String(goal);
  levelEl.textContent = '1';
  timeEl.textContent = String(LEVEL_TIME);
  showOverlay(
    'Altın Madencisi',
    'Çengel sağa sola sallanır. Doğru anda fırlat, altını yakala!\nHedef paraya ulaş, sonraki seviyeye geç.',
    'Başla',
  );
  draw();
}

function onAction(): void {
  if (state === 'ready') {
    startLevel();
  } else if (state === 'levelclear') {
    level++;
    startLevel();
  } else if (state === 'gameover') {
    reset();
  }
}

function launchHook(): void {
  if (state !== 'playing' || hookState !== 'swing') return;
  hookState = 'extend';
}

function commitBest(): void {
  if (level > best) {
    best = level;
    safeWrite(STORAGE_BEST, best);
  }
}

function finishLevelOrGameOver(): void {
  if (money >= goal) {
    state = 'levelclear';
    commitBest();
    showOverlay(
      `Seviye ${level} tamam!`,
      `Topladığın para: ${money}\nHedef: ${goal}\nSonraki seviye hedefi: ${goalFor(level + 1)}`,
      'Sonraki seviye',
    );
  } else {
    state = 'gameover';
    commitBest();
    showOverlay(
      'Süre doldu!',
      `Seviye ${level} hedefine ulaşamadın.\nPara: ${money} / ${goal}\nEn iyi seviye: ${best}`,
      'Tekrar dene',
    );
  }
}

// --- Güncelleme -----------------------------------------------------------

function update(dt: number): void {
  if (state !== 'playing') return;

  // Süre
  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0;
    timeEl.textContent = '0';
    // Çengel boştayken süre bittiyse hemen sonuçlandır; iş yapıyorsa
    // mevcut çekimi bitirmesine izin ver (retract sonunda kontrol edilir).
    if (hookState === 'swing') {
      finishLevelOrGameOver();
      return;
    }
  } else {
    timeEl.textContent = String(Math.ceil(timeLeft));
  }

  if (hookState === 'swing') {
    angle += angleDir * ANG_SPEED * dt;
    if (angle > MAX_ANGLE) {
      angle = MAX_ANGLE;
      angleDir = -1;
    } else if (angle < -MAX_ANGLE) {
      angle = -MAX_ANGLE;
      angleDir = 1;
    }
    return;
  }

  if (hookState === 'extend') {
    len += EXTEND_SPEED * dt;
    const tip = tipPos();
    // Sınır kontrolü
    if (tip.x < CLAW_R || tip.x > W - CLAW_R || tip.y > H - CLAW_R || len > 720) {
      retractSpeed = EMPTY_RETRACT;
      hookState = 'retract';
      return;
    }
    // Çarpışma
    for (const o of objs) {
      if (o.grabbed) continue;
      if (Math.hypot(o.x - tip.x, o.y - tip.y) <= o.r + CLAW_R) {
        o.grabbed = true;
        grabbed = o;
        retractSpeed = SPECS[o.kind].pull;
        hookState = 'retract';
        return;
      }
    }
    return;
  }

  if (hookState === 'retract') {
    len -= retractSpeed * dt;
    if (grabbed) {
      const tip = tipPos();
      grabbed.x = tip.x;
      grabbed.y = tip.y;
    }
    if (len <= MIN_LEN) {
      len = MIN_LEN;
      if (grabbed) {
        setMoney(money + grabbed.value);
        objs = objs.filter((o) => o !== grabbed);
        grabbed = null;
      }
      hookState = 'swing';
      // Çekim bittikten sonra hedef/süre kontrolü
      if (money >= goal || timeLeft <= 0) {
        finishLevelOrGameOver();
      }
    }
  }
}

// --- Çizim ----------------------------------------------------------------

function draw(): void {
  // Gökyüzü
  ctx.fillStyle = '#1b2330';
  ctx.fillRect(0, 0, W, GROUND_Y);
  // Toprak
  const grd = ctx.createLinearGradient(0, GROUND_Y, 0, H);
  grd.addColorStop(0, '#5b3d24');
  grd.addColorStop(1, '#3a2616');
  ctx.fillStyle = grd;
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

  // Zemin çizgisi
  ctx.fillStyle = '#7a5230';
  ctx.fillRect(0, GROUND_Y - 4, W, 6);

  // Madenci platformu + pivot
  ctx.fillStyle = '#39414d';
  ctx.fillRect(ORIGIN.x - 34, GROUND_Y - 22, 68, 20);
  ctx.fillStyle = '#cdd3db';
  ctx.beginPath();
  ctx.arc(ORIGIN.x, GROUND_Y - 30, 11, 0, Math.PI * 2); // baş
  ctx.fill();
  ctx.fillStyle = '#e0b15a';
  ctx.fillRect(ORIGIN.x - 12, GROUND_Y - 26, 24, 6); // şapka kenarı

  // Nesneler
  for (const o of objs) drawObj(o);

  // Çengel ipi
  const tip = tipPos();
  ctx.strokeStyle = '#d8dee8';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(ORIGIN.x, ORIGIN.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();

  // Çengel ucu (V şeklinde kanca)
  drawClaw(tip.x, tip.y, angle);

  // Taşınan nesneyi en üste tekrar çiz
  if (grabbed) drawObj(grabbed);
}

function drawClaw(x: number, y: number, ang: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.strokeStyle = '#aeb6c2';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(0, 4);
  ctx.moveTo(0, 4);
  ctx.lineTo(-9, 13);
  ctx.moveTo(0, 4);
  ctx.lineTo(9, 13);
  ctx.stroke();
  ctx.restore();
}

function drawObj(o: Obj): void {
  const spec = SPECS[o.kind];
  if (o.kind === 'diamond') {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = spec.color;
    ctx.beginPath();
    ctx.moveTo(0, -o.r);
    ctx.lineTo(o.r, 0);
    ctx.lineTo(0, o.r);
    ctx.lineTo(-o.r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (o.kind === 'bag') {
    ctx.fillStyle = spec.color;
    ctx.beginPath();
    ctx.arc(o.x, o.y + 2, o.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6e4f24';
    ctx.fillRect(o.x - 5, o.y - o.r - 2, 10, 7); // boğaz
    ctx.fillStyle = '#ffd86b';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', o.x, o.y + 3);
    return;
  }
  // Altın ve kaya: daire + parıltı/gölge
  ctx.fillStyle = spec.color;
  ctx.beginPath();
  ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
  ctx.fill();
  if (o.kind === 'rock') {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.arc(o.x - o.r * 0.3, o.y - o.r * 0.25, o.r * 0.32, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(o.x - o.r * 0.32, o.y - o.r * 0.32, o.r * 0.25, 0, Math.PI * 2);
    ctx.fill();
  }
}

// --- Döngü ----------------------------------------------------------------

function loop(ts: number): void {
  const dt = lastTs === 0 ? 0 : Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  moneyEl = document.querySelector<HTMLElement>('#money')!;
  goalEl = document.querySelector<HTMLElement>('#goal')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  actionBtn = document.querySelector<HTMLButtonElement>('#action')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  launchBtn = document.querySelector<HTMLButtonElement>('#launch')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  actionBtn.addEventListener('click', onAction);
  restartBtn.addEventListener('click', reset);
  launchBtn.addEventListener('click', launchHook);
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'playing') launchHook();
    else onAction();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter' || k === 'arrowdown') {
      e.preventDefault();
      if (state === 'playing') launchHook();
      else onAction();
    } else if (k === 'r') {
      e.preventDefault();
      reset();
    }
  });

  reset();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
