# Yeni oyun ekleme

> Hedef: 10 dakikada çalışan bir oyun + PR.

## Önkoşul

- `npm install` çalışmış
- `npm run dev` çalışıyor (`http://localhost:4321/games/`)
- [AGENTS.md](../AGENTS.md) okunmuş (özellikle yasaklar bölümü)

## 1. Slug seç

`<slug>` = kebab-case, sadece `[a-z0-9-]`, eşsiz.

Doğru: `snake`, `tic-tac-toe`, `memory-flip`, `2048` ✓
Yanlış: `MyGame`, `my_game`, `Memory Flip`, `game!` ✗

`src/content/games/` altına bak; aynı isim varsa farklı bir slug seç.

## 2. Scaffold

```sh
npm run new-game my-game -- \
  --title "My Game" \
  --description "Bir cümle ile ne yaptığını anlat." \
  --tags "arcade,klasik"
```

Bu komut şu 4 dosyayı oluşturur (`<slug>`/`<title>` placeholder'ları
doldurulmuş):

```
src/content/games/my-game.json       ← meta
src/game-bodies/my-game.astro        ← body markup (placeholder)
src/game-logic/my-game.ts            ← logic (placeholder)
src/styles/games/my-game.css         ← CSS (boş)
```

Thumbnail (opsiyonel): `public/thumbs/my-game.svg` — kendin ekle. Yoksa
arşiv kartında oyunun ilk harfi placeholder olarak çıkar.

Var olan slug'la çağırırsan generator hata verir (idempotent).

## 3. Body markup'ı yaz

`src/game-bodies/my-game.astro`:

```astro
---
---

<header class="hud">
  <div class="hud__score">Skor<span id="score">0</span></div>
  <button id="restart" class="hud__btn" type="button">Yeniden başla</button>
</header>
<canvas id="board" width="480" height="480" aria-label="My Game alanı"></canvas>
```

Kurallar:
- `<!doctype>`, `<html>`, `<head>`, `<body>`, `<main>` YAZMA. `GameLayout`
  bunları zaten sarmalıyor.
- Frontmatter (`---` blok) boş kalabilir; CSS import etme — page-level
  inline ediliyor.
- ID/class isimleri sana ait; ama paylaşılan HUD class'larını
  ([GAME_CONTRACT.md](GAME_CONTRACT.md)) kullanırsan ücretsiz stil alırsın.

## 4. Logic'i yaz

Scaffold zaten `@shared/*` + `defineGame()` boilerplate'i üretir. Doldur:

`src/game-logic/my-game.ts`:

```ts
import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';

const STORAGE_KEY = 'my-game.best';
let best = 0;
let score = 0;

// DOM refs — init() içinde doldurulur. Module-level querySelector yasak.
let canvas!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let scoreEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;

function reset(): void {
  score = 0;
  scoreEl.textContent = '0';
  // … oyunu sıfırla, draw()
}

function draw(): void {
  // … canvas çizimi
}

function init(): void {
  canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  ctx = canvas.getContext('2d')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;

  best = safeRead<number>(STORAGE_KEY, 0);

  restartBtn.addEventListener('click', reset);

  reset();
}

export const game = defineGame({ init, reset });
```

Kurallar:
- Tüm `document.querySelector` + event listener + `localStorage` erişimi
  `init()` içinde. Module-level olursa `npm run audit:games --ci` fail.
- State sadece `@shared/storage` üzerinden (`safeRead`/`safeWrite`).
  Anahtar prefix `<slug>.` (`my-game.best`).
- DOM seçicileri `!` ile non-null asserlebilirsin (markup garanti).
- Async setTimeout/setInterval bir reset sırasında stale kalıyorsa
  `@shared/gen-token` kullan (örn. `src/game-logic/2048.ts` AI move).
- Overlay göster/gizle: `@shared/overlay`'ın `showOverlay`/`hideOverlay`'i
  `.overlay--hidden` class + `aria-hidden` atomik toggle eder.
- Modül seviyesinde init et (`reset()` en sonda); Astro `<script>` ile
  page'e bağlar.

Detay: [GAME_CONTRACT.md](GAME_CONTRACT.md).

