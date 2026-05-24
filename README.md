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

## PWA olarak kurma

Site bir PWA'dır — çevrimdışı çalışır ve ana ekrana kurulabilir:

- **Android (Chrome):** üstteki **İndir** butonu (ya da menü ⋮ → **Ana ekrana ekle**).
- **iOS (Safari):** **Paylaş** → **Ana Ekrana Ekle**.

Kurulduktan sonra daha önce açtığın oyunlar çevrimdışı da oynanabilir. Yeni
sürümler arka planda **otomatik** güncellenir — bir sonraki açılışta en güncel
sürümü alırsın (elle yenileme gerekmez).

## Yeni oyun ekleme

```sh
npm run new-game my-game -- \
  --title "My Game" \
  --description "Kısa açıklama" \
  --tags "arcade,klasik"
```

Bu, gereken 4 dosyayı şablondan üretir:
- `src/content/games/my-game.json` (meta; tag/title doldurulmuş)
- `src/game-bodies/my-game.astro` (DOM markup placeholder)
- `src/game-logic/my-game.ts` (logic placeholder)
- `src/styles/games/my-game.css` (oyuna özel CSS)

Dosyaları gerçek içerikle doldur, `npm run build && npm run dev` ile doğrula,
commit + PR aç. Arşiv `getCollection('games')` ile otomatik keşfeder; merkezi
liste güncelleme yok.

Adım adım: [docs/ADDING_A_GAME.md](docs/ADDING_A_GAME.md).

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

## AI ajan ile katkı

Bu repo paralel AI ajan üretimine göre tasarlandı. Eğer bir ajan tarafından
çalıştırılıyorsan **ilk önce** şunları oku:

1. [CLAUDE.md](CLAUDE.md) — repo girişi, neyi yapabilirsin/yapamazsın
2. [AGENTS.md](AGENTS.md) — paralel çalışma kuralları, çakışma kaçınma
3. [docs/ADDING_A_GAME.md](docs/ADDING_A_GAME.md) — yeni oyun akışı
4. [docs/GAME_CONTRACT.md](docs/GAME_CONTRACT.md) — DOM/lifecycle kontratı
5. [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — kod & stil
6. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — derin yapı / build pipeline

PR'lar `.github/workflows/pr-check.yml` ile otomatik kontrol edilir
(astro check + build + her oyun route'unun üretildiğini doğrulama).
