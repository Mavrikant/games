// ---------------------------------------------------------------------------
// Adam Asmaca — Klasik Türkçe kelime tahmin oyunu.
// State machine: Playing | Won | Lost
//
// Pitfalls addressed:
//   - visual-vs-hitbox: Gallows segments use a single wrongCount counter; the
//     same wrongCount drives both draw and the 6-wrong lose condition.
//     On-screen keyboard buttons read their letter from data-letter; the
//     normalized comparison is done once via `toLocaleLowerCase('tr-TR')`.
//   - overlay-input-leak: Explicit `state` enum; guessLetter returns early
//     when state !== 'playing'. Keyboard keys (window keydown) also gate
//     on state. Overlay open => only "restart" path mutates state.
//   - stale-async-callback: No async/setTimeout needed for gameplay, but
//     a `gen` token guards any future-deferred work and ensures restart
//     during a hypothetical animation can't leak callbacks.
//   - invisible-boot: First render paints the empty gallows, hidden-word
//     underscores, and the full keyboard immediately on init — visible
//     feedback < 250 ms after page load.
//   - unguarded-storage: @shared/storage helpers; all DOM/localStorage
//     access happens inside init().
//   - duplicate-with-shared-layer: Body has no <h1>, no <p class="hint">;
//     title and controls come from JSON via GameLayout.
//   - Türkçe case: All compares run through tr(s) = s.toLocaleLowerCase('tr-TR').
//     'İ'→'i', 'I'→'ı'. Display uses upper case via toLocaleUpperCase('tr-TR').
// ---------------------------------------------------------------------------

import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { reportGameOver } from '@shared/leaderboard';

type State = 'playing' | 'won' | 'lost';

interface WordEntry {
  word: string;
  category: string;
}

const MAX_WRONG = 6;
const STORAGE_WINS = 'adam-asmaca.wins';
const STORAGE_LOSSES = 'adam-asmaca.losses';
const SCORE_DESC = { gameId: 'adam-asmaca', storageKey: STORAGE_WINS, direction: 'higher' as const };

// Türkçe alfabe — display order, no Q/W/X.
// 29 harf. Klavyede 8'li grid yapacağız (CSS responsive).
const TR_ALPHABET: readonly string[] = [
  'A',
  'B',
  'C',
  'Ç',
  'D',
  'E',
  'F',
  'G',
  'Ğ',
  'H',
  'I',
  'İ',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'Ö',
  'P',
  'R',
  'S',
  'Ş',
  'T',
  'U',
  'Ü',
  'V',
  'Y',
  'Z',
];

