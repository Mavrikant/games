import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite (try/catch built in).
// - stale-async-callback: gen.bump() on reset; rAF guards on token.
// - overlay-input-leak: state enum + input guards at top of handlers.
// - module-level: every DOM lookup is inside init().

const STORAGE_BEST = 'sismograf.best';
const DRAW_MS = 1800;
const RESPONSE_MS = 2200;
const REVEAL_MS = 950;
const NEXT_DELAY_MS = 380;
const SAMPLES = 480;

type Category = 'deprem' | 'patlama' | 'kamyon' | 'balina' | 'ruzgar';
type State = 'ready' | 'drawing' | 'waiting' | 'reveal' | 'gameover';

const CATEGORY_LIST: Category[] = ['deprem', 'patlama', 'kamyon', 'balina', 'ruzgar'];
const CATEGORY_LABEL: Record<Category, string> = {
  deprem: 'Deprem',
  patlama: 'Patlama',
  kamyon: 'Kamyon',
  balina: 'Balina',
  ruzgar: 'Rüzgar',
};
const KEY_TO_CATEGORY: Record<string, Category> = {
  '1': 'deprem',
  '2': 'patlama',
  '3': 'kamyon',
  '4': 'balina',
  '5': 'ruzgar',
};

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let lives = 3;
let streak = 0;
let round = 1;
let answered = 0;
let currentCat: Category | null = null;
let currentWave: Float32Array | null = null;
let waveStartTs = 0;
let drawMs = DRAW_MS;
let responseMs = RESPONSE_MS;
let revealEndsAt = 0;
let answerWindowEndsAt = 0;
let rafToken = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let livesEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let startBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let statusLine!: HTMLElement;
let choiceBtns: HTMLButtonElement[] = [];

const cssCache = new Map<string, string>();
function getCss(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const resolved = v.length > 0 ? v : fallback;
  cssCache.set(name, resolved);
  return resolved;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthesize(cat: Category): Float32Array {
  const wave = new Float32Array(SAMPLES);
  const rng = mulberry32((Math.random() * 1e9) | 0);
  const noiseAmp = 0.04;
  for (let i = 0; i < SAMPLES; i++) {
    wave[i] = (rng() - 0.5) * 2 * noiseAmp;
  }
  const t = (i: number) => i / SAMPLES;

  if (cat === 'deprem') {
    // P-wave: küçük yüksek-frekans burst @ 12% , S-wave: büyük geç gelen @ 30%, sustain ile
    const pStart = 0.1;
    const pEnd = 0.22;
    const sStart = 0.3;
    for (let i = 0; i < SAMPLES; i++) {
      const tt = t(i);
      if (tt >= pStart && tt <= pEnd) {
        const local = (tt - pStart) / (pEnd - pStart);
        const env = Math.sin(local * Math.PI);
        wave[i]! += env * 0.32 * Math.sin(tt * SAMPLES * 0.9 + i * 0.05);
      }
      if (tt >= sStart) {
        const local = tt - sStart;
        const env = Math.exp(-local * 2.4);
        wave[i]! += env * 0.78 * Math.sin(tt * 95 + Math.sin(tt * 8) * 1.4);
      }
    }
  } else if (cat === 'patlama') {
    // Tek keskin spike @ 22%; öncesi sessizlik, sonrası kısa decay
    const spikeAt = 0.22;
    for (let i = 0; i < SAMPLES; i++) {
      const tt = t(i);
      const d = tt - spikeAt;
      if (d >= 0 && d < 0.04) {
        const local = d / 0.04;
        wave[i]! += (1 - local) * (i % 2 === 0 ? 0.95 : -0.95);
      } else if (d >= 0.04 && d < 0.18) {
        const env = Math.exp(-(d - 0.04) * 14);
        wave[i]! += env * 0.45 * Math.sin(tt * 220);
      }
    }
  } else if (cat === 'kamyon') {
    // Sürekli düşük frekanslı rumble; envelope yumuşak in/out
    for (let i = 0; i < SAMPLES; i++) {
      const tt = t(i);
      const env = Math.sin(tt * Math.PI);
      const carrier = Math.sin(tt * 36) * 0.35 + Math.sin(tt * 17 + 0.8) * 0.22;
      const wobble = Math.sin(tt * 6.2) * 0.18;
      wave[i]! += env * (carrier + wobble);
    }
  } else if (cat === 'balina') {
    // Düşük frekans temiz sinüs + ikinci harmonik
    for (let i = 0; i < SAMPLES; i++) {
      const tt = t(i);
      const env = Math.sin(tt * Math.PI) ** 0.5;
      wave[i]! += env * 0.62 * Math.sin(tt * 9.5 + 0.4);
      wave[i]! += env * 0.18 * Math.sin(tt * 19 + 1.6);
    }
  } else {
    // Rüzgar: yoğun beyaz gürültü + yavaş envelope dalgalanması
    for (let i = 0; i < SAMPLES; i++) {
      const tt = t(i);
      const env = 0.45 + 0.35 * Math.sin(tt * 6.0 + 1.2);
      wave[i]! += (rng() - 0.5) * 2 * 0.7 * env;
    }
  }

  // Normalize to [-1, 1]
  let peak = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const a = Math.abs(wave[i]!);
    if (a > peak) peak = a;
  }
  if (peak > 1) {
    const inv = 1 / peak;
    for (let i = 0; i < SAMPLES; i++) wave[i]! *= inv;
  }
  return wave;
}

