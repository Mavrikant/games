import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { showOverlay as showOverlayEl, hideOverlay as hideOverlayEl } from '@shared/overlay';
import { createGenToken } from '@shared/gen-token';

const STORAGE_BEST = 'suflor.best';
const ACTOR_COUNT = 3;
const MAX_MEMORY = 100;
const CUE_DURATION = 4.0;

type State = 'ready' | 'playing' | 'gameover';

type Actor = {
  name: string;
  cue: number;
  memory: number;
  drainRate: number;
  cardEl: HTMLButtonElement;
  barEl: HTMLElement;
  cueEl: HTMLElement;
};

const gen = createGenToken();

let state: State = 'ready';
let score = 0;
let best = 0;
let combo = 0;
let elapsed = 0;
let lastTick = 0;

let actors: Actor[] = [];
let currentCue: number | null = null;
let cueRemaining = 0;
let nextCueIn = 0;
let usedCueNumbers = new Set<number>();

let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let comboEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let stageEl!: HTMLElement;
let cueEl!: HTMLElement;
let cueBarEl!: HTMLElement;
let cueLabelEl!: HTMLElement;
let overlay!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function freshCueNumber(): number {
  for (let tries = 0; tries < 200; tries++) {
    const n = randInt(10, 99);
    if (!usedCueNumbers.has(n)) return n;
  }
  return randInt(10, 99);
}

function rotateActorCue(a: Actor): void {
  usedCueNumbers.delete(a.cue);
  a.cue = freshCueNumber();
  usedCueNumbers.add(a.cue);
  a.cueEl.textContent = String(a.cue);
}

function setOverlay(title: string, msg: string): void {
  overlayTitle.textContent = title;
  overlayMsg.textContent = msg;
  showOverlayEl(overlay);
}

function buildActors(): void {
  stageEl.innerHTML = '';
  actors = [];
  usedCueNumbers = new Set();

  const names = ['I. Aktör', 'II. Aktör', 'III. Aktör'];
  const drainRates = [6, 8, 10];

  for (let i = 0; i < ACTOR_COUNT; i++) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'actor';
    card.setAttribute('aria-label', `${names[i]} — repliği aktarmak için tıkla`);
    card.innerHTML = `
      <div class="actor__cue" aria-hidden="true"></div>
      <div class="actor__fig" aria-hidden="true">
        <svg viewBox="0 0 100 140" xmlns="http://www.w3.org/2000/svg">
          <circle cx="50" cy="32" r="20"></circle>
          <path d="M22 132 Q22 72 50 60 Q78 72 78 132 Z"></path>
        </svg>
      </div>
      <div class="actor__name"></div>
      <div class="actor__bar" aria-hidden="true"><div class="actor__bar-fill"></div></div>
    `;

    const cueDiv = card.querySelector<HTMLElement>('.actor__cue')!;
    const nameDiv = card.querySelector<HTMLElement>('.actor__name')!;
    const barFill = card.querySelector<HTMLElement>('.actor__bar-fill')!;
    nameDiv.textContent = names[i]!;

    const a: Actor = {
      name: names[i]!,
      cue: 0,
      memory: MAX_MEMORY,
      drainRate: drainRates[i]!,
      cardEl: card,
      barEl: barFill,
      cueEl: cueDiv,
    };

    a.cue = freshCueNumber();
    usedCueNumbers.add(a.cue);
    cueDiv.textContent = String(a.cue);

    const idx = i;
    card.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onActorTap(idx);
    });

    stageEl.appendChild(card);
    actors.push(a);
  }
  renderActors();
}

function renderActors(): void {
  for (const a of actors) {
    const pct = Math.max(0, Math.min(100, (a.memory / MAX_MEMORY) * 100));
    a.barEl.style.width = `${pct}%`;
    if (pct > 60) a.barEl.style.background = 'var(--accent)';
    else if (pct > 30) a.barEl.style.background = '#facc15';
    else a.barEl.style.background = '#ef4444';
  }
}

function renderCue(): void {
  if (currentCue === null) {
    cueLabelEl.textContent = '—';
    cueBarEl.style.width = '0%';
    cueEl.classList.remove('cue--active');
  } else {
    cueLabelEl.textContent = String(currentCue);
    const pct = Math.max(0, (cueRemaining / CUE_DURATION) * 100);
    cueBarEl.style.width = `${pct}%`;
    cueEl.classList.add('cue--active');
  }
}

function renderHud(): void {
  scoreEl.textContent = String(score);
  bestEl.textContent = String(best);
  comboEl.textContent = `×${combo}`;
}

function announceCue(): void {
  const idx = randInt(0, actors.length - 1);
  currentCue = actors[idx]!.cue;
  cueRemaining = CUE_DURATION;
  renderCue();
}

function flashCard(el: HTMLElement, className: string): void {
  el.classList.add(className);
  const myGen = gen.current();
  window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    el.classList.remove(className);
  }, 260);
}

