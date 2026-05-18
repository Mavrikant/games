import './styles.css';
import { games, allTags } from './games-loader';
import type { ResolvedGame } from './games-loader';

type SortKey = 'newest' | 'oldest' | 'alpha';

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
const countEl = document.querySelector<HTMLElement>('#count')!;
const yearEl = document.querySelector<HTMLElement>('#year');

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

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

function thumbHtml(game: ResolvedGame): string {
  if (game.thumbnailUrl) {
    return `<img src="${escapeHtml(game.thumbnailUrl)}" alt="" loading="lazy" />`;
  }
  const letter = game.title.charAt(0).toUpperCase();
  return `<span class="card__thumb-placeholder" aria-hidden="true">${escapeHtml(letter)}</span>`;
}

function filtered(): ResolvedGame[] {
  const q = state.query.trim().toLowerCase();
  let list = games.filter((g) => {
    if (state.activeTag && !g.tags.includes(state.activeTag)) return false;
    if (!q) return true;
    return (
      g.title.toLowerCase().includes(q) ||
      g.description.toLowerCase().includes(q) ||
      g.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
  if (state.sort === 'oldest') {
    list = [...list].sort((a, b) => a.dateAdded.localeCompare(b.dateAdded));
  } else if (state.sort === 'alpha') {
    list = [...list].sort((a, b) =>
      a.title.localeCompare(b.title, 'tr', { sensitivity: 'base' }),
    );
  }
  return list;
}

const EMPTY_HTML = `
  <div class="empty">
    <div class="empty__icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <circle cx="7" cy="7" r="5"/><path d="m11 11 3 3"/>
      </svg>
    </div>
    <p class="empty__text">Bu kriterlere uyan oyun yok.</p>
  </div>
`;

function renderGrid(): void {
  const list = filtered();
  countEl.textContent = `${list.length} oyun`;
  if (list.length === 0) {
    grid.innerHTML = EMPTY_HTML;
    return;
  }
  grid.innerHTML = list
    .map(
      (g) => `
        <button class="card" data-slug="${escapeHtml(g.slug)}" type="button" aria-label="${escapeHtml(g.title)} oyna">
          <div class="card__thumb">${thumbHtml(g)}</div>
          <div class="card__body">
            <h2 class="card__title">${escapeHtml(g.title)}</h2>
            <p class="card__desc">${escapeHtml(g.description)}</p>
            <div class="card__meta">
              <span class="card__date">${escapeHtml(relativeDate(g.dateAdded))}</span>
              <span class="card__tags">${g.tags
                .slice(0, 2)
                .map((t) => `<span class="card__tag">${escapeHtml(t)}</span>`)
                .join('')}</span>
            </div>
          </div>
        </button>
      `,
    )
    .join('');
}

function renderTags(): void {
  if (allTags.length === 0) {
    tagsEl.innerHTML = '';
    return;
  }
  tagsEl.innerHTML = [
    `<button class="tag${state.activeTag === null ? ' tag--active' : ''}" data-tag="" type="button">Tümü</button>`,
    ...allTags.map(
      (t) =>
        `<button class="tag${state.activeTag === t ? ' tag--active' : ''}" data-tag="${escapeHtml(t)}" type="button">${escapeHtml(t)}</button>`,
    ),
  ].join('');
}

function openGame(slug: string): void {
  const game = games.find((g) => g.slug === slug);
  if (!game) {
    closeGame();
    return;
  }
  state.playingSlug = slug;
  const url = game.url;
  playerFrame.src = url;
  playerTitle.textContent = game.title;
  if (game.controls) {
    playerControls.textContent = game.controls;
    playerControls.style.display = '';
  } else {
    playerControls.textContent = '';
    playerControls.style.display = 'none';
  }
  playerOpen.href = url;
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
  renderGrid();
});

searchEl.addEventListener('input', () => {
  state.query = searchEl.value;
  renderGrid();
});

sortEl.addEventListener('change', () => {
  state.sort = sortEl.value as SortKey;
  renderGrid();
});

playerBack.addEventListener('click', closeGame);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.playingSlug !== null) closeGame();
});

window.addEventListener('popstate', syncFromHash);

if (yearEl) yearEl.textContent = String(new Date().getFullYear());
renderTags();
renderGrid();
syncFromHash();