function pickCategory(): Category {
  return CATEGORY_LIST[Math.floor(Math.random() * CATEGORY_LIST.length)]!;
}

function showOverlay(title: string, msg: string, btnLabel: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  startBtn.textContent = btnLabel;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function updateHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  livesEl.textContent = String(lives);
}

function setChoicesEnabled(enabled: boolean): void {
  for (const b of choiceBtns) {
    b.disabled = !enabled;
    b.classList.remove('choice-flash-good', 'choice-flash-bad', 'choice-flash-correct');
  }
}

function flashChoice(cat: Category | null, correct: Category, picked: Category | null): void {
  for (const b of choiceBtns) {
    const c = b.dataset.cat as Category | undefined;
    if (!c) continue;
    if (c === correct) {
      b.classList.add(picked === correct ? 'choice-flash-good' : 'choice-flash-correct');
    } else if (c === picked) {
      b.classList.add('choice-flash-bad');
    }
  }
  void cat;
}

function setStatus(text: string, cls: '' | 'status-good' | 'status-bad'): void {
  statusLine.className = cls;
  statusLine.textContent = text;
}

function startGame(): void {
  gen.bump();
  state = 'drawing';
  score = 0;
  lives = 3;
  streak = 0;
  round = 1;
  answered = 0;
  drawMs = DRAW_MS;
  responseMs = RESPONSE_MS;
  updateHud();
  hideOverlay();
  spawnEvent();
}

function spawnEvent(): void {
  const myGen = gen.current();
  currentCat = pickCategory();
  currentWave = synthesize(currentCat);
  waveStartTs = performance.now();
  state = 'drawing';
  setChoicesEnabled(true);
  setStatus(`Tur ${round} · Sıra dalgası geliyor…`, '');
  rafToken++;
  const myRaf = rafToken;
  const loop = (): void => {
    if (!gen.isCurrent(myGen)) return;
    if (myRaf !== rafToken) return;
    if (state === 'gameover' || state === 'ready') return;
    const now = performance.now();
    if (state === 'drawing') {
      const elapsed = now - waveStartTs;
      const ratio = Math.min(1, elapsed / drawMs);
      drawWave(ratio);
      if (ratio >= 1) {
        state = 'waiting';
        answerWindowEndsAt = now + responseMs;
        setStatus('Sınıflandır! (1-5 ya da butonlar)', '');
      }
      requestAnimationFrame(loop);
    } else if (state === 'waiting') {
      drawWave(1);
      const remain = Math.max(0, answerWindowEndsAt - now);
      drawCountdown(remain / responseMs);
      if (remain <= 0) {
        // Cevap verilmedi — kaçırıldı
        handleAnswer(null);
      } else {
        requestAnimationFrame(loop);
      }
    } else if (state === 'reveal') {
      drawWave(1);
      drawLabel();
      if (now >= revealEndsAt) {
        // Sonraki olay
        if (lives <= 0) {
          endGame();
        } else {
          setTimeout(() => {
            if (!gen.isCurrent(myGen)) return;
            spawnEvent();
          }, NEXT_DELAY_MS);
        }
      } else {
        requestAnimationFrame(loop);
      }
    }
  };
  requestAnimationFrame(loop);
}

