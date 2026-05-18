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
3. **Modül yan etkisi**: Logic dosyası en üst seviyede DOM'u sorgular,
   event handler bağlar, oyunu init eder. Export gerekmez.

```ts
// src/game-logic/<slug>.ts
const board = document.querySelector<HTMLCanvasElement>('#board')!;
const restart = document.querySelector<HTMLButtonElement>('#restart')!;

function reset() { /* ... */ }

restart.addEventListener('click', reset);
reset();   // ← init
```

DOM yüklendiğinde script de yüklendiği için `DOMContentLoaded` beklemek
**gerekli değil** — Astro `<script>` tag'i body sonunda. Yine de zarar yok.

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
- JSON serileştirilebilir veriler için `JSON.stringify`/`JSON.parse`
- try/catch ile koru (kullanıcı disable etmiş olabilir)

```ts
const KEY = 'my-game.best';
let best = Number(localStorage.getItem(KEY) ?? '0') || 0;
try { localStorage.setItem(KEY, String(best)); } catch { /* ignore */ }
```

`sessionStorage` da kullanılabilir; ama oyun reload'ında skor silinir.

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
- ✅ İlk render'ı modül en sonunda yap (`init()` / `reset()`)
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
