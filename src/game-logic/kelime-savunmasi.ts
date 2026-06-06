import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay, hideOverlay } from '@shared/overlay';
import { reportGameOver } from '@shared/leaderboard';

// Typing-defense: Turkish words fall toward the city; type a word to lock
// onto it and finish typing it to destroy it before it lands.
//
// PITFALLS guarded here:
// - module-level-dom-access: all DOM/canvas/storage access lives in init().
// - unguarded-storage: best score via safeRead/safeWrite.
// - hud-counter-synced-only-at-lifecycle-edges: setScore/setLives write the
//   DOM at the moment the value changes, not only at start/end.
// - designed-lose-condition-not-wired: a word reaching the city costs a life;
//   0 lives -> game over (the intended failure is explicitly handled).
// - overlay-input-leak / unreachable-start-state: explicit state enum guards
//   every handler; Ready has an explicit Başla button + Enter to start.
// - stale-async-callback: a single rAF loop guarded by `state`; no setTimeout.

const STORAGE_BEST = 'kelime-savunmasi.best';
const SCORE_DESC = { gameId: 'kelime-savunmasi', storageKey: STORAGE_BEST, direction: 'higher' as const };

const WORDS = [
  'kale', 'kalkan', 'ışık', 'rüzgar', 'deniz', 'orman', 'yıldız', 'gezegen',
  'köprü', 'sokak', 'kelime', 'harf', 'zaman', 'gölge', 'şimşek', 'bulut',
  'yağmur', 'ateş', 'toprak', 'çelik', 'demir', 'altın', 'gümüş', 'kristal',
  'enerji', 'kalp', 'beyin', 'koşu', 'atla', 'savun', 'yaz', 'oku', 'düşün',
  'planla', 'hızlı', 'yavaş', 'kahve', 'ekmek', 'peynir', 'elma', 'kiraz',
  'üzüm', 'limon', 'portakal', 'masa', 'pencere', 'kapı', 'duvar', 'merdiven',
  'anahtar', 'kilit', 'saat', 'kalem', 'mektup', 'fener', 'gemi', 'uçak',
  'tren', 'bisiklet',
];

type State = 'ready' | 'playing' | 'gameover';

interface Word {
  text: string;
  typed: number;
  x: number;
  y: number;
  speed: number;
}

const W = 480;
const H = 600;
const BASE_H = 56;
const BASE_Y = H - BASE_H;
const FONT_PX = 22;

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
let typer!: HTMLInputElement;

let state: State = 'ready';
let score = 0;
let best = 0;
let lives = 3;
let words: Word[] = [];
let target: Word | null = null;
let spawnTimer = 0;
let flashBase = 0;
let lastTime = 0;

const cssCache = new Map<string, string>();
function css(name: string, fallback: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  let val = '';
  try {
    val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    val = '';
  }
  if (!val) val = fallback;
  cssCache.set(name, val);
  return val;
}

function setScore(): void {
  scoreEl.textContent = String(score);
}

