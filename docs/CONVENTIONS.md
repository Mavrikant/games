# Conventions

> Tek satır: **vanilla TS, hiç framework, minimal kod, ortak ton.**

## Diller ve sürümler

- Astro 4.x (`.astro` template + frontmatter)
- TypeScript 5.x (`astro/tsconfigs/strict`, `moduleDetection: force`)
- ES2022 hedefi (top-level await OK, `Array.at()` OK)
- Node ≥ 22.12 (Astro 6 zorunlu, CI ve lokal)

## TypeScript

- `strict` aktif; özellikle `noUncheckedIndexedAccess`. Array index
  okurken `arr[i]!` veya guard zorunlu.
- Modül seviyesinde yan etki yapan dosyalar (`game-logic/*.ts`) için
  `moduleDetection: force` aktif — `export {}` eklemeye gerek yok.
- `any` neredeyse hiç. `unknown` tercih et, narrow et.
- Type alias yerine `interface` öncelik (genişletilebilir).
- Util fonksiyonlar `function foo()`; kallable variable yerine.

## Dosya/klasör isimleri

- Klasör: kebab-case (`game-bodies/`, `game-logic/`)
- Astro/TS dosya: kebab-case (`my-game.astro`, `my-game.ts`)
- Component (Astro JSX): PascalCase (`Card.astro`, `Nav.astro`)
- Test/script dosya: kebab-case

`<slug>` her zaman regex `[a-z0-9-]+`.

## CSS

- BEM-style class isimleri: `block`, `block__element`, `block--modifier`
- ID'ler camelCase yerine kebab: `#player-back`, `#game-canvas`
- CSS variable: `--kebab-case`
- Token isim örneği: `--bg`, `--surface`, `--text-muted`, `--accent`,
  `--accent-soft`
- Per-game CSS'te global selector (`*`, `body`, `html`) **yazma**
- Yeni token tanımlamayı azalt; mevcut palet yetersizse human review
- `!important` neredeyse hiç

## Astro

- Frontmatter (`---`) içinde top-level await OK
- `<style>` (scope edilmiş) tercih edilir; `<style is:global>` sadece
  layout-level kullanım için
- `<script>` Astro tarafından bundle edilir (hoisted); `is:inline`
  sadece JSON data island için
- `import.meta.glob` paterni: eager + `?inline` query CSS için, eager
  body component için, lazy logic için

## Kod stili

- **Yorum yazma** (zorunlu değilse). İyi isimlendirme yeterli.
  - Yorum kuralı: WHY non-obvious ise yaz (workaround, invariant). WHAT
    yazma — kodun kendisi.
- Function ≤ 40 satır; uzunsa böl
- `if (cond) return;` (early return) tercih
- Magic number'ı `const SOMETHING = …;` ile name'le
- async/await > Promise chain
- `try/catch` sadece gerçek failable I/O (localStorage, JSON.parse) etrafında

## Hata yönetimi

- DOM seçicide `!` OK (markup garanti). null check abuse etme.
- `localStorage` try/catch: kullanıcı disable etmiş olabilir
- `JSON.parse` try/catch: corrupt veri olabilir
- Network YOK (statik proje)
- `console.error` tolere edilir; `console.log` build'de kalmasın

## Bağımlılıklar

- **Hiçbir yeni dependency eklenmez** (paralel ajan kuralı, [AGENTS.md](../AGENTS.md))
- Dev: TypeScript, Astro, `@astrojs/check`
- Runtime: HİÇ — bundle %100 kendi kodun + Astro hoist'ları

## Performans

- Bundle hedef: tüm site < 50 KB gzipped (şu an ~6 KB)
- Per-game logic chunk: < 5 KB (canvas + DOM yeterli)
- Resim: SVG tercih (vector, küçük); raster gerekirse `public/`'e koy
- requestAnimationFrame > setInterval (saniyede 60+ frame için)
- `localStorage` write < 10/sn (high score, save state — frekans düşük)

## A11y

- Buton ≠ `<div onclick>` — gerçek `<button type="button">`
- Image: `alt=""` decorative ise
- Canvas: `aria-label="..."` ne işe yaradığını söyle
- Klavye navigation: tab order doğal HTML akışıyla yeterli; özel
  shortcut varsa `aria-keyshortcuts`
- Color contrast: `--text` üzerine `--bg` zaten WCAG AA

## Test stratejisi

- Unit test YOK (overkill)
- Type check (`astro check`) zorunlu
- Build (`astro build`) zorunlu — bu zaten "smoke test"
- Manuel oynama testi PR öncesi
- Önemli regression olursa Playwright eklemek değerlendirilir (henüz
  gerek yok)

## Git

- Tek mantıksal commit per PR (squash merge varsayılır)
- Commit message: imperative — `Add Snake`, `Fix XOX win highlight`
- Co-author ekleyebilirsin (AI tool ise)
- Branch: `add-<slug>`, `fix-<slug>-<short>`, `polish-<slug>`
- `--force` push ASLA; `main`'e doğrudan push ASLA

## "Belirsizse yapma" kuralı

Aşağıdaki sorulardan birine "evet" diyorsan, yapma:
- Bu değişiklik shared layer'a dokunuyor mu?
- Yeni bir dependency gerektiriyor mu?
- Bir başka oyunun davranışını değiştirir mi?
- Build pipeline'ını etkiler mi?
- Schema'yı kırar mı?

Her biri "hayır" ise devam. Aksi halde PR'da soru aç veya issue tag'le
("human review").

## Doc tutarlılığı

Doc'lar **kaynak kod ile aynı PR'da** güncellenmeli. Değişen davranış için
ilgili doc'u (`ADDING_A_GAME.md`, `GAME_CONTRACT.md`, vs.) güncelle.

## Daha fazla

- [AGENTS.md](../AGENTS.md) — paralel ajan çalışma kuralları
- [GAME_CONTRACT.md](GAME_CONTRACT.md) — DOM/lifecycle kontratı
- [ARCHITECTURE.md](ARCHITECTURE.md) — pipeline detayı
