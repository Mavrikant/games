# Tarayıcı Oyunları

Tamamen statik bir oyun arşivi. Tüm oyunlar tarayıcıda çalışır — server yok.

Production: [karaman.dev/games/](https://karaman.dev/games/)

## Stack

- **Astro 4** (file-based routing, content collections, type-safe meta)
- TypeScript (vanilla TS oyun mantığı, Canvas / DOM)
- GitHub Pages + GitHub Actions ile deploy

## Yapı

```
.
├── astro.config.mjs              # site, base: '/games/', trailingSlash
├── package.json
├── tsconfig.json                 # extends astro/tsconfigs/strict
├── public/
│   └── thumbs/                   # oyun thumbnail SVG/PNG
├── src/
│   ├── layouts/
│   │   ├── BaseLayout.astro      # html + head + font + body (tüm sayfalar)
│   │   └── GameLayout.astro      # stage + hint wrapper (oyun sayfaları)
│   ├── pages/
│   │   ├── index.astro           # arşiv (kart grid, filtre, iframe player)
│   │   └── [slug].astro          # dinamik oyun route (getStaticPaths)
│   ├── content/
│   │   ├── config.ts             # zod schema (title, desc, tags, controls, …)
│   │   └── games/                # her oyun = bir .json
│   │       ├── snake.json
│   │       └── tic-tac-toe.json
│   ├── game-bodies/              # oyuna özel DOM (Astro markup)
│   │   ├── snake.astro
│   │   └── tic-tac-toe.astro
│   ├── game-logic/               # oyun TS modülü (mantık)
│   │   ├── snake.ts
│   │   └── tic-tac-toe.ts
│   ├── components/               # Nav, Card, PlayerOverlay
│   ├── styles/
│   │   ├── tokens.css            # CSS değişkenleri (renk, radius, font)
│   │   ├── base.css              # reset
│   │   ├── game-shell.css        # stage, hud, hud__btn
│   │   ├── archive.css           # anasayfa
│   │   └── games/                # oyuna özel stiller (her sayfada sadece kendi yüklenir)
│   │       ├── snake.css
│   │       └── tic-tac-toe.css
│   └── archive/
│       └── main.ts               # arşiv runtime (search, filter, sort, iframe nav)
└── .github/workflows/deploy.yml
```

## Geliştirme

```sh
npm install
npm run dev       # http://localhost:4321/games/
npm run build     # astro check + astro build → dist/
npm run preview   # build'i lokal test et
```

## Yeni oyun ekleme

Sadece 3 dosya:

1. **Meta** — `src/content/games/<slug>.json`
   ```json
   {
     "title": "Oyun Adı",
     "description": "Kısa açıklama.",
     "dateAdded": "YYYY-MM-DD",
     "tags": ["arcade"],
     "controls": "Ok tuşları",
     "thumbnail": "<slug>.svg"
   }
   ```
2. **DOM** — `src/game-bodies/<slug>.astro` (sadece oyuna özel markup; head/body/stage zaten layout'tan)
3. **Mantık** — `src/game-logic/<slug>.ts` (DOM event listener'ları)

Opsiyonel:
- `src/styles/games/<slug>.css` — oyuna özel CSS (otomatik scope edilir, sadece kendi sayfasında yüklenir)
- `public/thumbs/<slug>.svg` — kart önizleme görseli

Commit + push → GitHub Actions ~30 saniyede deploy eder. Arşiv `getCollection('games')` ile auto-discover.

## Mimari notlar

- **Tek HTML kaynağı**: `BaseLayout.astro` head/font/meta tek yer; `GameLayout.astro` stage wrapper'ı tek yer. Yeni oyun eklerken HTML boilerplate yazılmaz.
- **CSS scope**: `[slug].astro` glob ile sadece o oyunun CSS'ini inline `<style is:global>` olarak yükler. Cascade order: tokens → base → game-shell → per-game.
- **Type-safe meta**: `src/content/config.ts`'deki zod schema her `games/*.json`'ı build-time'da doğrular.
- **Dinamik route**: `pages/[slug].astro` + `getStaticPaths` her oyun için ayrı static HTML (`/games/snake/`, `/games/tic-tac-toe/`).
- **İzolasyon**: Arşiv `<iframe>` ile oyunu gömer; her oyun ayrıca direkt URL'inde de tek başına çalışır.
- **Tema**: tek `tokens.css` — palet/font değişikliği tüm site için tek yerden.

## Deploy

`main` branch'e push → Actions tetiklenir → `astro build` → `dist/` GitHub Pages'e deploy.

Domain: `Mavrikant.github.io` kullanıcı sitesi `karaman.dev`'e CNAME ile bağlı olduğundan `Mavrikant/games` project repo'su `karaman.dev/games/`'e maplenir.
