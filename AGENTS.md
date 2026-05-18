# AGENTS.md

> Paralel AI ajan çalışma kuralları. Bu repo birden fazla ajanın **aynı anda**
> üretim yapacağı varsayımıyla tasarlandı. Aşağıdaki kurallara uy → merge
> çakışması yaşamazsın; uyma → işin başka ajanın işini bozar.

## Tek cümle: ne yapabilirsin, ne yapamazsın

- **Yapabilirsin**: Kendi `<slug>` adına ait yeni dosyalar oluşturmak (oyun
  ekleme), kendi oyunundaki bir bug'ı düzeltmek.
- **Yapamazsın**: Shared layer'a (layouts, ortak CSS, config, package.json,
  başka oyunun dosyaları) tek başına dokunmak.

## Görev türleri ve dosya yetkisi

| Görev | Sadece bu dosyalara yaz |
|---|---|
| Yeni oyun ekleme | `src/content/games/<slug>.json`, `src/game-bodies/<slug>.astro`, `src/game-logic/<slug>.ts`, `src/styles/games/<slug>.css?`, `public/thumbs/<slug>.svg?` |
| Mevcut oyunda bug fix | Yalnızca o oyunun `<slug>.*` dosyaları |
| Mevcut oyunda görsel polish | `src/styles/games/<slug>.css` + (varsa) `<slug>.svg` |
| Shared layer değişikliği | **DURAKLA → human review iste** |

`<slug>` = kebab-case, sadece `[a-z0-9-]`. (`my-game` ✓, `MyGame` ✗,
`my_game` ✗, `mygame2!` ✗.)

## Çakışma kaçınma prensipleri

1. **Tek dosya = tek ajan**. İki ajan asla aynı dosyaya yazmaz. Yeni oyunlar
   her zaman yeni dosyalar oluşturur (overlap yok).
2. **Auto-discovery**: Hiçbir merkezi liste güncelleme yok. Astro
   `getCollection('games')` ile yeni JSON'u otomatik görür. **Merkezi bir
   dosyaya isim eklemeye çalışma** — yok, gerek de yok.
3. **Append-only**: Eğer bir noktada paylaşılan bir log/index dosyasına
   eklemek **zorunda kalırsan**, sadece sonuna ekle (silme, sıralama
   değiştirme yok). Şu an böyle bir dosya yok.
4. **Idempotent**: Aynı oyunu iki kez scaffold etme. `npm run new-game <slug>`
   dosya varsa hata verir; üzerine yazmaz.
5. **Bağımlılık eklemek YASAK**: `package.json`/`package-lock.json`'a dokunma.
   Hepsi paylaşılan; iki ajan ekleme yaparsa kilitlenir. Vanilla TS yeter.

## Branch ve commit konvansiyonu

```
branch: add-<slug>          # yeni oyun
branch: fix-<slug>-<short>  # mevcut oyun bug fix
branch: polish-<slug>       # mevcut oyun görsel
branch: shared-<short>      # shared layer (human review zorunlu)

commit: Add <Title>                     # yeni oyun (tek commit ideal)
commit: Fix <slug>: <kısa açıklama>     # bug fix
```

Asla `main`'e doğrudan push etme. Her zaman PR aç.

## PR kuralları

- Her oyun **tek PR**'dır. Birden fazla oyunu aynı PR'a koyma.
- PR template (`.github/PULL_REQUEST_TEMPLATE.md`) sahnelerini doldur.
- Açmadan önce **lokalde** doğrula:
  ```sh
  npm run build              # type-check + build, sıfır error
  npm run dev                # /games/<slug>/ tarayıcıda aç, oyna
  ```
- CI otomatik tekrar koşar; lokalde geçen build CI'da da geçer.

## Spawning workflow (otonom döngü)

Tipik bir ajan turuyla:

