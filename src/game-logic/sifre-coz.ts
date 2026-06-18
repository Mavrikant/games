import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// PITFALLS guarded:
// - unguarded-storage: safeRead/safeWrite.
// - stale-async-callback: gen.bump() in reset() invalidates timer ticks.
// - overlay-input-leak: state enum ('playing'|'won') guards every handler.
// - module-level side effects: only inside init().

const STORAGE_BEST = 'sifre-coz.best';

const ALPHABET = [
  'A','B','C','Ç','D','E','F','G','Ğ','H','I','İ','J','K','L','M',
  'N','O','Ö','P','R','S','Ş','T','U','Ü','V','Y','Z',
];

// Short, well-known Turkish atasözleri. Picked to fit in 1–3 lines on phones
// (≤40 chars) so the puzzle stays solvable in a couple of minutes.
const QUOTES: ReadonlyArray<string> = [
  'NEREDE BİRLİK ORADA DİRLİK',
  'DAMLAYA DAMLAYA GÖL OLUR',
  'KOMŞU KOMŞUNUN KÜLÜNE MUHTAÇTIR',
  'SAKLA SAMANI GELİR ZAMANI',
  'ŞEYTAN AYRINTIDA GİZLİDİR',
  'ACELE İŞE ŞEYTAN KARIŞIR',
  'GÖRÜNEN KÖY KILAVUZ İSTEMEZ',
  'SU TESTİSİ SU YOLUNDA KIRILIR',
  'MUM DİBİNE IŞIK VERMEZ',
  'GÜLÜ SEVEN DİKENİNE KATLANIR',
  'BİR ELİN NESİ VAR İKİ ELİN SESİ VAR',
  'TATLI DİL YILANI DELİKTEN ÇIKARIR',
  'BAL TUTAN PARMAĞINI YALAR',
  'GÜLME KOMŞUNA GELİR BAŞINA',
  'ZAMAN SANA UYMAZSA SEN ZAMANA UY',
  'EMEK OLMADAN YEMEK OLMAZ',
  'AĞACIN KURDU İÇİNDEN OLUR',
  'TAŞ YERİNDE AĞIRDIR',
  'KÖPEK ÜRÜR KERVAN YÜRÜR',
  'BOŞ ÇUVAL AYAKTA DURMAZ',
];

type State = 'playing' | 'won';

interface Cell {
  ch: string;
  isLetter: boolean;
}

const gen = createGenToken();

let state: State = 'playing';
let plaintext = '';
let cells: Cell[] = [];
let encryptMap: Record<string, string> = {};
let decryptMap: Record<string, string> = {};
let guess: Record<string, string> = {};
let selected: string | null = null;
let hintsUsed = 0;
let startMs = 0;
let elapsedSec = 0;
let bestSec = 0;
let tickToken: ReturnType<typeof setInterval> | null = null;

let timeEl!: HTMLElement;
let hintsEl!: HTMLElement;
let bestEl!: HTMLElement;
let hintBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let cipherEl!: HTMLElement;
let padEl!: HTMLElement;
let clearBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayText!: HTMLElement;
let overlayBtn!: HTMLButtonElement;

function isLetter(ch: string): boolean {
  return ALPHABET.includes(ch);
}

