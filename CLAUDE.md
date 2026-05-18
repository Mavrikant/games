# CLAUDE.md

> Bu repoyu okuyan AI ajanı için **birinci durak**. İnsan okuyucu için kısa
> giriş `README.md`'dedir; derin referanslar `docs/` altındadır.

## Bir cümleyle proje

`karaman.dev/games/` adresinde yayınlanan, tamamen statik bir tarayıcı oyunları
arşivi. Hiçbir backend yok; her oyun bir HTML sayfası + bir TS modülünden
oluşur ve Astro build pipeline'ı tarafından üretilir.

## Sen (ajan) burada ne yapıyorsun?

Bu repodaki tipik görevin **yeni bir oyun eklemek**. Daha nadir olarak:
mevcut bir oyunu polishlemek, ortak UI/shared layer'ı genişletmek, build
boru hattını iyileştirmek.

> Üretim repository'i çoklu ajanı paralel kabul eder. Sen yalnız değilsin;
> başka ajanlar aynı anda farklı oyunlar ekliyor olabilir. Çakışmayı önleyen
> kuralları **mutlaka** [AGENTS.md](AGENTS.md) içinden oku.

## En kısa "yeni oyun ekleme" akışı

```bash
# 1. Scaffold (her şeyi seninle aynı yapıdaki dosyalara taşır)
npm run new-game my-game -- --title "My Game" --description "Kısa açıklama"

# 2. Dosyaları doldur (placeholder'lar yerine gerçek içerik)
#    src/game-bodies/my-game.astro   ← DOM markup
#    src/game-logic/my-game.ts       ← oyun mantığı
#    src/styles/games/my-game.css    ← (opsiyonel) oyuna özel CSS
#    src/content/games/my-game.json  ← meta (zaten doldurulmuş)
#    public/thumbs/my-game.svg       ← (opsiyonel) kart görseli

# 3. Doğrula
npm run build         # astro check + astro build
npm run dev           # http://localhost:4321/games/  → kart + oyun

# 4. Commit + PR (her oyun ayrı branch + ayrı PR)
git checkout -b add-my-game
git add -A
git commit -m "Add My Game"
git push -u origin add-my-game
gh pr create --fill
```

Detay: [docs/ADDING_A_GAME.md](docs/ADDING_A_GAME.md)

## Dokunabileceğin dosyalar (kendi oyunun için)

| Dosya | Zorunlu | Amaç |
|---|---|---|
| `src/content/games/<slug>.json` | ✅ | Oyun metadata (title, desc, tarih, etiketler, kontroller) |
| `src/game-bodies/<slug>.astro` | ✅ | Oyuna özel DOM (head/body **YAZMA** — layout zaten sarmalıyor) |
| `src/game-logic/<slug>.ts` | ✅ | Oyun mantığı; `document.querySelector` ile body markup'a bağlanır |
| `src/styles/games/<slug>.css` | ⬜ | Oyuna özel CSS; otomatik sadece kendi sayfasına inline edilir |
| `public/thumbs/<slug>.svg` | ⬜ | 16:10 kart önizleme görseli |

## Dokunmaman gereken dosyalar (shared layer)

Bu dosyalar paylaşılan altyapıdır. Değiştirmek paralel ajanlarla çakışma
yaratır ve mevcut oyunları kırabilir. Bir gereksinim ortaya çıkarsa **insan
review** iste, kendi başına değiştirme.

| Dosya/Klasör | Neden |
|---|---|
| `src/layouts/*.astro` | Tüm sayfaların HTML iskeleti |
| `src/styles/{tokens,base,game-shell,archive}.css` | Tema, reset, ortak HUD |
| `src/pages/{index,[slug]}.astro` | Arşiv ve dinamik oyun routing'i |
| `src/components/*.astro` | Nav, Card, PlayerOverlay (arşiv UI) |
| `src/content.config.ts` | Zod schema + glob loader (sahanın değişimi tüm oyunları etkiler) |
| `src/archive/main.ts` | Arşiv runtime (search/filter/iframe) |
| `astro.config.mjs`, `tsconfig.json`, `package.json` | Build & types |
| `.github/workflows/*`, `.github/PULL_REQUEST_TEMPLATE.md` | CI & PR |

