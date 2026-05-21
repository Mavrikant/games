// Standard overlay show/hide. Use these on any element that visually
// represents a modal-style overlay (game-over, win, pause, level-complete).
//
// Combines CSS class `overlay--hidden` (visual) with `aria-hidden` attribute
// (accessibility) — keeping these in sync manually across 46 games led to
// drift (some games set only classList, some only aria-hidden). This helper
// makes the two atomic.
//
// Required CSS: caller's stylesheet must define `.overlay--hidden { display:
// none }` (or visibility:hidden). The shared archive shell ships this for
// `.overlay`; per-game overlays can reuse the modifier name with their own
// base class.

export function showOverlay(el: HTMLElement): void {
  el.classList.remove('overlay--hidden');
  el.setAttribute('aria-hidden', 'false');
}

export function hideOverlay(el: HTMLElement): void {
  el.classList.add('overlay--hidden');
  el.setAttribute('aria-hidden', 'true');
}

export function isOverlayHidden(el: HTMLElement): boolean {
  return el.classList.contains('overlay--hidden');
}
