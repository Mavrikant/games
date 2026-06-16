import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';

// Daktilo — type the falling Turkish letters one by one. Anti-typing-speed
// twist: pressing a key less than MIN_GAP_MS after the previous keystroke
// jams the typewriter; press Space to clear (1s time penalty). Wrong key:
// 0.5s penalty, no progress. Game lasts GAME_DURATION_MS; high score is
// total correct letters typed in that window.

const STORAGE_BEST = 'daktilo.best';
const MIN_GAP_MS = 100;
const GAME_DURATION_MS = 60_000;
const WRONG_PENALTY_MS = 500;
const JAM_PENALTY_MS = 1000;
const MALLET_SWING_MS = 180;

type State = 'ready' | 'playing' | 'jammed' | 'gameover';

const PHRASES = [
  'kedi',
  'çay',
  'elma',
  'kalem',
  'kitap',
  'masa',
  'pencere',
  'gemi',
  'yıldız',
  'bulut',
  'deniz',
  'koşu',
  'şehir',
  'köprü',
  'bahçe',
  'gözlük',
  'şemsiye',
  'orman',
  'ışık',
  'gümüş',
  'rüzgar',
  'simit',
  'lokum',
  'çiçek',
  'gönül',
  'yağmur',
  'kahve',
  'üzüm',
  'mum',
  'taş',
  'kale',
  'fener',
  'türkü',
  'müzik',
  'şarkı',
  'göl',
  'ada',
  'ayna',
  'kuş',
  'altın',
];

// Allowed printable letters (includes Turkish letters). All input lower-cased
// before comparison.
const LETTER_RE = /^[a-zçğıöşü]$/;

const gen = createGenToken();
let state: State = 'ready';
let score = 0;
let best = 0;
let phrase = '';
let typed = '';

// Time tracking.
let endTimeMs = 0;          // absolute timestamp the round ends
let remainingMs = GAME_DURATION_MS; // updated when paused (ready/jammed/gameover)
let lastKeyMs = -Infinity;  // timestamp of last accepted keystroke
let malletAt = -Infinity;   // timestamp of last mallet swing start (for animation)
let lastTypedChar = '';     // for mallet animation label
let mistakeFlashUntilMs = 0;
let jamFlashUntilMs = 0;

let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let timeEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

const READY_TITLE = 'Daktilo';
const READY_MSG =
  "Aşağıdaki harfleri sırayla yaz. İki tuş arasında 100 ms'den az boşluk olursa daktilo sıkışır — Boşluk'a basıp aç. Yanlış harf 0,5 sn, sıkışma 1 sn ceza. 60 saniyede kaç harf yazabilirsin?\n\nBaşlamak için bir harfe bas.";

function showOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function hideOverlay(): void {
  hideOverlayEl(overlay);
}

function pickPhrase(): string {
  // Avoid repeating the same phrase twice in a row.
  let next = PHRASES[Math.floor(Math.random() * PHRASES.length)]!;
  if (next === phrase && PHRASES.length > 1) {
    const idx = (PHRASES.indexOf(next) + 1) % PHRASES.length;
    next = PHRASES[idx]!;
  }
  return next;
}

function commitBest(): void {
  if (score > best) {
    best = score;
    safeWrite(STORAGE_BEST, best);
  }
}

function nowMs(): number {
  return performance.now();
}

function getRemainingMs(): number {
  if (state === 'playing') {
    return Math.max(0, endTimeMs - nowMs());
  }
  return remainingMs;
}

function updateHud(): void {
  const ms = getRemainingMs();
  timeEl.textContent = (ms / 1000).toFixed(1);
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
}

function reset(): void {
  const token = gen.bump();
  commitBest();
  state = 'ready';
  score = 0;
  phrase = pickPhrase();
  typed = '';
  remainingMs = GAME_DURATION_MS;
  endTimeMs = 0;
  lastKeyMs = -Infinity;
  malletAt = -Infinity;
  lastTypedChar = '';
  mistakeFlashUntilMs = 0;
  jamFlashUntilMs = 0;
  showOverlay(READY_TITLE, READY_MSG);
  updateHud();
  draw();
  requestAnimationFrame(() => loop(token));
}

function startPlaying(): void {
  state = 'playing';
  endTimeMs = nowMs() + remainingMs;
  hideOverlay();
}

function endGame(): void {
  // Capture remaining at moment of end so HUD freezes correctly.
  remainingMs = 0;
  state = 'gameover';
  commitBest();
  updateHud();
  showOverlay(
    'Süre doldu!',
    `${score} harf yazdın.\nRekor: ${best}\n\nYeniden başlamak için R tuşuna ya da düğmeye bas.`,
  );
  draw();
}

function applyPenalty(ms: number): void {
  if (state !== 'playing') return;
  endTimeMs -= ms;
  if (endTimeMs <= nowMs()) {
    endGame();
  }
}

function jam(): void {
  if (state !== 'playing') return;
  state = 'jammed';
  // Freeze remaining time at the moment of jam so penalty/clearing is exact.
  remainingMs = Math.max(0, endTimeMs - nowMs());
  jamFlashUntilMs = nowMs() + 600;
  showOverlay(
    'Sıkıştı!',
    "Daktilo tıkandı. Açmak için Boşluk'a bas (1 saniye ceza).",
  );
}

