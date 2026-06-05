// Shared "game over" scoreboard overlay. A game calls reportGameOver()
// (@shared/leaderboard) at the end of a run; in production (backend enabled)
// this module pops a modal inside the game iframe showing the global top-N for
// that game plus the player's score, and — when signed out — a sign-in prompt.
//
// Self-contained: it injects its own DOM + CSS into the document so it works in
// every game regardless of that game's own markup/styles. OAuth cannot run
// inside the game iframe, so the sign-in button navigates the TOP window to
// /siralama (where Google login already works); the Supabase session is shared
// (same origin) so the next finished run submits and ranks the player.
//
// No top-level side effects and no eager Supabase import → safe to bundle into
// every game; nothing runs until a real game-over calls showScoreboard().

import {
  fetchLeaderboard,
  getPlayer,
  submitScore,
  type LeaderboardRow,
} from './leaderboard-client';

export interface ScoreboardOptions {
  gameId: string;
  direction: 'higher' | 'lower';
  value: number;
  /** Label for the "your score" line (default "Skorun"). */
  label?: string;
  /** Unit suffix for values, e.g. "m", "sn". */
  unit?: string;
}

const STYLE_ID = 'lbsb-style';
const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function fmt(v: number, unit?: string): string {
  const n = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return unit ? `${n} ${unit}` : n;
}

function siralamaUrl(): string {
  return `${import.meta.env.BASE_URL}siralama/`;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.lbsb{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
  padding:16px;background:rgba(0,0,0,.6);font-family:inherit}
.lbsb[hidden]{display:none}
.lbsb__panel{width:100%;max-width:360px;max-height:90%;overflow:auto;
  background:var(--surface,#15171c);color:var(--text,#e7e9ee);
  border:1px solid var(--border,#2a2f3a);border-radius:16px;padding:20px 18px;
  box-shadow:0 20px 60px rgba(0,0,0,.5)}
.lbsb__title{margin:0 0 2px;font-size:18px}
.lbsb__you{margin:0 0 14px;color:var(--text-muted,#9aa3b2);font-size:14px}
.lbsb__you strong{color:var(--accent,#60a5fa);font-size:16px}
.lbsb__rows{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:2px}
.lbsb__row{display:grid;grid-template-columns:26px 1fr auto;gap:10px;align-items:center;
  padding:6px 8px;border-radius:8px;font-size:14px}
.lbsb__row--self{background:var(--accent-soft,rgba(96,165,250,.15))}
.lbsb__rank{color:var(--text-dim,#6b7280);text-align:right;font-variant-numeric:tabular-nums}
.lbsb__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lbsb__val{font-weight:600;font-variant-numeric:tabular-nums}
.lbsb__empty,.lbsb__loading{color:var(--text-dim,#6b7280);font-size:14px;padding:6px 8px}
.lbsb__cta{font-size:13px;color:var(--text-muted,#9aa3b2);display:grid;gap:8px}
.lbsb__btn{font:inherit;font-size:14px;font-weight:600;cursor:pointer;border-radius:999px;
  padding:9px 14px;border:1px solid var(--border,#2a2f3a);
  background:var(--surface-2,#1d2127);color:var(--text,#e7e9ee)}
.lbsb__btn--primary{background:var(--accent,#60a5fa);border-color:var(--accent,#60a5fa);color:#06121f}
.lbsb__actions{display:flex;gap:8px;margin-top:14px}
.lbsb__actions .lbsb__btn{flex:1}`;
  document.head.appendChild(style);
}

let overlayEl: HTMLElement | null = null;

function ensureOverlay(): HTMLElement {
  injectStyles();
  if (overlayEl) return overlayEl;
  const el = document.createElement('div');
  el.className = 'lbsb';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.hidden = true;
  el.addEventListener('click', (e) => {
    if (e.target === el) el.hidden = true; // backdrop click closes
  });
  document.body.appendChild(el);
  overlayEl = el;
  return el;
}

function rowHtml(r: LeaderboardRow, unit?: string): string {
  return (
    `<li class="lbsb__row${r.isSelf ? ' lbsb__row--self' : ''}">` +
    `<span class="lbsb__rank">${r.rank}</span>` +
    `<span class="lbsb__name">${esc(r.displayName)}</span>` +
    `<span class="lbsb__val">${esc(fmt(r.value, unit))}</span>` +
    '</li>'
  );
}

export async function showScoreboard(opts: ScoreboardOptions): Promise<void> {
  const { gameId, direction, value, label, unit } = opts;
  const el = ensureOverlay();
  el.innerHTML =
    '<div class="lbsb__panel">' +
    '<h2 class="lbsb__title">Skor Tablosu</h2>' +
    `<p class="lbsb__you">${esc(label ?? 'Skorun')}: <strong>${esc(fmt(value, unit))}</strong></p>` +
    '<ol class="lbsb__rows"><li class="lbsb__loading">Yükleniyor…</li></ol>' +
    '<div class="lbsb__cta"></div>' +
    '<div class="lbsb__actions">' +
    '<button class="lbsb__btn" data-act="close" type="button">Kapat</button>' +
    '</div></div>';
  el.hidden = false;
  el.querySelector<HTMLButtonElement>('[data-act="close"]')!.addEventListener('click', () => {
    el.hidden = true;
  });

  const player = await getPlayer();
  // Submit the just-finished score before reading the board back, so the
  // player's entry is included. submitScore no-ops when signed out.
  if (player) {
    try {
      await submitScore({ gameId, value, direction });
    } catch {
      /* ignore */
    }
  }
  const rows = await fetchLeaderboard(gameId, direction, 10);

  const rowsEl = el.querySelector<HTMLElement>('.lbsb__rows');
  if (rowsEl) {
    rowsEl.innerHTML =
      rows.length === 0
        ? '<li class="lbsb__empty">Henüz skor yok — ilk sen ol!</li>'
        : rows.map((r) => rowHtml(r, unit)).join('');
  }

  const ctaEl = el.querySelector<HTMLElement>('.lbsb__cta');
  if (ctaEl) {
    if (player) {
      ctaEl.innerHTML = `<span>Giriş: <strong>${esc(player.displayName)}</strong> — skorun kaydedildi.</span>`;
    } else {
      ctaEl.innerHTML =
        '<span>Skorunu küresel sıralamaya eklemek için giriş yap.</span>' +
        '<button class="lbsb__btn lbsb__btn--primary" data-act="login" type="button">Google ile giriş →</button>';
      ctaEl.querySelector<HTMLButtonElement>('[data-act="login"]')!.addEventListener('click', () => {
        // OAuth can't run inside the game iframe — send the top window to
        // /siralama, where sign-in works. Same-origin, so this is allowed.
        try {
          window.top!.location.href = siralamaUrl();
        } catch {
          window.location.href = siralamaUrl();
        }
      });
    }
  }
}
