# Pitfalls — geçmiş ajan hatalarından dersler

> Bu dosya **kurumsal hafıza**dır. Her satırı bir önceki ajanın
> yaptığı (ve fark edemediği) somut bir hatadan damıtıldı. Yeni bir oyun
> yazmadan **önce** baştan sona oku; bir oyununda fix landlediğinde **sonra**
> yeni pattern'i buraya ekle. Aksi halde aynı bug 8. kez yazılır.

## Nasıl kullanılır?

1. **Yeni oyun yazmaya başlamadan önce**: bu dosyayı oku. Her pattern'in
   "nasıl tespit edilir" satırını [docs/PLAYTEST.md](PLAYTEST.md) checklist'i
   ile birlikte uygula.
2. **PR'ında bir fix landlediğinde**: 5 dakika ayır, fix'in altında yatan
   _pattern_'i (kod değil, soyut hata sınıfı) buraya ekle veya mevcut bir
   entry'yi güncelle. Tekrar etmemek tek başına kaydedilmiş olmaya bağlı.
3. **Mevcut bir pattern'i gördüğünde**: PR açıklamasında entry'ye link ver
   (örn. `pitfall: visual-vs-hitbox`). Reviewer hızlı eşleştirir.

Entry formatı (zorunlu alanlar):

```
### <kısa-pattern-adı>
**Vaka**: <PR# + bir cümle>
**Pattern**: <soyut sınıf, 1-2 cümle>
**Tespit**: <playtest sırasında ne yapılır>
**Önlem**: <kod yazarken ne yapılır>
```

---

## Tuzaklar

