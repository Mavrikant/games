// A small set of quick mini-games. To open a hidden memory the player must win a
// randomly-chosen one. Each builder fills `host` and calls finish(win). Builders
// return a cleanup fn (clear timers / RAF). cancelMiniGame() aborts the active
// one (used when restarting mid-game).

import { ensureAudio, sfxClick, sfxFail, sfxPickup } from './audio';
import { gen } from './state';
import type { MiniGameId } from './types';

type Finish = (win: boolean) => void;
type Builder = (host: HTMLElement, finish: Finish) => () => void;

let activeFinish: Finish | null = null;

const refleks: Builder = (host, finish) => {
  host.innerHTML =
    `<div class="yi-mini"><h3 class="yi-mini__title">Refleks</h3>` +
    `<p class="yi-mini__hint">Yeşil olunca hemen tıkla!</p>` +
    `<button class="yi-mini__pad yi-mini__pad--wait" type="button">Bekle…</button></div>`;
  const pad = host.querySelector<HTMLButtonElement>('.yi-mini__pad')!;
  let green = false;
  const myGen = gen.current();
  const t1 = window.setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;
    green = true;
    pad.classList.replace('yi-mini__pad--wait', 'yi-mini__pad--go');
    pad.textContent = 'TIKLA!';
  }, 900 + Math.random() * 1500);
  const t2 = window.setTimeout(() => green && finish(false), 4200);
  pad.onclick = () => {
    ensureAudio();
    if (!green) {
      sfxFail();
      finish(false);
    } else {
      sfxPickup();
      finish(true);
    }
  };
  return () => {
    clearTimeout(t1);
    clearTimeout(t2);
  };
};

const hedef: Builder = (host, finish) => {
  host.innerHTML =
    `<div class="yi-mini"><h3 class="yi-mini__title">Hedef Avı</h3>` +
    `<p class="yi-mini__hint">5 hedefi 8 saniyede vur</p>` +
    `<div class="yi-mini__field"><button class="yi-mini__target" type="button" aria-label="hedef"></button></div>` +
    `<div class="yi-mini__bar">Süre <b class="yi-mini__t">8.0</b>s · Vuruş <b class="yi-mini__h">0</b>/5</div></div>`;
  const target = host.querySelector<HTMLButtonElement>('.yi-mini__target')!;
  const tEl = host.querySelector<HTMLElement>('.yi-mini__t')!;
  const hEl = host.querySelector<HTMLElement>('.yi-mini__h')!;
  let hits = 0;
  let left = 8.0;
  const move = (): void => {
    target.style.left = `${8 + Math.random() * 84}%`;
    target.style.top = `${14 + Math.random() * 72}%`;
  };
  move();
  target.onclick = () => {
    ensureAudio();
    sfxClick();
    hits++;
    hEl.textContent = String(hits);
    if (hits >= 5) {
      sfxPickup();
      finish(true);
    } else move();
  };
  const iv = window.setInterval(() => {
    left -= 0.1;
    tEl.textContent = left.toFixed(1);
    if (left <= 0) {
      sfxFail();
      finish(false);
    }
  }, 100);
  return () => clearInterval(iv);
};

const hafiza: Builder = (host, finish) => {
  const COLORS = ['#FF4081', '#00BCD4', '#FFEB3B', '#66BB6A'];
  const seq = Array.from({ length: 3 }, () => Math.floor(Math.random() * 4));
  host.innerHTML =
    `<div class="yi-mini"><h3 class="yi-mini__title">Hafıza</h3>` +
    `<p class="yi-mini__hint yi-mini__status">İzle…</p>` +
    `<div class="yi-mini__tiles">${COLORS.map((c, i) => `<button class="yi-mini__tile" type="button" data-i="${i}" style="background:${c}" aria-label="renk ${i + 1}"></button>`).join('')}</div></div>`;
  const tiles = Array.from(host.querySelectorAll<HTMLButtonElement>('.yi-mini__tile'));
  const status = host.querySelector<HTMLElement>('.yi-mini__status')!;
  let accept = false;
  let idx = 0;
  const timers: number[] = [];
  const myGen = gen.current();
  const flash = (i: number): void => {
    const t = tiles[i];
    if (!t) return;
    t.classList.add('yi-mini__tile--on');
    timers.push(window.setTimeout(() => t.classList.remove('yi-mini__tile--on'), 320));
  };
  seq.forEach((s, k) =>
    timers.push(
      window.setTimeout(() => {
        if (!gen.isCurrent(myGen)) return;
        flash(s);
        if (k === seq.length - 1) {
          timers.push(
            window.setTimeout(() => {
              accept = true;
              status.textContent = 'Şimdi tekrarla';
            }, 480),
          );
        }
      }, 560 * (k + 1)),
    ),
  );
  tiles.forEach((t) => {
    t.onclick = () => {
      if (!accept) return;
      ensureAudio();
      const i = Number(t.dataset.i);
      flash(i);
      if (i === seq[idx]) {
        idx++;
        sfxClick();
        if (idx >= seq.length) {
          sfxPickup();
          finish(true);
        }
      } else {
        sfxFail();
        finish(false);
      }
    };
  });
  return () => timers.forEach(clearTimeout);
};

const zamanlama: Builder = (host, finish) => {
  host.innerHTML =
    `<div class="yi-mini"><h3 class="yi-mini__title">Zamanlama</h3>` +
    `<p class="yi-mini__hint">İşaretçi yeşil bölgedeyken DUR'a bas</p>` +
    `<div class="yi-mini__track"><div class="yi-mini__zone"></div><div class="yi-mini__marker"></div></div>` +
    `<button class="yi-btn yi-btn--turq yi-mini__stop" type="button">DUR</button></div>`;
  const marker = host.querySelector<HTMLElement>('.yi-mini__marker')!;
  const zone = host.querySelector<HTMLElement>('.yi-mini__zone')!;
  const zStart = 32 + Math.random() * 32;
  const zW = 18;
  zone.style.left = `${zStart}%`;
  zone.style.width = `${zW}%`;
  let pos = 0;
  let dir = 1;
  let raf = 0;
  let running = true;
  const myGen = gen.current();
  const tick = (): void => {
    if (!running || !gen.isCurrent(myGen)) return;
    pos += dir * 1.5;
    if (pos >= 100) {
      pos = 100;
      dir = -1;
    } else if (pos <= 0) {
      pos = 0;
      dir = 1;
    }
    marker.style.left = `${pos}%`;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  host.querySelector<HTMLButtonElement>('.yi-mini__stop')!.onclick = () => {
    ensureAudio();
    running = false;
    cancelAnimationFrame(raf);
    if (pos >= zStart && pos <= zStart + zW) {
      sfxPickup();
      finish(true);
    } else {
      sfxFail();
      finish(false);
    }
  };
  return () => {
    running = false;
    cancelAnimationFrame(raf);
  };
};

const GAMES: Record<MiniGameId, Builder> = { refleks, hedef, hafiza, zamanlama };

export function cancelMiniGame(): void {
  activeFinish?.(false);
}

export function playRandomMiniGame(host: HTMLElement): Promise<boolean> {
  const ids = Object.keys(GAMES) as MiniGameId[];
  const id = ids[Math.floor(Math.random() * ids.length)]!;
  return new Promise<boolean>((resolve) => {
    let done = false;
    let cleanup: (() => void) | null = null;
    const finish: Finish = (win) => {
      if (done) return;
      done = true;
      activeFinish = null;
      try {
        cleanup?.();
      } catch {
        /* ignore */
      }
      resolve(win);
    };
    activeFinish = finish;
    cleanup = GAMES[id](host, finish);
  });
}