function unjam(): void {
  if (state !== 'jammed') return;
  // 1s penalty, then resume.
  remainingMs = Math.max(0, remainingMs - JAM_PENALTY_MS);
  state = 'playing';
  if (remainingMs <= 0) {
    endGame();
    return;
  }
  endTimeMs = nowMs() + remainingMs;
  // After unjam, accept the next keystroke without a gap-based jam.
  lastKeyMs = -Infinity;
  hideOverlay();
}

function handleLetter(ch: string): void {
  if (state === 'ready') {
    startPlaying();
    // First keystroke just starts the timer — do not consume a letter,
    // otherwise the dimmed paper behind the overlay tricks the player.
    lastKeyMs = nowMs();
    return;
  }
  if (state === 'gameover') return;
  if (state === 'jammed') {
    // Any letter while jammed is ignored visually but still counts toward
    // mistake flash, so the player can't mash through.
    mistakeFlashUntilMs = nowMs() + 220;
    return;
  }
  // state === 'playing'
  const now = nowMs();
  if (now - lastKeyMs < MIN_GAP_MS) {
    jam();
    return;
  }

  const target = phrase[typed.length];
  if (target === undefined) {
    // Defensive: shouldn't happen since completing a phrase loads a new one.
    return;
  }

  if (ch === target) {
    typed += ch;
    score += 1;
    lastKeyMs = now;
    malletAt = now;
    lastTypedChar = ch;
    if (typed === phrase) {
      phrase = pickPhrase();
      typed = '';
    }
  } else {
    // Wrong key: penalty, mistake flash, no progress, but DO update lastKeyMs
    // so a rapid wrong-then-right press still triggers the jam (or the player
    // realises they need to wait).
    lastKeyMs = now;
    mistakeFlashUntilMs = now + 280;
    applyPenalty(WRONG_PENALTY_MS);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  const key = e.key.toLowerCase();

  if (key === 'r') {
    e.preventDefault();
    reset();
    return;
  }

  if (key === ' ') {
    e.preventDefault();
    if (state === 'jammed') unjam();
    return;
  }

  if (key === 'enter') {
    e.preventDefault();
    if (state === 'gameover') reset();
    return;
  }

  if (LETTER_RE.test(key)) {
    e.preventDefault();
    handleLetter(key);
  }
}

// --- Drawing ----------------------------------------------------------------

const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  cssCache.set(varName, val);
  return val;
}

function drawPaper(now: number): void {
  const w = canvas.width;
  // Paper sheet at top.
  const paperX = 80;
  const paperY = 40;
  const paperW = w - 160;
  const paperH = 110;

  ctx.fillStyle = '#f4ead5';
  ctx.fillRect(paperX, paperY, paperW, paperH);
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(paperX + 0.5, paperY + 0.5, paperW - 1, paperH - 1);

  // Mistake flash: a thin red bar at top of paper.
  if (now < mistakeFlashUntilMs) {
    ctx.fillStyle = 'rgba(220, 40, 40, 0.35)';
    ctx.fillRect(paperX, paperY, paperW, 6);
  }

  // Current phrase: typed (dim) + remaining (bold dark), centered.
  ctx.font = 'bold 30px "Courier New", monospace';
  ctx.textBaseline = 'middle';

  const fullText = phrase;
  const measured = ctx.measureText(fullText);
  const textY = paperY + paperH / 2;
  let cursorX = paperX + (paperW - measured.width) / 2;

  for (let i = 0; i < fullText.length; i++) {
    const ch = fullText[i]!;
    if (i < typed.length) {
      ctx.fillStyle = '#6b6354';
    } else if (i === typed.length) {
      ctx.fillStyle = '#1a1a1a';
    } else {
      ctx.fillStyle = '#2a2a2a';
    }
    ctx.fillText(ch, cursorX, textY);
    const w2 = ctx.measureText(ch).width;
    if (i === typed.length) {
      // Cursor underscore under the next-letter target.
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(cursorX, textY + 18, w2, 3);
    }
    cursorX += w2;
  }
}

