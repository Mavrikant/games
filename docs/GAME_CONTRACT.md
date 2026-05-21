# Game Contract

> Oyun-mantığı dosyasının (`src/game-logic/<slug>.ts`) ve oyun-body
> dosyasının (`src/game-bodies/<slug>.astro`) birbiriyle ve shell ile
> uyumlu çalışmasını sağlayan kurallar.

## Lifecycle

1. **Build-time**: `pages/[slug].astro` body component'i render eder
   (markup HTML'e döner) ve sayfa sonuna bir `<script>` tag ekler.
2. **Runtime (sayfa açıldığında)**: `<script>` URL'den slug çıkarır ve
   `import.meta.glob('/src/game-logic/*.ts')` ile ilgili modülü dinamik
   import eder.
3. **Modül entry**: Logic dosyası `defineGame({ init })` export eder.
   `defineGame` queueMicrotask ile `init()`'i otomatik çağırır — DOM
   parse sonrası, manuel çağrıya gerek yok.

```ts
// src/game-logic/<slug>.ts
import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';

let board!: HTMLCanvasElement;
let restartBtn!: HTMLButtonElement;

function reset(): void { /* ... */ }

function init(): void {
  // Tüm DOM querySelector + addEventListener + localStorage erişimi burada.
  board = document.querySelector<HTMLCanvasElement>('#board')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  restartBtn.addEventListener('click', reset);
  reset();
}

export const game = defineGame({ init, reset });
```

**Module-level side effect yazma.** `const x = document.querySelector(...)`
top-level → PITFALLS#module-level-dom-access. Aynı sınıfta: top-level
`localStorage.getItem`, top-level event listener, top-level
`new ResizeObserver`. Hepsi `init()` içine.

CI'da `npm run audit:games --ci` bu kuralı zorunlu kılar (build fail).

## DOM bağlama kontratı

Logic dosyası sadece kendi body dosyasında tanımlı ID/class'lara `querySelector`
yapar. Cross-game selector **yasak** (iframe içinde zaten görmezsin ama
direkt URL'de bile yapma).

| Konu | Convention |
|---|---|
| Element ID | Tek kelime, kebab veya camel: `board`, `restart`, `player-name` |
| Class | BEM: `block__elem--mod` (örn. `hud__btn`, `cell--active`) |
| Slug-prefix? | Hayır; iframe izolasyonu garanti |
| Global ID çakışması? | Hayır; her oyun ayrı iframe document |

## Paylaşılan CSS class'ları (free styling)

Body markup'ında bu class'ları kullanırsan `game-shell.css`'ten gelen stiller
otomatik uygulanır. **Kendin yeniden tanımlama** — sadece kullan.

| Class | Ne yapar |
|---|---|
| `.stage` | `GameLayout` zaten `<main class="stage">` veriyor; sen body'de tekrar wrap etme |
| `.hud` | Üst HUD bar (flex, gap) |
| `.hud__btn` | Standart buton (border, padding, hover) |
| `.hint` | Layout zaten footer hint'i kontrol ediyor; sen tekrar yazma |

Daha fazla widget ihtiyacın varsa kendi CSS'ine yaz; shared'a ekleme **human
review** gerektirir.

## State persistence (localStorage)

- Tek state mekanizması: `localStorage` (server yok)
- Anahtar prefix: `<slug>.` — örn. `snake.best`, `xox.scores`
- Erişim **her zaman** `@shared/storage` üzerinden (JSON-encoded, try/catch built-in)

```ts
import { safeRead, safeWrite } from '@shared/storage';

const KEY = 'my-game.best';

// Generic, fallback değer döner; localStorage throw etse bile crash etmez.
let best = safeRead<number>(KEY, 0);

// En iyi skor değiştiğinde:
safeWrite(KEY, best);
```

Ham `localStorage.getItem`/`setItem` çağrısı yasak — PITFALLS#unguarded-storage.
CI'da `npm run audit:games --ci` yakalar.

İstisna: önceden raw-string formatında saklanan veri varsa (örn.
`localStorage.setItem(KEY, 'easy')`) ve format'ı korumak gerekiyorsa, local
`try { localStorage.getItem(...) } catch { return fallback; }` pattern'i
geçerli (örnek: `src/game-logic/memory.ts` `loadDifficulty`).

`sessionStorage` da kullanılabilir ama reload'da silinir.

## Event handling

| Olay | Notlar |
|---|---|
| `click`/`pointerdown` | İframe içinde sorun yok |
| `keydown`/`keyup` | İframe focus aldığında çalışır. Karta tıklayınca otomatik focus alır; yine de `e.preventDefault()` çağırarak parent'a sıçramayı önle |
| `resize` | Canvas'ı responsive yap; `cellSize = canvas.width / COLS` gibi |
| `gamepadconnected` | Allowed; opsiyonel |
| `beforeunload` | Kullanma — kullanıcıyı engelleme |

## Canvas rendering

Standart paterni izlemek zorunda değilsin, ama tutarlılık için:

- `canvas.width`/`height` HTML'de tanımlı; logic'te DPR scaling opsiyonel
- Renkleri CSS variable üzerinden oku: `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`
- Animation loop: `requestAnimationFrame` veya `setInterval` (basit oyunlar
  için interval yeterli)

## Theming via CSS variables

Game logic'inin renkleri shared paletten almasını sağla. Bu sayede tema
değişimi tek `tokens.css` değişikliğiyle tüm oyunlara yansır.

```ts
const cssCache = new Map<string, string>();
function getCss(varName: string): string {
  const cached = cssCache.get(varName);
  if (cached !== undefined) return cached;
  const val = getComputedStyle(document.documentElement)
    .getPropertyValue(varName).trim();
  cssCache.set(varName, val);
  return val;
}

ctx.fillStyle = getCss('--accent');
```

Snake'in çiziminde aynı pattern var; referans:
[src/game-logic/snake.ts](../src/game-logic/snake.ts).

## Yapma listesi (don'ts)

- ❌ `document.title = ...` değiştirme — layout title'ı set ediyor
- ❌ `<head>` manipülasyonu (meta, link inject)
- ❌ `fetch()` ile remote API
- ❌ `<script src="cdn...">` (extern asset)
- ❌ `window.parent` / `window.top` / `postMessage` (iframe içinde
  çalışıyorsun ama direkt URL'de bunlar undefined olabilir)
- ❌ `alert()`, `confirm()`, `prompt()` — modal kullan
- ❌ `eval`, `new Function()` — güvenlik
- ❌ Inline `<style>` tag içinde CSS — file'a yaz
- ❌ Mevcut paylaşılan token'ları (`--bg`, `--accent`, ...) `:root`'ta
  yeniden tanımlama

## Yap listesi (do's)

- ✅ TypeScript strict — `noUncheckedIndexedAccess` aktif, array index
  null kontrol gerekli (`arr[0]!` veya guard)
- ✅ `defineGame({ init, reset })` export et; tüm side effect `init()` içinde
- ✅ Storage `@shared/storage`, async iptal `@shared/gen-token`, overlay `@shared/overlay` ([docs/SHARED_HELPERS.md](SHARED_HELPERS.md))
- ✅ Cleanup gerekmez (her sayfa kendi document'ı)
- ✅ İskelet markup body dosyasında, dinamik markup logic'te
- ✅ A11y: `aria-label` canvas/button'larda, `role="grid"` görsel grid'lerde
- ✅ Mobile-first; touch events ekle veya `<button>` ile alternatif kontrol

## Örnekler

İki canonical referans var:

- [src/game-bodies/snake.astro](../src/game-bodies/snake.astro) +
  [src/game-logic/snake.ts](../src/game-logic/snake.ts) — canvas + keyboard
- [src/game-bodies/tic-tac-toe.astro](../src/game-bodies/tic-tac-toe.astro) +
  [src/game-logic/tic-tac-toe.ts](../src/game-logic/tic-tac-toe.ts) — DOM
  grid + click
