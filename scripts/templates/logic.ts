const STORAGE_KEY = '__SLUG__.state';

const root = document.querySelector<HTMLElement>('#root')!;
const scoreEl = document.querySelector<HTMLElement>('#score')!;
const restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

let score = 0;

function load(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? Number(raw) || 0 : 0;
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(score));
  } catch {
    /* ignore */
  }
}

function render(): void {
  scoreEl.textContent = String(score);
  root.textContent = '__TITLE__ — buraya oyun mantığını yaz.';
}

function reset(): void {
  score = load();
  render();
}

restartBtn.addEventListener('click', () => {
  score = 0;
  save();
  render();
});

reset();