// Türkçe kelime listesi — kategoriye göre. Tüm kelimeler ilk halinde
// büyük harf yazıldı; karşılaştırma sırasında normalize edilir.
const WORDS: readonly WordEntry[] = [
  // Hayvan
  { word: 'KAPLAN', category: 'Hayvan' },
  { word: 'PENGUEN', category: 'Hayvan' },
  { word: 'KELEBEK', category: 'Hayvan' },
  { word: 'ZÜRAFA', category: 'Hayvan' },
  { word: 'AYI', category: 'Hayvan' },
  { word: 'KAPLUMBAĞA', category: 'Hayvan' },
  { word: 'KIRLANGIÇ', category: 'Hayvan' },
  { word: 'BAYKUŞ', category: 'Hayvan' },
  { word: 'TİLKİ', category: 'Hayvan' },
  { word: 'KEÇİ', category: 'Hayvan' },
  { word: 'BALIK', category: 'Hayvan' },
  { word: 'HOROZ', category: 'Hayvan' },
  // Meslek
  { word: 'ÖĞRETMEN', category: 'Meslek' },
  { word: 'DOKTOR', category: 'Meslek' },
  { word: 'MÜHENDİS', category: 'Meslek' },
  { word: 'AŞÇI', category: 'Meslek' },
  { word: 'POSTACI', category: 'Meslek' },
  { word: 'BAHÇIVAN', category: 'Meslek' },
  { word: 'TERZİ', category: 'Meslek' },
  { word: 'ÇİFTÇİ', category: 'Meslek' },
  { word: 'GAZETECİ', category: 'Meslek' },
  { word: 'PİLOT', category: 'Meslek' },
  { word: 'BERBER', category: 'Meslek' },
  { word: 'ECZACI', category: 'Meslek' },
  // Şehir
  { word: 'İSTANBUL', category: 'Şehir' },
  { word: 'ANKARA', category: 'Şehir' },
  { word: 'İZMİR', category: 'Şehir' },
  { word: 'BURSA', category: 'Şehir' },
  { word: 'TRABZON', category: 'Şehir' },
  { word: 'KONYA', category: 'Şehir' },
  { word: 'GAZİANTEP', category: 'Şehir' },
  { word: 'ESKİŞEHİR', category: 'Şehir' },
  { word: 'ÇANAKKALE', category: 'Şehir' },
  { word: 'KAYSERİ', category: 'Şehir' },
  { word: 'MUĞLA', category: 'Şehir' },
  { word: 'EDİRNE', category: 'Şehir' },
  // Yemek
  { word: 'KEBAP', category: 'Yemek' },
  { word: 'MANTI', category: 'Yemek' },
  { word: 'BAKLAVA', category: 'Yemek' },
  { word: 'LAHMACUN', category: 'Yemek' },
  { word: 'KÖFTE', category: 'Yemek' },
  { word: 'PİLAV', category: 'Yemek' },
  { word: 'BÖREK', category: 'Yemek' },
  { word: 'ÇORBA', category: 'Yemek' },
  { word: 'DOLMA', category: 'Yemek' },
  { word: 'MENEMEN', category: 'Yemek' },
  { word: 'SİMİT', category: 'Yemek' },
  { word: 'KUMPİR', category: 'Yemek' },
  // Eşya
  { word: 'BUZDOLABI', category: 'Eşya' },
  { word: 'ŞEMSİYE', category: 'Eşya' },
  { word: 'BİLGİSAYAR', category: 'Eşya' },
  { word: 'TELEFON', category: 'Eşya' },
  { word: 'ÇAYDANLIK', category: 'Eşya' },
  { word: 'ANAHTAR', category: 'Eşya' },
  { word: 'KİTAPLIK', category: 'Eşya' },
  { word: 'YASTIK', category: 'Eşya' },
  { word: 'PERDE', category: 'Eşya' },
  { word: 'GÖZLÜK', category: 'Eşya' },
  { word: 'KALEM', category: 'Eşya' },
  { word: 'MAKAS', category: 'Eşya' },
];

// ── DOM refs (filled in init) ──────────────────────────────────────────────
let gallows!: HTMLCanvasElement;
let gctx!: CanvasRenderingContext2D;
let winsEl!: HTMLElement;
let lossesEl!: HTMLElement;
let categoryEl!: HTMLElement;
let wordEl!: HTMLElement;
let wrongEl!: HTMLElement;
let keyboardEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;

// ── Türkçe normalize ───────────────────────────────────────────────────────
/** Türkçe-aware lower case. 'İ' → 'i', 'I' → 'ı', diacritics preserved. */
function tr(s: string): string {
  return s.toLocaleLowerCase('tr-TR');
}

// ── Game state ─────────────────────────────────────────────────────────────
let state: State = 'playing';
let currentWord = '';
let currentWordLower = '';
/** Normalized (tr-lower) set of guessed letters. */
const guessed = new Set<string>();
/** Letters guessed in display order (uppercase Türkçe). */
const guessedDisplay: string[] = [];
let wrongCount = 0;
let wins = 0;
let losses = 0;
const gen = createGenToken();

// ── Picking a word ─────────────────────────────────────────────────────────
let lastPickedIdx = -1;
function pickWord(): WordEntry {
  if (WORDS.length === 0) return { word: 'TÜRKÇE', category: 'Dil' };
  if (WORDS.length === 1) return WORDS[0]!;
  let idx = Math.floor(Math.random() * WORDS.length);
  // Avoid immediate repetition.
  if (idx === lastPickedIdx) {
    idx = (idx + 1) % WORDS.length;
  }
  lastPickedIdx = idx;
  return WORDS[idx]!;
}