function onActorTap(i: number): void {
  if (state === 'ready' || state === 'gameover') {
    startGame();
    return;
  }
  if (state !== 'playing') return;
  const a = actors[i];
  if (!a) return;

  if (currentCue === null) {
    a.memory -= 8;
    combo = 0;
    flashCard(a.cardEl, 'card--bad');
    renderActors();
    renderHud();
    if (a.memory <= 0) {
      a.memory = 0;
      renderActors();
      endGame();
    }
    return;
  }

  if (a.cue === currentCue) {
    const gained = 1 + Math.floor(combo / 3);
    score += gained;
    combo += 1;
    if (score > best) {
      best = score;
      safeWrite(STORAGE_BEST, best);
    }
    a.memory = MAX_MEMORY;
    rotateActorCue(a);
    currentCue = null;
    cueRemaining = 0;
    nextCueIn = Math.max(0.6, baseCueInterval() * 0.75);
    flashCard(a.cardEl, 'card--good');
    renderActors();
    renderCue();
    renderHud();
  } else {
    a.memory -= 14;
    combo = 0;
    flashCard(a.cardEl, 'card--bad');
    renderActors();
    renderHud();
    if (a.memory <= 0) {
      a.memory = 0;
      renderActors();
      endGame();
    }
  }
}

function baseCueInterval(): number {
  const k = Math.min(1, elapsed / 90);
  return 2.4 - 1.0 * k;
}

function tick(dt: number): void {
  if (state !== 'playing') return;
  elapsed += dt;

  const ramp = 1 + Math.min(1, elapsed / 120) * 0.5;
  let died = false;
  for (const a of actors) {
    a.memory -= a.drainRate * ramp * dt;
    if (a.memory <= 0) {
      a.memory = 0;
      died = true;
    }
  }
  renderActors();
  if (died) {
    endGame();
    return;
  }

  if (currentCue !== null) {
    cueRemaining -= dt;
    if (cueRemaining <= 0) {
      const matching = actors.find((a) => a.cue === currentCue);
      if (matching) {
        matching.memory -= 18;
        flashCard(matching.cardEl, 'card--miss');
        if (matching.memory <= 0) {
          matching.memory = 0;
          currentCue = null;
          cueRemaining = 0;
          renderCue();
          renderActors();
          endGame();
          return;
        }
      }
      combo = 0;
      currentCue = null;
      cueRemaining = 0;
      nextCueIn = baseCueInterval();
      renderActors();
      renderHud();
    }
    renderCue();
  } else {
    nextCueIn -= dt;
    if (nextCueIn <= 0) {
      announceCue();
    }
  }
}

function loop(): void {
  const now = performance.now();
  const dt = Math.max(0, Math.min(0.1, (now - lastTick) / 1000));
  lastTick = now;
  tick(dt);
  window.requestAnimationFrame(loop);
}

function startGame(): void {
  gen.bump();
  state = 'playing';
  score = 0;
  combo = 0;
  elapsed = 0;
  currentCue = null;
  cueRemaining = 0;
  nextCueIn = 0.7;
  buildActors();
  hideOverlayEl(overlay);
  renderHud();
  renderCue();
  lastTick = performance.now();
}

function endGame(): void {
  state = 'gameover';
  currentCue = null;
  cueRemaining = 0;
  renderCue();
  renderActors();
  setOverlay(
    'Perde indi',
    `Skor: ${score}  ·  Rekor: ${best}\nYeniden başlamak için tıkla, R veya Enter.`,
  );
}

function reset(): void {
  gen.bump();
  state = 'ready';
  score = 0;
  combo = 0;
  elapsed = 0;
  currentCue = null;
  cueRemaining = 0;
  nextCueIn = 0;
  buildActors();
  renderHud();
  renderCue();
  setOverlay(
    'Suflör',
    'Sahnede üç aktör; hafızaları damla damla dökülüyor.\nAşağıda beliren replik numarasını, aynı numarayı bekleyen aktöre tıklayarak fısılda.\nBaşlamak için tıkla / Enter.',
  );
}

function init(): void {
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  comboEl = document.querySelector<HTMLElement>('#combo')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  stageEl = document.querySelector<HTMLElement>('#stage')!;
  cueEl = document.querySelector<HTMLElement>('#cue')!;
  cueBarEl = document.querySelector<HTMLElement>('#cue-bar')!;
  cueLabelEl = document.querySelector<HTMLElement>('#cue-label')!;
  overlay = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;

  best = safeRead<number>(STORAGE_BEST, 0);

  restartBtn.addEventListener('click', () => reset());

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'ready' || state === 'gameover') startGame();
  });

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'r') {
      reset();
      e.preventDefault();
      return;
    }
    if (k === 'enter' || k === ' ') {
      if (state === 'ready' || state === 'gameover') {
        startGame();
        e.preventDefault();
      }
      return;
    }
    if (state !== 'playing') return;
    if (k === '1' || k === '2' || k === '3') {
      const i = Number(k) - 1;
      if (i < actors.length) onActorTap(i);
      e.preventDefault();
    }
  });

  reset();
  window.requestAnimationFrame(loop);
}

export const game = defineGame({ init, reset });