## Yapı haritası

Tek satırlık özet — derinlik için [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
src/
├── pages/[slug].astro    ← her oyun için /games/<slug>/index.html üretir
├── layouts/              ← head/body/stage sarmalayıcısı
├── content/games/        ← oyun meta (Astro content collection, zod ile validate)
├── game-bodies/          ← oyuna özel markup (slot içeriği)
├── game-logic/           ← oyuna özel TS (iframe içinde çalışır)
├── styles/games/         ← oyuna özel CSS (sadece kendi sayfasına inline)
└── archive/              ← anasayfa runtime
public/thumbs/            ← kart görselleri
```

## Önemli kontratlar (özet)

- **DOM kontratı**: `game-bodies/<slug>.astro` ne yazarsa, `game-logic/<slug>.ts`
  oraya bağlanır. ID/class isimleri **sadece o oyunda anlamlıdır** — paylaşılan
  HUD class'ları için [docs/GAME_CONTRACT.md](docs/GAME_CONTRACT.md)'ye bak.
- **CSS scope**: Per-game CSS sadece o oyunun sayfasında yüklenir; başka oyuna
  sızmaz. Buna güven, ama global selector (`*`, `body`, `html`) yazma.
- **State**: Sadece `localStorage` kullan (server yok). Anahtar prefix: `<slug>.`.
- **Bağımlılık eklemek YASAK**: Vanilla TS + Canvas/DOM yeterli. Kütüphane
  gerekiyorsa human-review iste.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm install` | Bağımlılıklar |
| `npm run dev` | Dev server (`http://localhost:4321/games/`) |
| `npm run build` | `astro check && astro build` → `dist/` |
| `npm run preview` | Prod build'i lokal serve et |
| `npm run new-game <slug> -- --title "..." --description "..."` | Scaffold |
| `npm run check` | Sadece type check |

## Doğrulama (PR açmadan önce çalıştır)

```sh
npm run build          # type check + build, kırılırsa düzelt
npm run dev            # tarayıcıda /games/<slug>/ aç, [docs/PLAYTEST.md] uygula
```

CI otomatik olarak build + check çalıştırır; ama lokalde önce dene.
**Curl-based smoke test artık geçersiz** — geçmiş 4 fix PR'ı curl ile
yakalanamazdı. [docs/PLAYTEST.md](docs/PLAYTEST.md) checklist'i zorunlu.

## Öğrenme döngüsü

Bu repoda iki yönlü hafıza var; her ikisini de besle:

- **Yazmadan önce oku**: [docs/PITFALLS.md](docs/PITFALLS.md) (geçmiş hata
  pattern'leri) ve [docs/CREATIVITY.md](docs/CREATIVITY.md) (klon yasak,
  twist veya orijinal).
- **PR-sonrası yaz**: Fix landlediğinde PITFALLS.md'ye entry ekle veya
  mevcut entry'ye PR# yapıştır. Bu olmadan sonraki ajan aynı bug'ı yazar.

## Daha fazla

- [README.md](README.md) — insan okuyucu için kısa giriş
- [AGENTS.md](AGENTS.md) — paralel ajan workflow'u, çakışma kuralları
- [docs/PITFALLS.md](docs/PITFALLS.md) — geçmiş ajan hatalarından dersler (kod yazmadan önce zorunlu)
- [docs/PLAYTEST.md](docs/PLAYTEST.md) — PR-öncesi oynanış protokolü (curl smoke test artık geçersiz)
- [docs/CREATIVITY.md](docs/CREATIVITY.md) — yeni oyun: klon yasak, twist veya orijinal mekanik
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — build pipeline, layout flow
- [docs/ADDING_A_GAME.md](docs/ADDING_A_GAME.md) — step-by-step yeni oyun
- [docs/GAME_CONTRACT.md](docs/GAME_CONTRACT.md) — DOM/lifecycle kontratı
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — kod ve stil kuralları
