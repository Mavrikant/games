// Runtime for the /siralama (leaderboard) page. Vanilla TS in the same style as
// archive/main.ts: read a build-injected JSON blob, query the DOM, render.
//
// Only runs when the backend is configured (data-enabled="true" on the root,
// set by the page from PUBLIC_SUPABASE_*). When disabled, the page renders a
// static "yakında" placeholder and this module bails immediately — no network,
// so offline dev and the smoke test stay clean.

import {
  fetchLeaderboard,
  getPlayer,
  signIn,
  signOut,
  type LeaderboardRow,
  type OAuthProvider,
} from '@shared/leaderboard-client';

interface Board {
  gameId: string;
  slug: string;
  title: string;
  label: string;
  unit: string;
  direction: 'higher' | 'lower';
  url: string;
}

async function run(): Promise<void> {
  const dataEl = document.querySelector<HTMLElement>('#leaderboard-data');
  const boards = JSON.parse(dataEl?.textContent || '[]') as Board[];
  await Promise.all([
    renderAuth(document.querySelector<HTMLElement>('#lb-auth')),
    renderBoards(document.querySelector<HTMLElement>('#lb-boards'), boards),
  ]);
}

async function renderAuth(el: HTMLElement | null): Promise<void> {
  if (!el) return;
  el.hidden = false;
  const player = await getPlayer();
  if (player) {
    el.innerHTML =
      '<span class="lb__who">Giriş yapıldı: <strong></strong></span>' +
      '<button class="lb__btn" type="button" data-action="signout">Çıkış</button>';
    el.querySelector('strong')!.textContent = player.displayName;
    el.querySelector<HTMLButtonElement>('[data-action="signout"]')!.addEventListener(
      'click',
      () => {
        void signOut().then(() => location.reload());
      },
    );
  } else {
    el.innerHTML =
      '<span class="lb__who">Skorunu küresel sıralamaya göndermek için giriş yap:</span>' +
      '<button class="lb__btn lb__btn--google" type="button" data-provider="google">Google ile giriş</button>';
    el.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void signIn(btn.dataset.provider as OAuthProvider);
      });
    });
  }
}

async function renderBoards(el: HTMLElement | null, boards: Board[]): Promise<void> {
  if (!el) return;
  if (boards.length === 0) {
    el.innerHTML = '<p class="lb__empty">Henüz sıralamaya katılan oyun yok.</p>';
    return;
  }
  // Render shells first so the page isn't blank while rows fetch in parallel.
  el.innerHTML = boards
    .map(
      (b) =>
        `<section class="lb__board" data-game="${escapeAttr(b.gameId)}">` +
        `<h2 class="lb__board-title"><a href="${escapeAttr(b.url)}">${escapeHtml(b.title)}</a>` +
        `<span class="lb__board-metric">${escapeHtml(b.label)}</span></h2>` +
        '<ol class="lb__rows"><li class="lb__loading">Yükleniyor…</li></ol>' +
        '</section>',
    )
    .join('');

  await Promise.all(
    boards.map(async (b) => {
      const rows = await fetchLeaderboard(b.gameId, b.direction, 10);
      const ol = el.querySelector<HTMLElement>(
        `.lb__board[data-game="${escapeAttr(b.gameId)}"] .lb__rows`,
      );
      if (!ol) return;
      ol.innerHTML =
        rows.length === 0
          ? '<li class="lb__empty">Henüz skor yok</li>'
          : rows.map((r) => rowHtml(r, b.unit)).join('');
    }),
  );
}

function rowHtml(r: LeaderboardRow, unit: string): string {
  const value = Number.isInteger(r.value) ? String(r.value) : r.value.toFixed(2);
  const display = unit ? `${value} ${unit}` : value;
  return (
    `<li class="lb__row${r.isSelf ? ' lb__row--self' : ''}">` +
    `<span class="lb__rank">${r.rank}</span>` +
    `<span class="lb__name">${escapeHtml(r.displayName)}</span>` +
    `<span class="lb__value">${escapeHtml(display)}</span>` +
    '</li>'
  );
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}
// Game ids and urls are slugs/known paths, but escape quotes defensively so a
// value can never break out of an attribute / selector.
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Kick off only after every module-level binding above (e.g. HTML_ESCAPES) is
// initialized — run() executes its synchronous prefix immediately, so invoking
// it before those `const`s would hit a temporal-dead-zone error and render
// nothing. (This is why /siralama showed empty.)
const root = document.querySelector<HTMLElement>('#leaderboard-root');
if (root && root.dataset.enabled === 'true') {
  void run();
}