### visual-vs-hitbox
**Vaka**: [#10 breakout](https://github.com/Mavrikant/games/pull/10) tuğla yan çarpışması yanlış eksene yansıyordu; çarpışan top tuğlanın
içinde sıkışıp salınıyordu. [#11 flappy](https://github.com/Mavrikant/games/pull/11) borunun çizilen "kap" dikdörtgenleri hitbox'a dahil
değildi; kuş kap'tan içeri girip ölmüyordu.
**Pattern**: `draw()` ile `collide()` farklı sayılardan besleniyor.
Görüntü doğru çıkıyor, fizik yanlış. Smoke test sırasında oyun "görsel
olarak" iyi göründüğü için fark edilmiyor.
**Tespit**: Bilerek görsel kenara değdir. Tuğlanın **yan** ortasına soldan
gel; borunun **kap** köşesine değ. Çarpışma tetiklenmiyorsa veya yanlış
yönde sıçrıyorsa desync var.
**Önlem**: Görsel boyutlar (kap yüksekliği, tuğla çerçevesi, oyuncu
yarıçapı) tek bir `const` bloğunda dursun ve **hem** `draw()` **hem**
`collide()` aynı sabitleri import etsin. Hard-coded number'ları her iki
fonksiyona ayrı ayrı yazma.

### overlay-input-leak
**Vaka**: [#9 2048](https://github.com/Mavrikant/games/pull/9) "Kazandın!" overlay'i açıkken ok tuşları arkadaki grid'i kaydırıyordu.
[#11 flappy](https://github.com/Mavrikant/games/pull/11) gameover ekranından restart için iki tıklama gerekiyordu (overlay
"click to try again" diyordu ama bir tık sadece `ready` state'ine geçiriyordu).
**Pattern**: State machine'in transition'larında boşluk var. Overlay/menü
açıkken oyun input'unu kabul ediyor veya iki state arasında gereksiz bir
"ara" state var.
**Tespit**: Her overlay/menü state'inde **tüm** input binding'lerini
(klavye + dokunma + tıklama) tek tek dene. Underlying state değişiyor mu,
veya beklenmedik bir state'e mi geçiyor?
**Önlem**: Explicit state enum tut (`Ready | Playing | Paused | GameOver |
WinOverlay`). Bütün input handler'ları **tek** `handleInput(state, input)`
switch'i içinden geçsin; default case her zaman `return` etsin. State
geçişlerini diagram olarak kafanda çiz.

### stale-async-callback
**Vaka**: [#9 2048](https://github.com/Mavrikant/games/pull/9) restart sırasında animasyon bitirme callback'i (eski setTimeout)
hâlâ tetikleniyor, fresh grid'e fazladan bir tile ekliyordu.
**Pattern**: `setTimeout` / `requestAnimationFrame` / promise zinciri
reset'i hayatta kalıyor. Reset yeni state kuruyor; eski callback bittiğinde
yeni state'i mutate ediyor.
**Tespit**: Animasyon sırasında **spam restart** yap. Tek bir tile, skor,
overlay, veya gravity tick beklenmedik şekilde tetikleniyor mu?
**Önlem**: Async iş bir **generation token**'a bağlansın. `reset()` token'ı
bump eder; deferred callback başında `if (myToken !== currentToken) return;`
yapar. Alternatif: `clearTimeout` / `cancelAnimationFrame` el ile çağır.

### invisible-boot
**Vaka**: [#12 tetris](https://github.com/Mavrikant/games/pull/12) parça gizli buffer satırında (y=0) spawn oluyordu; level 1 gravity ile
ilk parçanın görünür alana düşmesi **1.6 saniye** sürüyordu. Kullanıcı "oyun
başlamadı mı?" hissi yaşıyordu.
**Pattern**: Cold start'tan sonra ilk visible frame'e kadar geçen zaman çok
uzun. Oyun "teknik olarak" çalışıyor ama kullanıcı geri-bildirim alamıyor.
Ayrıca bonus: per-life accumulator (gravity, combo timer) önceki hayattan
sızıyor.
**Tespit**: Sayfayı hard reload et, "Başla" tıkla, kronometre tut. **250 ms
içinde** playfield'da görünür bir değişiklik olmalı (parça, top, oyuncu,
HUD). Aynı şekilde restart sonrası ilk frame.
**Önlem**: `start()` ve `reset()` fonksiyonları kendi içinde tüm per-life
state'i sıfırlasın: spawn pozisyonu görünür alana, gravity accumulator 0,
combo timer 0, particle pool 0. Spawn'i hidden buffer'a koymak zorundaysan
spawn anında bir frame görsel feedback ver.

### unguarded-storage
**Vaka**: [#12 tetris](https://github.com/Mavrikant/games/pull/12) module-init sırasında `localStorage.getItem('tetris.hi')` çağrısı
Safari private mode'da exception fırlatıyor; tüm modül import sırasında
patlıyor; oyun hiç yüklenmiyor.
**Pattern**: `localStorage`, `IndexedDB`, `navigator.clipboard`, `DOMRect`
gibi exotic API'lar belirli ortamlarda (private mode, file://, embedded
WebView, iframe sandbox) throw eder. Module-level çağrılar tüm modülü
çökertir.
**Tespit**: Safari private mode'da veya `localStorage` devre dışı bir
profile'da aç. Module-level side effect yoksa zaten güvendesin.
**Önlem**: Tüm storage erişimi `safeRead<T>(key, fallback)` ve
`safeWrite(key, value)` helper'larından geçsin. Try/catch içine al,
exception'da fallback dön. Module-level side effect koyma — her şey
`init()` / `start()` içinde olsun.

### duplicate-with-shared-layer
**Vaka**: [#10 breakout](https://github.com/Mavrikant/games/pull/10) body içinde `<p class="bo-hint">…</p>` ve CSS'i vardı.
`GameLayout` zaten `controls` JSON alanından `.hint` footer'ı render
ediyordu — kullanıcı aynı metni iki kere görüyordu.
**Pattern**: Shared layer'ın (GameLayout, content schema, archive shell)
sağladığı şeyi bilmeden, body'de tekrar implement etmek. Title, hint,
score HUD, pause button gibi şeyler layout'tan otomatik gelir; ikinci kez
ekleme görsel duplicate yaratır.
**Tespit**: Yeni oyun sayfasını başka bir oyunun yanında aç. Layout
chrome'unda (header, footer, hint area) ne otomatik geliyor? Body'de aynı
şeyi tekrar yazmadığından emin ol.
**Önlem**: Body yazmadan önce [docs/GAME_CONTRACT.md](GAME_CONTRACT.md)'yi
oku. Body **sadece** oyun-spesifik canvas/grid'i içerir; HUD, hint, title
zaten layout'tadır. Şüphedeysen mevcut bir basit oyunun (`snake.astro`,
`tic-tac-toe.astro`) body'sine bak.

### stale-dom-from-prev-state
**Vaka**: Vardiya PR — `fullReset()` ve `next()` fonksiyonları çocukları bu sırayla işliyordu: önce `clearAssignments()` (içinde `renderAssignments()`) → sonra `renderGrid()` + `renderWorkers()`. Level 5'ten level 1'e dönerken, `renderAssignments()` hâlâ ekranda olan eski level 5 worker chip'lerini (w5, w6) okuyup `workerById(wid)` çağırıyor — yeni level'da o id'ler olmadığı için undefined dönüyor ve `.maxShifts` erişiminde crash.
**Pattern**: State transition'da yeni veriye geç ama eski DOM hâlâ ekranda. Yeni-state render'ı eski-DOM'u tarayan helper'lar `undefined` lookup yapıp patlar. Sık görülen senaryo: level/round değişiminde önce mevcut DOM'u güncelle, sonra yeni DOM oluştur.
**Tespit**: Çok-level/çok-aşama oyunlarda en son level'den restart yap. Crash veya boş render olur mu? Headless harness'da `reset()` çağrısını level değiştirme sonrası tekrar et.
**Önlem**: State transition'da sıra: (1) state alanlarını güncelle, (2) eski DOM'u temizle (`element.innerHTML = ''` veya kendi `renderGrid/Workers`'i çağır), (3) yeni DOM'u kur, (4) sonra `renderAssignments`/cross-element render. Bonus: yardımcı render fonksiyonlarında `if (!w) return;` defensive guard ekle — DOM'da hayalet element olabilir.

### module-level-dom-access
**Vaka**: Sprint 2 boyunca 46 oyunun 39'unda `const canvas = document.querySelector(...)` top-level çağrılıyordu. Hiçbiri **Safari private mode**'da modül yüklenirken patlamadı çünkü `querySelector` throw etmez — ama aynı dosyalardaki module-level `const best = Number(localStorage.getItem(...))` patlardı (PITFALLS#unguarded-storage). Pattern olarak ikisi aynı sınıf: "module body, init() yerine."
**Pattern**: Modül parse edilirken çalışan kod, `init()` fonksiyonunun dışında. DOM yoksa / storage erişimi yoksa, modül yüklenmiyor → tüm oyun yüklenmiyor. Aynı sınıfta: top-level event listener'lar (DOM hazır olmadan bağlanır → listener kaybı), top-level `new ResizeObserver`, top-level RAF.
**Tespit**: `npm run audit:games` → ModLvlQS sütunu. `--ci` flag'i CI'da fail eder. Manuel: `grep -E "^(const|let).*=.*document\." src/game-logic/*.ts` → çıktı boş olmalı.
**Önlem**: `@shared/game-module` import et, `defineGame({ init })` export et. Tüm DOM access, event binding, storage okuma `init()` içinde. `defineGame()` queueMicrotask ile init'i otomatik çağırır — manuel çağrı gerekmez. Örnek için `docs/SHARED_HELPERS.md` ve mevcut oyunlardan herhangi biri (örn. `src/game-logic/snake.ts`).

### missing-overlay-css
**Vaka**: [#76 kafe-gorevlisi](https://github.com/Mavrikant/games/pull/76), [#77 lazer-ayna](https://github.com/Mavrikant/games/pull/77), [#78 kor-tus](https://github.com/Mavrikant/games/pull/78) üçü de `@shared/overlay` import etti ama oyuna özel CSS'te ne `.overlay { position: absolute; inset: 0 }` ne de `.overlay--hidden { opacity: 0; pointer-events: none }` tanımladı. Sonuç: overlay normal akışta inline bir blok olarak göründü (canvas'ın altında veya yanında, modal değil) ve `hideOverlay()` görsel hiçbir şey yapmadı. kafe-gorevlisi'de bu, "Başlamak için tıkla" overlay'inin tıklanmaya cevap vermemesiyle birleşti → oyun tamamen oynanamaz hale geldi.
**Pattern**: `@shared/overlay` helper'ı `.overlay--hidden` class'ını ve `aria-hidden` attribute'unu set ediyor — ama görsel etkiyi **per-game CSS** sağlar (helper'ın JSDoc'unda "Required CSS: caller's stylesheet must define `.overlay--hidden { display: none }`" yazıyor ama agent bu kontratı kaçırdı). Build geçer, type-check geçer, smoke test "sayfa yüklendi" der; sadece elle/test ile fark edilir.
**Tespit**: Sayfayı aç, overlay görünüyor mu? Konumlu mu (canvas/grid üzerine modal)? "Başla"/tıkla → overlay'in `opacity` veya `display` değeri değişiyor mu? `getComputedStyle(overlay).position === 'absolute'` olmalı; `hideOverlay()` sonrası `opacity` 0 veya `display` `none` olmalı. `scripts/audit-games.mjs` artık CI gate'te kontrol ediyor: `@shared/overlay` import eden her oyunun CSS'i `.overlay--hidden` (veya `--game-prefix-overlay--hidden`) tanımlamalı.
**Önlem**: Yeni oyun scaffold'u (`scripts/templates/style.css`) overlay CSS bloğunu hazır içeriyor — silme. Mevcut bir oyuna `@shared/overlay` ekliyorsan, aynı bloğu CSS'e kopyala. Pattern olarak: `.board-wrap { position: relative }`, `.overlay { position: absolute; inset: 0; ... }`, `.overlay--hidden { opacity: 0; pointer-events: none }`. Helper'lar görsel reset yapmaz — class adlandırması sade ama görsel kontratı sen yazarsın.

### unreachable-start-state
**Vaka**: [#76 kafe-gorevlisi](https://github.com/Mavrikant/games/pull/76) `reset()` fonksiyonu `setDrinkBtnsEnabled(false)` çağırdı ve overlay mesajına "Başlamak için aşağıdan bir içecek seç" yazdı. Ama drink button'lar `disabled=true` durumdayken tıklama event'i fire etmez — kullanıcı overlay mesajını okuyup tıkladığında hiçbir şey olmadı. Aynı state'e başka bir giriş yolu da yoktu (Space, Enter, restart butonu, hepsi reset()'i çağırıyor). Oyun tamamen oynanamaz.
**Pattern**: "Ready" state'inde **hiçbir input** o state'ten çıkmıyor. Overlay mesajı bir aksiyon vaat ediyor (örn. "X'e tıkla") ama o aksiyon mevcut state'te disabled veya yok. Agent overlay'in ne dediğini yazdı ama mesajda söz verilen davranışı runtime'da implement etmedi.
**Tespit**: Cold boot sonrası sayfayı aç. Overlay'in vaat ettiği aksiyonu **tam olarak** yap — gerçekten o şeyi tıkla veya o tuşa bas. State değişti mi? Değişmediyse "ready unreachable". Aynı kontrol gameover sonrası restart için de.
**Önlem**: Her overlay mesajının vaat ettiği aksiyona en az iki giriş yolu olsun: (a) overlay üzerinde explicit bir "Başla" butonu, (b) klavye fallback (Enter/Space). Drink/option button gibi gameplay input'larını **dual-purpose** yapma — ready state'te "start" anlamına gelmesi user için kafa karıştırıcı; ayrı bir entry point ekle. State enum'unda her state'in en az bir explicit transition'ı olmalı; review sırasında kafanda diyagramı çiz.

### untested-edge-state
**Vaka**: Yukarıdaki 4 PR'ın **hepsi** + trafik-memuru: sinyal NS yeşilken kavşağa girmiş
araç, kullanıcı sinyali toggle'larsa **kavşak ortasında kilitleniyordu**; karşı eksen
yeşile dönünce diğer araçlar üzerinden geçiyordu (görsel çarpışma + sabır da drain
olmuyordu çünkü `isWaiting` testi `pos < APPROACH_LEN + 5` ile sınırlıydı). Her bug 30
saniyelik gerçek oynayarak-test ile yakalanırdı: restart, win, overlay'de input, ilk
frame, **sinyal değişimi sırasında kavşaktaki araç**. Ajan `curl /games/<slug>/` 200
gördü, "smoke test passed" dedi, mergeledi.
**Pattern**: "Sayfa yüklendi" ≠ "oyun çalışıyor". HTTP 200 hiçbir oynanış
bug'ını yakalamaz. Type-check ve build hiçbir runtime/UX bug'ını yakalamaz.
**Tespit**: [docs/PLAYTEST.md](PLAYTEST.md) checklist'ini her PR öncesi
uygula. Curl smoke test artık yeterli değil.
**Önlem**: Playtest, build kadar zorunlu. Atlanamaz. CI'da `npm run test:smoke` artık her oyunu headless chromium'da açıyor; init crash, console error, blank render bu seviyede yakalanır. Ama oynanış bug'larını (yanlış skor, AI lock, restart race) hâlâ insan playtest yakalayabilir — [docs/PLAYTEST.md](PLAYTEST.md) zorunlu.

---

## Bu dosya ne zaman güncellenir?

- Her fix PR mergelendikten sonra, **fix'i yazan ajan** (veya merge eden
  insan) yeni bir entry ekler veya mevcut bir entry'nin "Vaka" satırına
  PR# ekler.
- Aynı pattern ikinci kez tekrarlandıysa entry'yi sil ve yerine daha net
  bir versiyon yaz — açıkça aynı şeyi tekrar yapıyorsak entry yeterince
  somut değildi.
- 12+ aydır kimsenin tekrarlamadığı bir pattern silinebilir (modern
  toolchain veya konvansiyon değişikliği ile artık geçersiz olabilir).
