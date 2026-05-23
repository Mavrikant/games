import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';

// Renk Karıştır — subtractive CMY pigment-matching deduction puzzle.
// Cyan absorbs red, magenta absorbs green, yellow absorbs blue; each drop
// darkens its channel. Read the target colour, set the drops, match exactly
// within a limited number of tries. Streak grows as the palette widens.

const STORAGE_BEST = 'renk-karistir.best';
const STRENGTH = 0.75; // per-drop channel multiplier
const TRIES = 3;

type Pig = 'c' | 'm' | 'y';
const PIGS: readonly Pig[] = ['c', 'm', 'y'];
type Mix = Record<Pig, number>;

const gen = createGenToken();

let streak = 0;
let best = 0;
let maxN = 3;
let triesLeft = TRIES;
let locked = false;
let target: Mix = { c: 0, m: 0, y: 0 };
let mix: Mix = { c: 0, m: 0, y: 0 };

let streakEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let targetChip!: HTMLElement;
let mixChip!: HTMLElement;
let closenessEl!: HTMLElement;
let triesEl!: HTMLElement;
let submitBtn!: HTMLButtonElement;
let statusEl!: HTMLElement;
const countEls: Record<Pig, HTMLElement> = {} as Record<Pig, HTMLElement>;
const hintEls: Record<Pig, HTMLElement> = {} as Record<Pig, HTMLElement>;

function channel(drops: number): number {
  return Math.round(255 * Math.pow(STRENGTH, drops));
}

function rgbOf(m: Mix): [number, number, number] {
  return [channel(m.c), channel(m.m), channel(m.y)];
}

function cssColor(m: Mix): string {
  const [r, g, b] = rgbOf(m);
  return `rgb(${r}, ${g}, ${b})`;
}

function closeness(a: Mix, b: Mix): number {
  const [r1, g1, b1] = rgbOf(a);
  const [r2, g2, b2] = rgbOf(b);
  const diff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
  return Math.round(100 * (1 - diff / (3 * 255)));
}

function isExact(a: Mix, b: Mix): boolean {
  return a.c === b.c && a.m === b.m && a.y === b.y;
}

function randInt(maxInclusive: number): number {
  return Math.floor(Math.random() * (maxInclusive + 1));
}

function renderCounts(): void {
  for (const p of PIGS) countEls[p].textContent = String(mix[p]);
}

function renderMix(): void {
  mixChip.style.background = cssColor(mix);
  closenessEl.textContent = `Yakınlık: ${closeness(mix, target)}%`;
}

function clearHints(): void {
  for (const p of PIGS) {
    hintEls[p].textContent = '';
    hintEls[p].classList.remove(
      'rk__pig-hint--up',
      'rk__pig-hint--down',
      'rk__pig-hint--ok',
    );
  }
}

function setControlsDisabled(disabled: boolean): void {
  document
    .querySelectorAll<HTMLButtonElement>('.rk__step')
    .forEach((b) => (b.disabled = disabled));
  submitBtn.disabled = disabled;
}

function newRound(): void {
  gen.bump();
  locked = false;
  maxN = Math.min(3 + Math.floor(streak / 2), 7);
  do {
    target = { c: randInt(maxN), m: randInt(maxN), y: randInt(maxN) };
  } while (target.c === 0 && target.m === 0 && target.y === 0);
  mix = { c: 0, m: 0, y: 0 };
  triesLeft = TRIES;
  targetChip.style.background = cssColor(target);
  clearHints();
  setControlsDisabled(false);
  triesEl.textContent = `Deneme: ${triesLeft} / ${TRIES}`;
  statusEl.textContent = 'Pigmentleri ayarla, Eşleştir’e bas.';
  renderCounts();
  renderMix();
}

function adjust(pig: Pig, dir: number): void {
  if (locked) return;
  const next = mix[pig] + dir;
  if (next < 0 || next > maxN) return;
  mix[pig] = next;
  renderCounts();
  renderMix();
}