## 5. Oyuna özel CSS (opsiyonel)

`src/styles/games/my-game.css`:

```css
:root {
  --my-color: #f43f5e;
}

#board {
  display: block;
  width: 100%;
  height: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
}
```

Kurallar:
- Global selector (`*`, `body`, `html`, `:root` dışı) yazma — sızıntı yok
  ama `body { background: red }` yazarsan kendi sayfanı da değiştirir.
- `:root` içinde sadece kendi değişkenlerini tanımla; mevcut token'ları
  (`--bg`, `--accent`, `--text`, `--surface`, `--border`) override etme.
- Renk için mevcut palet yeterse yeni token tanımlama.

## 6. Thumbnail (opsiyonel)

`public/thumbs/my-game.svg` — 16:10 oran (örn. 320×200), koyu zemin
(`#0a0b0e`), gradient veya geometrik desen. Mevcut iki oyunun thumb'ına
baş referans için bak: `public/thumbs/snake.svg`,
`public/thumbs/tic-tac-toe.svg`.

Yoksa arşiv kartı placeholder (ilk harf) gösterir; build kırılmaz.

## 7. Doğrula

```sh
npm run build
```

Hata varsa düzelt. Sık hatalar:

- **zod schema fail**: `content/games/my-game.json` eksik alan veya yanlış
  tip → JSON'u kontrol et.
- **Type error**: `noUncheckedIndexedAccess` etkin; array index erişiminde
  `!` veya guard ekle.
- **Cannot redeclare variable**: TS aynı isimde global var sayıyor — dosyayı
  ESM yap (en üste `export {}` ekle veya bir şey import et).

Sonra otomatik kontroller (CI'da da koşar):

```sh
npm run audit:games --ci    # 0 module-level qS, 0 unsafe localStorage
npm run test:smoke          # her oyun headless chromium'da yüklenir
```

`test:smoke` `test-results/<slug>.png` üretir; oyununun screenshot'ına
bakabilirsin. CI'da artifact olarak 7 gün saklanır.

Manuel oynanış kontrolü:

```sh
npm run dev   # http://localhost:4321/games/
```

- Arşivde kart görünüyor mu? → karta tıkla, iframe'de açılıyor mu?
- Direkt URL `http://localhost:4321/games/my-game/` çalışıyor mu?
- Klavye / mouse kontrolleri reactif mi?
- localStorage skor saklıyor mu? (refresh sonrası dur)
- [docs/PLAYTEST.md](PLAYTEST.md) checklist'i — runtime/UX bug'lar için zorunlu

## 8. Commit + PR

```sh
git checkout -b add-my-game

# SADECE kendi dosyaların — git add -A YASAK
git add \
  src/content/games/my-game.json \
  src/game-bodies/my-game.astro \
  src/game-logic/my-game.ts \
  src/styles/games/my-game.css \
  public/thumbs/my-game.svg

git commit -m "Add My Game"
git push -u origin add-my-game

gh pr create --fill
```

PR template otomatik açılır; doldur (test ne yaptın, ekran görüntüsü vs.).

## 9. CI

PR açılınca `.github/workflows/pr-check.yml` otomatik koşar:
- `npm ci`
- `npm run build` (astro check + build)

Yeşil ise merge için hazır. Kırmızı ise hatayı düzelt, push, CI tekrar koşar.

## Tipik hatalar

| Belirti | Sebep | Çözüm |
|---|---|---|
| Build'de "No body component found at..." | `src/game-bodies/<slug>.astro` eksik | Dosyayı oluştur |
| Build'de zod error | `content/games/<slug>.json` schema'ya uymuyor | [content.config.ts](../src/content.config.ts) şemasına bak |
| Tarayıcıda boş sayfa | `game-logic` dosyası bağlanamadı | Console'a bak; `querySelector!` null mu? |
| Hücreler görünmüyor | CSS yüklenmiyor | `src/styles/games/<slug>.css` adı slug ile **bire bir** aynı mı? |
| Arşivde görünmüyor | Meta dosyası içeri girmemiş | Dev server'ı restart |
| Aynı oyun iki kez | İki farklı slug aynı içerikle | Birini sil |