function drawWave(progress: number): void {
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;
  const ampPx = h * 0.42;
  const bg = '#0b1218';
  const grid = 'rgba(80, 140, 160, 0.18)';
  const accent = getCss('--accent', '#4dd0e1');
  const trail = 'rgba(77, 208, 225, 0.18)';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Izgara
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 48) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += 44) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();

  // Orta baseline
  ctx.strokeStyle = 'rgba(120, 160, 175, 0.35)';
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();

  if (!currentWave) return;
  const upto = Math.max(1, Math.floor(SAMPLES * progress));
  // Geçmiş gölge dolgusu
  ctx.fillStyle = trail;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let i = 0; i < upto; i++) {
    const x = (i / (SAMPLES - 1)) * w;
    const y = mid - currentWave[i]! * ampPx;
    ctx.lineTo(x, y);
  }
  const lastX = ((upto - 1) / (SAMPLES - 1)) * w;
  ctx.lineTo(lastX, mid);
  ctx.closePath();
  ctx.fill();

  // Çizgi
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < upto; i++) {
    const x = (i / (SAMPLES - 1)) * w;
    const y = mid - currentWave[i]! * ampPx;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Anlık nokta (yazıcı kafası)
  if (progress < 1) {
    const i = upto - 1;
    const x = (i / (SAMPLES - 1)) * w;
    const y = mid - currentWave[i]! * ampPx;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCountdown(ratio: number): void {
  const w = canvas.width;
  const h = canvas.height;
  const r = Math.max(0, Math.min(1, ratio));
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(0, h - 6, w, 6);
  const color = r < 0.35 ? '#ff7a7a' : r < 0.6 ? '#f0c674' : getCss('--accent', '#4dd0e1');
  ctx.fillStyle = color;
  ctx.fillRect(0, h - 6, w * r, 6);
}

function drawLabel(): void {
  if (!currentCat) return;
  const w = canvas.width;
  ctx.font = '600 14px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const label = CATEGORY_LABEL[currentCat];
  const text = `Doğru: ${label}`;
  const padX = 10;
  const padY = 6;
  const metrics = ctx.measureText(text);
  const boxW = metrics.width + padX * 2;
  const boxH = 14 + padY * 2;
  const x = (w - boxW) / 2;
  const y = 10;
  ctx.fillStyle = 'rgba(10, 20, 26, 0.85)';
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = getCss('--accent', '#4dd0e1');
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, boxW - 1, boxH - 1);
  ctx.fillStyle = '#e8f5f8';
  ctx.fillText(text, w / 2, y + padY);
}

function handleAnswer(picked: Category | null): void {
  if (state !== 'waiting') return;
  if (!currentCat) return;
  setChoicesEnabled(false);
  const correct = currentCat;
  const isCorrect = picked === correct;
  if (isCorrect) {
    streak++;
    const gained = 10 + Math.min(15, streak * 2);
    score += gained;
    setStatus(`Doğru! +${gained} (seri ${streak})`, 'status-good');
  } else {
    streak = 0;
    lives--;
    if (picked === null) {
      setStatus(`Geç kaldın — doğru: ${CATEGORY_LABEL[correct]}`, 'status-bad');
    } else {
      setStatus(`Yanlış — doğru: ${CATEGORY_LABEL[correct]}`, 'status-bad');
    }
  }
  flashChoice(currentCat, correct, picked);
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
  updateHud();
  answered++;
  // Her 5 olayda tur ilerle ve hızlan
  if (answered % 5 === 0) {
    round++;
    drawMs = Math.max(900, drawMs - 120);
    responseMs = Math.max(1200, responseMs - 150);
  }
  state = 'reveal';
  revealEndsAt = performance.now() + REVEAL_MS;
}

function endGame(): void {
  state = 'gameover';
  setChoicesEnabled(false);
  setStatus(`Oyun bitti — skor: ${score}`, 'status-bad');
  showOverlay(
    'Sismograf — Bitti',
    `Skor: ${score} · Rekor: ${best}\nDoğru sinyali ayırt etmek için tekrar dene.`,
    'Tekrar oyna',
  );
}

function reset(): void {
  gen.bump();
  rafToken++;
  state = 'ready';
  score = 0;
  lives = 3;
  streak = 0;
  round = 1;
  answered = 0;
  drawMs = DRAW_MS;
  responseMs = RESPONSE_MS;
  currentCat = null;
  currentWave = null;
  updateHud();
  setChoicesEnabled(false);
  setStatus('Başlamak için "Başla"ya bas.', '');
  drawWave(0);
  showOverlay(
    'Sismograf',
    'Beş tür sismik sinyali ayırt et: deprem, patlama, kamyon, balina, rüzgar. Dalgaya bak, doğru kategoriyi seç.',
    'Başla',
  );
}

function onPick(cat: Category): void {
  if (state !== 'waiting') return;
  handleAnswer(cat);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start-btn')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  statusLine = document.querySelector<HTMLElement>('#status-line')!;
  choiceBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.choice-btn'));

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => reset());
  startBtn.addEventListener('click', () => {
    if (state === 'ready' || state === 'gameover') startGame();
  });

  for (const b of choiceBtns) {
    b.addEventListener('click', () => {
      const c = b.dataset.cat as Category | undefined;
      if (c) onPick(c);
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      reset();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && (state === 'ready' || state === 'gameover')) {
      e.preventDefault();
      startGame();
      return;
    }
    const cat = KEY_TO_CATEGORY[e.key];
    if (cat) {
      e.preventDefault();
      onPick(cat);
    }
  });

  reset();
}

export const game = defineGame({ init, reset });
