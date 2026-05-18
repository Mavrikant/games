# Mimari

> Tek statement: **Astro static site, file-based routing, content
> collections. Her oyun bir slug; build üç yere bakar (meta + body + logic)
> ve `dist/<slug>/index.html` üretir.**

## 30 saniyede pipeline

```
src/content/games/<slug>.json   ──┐
                                  ├──► getStaticPaths() in pages/[slug].astro
src/game-bodies/<slug>.astro   ───┤        │
                                  │        ▼
src/game-logic/<slug>.ts       ───┘   render: GameLayout > BaseLayout
                                            │
                                            ▼
                                  dist/<slug>/index.html
                                  dist/_astro/<slug>-<hash>.js
                                  dist/thumbs/<slug>.svg  ← public/'ten kopya

src/pages/index.astro    ────► dist/index.html (arşiv)
src/archive/main.ts      ────► dist/_astro/hoisted-<hash>.js
```

## Dosya rolleri

### Layouts

- `src/layouts/BaseLayout.astro` — `<html>`, `<head>`, `<meta>`, Inter font,
  global stiller (`tokens.css`, `base.css`). Tüm sayfalar bunu sarar.
- `src/layouts/GameLayout.astro` — `BaseLayout` + `<main class="stage">` +
  hint paragraph. Oyun sayfası slot içeriği `<main>` içine girer.

### Routing

- `src/pages/index.astro` — arşiv anasayfası. `getCollection('games')` çağırır,
  her oyun için `<Card>` render eder, `<PlayerOverlay>` ile iframe player'ı
  yerleştirir.
- `src/pages/[slug].astro` — dinamik route. `getStaticPaths` her oyun için
  bir path üretir. Build sırasında:
  - `import.meta.glob('/src/game-bodies/*.astro', { eager: true })` ile body
    component'ı resolve eder
  - `import.meta.glob('/src/styles/games/*.css', { query: '?inline', eager: true })`
    ile sadece bu oyunun CSS'ini inline `<style>` olarak basar (per-game
    scope; başka oyunun CSS'i bu sayfaya sızmaz)
  - Bir `<script>` tag URL'den slug çıkarıp
    `import.meta.glob('/src/game-logic/*.ts')` ile ilgili modülü dinamik
    import eder. Vite her oyun için ayrı chunk üretir.

### Content collection

- `src/content.config.ts` — zod ile `GameMeta` şeması + `glob` loader.
  Schema yanlış JSON'u build'de hata olarak yakalar.
- `src/content/games/<slug>.json` — her oyun için bir JSON. Alanlar:
  `title`, `description`, `dateAdded`, `tags`, `controls?`, `thumbnail?`.

### Per-game

- `src/game-bodies/<slug>.astro` — oyuna özel DOM. `<head>` yazma — sadece
  body fragment. Layout sarmalar.
- `src/game-logic/<slug>.ts` — oyun mantığı. Body markup'ta tanımlı ID/class
  ile `document.querySelector` ile bağlanır. Yan etki = dosyanın çalışması
  (modül seviyesinde init).
- `src/styles/games/<slug>.css` — opsiyonel oyuna özel CSS. Sadece kendi
  sayfasında inline yüklenir (per-page CSS scope).

### Shared styles

CSS sıralaması (cascade): `tokens.css` → `base.css` → `game-shell.css` →
`games/<slug>.css` (per-page).

- `tokens.css` — CSS variables (palet, radius, font)
- `base.css` — reset (box-sizing, body, html, link)
- `game-shell.css` — `.stage`, `.hud`, `.hud__btn`, `.hint`
- `archive.css` — sadece anasayfada yüklenir (nav, hero, card, player)
- `games/<slug>.css` — sadece o oyun sayfasında inline

### Components

- `src/components/Nav.astro` — sticky top nav (brand, count, GitHub link)
- `src/components/Card.astro` — arşiv oyun kartı (thumb, title, desc, meta)
- `src/components/PlayerOverlay.astro` — iframe player bar + iframe

### Archive runtime

- `src/archive/main.ts` — anasayfa script. Build sırasında `<script
  id="games-data" type="application/json">` ile data inject edilir; runtime
  bunu okuyup search/filter/sort uygular. Iframe player nav + hash sync de
  burada.

### Public

- `public/thumbs/<slug>.svg` — kart önizleme. Astro `public/` içeriğini
  olduğu gibi `dist/`'e kopyalar; CSS bundling YOK (asset olarak servis).

## Build adımları (detay)

```
npm run build
  └─ astro check        ← TypeScript + Astro tag denetimi
  └─ astro build
      ├─ content collection scan + zod validate
      ├─ getStaticPaths → her oyun için route
      ├─ Vite client bundle
      │   ├─ hoisted.js (archive script)
      │   └─ <slug>.js (her oyun mantığı, ayrı chunk)
      ├─ CSS inline (per-page) + global (_astro/*.css)
      ├─ HTML render (pages + dynamic routes)
      └─ public/ copy → dist/
```

Çıktı (tipik):
```
dist/
├── index.html
├── snake/index.html
├── tic-tac-toe/index.html
├── thumbs/
│   ├── snake.svg
│   └── tic-tac-toe.svg
└── _astro/
    ├── index.<hash>.css           ← global (archive + tokens + base + shell)
    ├── hoisted.<hash>.js          ← archive runtime
    └── <slug>.<hash>.js           ← per-game logic chunk
```

## URL eşlemesi

`astro.config.mjs` içinde `base: '/games/'`. Build asset URL'leri
`/games/_astro/...` ile başlar. GitHub Pages sub-path (project repo + user
site CNAME) bunu `karaman.dev/games/`'e maps eder.

| Route (Astro) | Production URL |
|---|---|
| `/` | `karaman.dev/games/` |
| `/<slug>/` | `karaman.dev/games/<slug>/` |
| `/thumbs/<slug>.svg` | `karaman.dev/games/thumbs/<slug>.svg` |

## İframe izolasyonu

Arşiv UI'si bir `<iframe id="player-frame">` içinde oyunu yükler. Her oyun
ayrı bir `Window`/`Document` aldığı için:

- Global state çakışması yok
- CSS variable/class çakışması yok
- Bir oyun çökerse arşiv ayakta kalır
- Aynı oyun direkt URL'den de açılabilir (`karaman.dev/games/snake/`)

Bu izolasyon **garanti edilir**; oyun mantığında `window.parent`'a güvenme.

## Generator (`scripts/new-game.mjs`)

Yeni oyun için 5 dosyayı şablondan kopyalar, `__SLUG__`/`__TITLE__`/etc
placeholder'ları doldurur. Detay:
[ADDING_A_GAME.md](ADDING_A_GAME.md).

## Sonradan eklemek için iyi alanlar (henüz yok)

- Lighthouse CI (perf budget)
- E2E smoke test (Playwright — her oyun render olabiliyor mu?)
- Image optimization (`<Image>` ile PNG/JPG thumbs)
- Service worker (offline cache — gereksiz olabilir, statik zaten)
- View transitions (sayfa geçişleri yumuşatma)

Bunların hiçbiri **şu an gerekli değil**; eklemeden önce kullanım gerekçesini
[CONVENTIONS.md](CONVENTIONS.md) "no premature abstraction" prensibine göre
sorgula.
