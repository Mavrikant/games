# AGENTS.md

> Paralel AI ajan çalışma kuralları. Bu repo birden fazla ajanın **aynı anda**
> üretim yapacağı varsayımıyla tasarlandı. Aşağıdaki kurallara uy → merge
> çakışması yaşamazsın; uyma → işin başka ajanın işini bozar.

## Kod yazmadan önce zorunlu okuma

Sıraladığın türden ne olursa olsun **önce** bu üç dosyayı oku — geçmiş
ajanların aynı hatayı tekrarlamamasına ve sıkıcı klon üretmemesine bunlar
yarıyor:

1. [docs/PITFALLS.md](docs/PITFALLS.md) — geçmiş 4 fix'ten damıtılmış somut
   tuzaklar. Buradaki her pattern bir önceki ajanı kestirdi; senin görevin
   tekrarlamamak.
2. [docs/PLAYTEST.md](docs/PLAYTEST.md) — PR öncesi zorunlu oynanış protokolü.
   Eski `curl /games/<slug>/ → 200` smoke test'i **yeterli değil**, atlanırsa
   fix PR'ı sıraya girer.
3. [docs/CREATIVITY.md](docs/CREATIVITY.md) — yeni oyun yazıyorsan: 7 oyunun
   7'si de kanonik klon, sıradaki kabul edilmez. Twist veya orijinal mekanik
   zorunlu.

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

### Ortak yardımcılar — `src/shared/`

Yeni oyun yazarken aşağıdaki helper'ları **kendin yeniden yazma** — import
et. Tutarsız pattern'ler (3 farklı overlay stili, ham `localStorage` çağrısı)
geçmiş bug'ların kaynağıydı.

| Modül | Ne sağlar | Pitfall |
|---|---|---|
| `@shared/storage` | `safeRead<T>(key, fallback)`, `safeWrite(key, value)`, `safeRemove(key)` | `unguarded-storage` |
| `@shared/overlay` | `showOverlay(el)`, `hideOverlay(el)`, `isOverlayHidden(el)` — classList + aria-hidden atomik | `overlay-input-leak` (kısmî) |
| `@shared/gen-token` | `createGenToken()` — reset-safe async callback iptali | `stale-async-callback` |
| `@shared/game-module` | `GameModule` interface + `defineGame({ init, reset? })` — module-level DOM access yerine init() boundary | `unguarded-storage` (yapısal) |

Kural: `src/shared/` **import-only**. Buradaki dosyaları değiştirmek shared
layer modifikasyonudur → human review zorunlu.

### Önerilen pattern (yeni oyunlarda)

```ts
import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';

function init(): void {
  // Tüm DOM querySelector, localStorage erişimi, event listener burada
  const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
  // ...
}

export const game = defineGame({ init });
```

`defineGame()` queueMicrotask ile `init()`'i otomatik çağırır — manuel
çağrı **gerekmez**. Module-level side-effect (top-level `document.querySelector`,
`localStorage.getItem`) yazma; init() içine al.

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
0.  CREATIVITY.md, PITFALLS.md, PLAYTEST.md oku (zorunlu)
1.  Fikir üret: CREATIVITY.md karar ağacından geç. Klon ise reddet,
    twist/orijinal mekanik üret.
