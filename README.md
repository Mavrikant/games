# Tarayıcı Oyunları

Tamamen statik bir oyun arşivi. Tüm oyunlar tarayıcıda çalışır — server yok.

Production: [karaman.dev/games/](https://karaman.dev/games/)

## Stack

- Vite + TypeScript (multi-page)
- Vanilla TS oyun kodu (Canvas / DOM)
- GitHub Pages + GitHub Actions ile deploy

## Yapı

```
.
├── vite.config.ts              # root: games/, base: /games/
├── package.json
├── tsconfig.json
├── scripts/
│   └── copy-game-assets.mjs    # postbuild: thumb.* dosyalarını dist'e kopyalar
├── games/                      # Vite root
│   ├── index.html              # Arşiv anasayfası
│   ├── src/                    # Arşiv UI (kart grid, arama, iframe player)
│   │   ├── main.ts
│   │   ├── styles.css
│   │   ├── types.ts
│   │   └── games-loader.ts     # meta.json auto-discovery
│   ├── _template/              # Yeni oyun şablonu (build'e dahil değil)
│   └── <slug>/                 # Her oyun bağımsız bir Vite entry
│       ├── index.html
│       ├── game.ts
│       ├── style.css
│       ├── meta.json
│       └── thumb.svg
└── .github/workflows/deploy.yml
```

## Geliştirme

```sh
npm install
npm run dev       # http://localhost:5173/games/
npm run build     # ../dist/ (vite build + thumbnail copy)
npm run preview   # build'i lokal test et: http://localhost:4173/games/
```

## Yeni oyun ekleme

1. Şablonu kopyala:
   ```sh
   cp -r games/_template games/<slug>
   ```
2. `games/<slug>/meta.json`'ı doldur:
   ```json
   {
     "slug": "<slug>",
     "title": "Oyun Adı",
     "description": "Kısa açıklama.",
     "dateAdded": "YYYY-MM-DD",
     "tags": ["arcade"],
     "controls": "Ok tuşları",
     "thumbnail": "thumb.svg"
   }
   ```
3. `game.ts` içinde oyun mantığını yaz. `index.html` ve `style.css`'i ihtiyaca göre düzenle.
4. (Opsiyonel) `thumb.svg` / `thumb.png` / `thumb.jpg` / `thumb.webp` ekle (postbuild otomatik kopyalar).
5. Commit + push → GitHub Actions otomatik deploy eder. Arşiv `meta.json`'ları auto-discover eder, manuel kayıt gerekmez.

`_` ile başlayan klasörler (örn. `_template`) build'e dahil edilmez ve arşivde görünmez.

## Mimari notlar

- **İzolasyon**: Anasayfa karta tıkladığında oyun bir `<iframe>` içinde açılır. Her oyun ayrıca direkt URL'den (`/games/<slug>/`) tek başına da açılabilir.
- **Auto-discovery**: `games/src/games-loader.ts` `import.meta.glob('/*/meta.json')` ile tüm oyun metalarını build-time'da toplar.
- **Multi-page**: `vite.config.ts` `games/` altındaki her klasörü ayrı bir rollup entry olarak tanımlar. Vite root'u `games/` olduğundan dist çıktısı `dist/<slug>/index.html` olur ve prod URL `karaman.dev/games/<slug>/`'e maplenir.
- **Hash routing**: Anasayfada seçili oyun için `#/play/<slug>` hash kullanılır; oyunlar zaten gerçek bir HTML dosyası olduğundan SPA fallback gerekmez.

## Deploy

`main` branch'e push → Actions tetiklenir → `dist/` build edilir → GitHub Pages'e deploy. İlk kurulumdan sonra repo Settings → Pages → Source: **GitHub Actions** seçilmeli.

Domain: `Mavrikant.github.io` kullanıcı sitesi `karaman.dev`'e CNAME ile bağlıysa, `Mavrikant/games` project repo'su otomatik `karaman.dev/games/`'e maplenir. Bu repo'da ayrı bir `CNAME` dosyası gerekmez.