// ── CSS var cache ──────────────────────────────────────────────────────────
const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  let val = '';
  try {
    val = getComputedStyle(document.documentElement)
      .getPropertyValue(varName)
      .trim();
  } catch {
    val = '';
  }
  cssCache.set(varName, val);
  return val;
}

// ── Draw gallows ───────────────────────────────────────────────────────────
// Hard-coded geometry. wrongCount of 1..6 each adds one stage.
// All sizes derived from the canvas dimensions so visual = state.
function drawGallows(): void {
  const W = gallows.width;
  const H = gallows.height;
  gctx.clearRect(0, 0, W, H);

  // Background
  gctx.fillStyle = getCss('--surface-2') || '#1c2027';
  gctx.fillRect(0, 0, W, H);

  // Frame baseline (always drawn): floor + post + beam + rope
  const stroke = getCss('--text-muted') || '#98a0ad';
  gctx.strokeStyle = stroke;
  gctx.lineWidth = 4;
  gctx.lineCap = 'round';

  // Floor
  gctx.beginPath();
  gctx.moveTo(20, H - 20);
  gctx.lineTo(W - 20, H - 20);
  gctx.stroke();

  // Vertical post (left)
  gctx.beginPath();
  gctx.moveTo(60, H - 20);
  gctx.lineTo(60, 30);
  gctx.stroke();

  // Top beam
  gctx.beginPath();
  gctx.moveTo(58, 30);
  gctx.lineTo(170, 30);
  gctx.stroke();

  // Rope
  const ropeColor = getCss('--aa-rope') || '#d4a76a';
  gctx.strokeStyle = ropeColor;
  gctx.beginPath();
  gctx.moveTo(170, 30);
  gctx.lineTo(170, 65);
  gctx.stroke();

  // Diagonal brace
  gctx.strokeStyle = stroke;
  gctx.beginPath();
  gctx.moveTo(60, 60);
  gctx.lineTo(95, 30);
  gctx.stroke();

  // Body parts: drawn in order, count up to wrongCount.
  const body = getCss('--aa-body') || '#f5f6f8';
  gctx.strokeStyle = body;
  gctx.fillStyle = body;
  gctx.lineWidth = 3;

  // 1: head
  if (wrongCount >= 1) {
    gctx.beginPath();
    gctx.arc(170, 85, 20, 0, Math.PI * 2);
    gctx.stroke();
  }
  // 2: torso
  if (wrongCount >= 2) {
    gctx.beginPath();
    gctx.moveTo(170, 105);
    gctx.lineTo(170, 165);
    gctx.stroke();
  }
  // 3: left arm
  if (wrongCount >= 3) {
    gctx.beginPath();
    gctx.moveTo(170, 120);
    gctx.lineTo(145, 145);
    gctx.stroke();
  }
  // 4: right arm
  if (wrongCount >= 4) {
    gctx.beginPath();
    gctx.moveTo(170, 120);
    gctx.lineTo(195, 145);
    gctx.stroke();
  }
  // 5: left leg
  if (wrongCount >= 5) {
    gctx.beginPath();
    gctx.moveTo(170, 165);
    gctx.lineTo(150, 200);
    gctx.stroke();
  }
  // 6: right leg + sad face
  if (wrongCount >= 6) {
    gctx.beginPath();
    gctx.moveTo(170, 165);
    gctx.lineTo(190, 200);
    gctx.stroke();
    // Sad face (eyes + mouth)
    gctx.fillStyle = body;
    gctx.beginPath();
    gctx.arc(163, 82, 1.8, 0, Math.PI * 2);
    gctx.fill();
    gctx.beginPath();
    gctx.arc(177, 82, 1.8, 0, Math.PI * 2);
    gctx.fill();
    gctx.beginPath();
    gctx.arc(170, 95, 5, Math.PI, 0, false);
    gctx.stroke();
  }
}