function drawTypewriter(now: number): void {
  const w = canvas.width;
  const h = canvas.height;

  // Body of typewriter.
  const bodyX = 40;
  const bodyY = 170;
  const bodyW = w - 80;
  const bodyH = h - 200;

  // Base.
  ctx.fillStyle = '#2a2620';
  ctx.beginPath();
  const r = 18;
  ctx.moveTo(bodyX + r, bodyY);
  ctx.lineTo(bodyX + bodyW - r, bodyY);
  ctx.quadraticCurveTo(bodyX + bodyW, bodyY, bodyX + bodyW, bodyY + r);
  ctx.lineTo(bodyX + bodyW, bodyY + bodyH - r);
  ctx.quadraticCurveTo(bodyX + bodyW, bodyY + bodyH, bodyX + bodyW - r, bodyY + bodyH);
  ctx.lineTo(bodyX + r, bodyY + bodyH);
  ctx.quadraticCurveTo(bodyX, bodyY + bodyH, bodyX, bodyY + bodyH - r);
  ctx.lineTo(bodyX, bodyY + r);
  ctx.quadraticCurveTo(bodyX, bodyY, bodyX + r, bodyY);
  ctx.closePath();
  ctx.fill();

  // Top highlight strip.
  ctx.fillStyle = '#3a342a';
  ctx.fillRect(bodyX + 12, bodyY + 10, bodyW - 24, 6);

  // Key rows.
  const keys = [
    'qwertyuıop',
    'asdfghjklş',
    'zxcvbnmöç ',
  ];
  const keyTop = bodyY + 30;
  const keySize = 28;
  const keyGap = 4;
  const totalRowW = (keys[0]!.length) * (keySize + keyGap) - keyGap;
  const rowOffsetX = (bodyW - totalRowW) / 2;
  for (let row = 0; row < keys.length; row++) {
    const cols = keys[row]!;
    for (let c = 0; c < cols.length; c++) {
      const ch = cols[c]!;
      const x = bodyX + rowOffsetX + c * (keySize + keyGap) + row * (keySize / 3);
      const y = keyTop + row * (keySize + keyGap);
      const isHighlight = lastTypedChar === ch && now - malletAt < 160;
      ctx.fillStyle = ch === ' ' ? '#1c1812' : isHighlight ? '#c7a96a' : '#1c1812';
      roundRect(ctx, x, y, keySize, keySize, 5);
      ctx.fill();
      if (ch !== ' ') {
        ctx.fillStyle = isHighlight ? '#1a1a1a' : '#d8cca8';
        ctx.font = 'bold 13px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ch.toUpperCase(), x + keySize / 2, y + keySize / 2 + 1);
        ctx.textAlign = 'start';
      }
    }
  }

  // Mallet (type bar) swing animation.
  const swingT = Math.min(1, Math.max(0, (now - malletAt) / MALLET_SWING_MS));
  if (now - malletAt < MALLET_SWING_MS) {
    // Mallet is a thin bar swinging up from the body toward the paper.
    const malletX = w / 2;
    const malletStartY = bodyY + 10;
    const malletEndY = 145;
    // Triangle wave: up fast, then down.
    const phase = swingT < 0.45 ? swingT / 0.45 : 1 - (swingT - 0.45) / 0.55;
    const y = malletStartY + (malletEndY - malletStartY) * phase;
    ctx.strokeStyle = '#c7a96a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(malletX, bodyY + 12);
    ctx.lineTo(malletX, y);
    ctx.stroke();
    // The "head" of the mallet.
    ctx.fillStyle = '#e6cf94';
    ctx.beginPath();
    ctx.arc(malletX, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Jam indicator (top right).
  const jammed = state === 'jammed';
  const jamFlash = now < jamFlashUntilMs;
  if (jammed || jamFlash) {
    ctx.fillStyle = jammed ? '#e23a3a' : 'rgba(226, 58, 58, 0.6)';
    ctx.beginPath();
    ctx.arc(w - 60, bodyY + 22, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'start';
    ctx.fillText('SIKIŞTI', w - 48, bodyY + 26);
  }

  // Cooldown bar: small bar near the bottom of the body showing min-gap status.
  if (state === 'playing') {
    const sinceLast = now - lastKeyMs;
    const ready = sinceLast >= MIN_GAP_MS;
    const barX = bodyX + 20;
    const barY = bodyY + bodyH - 18;
    const barW = bodyW - 40;
    const barH = 6;
    ctx.fillStyle = '#1c1812';
    ctx.fillRect(barX, barY, barW, barH);
    const fillW = Math.min(1, sinceLast / MIN_GAP_MS) * barW;
    ctx.fillStyle = ready ? '#5fb96b' : '#e89c3a';
    ctx.fillRect(barX, barY, fillW, barH);
  }
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function draw(): void {
  const now = nowMs();
  // Background.
  ctx.fillStyle = getCss('--surface') || '#15171b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawPaper(now);
  drawTypewriter(now);
}

// --- Loop -------------------------------------------------------------------

function loop(token: number): void {
  if (token !== gen.current()) return;
  // Time check.
  if (state === 'playing' && nowMs() >= endTimeMs) {
    endGame();
  }
  updateHud();
  draw();
  requestAnimationFrame(() => loop(token));
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  timeEl = document.querySelector<HTMLElement>('#time')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  window.addEventListener('keydown', onKeyDown);
  restartBtn.addEventListener('click', reset);

  // Tapping the overlay (or canvas) on a touch device acts like "press a key
  // to start" so the player on mobile isn't stuck without a keyboard. After
  // starting, taps do nothing further.
  const startOnTap = (e: Event): void => {
    if (state === 'ready') {
      // Synthesize the first letter of the phrase to start the round so a
      // mobile player isn't trapped without a keyboard. They'll still need
      // a keyboard to actually play — surface that via the overlay text.
      e.preventDefault();
      startPlaying();
    } else if (state === 'gameover') {
      e.preventDefault();
      reset();
    }
  };
  overlay.addEventListener('pointerdown', startOnTap);

  reset();
}

export const game = defineGame({ init, reset });