2.  git checkout -b add-<slug>
3.  npm run new-game <slug> -- --title "..." --description "..."
4.  Dosyaları doldur (scaffold @shared/* boilerplate'i hazır verir):
      - game-bodies/<slug>.astro  → minimal markup
      - game-logic/<slug>.ts      → oyun mantığı; defineGame({ init, reset })
                                    export et, tüm DOM/storage erişimi
                                    init() içinde; PITFALLS pattern'lerine
                                    karşı @shared/* helper'ları kullan
                                    (storage / overlay / gen-token)
      - styles/games/<slug>.css   → (gerekiyorsa) görsel
      - public/thumbs/<slug>.svg  → (opsiyonel) kart görseli
      - content/games/<slug>.json → meta zaten dolu, son rötuş
5.  npm run build                 → hata varsa düzelt
6.  npm run audit:games --ci      → adoption gate; module-level qS
                                    veya unsafe localStorage varsa fail
7.  npm run test:smoke            → headless chromium init check;
                                    test-results/<slug>.png artifact
8.  PLAYTEST.md checklist'ini baştan sona uygula (curl YETERLİ DEĞİL —
    smoke runtime crash yakalar ama oynanış bug'ı insan playtest ister)
9.  Bulduğun her bug için: fix → PITFALLS entry'sine link ver veya yeni
    entry aç → checklist'e dön
10. git add <kendi dosyaların>    → git add -A YASAK (başka ajanın
                                    geçici dosyasını yutmasın)
11. git commit -m "Add <Title>"
12. git push -u origin add-<slug>
13. gh pr create --fill → PR description'a "## Playtest" bölümü ekle
14. CI yeşil olunca insan/auto-merge devralır
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

## Playtest (PR öncesi — zorunlu)

`curl /games/<slug>/ → 200` smoke test'i **artık geçerli değil**. Geçmiş
4 fix PR'ı ([#9](https://github.com/Mavrikant/browser-games/pull/9),
[#10](https://github.com/Mavrikant/browser-games/pull/10),
[#11](https://github.com/Mavrikant/browser-games/pull/11),
[#12](https://github.com/Mavrikant/browser-games/pull/12)) curl ile
yakalanamazdı; hepsi 30 saniyelik gerçek oynayarak-test ile yakalanırdı.

`npm run dev` (veya `preview_start`) çalıştır, sonra
[docs/PLAYTEST.md](docs/PLAYTEST.md)'deki tüm checklist'i tek tek geç:

- Cold boot (konsol temiz, ilk feedback <250ms, localStorage off-OK)
- Input matrisi (controls JSON'daki her tuş)
- State machine (Ready/Playing/Paused/GameOver/WinOverlay her overlay'de
  underlying state mutasyona uğramıyor)
- Async / restart yarışları (animasyon sırasında spam restart)
- Görsel ≠ hitbox
- Shared layer duplication
- Persistence + resize

PR description'a `## Playtest` bölümü ekle (PLAYTEST.md'de şablon var).
Test edemediğin bir maddeyi atlama — "edemedim, sebep: …" yaz.

## Hangi durumda human review istersin?

Aşağıdaki durumlardan biri varsa **kod yazmadan önce** PR'da soru aç veya
issue tag'le:

- Shared layer değişikliği (`layouts/`, `tokens.css`, `base.css`,
  `game-shell.css`, `archive.css`, `content.config.ts`, `astro.config.mjs`,
  `package.json`, `src/shared/`, herhangi bir `.github/` dosyası)
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

## PR-sonrası ritüel (öğrenme döngüsü)

Fix PR'ın merge olduktan sonra **5 dakika** ayır:

1. [docs/PITFALLS.md](docs/PITFALLS.md)'yi aç.
2. Fix'inin altında yatan soyut pattern var mı?
   - **Varsa**: o entry'nin "Vaka" satırına PR# ekle (`#13 vb.`). Aynı
     pattern'in tekrar geldiğine işaret eder; başka ajanların güvenmesi
     için sinyal güçlü olsun.
   - **Yoksa**: yeni bir entry aç (kısa pattern adı, Vaka, Pattern, Tespit,
     Önlem dört satırı). Sonraki ajan senin bug'ını tekrar yazmasın.
3. Aynı pattern 3. kez geldiyse entry yetersiz demektir — yeniden yaz veya
   önleme adımını sertleştir.

Bu adım atlanırsa öğrenme döngüsü çalışmaz; PITFALLS.md tutar ama gelişmez.

## Daha fazla okuma

- [CLAUDE.md](CLAUDE.md) — proje girişi
- [docs/PITFALLS.md](docs/PITFALLS.md) — geçmiş hata pattern'leri (zorunlu)
- [docs/PLAYTEST.md](docs/PLAYTEST.md) — PR-öncesi oynanış protokolü (zorunlu)
- [docs/CREATIVITY.md](docs/CREATIVITY.md) — yeni oyun: klon yasak, twist veya orijinal
- [docs/ADDING_A_GAME.md](docs/ADDING_A_GAME.md) — adım adım yeni oyun
- [docs/GAME_CONTRACT.md](docs/GAME_CONTRACT.md) — oyun DOM/lifecycle kontratı
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — code style
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — build pipeline detay