// ── Render hidden word ─────────────────────────────────────────────────────
function renderWord(): void {
  // Reveal a letter if its normalized form is in guessed set; otherwise
  // show underscore. Space → invisible gap.
  const out = document.createDocumentFragment();
  const finished = state !== 'playing';
  for (const ch of currentWord) {
    if (ch === ' ') {
      const span = document.createElement('span');
      span.className = 'aa-letter aa-letter--space';
      span.setAttribute('aria-hidden', 'true');
      out.appendChild(span);
      continue;
    }
    const lower = tr(ch);
    const revealed = guessed.has(lower) || (finished && state === 'lost');
    const span = document.createElement('span');
    span.className = revealed
      ? 'aa-letter aa-letter--revealed'
      : 'aa-letter';
    span.textContent = revealed ? ch : ' ';
    out.appendChild(span);
  }
  wordEl.textContent = '';
  wordEl.appendChild(out);
}

// ── Render wrong-letter strip ──────────────────────────────────────────────
function renderWrong(): void {
  const wrongLetters: string[] = [];
  for (const display of guessedDisplay) {
    const lower = tr(display);
    if (!currentWordLower.includes(lower)) {
      wrongLetters.push(display);
    }
  }
  if (wrongLetters.length === 0) {
    wrongEl.textContent = 'Yanlış: —';
    return;
  }
  wrongEl.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = `Yanlış (${wrongLetters.length}/${MAX_WRONG}): `;
  wrongEl.appendChild(label);
  for (const letter of wrongLetters) {
    const span = document.createElement('span');
    span.className = 'aa-wrong-letter';
    span.textContent = letter;
    wrongEl.appendChild(span);
  }
}

// ── Build keyboard ─────────────────────────────────────────────────────────
function buildKeyboard(): void {
  keyboardEl.innerHTML = '';
  for (const letter of TR_ALPHABET) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aa-key';
    btn.textContent = letter;
    btn.dataset.letter = letter;
    btn.setAttribute('aria-label', `Harf ${letter}`);
    btn.addEventListener('click', () => guessLetter(letter));
    keyboardEl.appendChild(btn);
  }
}

function updateKeyboardState(): void {
  const finished = state !== 'playing';
  for (const btn of Array.from(
    keyboardEl.querySelectorAll<HTMLButtonElement>('.aa-key'),
  )) {
    const letter = btn.dataset.letter ?? '';
    const lower = tr(letter);
    const isGuessed = guessed.has(lower);
    btn.disabled = isGuessed || finished;
    btn.classList.remove('aa-key--correct', 'aa-key--wrong');
    if (isGuessed) {
      if (currentWordLower.includes(lower)) {
        btn.classList.add('aa-key--correct');
      } else {
        btn.classList.add('aa-key--wrong');
      }
    }
  }
}