function setLives(): void {
  livesEl.textContent = lives > 0 ? '♥'.repeat(lives) : '–';
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function spawnInterval(): number {
  return Math.max(0.7, 2.1 - score * 0.016);
}

function fallSpeed(): number {
  return Math.min(235, 46 + score * 0.85);
}

function spawnWord(): void {
  const text = WORDS[Math.floor(Math.random() * WORDS.length)]!;
  ctx.font = `600 ${FONT_PX}px Inter, system-ui, sans-serif`;
  const width = ctx.measureText(text).width;
  const maxX = Math.max(10, W - 12 - width);
  const x = 10 + Math.random() * Math.max(0, maxX - 10);
  const speed = fallSpeed() * (0.85 + Math.random() * 0.35);
  words.push({ text, typed: 0, x, y: -FONT_PX, speed });
}

function releaseTarget(): void {
  if (target) target.typed = 0;
  target = null;
}

function destroy(w: Word): void {
  score += w.text.length;
  setScore();
  words = words.filter((o) => o !== w);
  if (target === w) target = null;
}

const LETTER_RE = /^[a-zçğıöşü]$/;

function processChar(raw: string): void {
  if (state !== 'playing') return;
  const ch = raw.toLocaleLowerCase('tr-TR');
  if (!LETTER_RE.test(ch)) return;

  if (target) {
    const expected = target.text[target.typed];
    if (ch === expected) {
      target.typed += 1;
      if (target.typed >= target.text.length) destroy(target);
    }
    return;
  }

  // No active target: lock onto the lowest (most urgent) word that starts
  // with this character.
  let pick: Word | null = null;
  for (const w of words) {
    if (w.text[0] === ch && (pick === null || w.y > pick.y)) pick = w;
  }
  if (pick) {
    target = pick;
    target.typed = 1;
    if (target.text.length === 1) destroy(target);
  }
}

function startGame(): void {
  state = 'playing';
  score = 0;
  lives = 3;
  words = [];
  target = null;
  spawnTimer = 0;
  flashBase = 0;
  setScore();
  setLives();
  hideOverlay(overlay);
  spawnWord(); // immediate first feedback (PITFALLS#invisible-boot)
  words[0]!.y = 8;
  lastTime = performance.now();
  typer.value = '';
  typer.focus();
}

function showReady(): void {
  overlayTitle.textContent = 'Kelime Savunması';
  overlayMsg.innerHTML =
    'Düşen kelimeleri yazarak vur.<br />Başlamak için Başla’ya bas veya Enter.';
  startBtn.textContent = 'Başla';
  showOverlay(overlay);
}

function gameOver(): void {
  state = 'gameover';
  commitBest();
  reportGameOver(SCORE_DESC, score);
  target = null;
  overlayTitle.textContent = 'Şehir düştü';
  overlayMsg.innerHTML = `Skor: <b>${score}</b> &nbsp;·&nbsp; Rekor: <b>${best}</b><br />Tekrar denemek için Enter.`;
  startBtn.textContent = 'Tekrar oyna';
  showOverlay(overlay);
}

function reset(): void {
  commitBest();
  state = 'ready';
  score = 0;
  lives = 3;
  words = [];
  target = null;
  spawnTimer = 0;
  flashBase = 0;
  setScore();
  setLives();
  showReady();
}

function update(dt: number): void {
  spawnTimer += dt;
  if (spawnTimer >= spawnInterval()) {
    spawnTimer = 0;
    spawnWord();
  }

  const survivors: Word[] = [];
  let lost = 0;
  for (const w of words) {
    w.y += w.speed * dt;
    if (w.y >= BASE_Y) {
      lost += 1;
      if (target === w) target = null;
    } else {
      survivors.push(w);
    }
  }

  if (lost > 0) {
    words = survivors;
    lives -= lost;
    if (lives < 0) lives = 0;
    setLives();
    flashBase = 0.3;
    if (lives <= 0) {
      gameOver();
      return;
    }
  }

  if (flashBase > 0) flashBase = Math.max(0, flashBase - dt);
}

function drawWord(w: Word): void {
  const isTarget = w === target;
  ctx.font = `600 ${FONT_PX}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  const matched = w.text.slice(0, w.typed);
  const rest = w.text.slice(w.typed);
  const matchedW = ctx.measureText(matched).width;
  const totalW = ctx.measureText(w.text).width;

  if (isTarget) {
    const pad = 7;
    const x0 = w.x - pad;
    const y0 = w.y - FONT_PX / 2 - pad;
    const bw = totalW + pad * 2;
    const bh = FONT_PX + pad * 2;
    const r = 8;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + bw, y0, x0 + bw, y0 + bh, r);
    ctx.arcTo(x0 + bw, y0 + bh, x0, y0 + bh, r);
    ctx.arcTo(x0, y0 + bh, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + bw, y0, r);
    ctx.closePath();
    ctx.fillStyle = css('--accent-soft', 'rgba(129,140,248,0.14)');
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = css('--accent', '#818cf8');
    ctx.stroke();
  }

  const danger = w.y > BASE_Y - 90;
  ctx.fillStyle = css('--success', '#34d399');
  ctx.fillText(matched, w.x, w.y);
  ctx.fillStyle = isTarget
    ? css('--text', '#f5f6f8')
    : danger
      ? '#fb7185'
      : css('--text-muted', '#98a0ad');
  ctx.fillText(rest, w.x + matchedW, w.y);
}

function render(): void {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, css('--surface', '#14171c'));
  grad.addColorStop(1, css('--bg', '#0a0b0e'));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // City / danger zone.
  const flash = flashBase > 0 ? 0.18 + flashBase * 0.6 : 0.1;
  ctx.fillStyle = `rgba(251,113,133,${flash.toFixed(3)})`;
  ctx.fillRect(0, BASE_Y, W, BASE_H);
  ctx.strokeStyle = '#fb7185';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, BASE_Y);
  ctx.lineTo(W, BASE_Y);
  ctx.stroke();
  ctx.fillStyle = 'rgba(251,113,133,0.85)';
  ctx.font = `700 13px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ŞEHİR', W / 2, BASE_Y + BASE_H / 2);

  for (const w of words) drawWord(w);
}

function loop(now: number): void {
  if (state === 'playing') {
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.1) dt = 0.1; // clamp after tab-away
    update(dt);
  } else {
    lastTime = now;
  }
  render();
  requestAnimationFrame(loop);
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  livesEl = document.querySelector<HTMLElement>('#lives')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  startBtn = document.querySelector<HTMLButtonElement>('#start')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  typer = document.querySelector<HTMLInputElement>('#typer')!;

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);
  setLives();

  // Character entry: a single source (the hidden input's beforeinput) so a
  // keystroke is never counted twice. Works for both physical and soft
  // keyboards while the input is focused during play.
  typer.addEventListener('beforeinput', (e) => {
    const ev = e as InputEvent;
    if (ev.inputType === 'insertText' && ev.data) {
      for (const ch of ev.data) processChar(ch);
      ev.preventDefault();
    } else if (ev.inputType.startsWith('delete')) {
      releaseTarget();
      ev.preventDefault();
    }
  });
  // Safety net if a browser ignores beforeinput.preventDefault: keep it empty.
  typer.addEventListener('input', () => {
    typer.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (state !== 'playing') {
        startGame();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace') {
      releaseTarget();
      e.preventDefault();
      return;
    }
    if ((e.key === 'r' || e.key === 'R') && state !== 'playing') {
      reset();
      e.preventDefault();
      return;
    }
    // Keep the hidden input focused so letters reach beforeinput.
    if (state === 'playing' && document.activeElement !== typer) {
      typer.focus();
    }
  });

  // Mobile: tapping the field summons the keyboard / keeps focus.
  canvas.addEventListener('pointerdown', (e) => {
    if (state === 'playing') {
      typer.focus();
      e.preventDefault();
    }
  });

  startBtn.addEventListener('click', startGame);
  restartBtn.addEventListener('click', reset);

  showReady();
  requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