function shuffled<T>(arr: readonly T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

function buildSubstitutionWithoutFixedPoints(): Record<string, string> {
  // Derangement-ish: shuffle until no plain[i] === cipher[i].
  // Cheap rejection sampling — 29 letters converges in a few tries.
  for (let attempt = 0; attempt < 200; attempt++) {
    const perm = shuffled(ALPHABET);
    let ok = true;
    for (let i = 0; i < ALPHABET.length; i++) {
      if (perm[i] === ALPHABET[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const map: Record<string, string> = {};
      for (let i = 0; i < ALPHABET.length; i++) {
        map[ALPHABET[i]!] = perm[i]!;
      }
      return map;
    }
  }
  // Fallback: rotate by 1 (guaranteed no fixed points).
  const map: Record<string, string> = {};
  for (let i = 0; i < ALPHABET.length; i++) {
    map[ALPHABET[i]!] = ALPHABET[(i + 1) % ALPHABET.length]!;
  }
  return map;
}

function pickQuote(): string {
  const last = safeRead<string>('sifre-coz.last', '');
  let q = QUOTES[Math.floor(Math.random() * QUOTES.length)]!;
  // Avoid back-to-back repeat.
  if (q === last && QUOTES.length > 1) {
    q = QUOTES[(QUOTES.indexOf(q) + 1) % QUOTES.length]!;
  }
  safeWrite('sifre-coz.last', q);
  return q;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderHud(): void {
  timeEl.textContent = formatTime(elapsedSec);
  hintsEl.textContent = String(hintsUsed);
  bestEl.textContent = bestSec > 0 ? formatTime(bestSec) : '—';
}

function tick(): void {
  if (state !== 'playing') return;
  elapsedSec = Math.floor((Date.now() - startMs) / 1000);
  timeEl.textContent = formatTime(elapsedSec);
}

function renderCipher(): void {
  cipherEl.innerHTML = '';
  let word = document.createElement('span');
  word.className = 'cipher__word';
  for (const cell of cells) {
    if (!cell.isLetter) {
      if (cell.ch === ' ') {
        cipherEl.appendChild(word);
        word = document.createElement('span');
        word.className = 'cipher__word';
        continue;
      }
      const punct = document.createElement('span');
      punct.className = 'cipher__punct';
      punct.textContent = cell.ch;
      word.appendChild(punct);
      continue;
    }
    const cipherChar = encryptMap[cell.ch]!;
    const guessed = guess[cipherChar] ?? '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cipher__cell';
    btn.dataset['cipher'] = cipherChar;
    if (cipherChar === selected) btn.classList.add('cipher__cell--selected');
    if (guessed) btn.classList.add('cipher__cell--filled');

    const top = document.createElement('span');
    top.className = 'cipher__guess';
    top.textContent = guessed || '·';

    const bottom = document.createElement('span');
    bottom.className = 'cipher__code';
    bottom.textContent = cipherChar;

    btn.appendChild(top);
    btn.appendChild(bottom);
    btn.setAttribute('aria-label', `${cipherChar} şifreli harf`);
    word.appendChild(btn);
  }
  cipherEl.appendChild(word);
}

function renderPad(): void {
  // Build pad once; on subsequent calls only refresh states. We always rebuild
  // because letter usage changes on every guess and the list is short (29).
  padEl.innerHTML = '';
  const used = new Set(Object.values(guess).filter(Boolean));
  for (const letter of ALPHABET) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pad__key';
    btn.dataset['plain'] = letter;
    btn.textContent = letter;
    btn.setAttribute('aria-label', `${letter} harfini ata`);
    if (used.has(letter)) btn.classList.add('pad__key--used');
    if (selected === null) btn.disabled = true;
    padEl.appendChild(btn);
  }
}

function clearStaleGuessFor(plain: string): void {
  for (const [cipher, val] of Object.entries(guess)) {
    if (val === plain) delete guess[cipher];
  }
}

function assignGuess(plain: string): void {
  if (state !== 'playing' || selected === null) return;
  // If user clicks the same plain letter again, treat as un-assign.
  if (guess[selected] === plain) {
    delete guess[selected];
  } else {
    clearStaleGuessFor(plain);
    guess[selected] = plain;
  }
  afterMutation();
}

function afterMutation(): void {
  renderCipher();
  renderPad();
  checkWin();
}

function checkWin(): void {
  if (state !== 'playing') return;
  const uniqueCipherLetters = new Set<string>();
  for (const cell of cells) {
    if (cell.isLetter) uniqueCipherLetters.add(encryptMap[cell.ch]!);
  }
  for (const cipher of uniqueCipherLetters) {
    if (guess[cipher] !== decryptMap[cipher]) return;
  }
  winGame();
}

function winGame(): void {
  state = 'won';
  if (tickToken !== null) {
    clearInterval(tickToken);
    tickToken = null;
  }
  // Persist best (lower is better; hints count as +10 s penalty each).
  const score = elapsedSec + hintsUsed * 10;
  if (bestSec === 0 || score < bestSec) {
    bestSec = score;
    safeWrite(STORAGE_BEST, bestSec);
  }
  renderHud();
  overlayTitle.textContent = 'Şifre çözüldü!';
  overlayText.textContent =
    `${plaintext}\n\n` +
    `Süre ${formatTime(elapsedSec)} · İpucu ${hintsUsed} · ` +
    `Skor ${formatTime(score)}`;
  showOverlay(overlayEl);
}

function revealHint(): void {
  if (state !== 'playing') return;
  // Pick an unfilled or wrongly-filled cipher letter present in the quote.
  const candidates: string[] = [];
  const present = new Set<string>();
  for (const cell of cells) {
    if (cell.isLetter) present.add(encryptMap[cell.ch]!);
  }
  for (const cipher of present) {
    if (guess[cipher] !== decryptMap[cipher]) candidates.push(cipher);
  }
  if (candidates.length === 0) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
  const correct = decryptMap[pick]!;
  clearStaleGuessFor(correct);
  guess[pick] = correct;
  hintsUsed++;
  selected = pick;
  renderHud();
  afterMutation();
}

function onCipherClick(e: Event): void {
  if (state !== 'playing') return;
  const target = e.target as HTMLElement;
  const btn = target.closest('.cipher__cell') as HTMLElement | null;
  if (!btn) return;
  const c = btn.dataset['cipher'];
  if (!c) return;
  selected = selected === c ? null : c;
  renderCipher();
  renderPad();
}

function onPadClick(e: Event): void {
  if (state !== 'playing') return;
  const target = e.target as HTMLElement;
  const btn = target.closest('.pad__key') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  const p = btn.dataset['plain'];
  if (!p) return;
  assignGuess(p);
}

function clearSelection(): void {
  if (state !== 'playing') return;
  if (selected !== null && guess[selected]) delete guess[selected];
  selected = null;
  afterMutation();
}

function onKey(e: KeyboardEvent): void {
  const k = e.key;
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    reset();
    return;
  }
  if (k === 'i' || k === 'I') {
    e.preventDefault();
    revealHint();
    return;
  }
  if (state !== 'playing') return;
  if (k === 'Escape') {
    selected = null;
    renderCipher();
    renderPad();
    return;
  }
  if (k === 'Backspace' || k === 'Delete') {
    if (selected !== null && guess[selected]) {
      delete guess[selected];
      afterMutation();
    }
    return;
  }
  // Single-character physical-key entry (a-z + Turkish where the OS supports).
  if (k.length === 1 && selected !== null) {
    const up = k.toLocaleUpperCase('tr-TR');
    if (ALPHABET.includes(up)) {
      e.preventDefault();
      assignGuess(up);
    }
  }
}

function reset(): void {
  gen.bump();
  if (tickToken !== null) {
    clearInterval(tickToken);
    tickToken = null;
  }
  state = 'playing';
  plaintext = pickQuote();
  encryptMap = buildSubstitutionWithoutFixedPoints();
  decryptMap = {};
  for (const [plain, cipher] of Object.entries(encryptMap)) {
    decryptMap[cipher] = plain;
  }
  guess = {};
  cells = [];
  for (const ch of plaintext) {
    cells.push({ ch, isLetter: isLetter(ch) });
  }
  selected = null;
  hintsUsed = 0;
  elapsedSec = 0;
  startMs = Date.now();
  const myGen = gen.current();
  tickToken = setInterval(() => {
    if (!gen.isCurrent(myGen)) return;
    tick();
  }, 1000);

  hideOverlay(overlayEl);
  renderHud();
  renderCipher();
  renderPad();
}

function init(): void {
  timeEl = document.querySelector<HTMLElement>('#time')!;
  hintsEl = document.querySelector<HTMLElement>('#hints')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  hintBtn = document.querySelector<HTMLButtonElement>('#hint')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  cipherEl = document.querySelector<HTMLElement>('#cipher')!;
  padEl = document.querySelector<HTMLElement>('#pad')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayText = document.querySelector<HTMLElement>('#overlay-text')!;
  overlayBtn = document.querySelector<HTMLButtonElement>('#overlay-btn')!;

  bestSec = safeRead<number>(STORAGE_BEST, 0);

  cipherEl.addEventListener('click', onCipherClick);
  padEl.addEventListener('click', onPadClick);
  clearBtn.addEventListener('click', clearSelection);
  hintBtn.addEventListener('click', revealHint);
  restartBtn.addEventListener('click', reset);
  overlayBtn.addEventListener('click', reset);
  window.addEventListener('keydown', onKey);

  reset();
}

export const game = defineGame({ init, reset });