function showHints(): void {
  for (const p of PIGS) {
    const el = hintEls[p];
    el.classList.remove(
      'rk__pig-hint--up',
      'rk__pig-hint--down',
      'rk__pig-hint--ok',
    );
    if (mix[p] < target[p]) {
      el.textContent = '▲'; // need more pigment (darker)
      el.classList.add('rk__pig-hint--up');
    } else if (mix[p] > target[p]) {
      el.textContent = '▼'; // need less
      el.classList.add('rk__pig-hint--down');
    } else {
      el.textContent = '●'; // correct
      el.classList.add('rk__pig-hint--ok');
    }
  }
}

function commitBest(): void {
  if (streak > best) {
    best = streak;
    safeWrite(STORAGE_BEST, best);
    bestEl.textContent = String(best);
  }
}

function winRound(): void {
  streak += 1;
  streakEl.textContent = String(streak);
  commitBest();
  clearHints();
  statusEl.textContent = 'Doğru! Yeni renk geliyor…';
  locked = true;
  setControlsDisabled(true);
  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    newRound();
  }, 850);
}

function failRound(): void {
  showHints();
  const t = target;
  statusEl.textContent = `Kaçırdın! Doğrusu — Camgöbeği ${t.c}, Macenta ${t.m}, Sarı ${t.y}.`;
  mix = { c: t.c, m: t.m, y: t.y };
  renderCounts();
  renderMix();
  streak = 0;
  streakEl.textContent = '0';
  locked = true;
  setControlsDisabled(true);
  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    newRound();
  }, 1600);
}

function submit(): void {
  if (locked) return;

  if (isExact(mix, target)) {
    winRound();
    return;
  }

  triesLeft -= 1;
  triesEl.textContent = `Deneme: ${triesLeft} / ${TRIES}`;

  if (triesLeft <= 0) {
    failRound();
    return;
  }

  showHints();
  statusEl.textContent = `Tutmadı — ipuçlarına bak. Kalan deneme: ${triesLeft}.`;
}

function reset(): void {
  gen.bump();
  streak = 0;
  streakEl.textContent = '0';
  newRound();
}

function init(): void {
  streakEl = document.querySelector<HTMLElement>('#streak')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  targetChip = document.querySelector<HTMLElement>('#target')!;
  mixChip = document.querySelector<HTMLElement>('#mix')!;
  closenessEl = document.querySelector<HTMLElement>('#closeness')!;
  triesEl = document.querySelector<HTMLElement>('#tries')!;
  submitBtn = document.querySelector<HTMLButtonElement>('#submit')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  for (const p of PIGS) {
    countEls[p] = document.querySelector<HTMLElement>(`#count-${p}`)!;
    hintEls[p] = document.querySelector<HTMLElement>(`#hint-${p}`)!;
  }

  best = safeRead<number>(STORAGE_BEST, 0);
  bestEl.textContent = String(best);

  document.querySelectorAll<HTMLButtonElement>('.rk__step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pig = btn.dataset.pig as Pig | undefined;
      const dir = Number(btn.dataset.dir);
      if (pig && (dir === 1 || dir === -1)) adjust(pig, dir);
    });
  });

  submitBtn.addEventListener('click', submit);
  restartBtn.addEventListener('click', reset);

  const KEYS: Record<string, [Pig, number]> = {
    q: ['c', 1],
    a: ['c', -1],
    w: ['m', 1],
    s: ['m', -1],
    e: ['y', 1],
    d: ['y', -1],
  };
  window.addEventListener('keydown', (ev) => {
    const k = ev.key.toLowerCase();
    if (k === 'r') {
      ev.preventDefault();
      reset();
      return;
    }
    if (k === 'enter') {
      ev.preventDefault();
      submit();
      return;
    }
    const mapped = KEYS[k];
    if (mapped) {
      ev.preventDefault();
      adjust(mapped[0], mapped[1]);
    }
  });

  newRound();
}

export const game = defineGame({ init, reset });