// ── Overlay (per-game class, keeps aa-overlay-- prefix; CSS unchanged) ─────
function showOverlay(title: string, msgHtml: string): void {
  overlayTitle.textContent = title;
  overlayMsg.innerHTML = msgHtml;
  overlay.classList.remove('aa-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'false');
}

function hideOverlay(): void {
  overlay.classList.add('aa-overlay--hidden');
  overlay.setAttribute('aria-hidden', 'true');
}

// ── HUD ────────────────────────────────────────────────────────────────────
function renderHud(): void {
  winsEl.textContent = String(wins);
  lossesEl.textContent = String(losses);
}

// ── Guess flow ─────────────────────────────────────────────────────────────
/**
 * Try to register a letter guess. Caller can pass any Latin or Türkçe
 * character; this function normalizes and maps it back to the on-screen
 * letter. Returns true if the letter was a brand-new guess.
 */
function guessLetter(rawLetter: string): boolean {
  if (state !== 'playing') return false;
  if (!rawLetter || rawLetter.length === 0) return false;

  // Only single-character letters. Allow any Türkçe alphabet letter.
  const lower = tr(rawLetter);
  // Find matching alphabet display letter.
  let display = '';
  for (const a of TR_ALPHABET) {
    if (tr(a) === lower) {
      display = a;
      break;
    }
  }
  if (!display) return false; // Not a Türkçe alphabet letter

  if (guessed.has(lower)) return false; // Already guessed: no-op
  guessed.add(lower);
  guessedDisplay.push(display);

  const isCorrect = currentWordLower.includes(lower);
  if (!isCorrect) {
    wrongCount++;
  }

  // Update visuals first (so first feedback is immediate).
  renderWord();
  renderWrong();
  updateKeyboardState();
  drawGallows();

  // Check terminal conditions
  if (isCorrect && isWordComplete()) {
    state = 'won';
    wins++;
    safeWrite(STORAGE_WINS, wins);
    renderHud();
    updateKeyboardState();
    reportGameOver(SCORE_DESC, wins, { label: 'Galibiyet' });
    showOverlay(
      'Kazandın!',
      `Kelime: <b>${escapeHtml(currentWord)}</b><br />R ile yeni kelime.`,
    );
  } else if (!isCorrect && wrongCount >= MAX_WRONG) {
    state = 'lost';
    losses++;
    safeWrite(STORAGE_LOSSES, losses);
    // Reveal the word on lose-render.
    renderWord();
    renderHud();
    updateKeyboardState();
    showOverlay(
      'Kaybettin',
      `Kelime: <b>${escapeHtml(currentWord)}</b><br />R ile yeni kelime.`,
    );
  }

  return true;
}

function isWordComplete(): boolean {
  for (const ch of currentWord) {
    if (ch === ' ') continue;
    if (!guessed.has(tr(ch))) return false;
  }
  return true;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
function newRound(): void {
  // Bump generation token (defensive — no async right now, but future-proof).
  gen.bump();
  const entry = pickWord();
  currentWord = entry.word;
  currentWordLower = tr(entry.word);
  guessed.clear();
  guessedDisplay.length = 0;
  wrongCount = 0;
  state = 'playing';

  categoryEl.textContent = `Kategori: ${entry.category}`;
  renderWord();
  renderWrong();
  drawGallows();
  updateKeyboardState();
  hideOverlay();
}

function loadStats(): void {
  wins = safeRead<number>(STORAGE_WINS, 0);
  losses = safeRead<number>(STORAGE_LOSSES, 0);
  // Guard against corrupt JSON entries (number or non-finite).
  if (!Number.isFinite(wins) || wins < 0) wins = 0;
  if (!Number.isFinite(losses) || losses < 0) losses = 0;
  renderHud();
}

// ── Init ───────────────────────────────────────────────────────────────────
function init(): void {
  gallows = document.querySelector<HTMLCanvasElement>('#gallows')!;
  gctx = gallows.getContext('2d')!;
  winsEl = document.querySelector<HTMLElement>('#wins')!;
  lossesEl = document.querySelector<HTMLElement>('#losses')!;
  categoryEl = document.querySelector<HTMLElement>('#category')!;
  wordEl = document.querySelector<HTMLElement>('#word')!;
  wrongEl = document.querySelector<HTMLElement>('#wrong')!;
  keyboardEl = document.querySelector<HTMLElement>('#keyboard')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  window.addEventListener('keydown', (e) => {
    const key = e.key;

    // R: always restart (even from overlay).
    if (key && tr(key) === 'r') {
      e.preventDefault();
      newRound();
      return;
    }

    // Enter / Space on overlay restarts.
    if (state !== 'playing' && (key === 'Enter' || key === ' ')) {
      e.preventDefault();
      newRound();
      return;
    }

    // Only single-char keys are candidate letters (filters Tab/Esc/Arrow).
    if (!key || key.length !== 1) return;

    // Ignore modified shortcuts (Cmd+R, Ctrl+T, ...).
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Only respond to letters while playing.
    if (state !== 'playing') return;

    guessLetter(key);
  });

  restartBtn.addEventListener('click', () => {
    newRound();
  });

  overlayBtn.addEventListener('click', () => {
    newRound();
  });

  buildKeyboard();
  loadStats();
  newRound();
}

export const game = defineGame({ init, reset: newRound });