```
1.  Konu/oyun fikrini al
2.  git checkout -b add-<slug>
3.  npm run new-game <slug> -- --title "..." --description "..."
4.  Dosyaları doldur:
      - game-bodies/<slug>.astro  → minimal markup
      - game-logic/<slug>.ts      → oyun mantığı
      - styles/games/<slug>.css   → (gerekiyorsa) görsel
      - public/thumbs/<slug>.svg  → (opsiyonel) kart görseli
      - content/games/<slug>.json → meta zaten dolu, son rötuş
5.  npm run build                 → hata varsa düzelt, döngüye gir
6.  npm run dev → DOM'da çalış, smoke test yap
7.  git add <kendi dosyaların>    → git add -A YASAK (başka ajanın
                                    geçici dosyasını yutmasın)
8.  git commit -m "Add <Title>"
9.  git push -u origin add-<slug>
10. gh pr create --fill
11. CI yeşil olunca insan/auto-merge devralır
```

**8. adımdaki `git add -A` kısıtı önemli**: Diğer ajanların branch'leri
worktree'de olabilir. Sadece kendi oyununun dosyalarını stage et:

```sh
git add \
  src/content/games/<slug>.json \
  src/game-bodies/<slug>.astro \
  src/game-logic/<slug>.ts \
  src/styles/games/<slug>.css \
  public/thumbs/<slug>.svg
```

## Smoke test (PR öncesi)

```sh
# Dev server zaten açıksa skip
npm run dev &
DEV_PID=$!
sleep 4
curl -sf http://localhost:4321/games/                  > /dev/null || exit 1
curl -sf http://localhost:4321/games/<slug>/           > /dev/null || exit 1
kill $DEV_PID
```

CI bunu farklı şekilde yapar; sen sadece `npm run build` ile yetinebilirsin.

## Hangi durumda human review istersin?

Aşağıdaki durumlardan biri varsa **kod yazmadan önce** PR'da soru aç veya
issue tag'le:

- Shared layer değişikliği (`layouts/`, `tokens.css`, `base.css`,
  `game-shell.css`, `archive.css`, `content.config.ts`, `astro.config.mjs`,
  `package.json`, herhangi bir `.github/` dosyası)
- Yeni dependency
- Build pipeline değişikliği
- Mevcut bir oyunun davranışını başka bir ajanın ekleyeceği değişikliklere
  bağımlı hale getirme
- Lisans, copyright, marka değişikliği
- 3rd party API / fetch (statik proje — backend yok)

## Yasaklar (hard rules)

- ❌ `package.json` / `package-lock.json` düzenleme
- ❌ Başka bir oyunun (`<other-slug>.*`) dosyalarına dokunma
- ❌ Shared CSS/layout/config'i değiştirme
- ❌ Yeni dependency ekleme
- ❌ `git push --force`, `git rebase main`, `main` branch'e doğrudan push
- ❌ `.github/` altında değişiklik (workflow, PR template, CODEOWNERS)
- ❌ Externalde host edilen asset (CDN, image bucket) gömme — repo
  içinde `public/` altında dur
- ❌ `fetch()` ile remote endpoint çağrısı
- ❌ Build çıktısını (`dist/`) commit etme
- ❌ `.DS_Store`, `.env`, IDE config commit etme

## Hızlı referans tablosu

| Soru | Cevap |
|---|---|
| Yeni oyun nereye? | `src/content/games/`, `src/game-bodies/`, `src/game-logic/` |
| Oyunun URL'i? | `karaman.dev/games/<slug>/` (otomatik) |
| Meta schema? | [src/content.config.ts](src/content.config.ts) |
| Tema/palet değişikliği? | Shared — human review |
| Yeni `npm` paketi? | YASAK |
| Build kırıldı? | `npm run check` ile detay; kendi dosyalarını düzelt |
| Eski oyunlar çalışıyor mu? | `npm run build` geçiyorsa evet (regression test) |

## Daha fazla okuma

- [CLAUDE.md](CLAUDE.md) — proje girişi
- [docs/ADDING_A_GAME.md](docs/ADDING_A_GAME.md) — adım adım yeni oyun
- [docs/GAME_CONTRACT.md](docs/GAME_CONTRACT.md) — oyun DOM/lifecycle kontratı
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — code style
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — build pipeline detay
