type SortKey = 'newest' | 'oldest' | 'alpha';

interface GameInfo {
  slug: string;
  title: string;
  description: string;
  dateAdded: string;
  tags: string[];
  controls: string;
  url: string;
}

interface State {
  query: string;
  activeTag: string | null;
  sort: SortKey;
  playingSlug: string | null;
}

const state: State = {
  query: '',
  activeTag: null,
  sort: 'newest',
  playingSlug: null,
};

const app = document.querySelector<HTMLElement>('#app')!;
const player = document.querySelector<HTMLElement>('#player')!;
const playerFrame = document.querySelector<HTMLIFrameElement>('#player-frame')!;
const playerTitle = document.querySelector<HTMLElement>('#player-title')!;
const playerControls = document.querySelector<HTMLElement>('#player-controls')!;
const playerOpen = document.querySelector<HTMLAnchorElement>('#player-open')!;
const playerBack = document.querySelector<HTMLButtonElement>('#player-back')!;
const grid = document.querySelector<HTMLElement>('#grid')!;
const tagsEl = document.querySelector<HTMLElement>('#tags')!;
const searchEl = document.querySelector<HTMLInputElement>('#search')!;
const sortEl = document.querySelector<HTMLSelectElement>('#sort')!;
const sortLabelEl = document.querySelector<HTMLElement>('#count');

const dataEl = document.querySelector<HTMLElement>('#games-data')!;
const games: GameInfo[] = JSON.parse(dataEl.textContent || '[]');
const gameMap = new Map(games.map((g) => [g.slug, g]));
const originalCards = Array.from(grid.querySelectorAll<HTMLElement>('.card'));

function relativeDate(iso: string): string {
  const then = new Date(iso + 'T00:00:00Z').getTime();
  if (Number.isNaN(then)) return iso;
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'bugün';
  if (days === 1) return 'dün';
  if (days < 7) return `${days} gün önce`;
  if (days < 30) return `${Math.floor(days / 7)} hafta önce`;
  if (days < 365) return `${Math.floor(days / 30)} ay önce`;
  return `${Math.floor(days / 365)} yıl önce`;
}

document.querySelectorAll<HTMLElement>('[data-date-iso]').forEach((el) => {
  const iso = el.dataset.dateIso;
  if (iso) el.textContent = relativeDate(iso);
});

function applyFilters(): void {
  const q = state.query.trim().toLowerCase();
  const visible = games.filter((g) => {
    if (state.activeTag && !g.tags.includes(state.activeTag)) return false;
    if (!q) return true;
    return (
      g.title.toLowerCase().includes(q) ||
      g.description.toLowerCase().includes(q) ||
      g.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const sorted = [...visible];
  if (state.sort === 'oldest') {
    sorted.sort((a, b) => a.dateAdded.localeCompare(b.dateAdded));
  } else if (state.sort === 'alpha') {
    sorted.sort((a, b) =>
      a.title.localeCompare(b.title, 'tr', { sensitivity: 'base' }),
    );
  }

  const cardBySlug = new Map<string, HTMLElement>();
  originalCards.forEach((card) => {
    const slug = card.dataset.slug;
    if (slug) cardBySlug.set(slug, card);
  });

  originalCards.forEach((card) => {
    card.style.display = 'none';
  });

  if (sorted.length === 0) {
    let empty = grid.querySelector<HTMLElement>('.empty');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = `
        <div class="empty__icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="7" cy="7" r="5"/><path d="m11 11 3 3"/>
          </svg>
        </div>
        <p class="empty__text">Bu kriterlere uyan oyun yok.</p>
      `;
      grid.appendChild(empty);
    }
    empty.style.display = '';
    return;
  }
  const empty = grid.querySelector<HTMLElement>('.empty');
  if (empty) empty.style.display = 'none';

  sorted.forEach((g) => {
    const card = cardBySlug.get(g.slug);
    if (card) {
      card.style.display = '';
      grid.appendChild(card);
    }
  });
}

function renderTags(): void {
  const allTags = [...new Set(games.flatMap((g) => g.tags))].sort();
  if (allTags.length === 0) {
    tagsEl.innerHTML = '';
    return;
  }
  tagsEl.innerHTML = [
    `<button class="tag${state.activeTag === null ? ' tag--active' : ''}" data-tag="" type="button">Tümü</button>`,
    ...allTags.map(
      (t) =>
        `<button class="tag${state.activeTag === t ? ' tag--active' : ''}" data-tag="${t}" type="button">${t}</button>`,
    ),
  ].join('');
}

function openGame(slug: string): void {
  const game = gameMap.get(slug);
  if (!game) {
    closeGame();
    return;
  }
  state.playingSlug = slug;
  playerFrame.src = game.url;
  playerTitle.textContent = game.title;
  if (game.controls) {
    playerControls.textContent = game.controls;
    playerControls.style.display = '';
  } else {
    playerControls.textContent = '';
    playerControls.style.display = 'none';
  }
  playerOpen.href = game.url;
  player.classList.add('player--open');
  app.classList.add('app--hidden');
  document.title = `${game.title} · Oyunlar`;
  const hash = `#/play/${slug}`;
  if (location.hash !== hash) {
    history.pushState(null, '', hash);
  }
}

function closeGame(): void {
  state.playingSlug = null;
  playerFrame.src = 'about:blank';
  player.classList.remove('player--open');
  app.classList.remove('app--hidden');
  document.title = 'Oyunlar — karaman.dev';
  if (location.hash.startsWith('#/play/')) {
    history.pushState(null, '', location.pathname + location.search);
  }
}

function syncFromHash(): void {
  const match = location.hash.match(/^#\/play\/([\w-]+)$/);
  if (match && match[1]) {
    if (state.playingSlug !== match[1]) openGame(match[1]);
  } else if (state.playingSlug !== null) {
    closeGame();
  }
}

grid.addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (!card) return;
  const slug = card.dataset.slug;
  if (slug) openGame(slug);
});

tagsEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.tag');
  if (!btn) return;
  const tag = btn.dataset.tag ?? '';
  state.activeTag = tag === '' ? null : tag;
  renderTags();
  applyFilters();
});

searchEl.addEventListener('input', () => {
  state.query = searchEl.value;
  applyFilters();
});

sortEl.addEventListener('change', () => {
  state.sort = sortEl.value as SortKey;
  applyFilters();
});

playerBack.addEventListener('click', closeGame);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.playingSlug !== null) closeGame();
});

window.addEventListener('popstate', syncFromHash);

void sortLabelEl;

renderTags();
applyFilters();
syncFromHash();
