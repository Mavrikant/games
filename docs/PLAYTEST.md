# Playtest protokolü

> Eski `curl /games/<slug>/ → 200` smoke test'i **artık yeterli değil**.
> Geçmiş 4 fix PR'ının ([#9](https://github.com/Mavrikant/games/pull/9), [#10](https://github.com/Mavrikant/games/pull/10), [#11](https://github.com/Mavrikant/games/pull/11), [#12](https://github.com/Mavrikant/games/pull/12)) hepsi 30 saniyelik gerçek oynama
> ile yakalanırdı. Bu dosya her oyun PR'ı öncesi yapılacak minimum playtest'i
> tanımlar. Atlanırsa fix PR'ı sıraya girer.
>
> **`npm run test:smoke` artık var**: her oyun headless chromium'da
> yükleniyor, init crash + console.error + blank render bu seviyede
> yakalanıyor. Aşağıdaki insan-playtest checklist'i hâlâ zorunlu —
> smoke ne overlay-input-leak'i ne stale-async-callback'i ne de yanlış
> skoru yakalar.

## Felsefe

- Build geçmesi ≠ oyun çalışıyor.
- "Açtım, fena değil" ≠ playtest.
- Oyunu yazan ajan playtest'in **aktif denek**idir — kullanıcının ilk kez
  karşılaşacağı edge case'leri ajan ilk fark eden olmalı.
- Bulunan her bug, fix'inden önce [PITFALLS.md](PITFALLS.md)'de bir entry'ye
  link verir; yoksa yeni entry açılır.

## Ne kullanılır?

- **Tercih edilen**: `preview_*` MCP araçları (`preview_start`,
  `preview_snapshot`, `preview_click`, `preview_console_logs`,
  `preview_screenshot`, `preview_eval`). Build kanıtı ekran görüntüsü +
  console temizliği şeklinde PR'a iliştirilebilir.
- **Fallback**: `npm run dev` + tarayıcı + DevTools console.
- ❌ `curl ... > /dev/null` — kullanma; hiçbir runtime bug'ı yakalamaz.

## Genel akış

```
1. preview_start (veya npm run dev) → http://localhost:4321/games/<slug>/
2. preview_console_logs → tek hata bile varsa düzelt
3. Aşağıdaki checklist'i baştan sona uygula
4. preview_screenshot → PR'a iliştir (görsel kanıt)
5. Bulduğun her sorunu fix → checklist'e dön (atlama)
```

---

## Checklist — her oyun için zorunlu

### A. Cold boot
- [ ] Sayfa hard reload sonrası **konsol temiz** (sıfır error, sıfır
      warning — şüpheli warning'leri açıkla)
- [ ] İlk kullanıcı action'ı (Start/tıkla/Space) **250 ms içinde** görünür
      feedback üretir (parça düşüyor, top hareket ediyor, grid değişiyor)
      — pitfall: [invisible-boot](PITFALLS.md#invisible-boot)
- [ ] `localStorage` devre dışı bir context'te (Safari private veya
      `preview_eval` ile `Object.defineProperty(window, 'localStorage', { get: () => { throw 0 } })`
      sonrası reload) sayfa hâlâ yükleniyor
      — pitfall: [unguarded-storage](PITFALLS.md#unguarded-storage)
- [ ] **Overlay gerçekten gizleniyor**: oyun başlama input'undan sonra
      `getComputedStyle(overlayEl).opacity === '0'` VEYA `display === 'none'`.
      Audit'in CSS check'i CI'de tutar (`scripts/audit-games.mjs --ci`), ama
      runtime'da elle de doğrula — visual regression compositing'i yakalamaz.
      — pitfall: [missing-overlay-css](PITFALLS.md#missing-overlay-css)
- [ ] **Ready state'ten çıkış var**: overlay mesajının söz verdiği aksiyon
      (örn. "Başla'ya tıkla", "Space'e bas") gerçekten state'i Playing'e
      taşıyor. Disabled button'ın click handler'ı fire etmez — fallback
      keyboard veya explicit Start button olsun.
      — pitfall: [unreachable-start-state](PITFALLS.md#unreachable-start-state)

### B. Input matrisi
- [ ] `content/games/<slug>.json`'daki `controls` alanında listelenen
      **her** input gerçekten çalışıyor (klavye, fare, dokunma)
- [ ] Listede olmayan tuşlar (ESC, Tab, F5, Backspace) oyunu kırmıyor
- [ ] `preventDefault` sadece oyun-spesifik tuşlarda; tarayıcı kısayolları
      (Cmd+R, Cmd+T) çalışıyor

### C. State machine — her overlay/menü için
- [ ] **Ready**: sadece "start" input'u oyunu başlatıyor; ok tuşları,
      tıklama gibi şeyler state'i mutate etmiyor
- [ ] **Playing**: tüm input set'i çalışıyor
- [ ] **Paused** (varsa): "resume"/"restart" hariç hiçbir input gameplay'i
      değiştirmiyor; pause sırasında zaman gerçekten duruyor (gravity tick
      yok, particle yok)
- [ ] **GameOver**: "restart" tek input'ta `Playing`'e geçiyor (2 tık
      ARAMAYIN — overlay "click to retry" diyorsa **bir** tık)
      — pitfall: [overlay-input-leak](PITFALLS.md#overlay-input-leak)
- [ ] **Win/Overlay** (varsa): underlying state ok tuşlarına cevap
      VERMİYOR; "devam et" ve "yeniden başla" net şekilde ayrı

### D. Async / restart yarışları
- [ ] Animasyon **sırasında** spam restart yap (10 kez hızlıca). Fresh
      grid'de beklenmedik tile/particle/score değişimi oluyor mu?
      — pitfall: [stale-async-callback](PITFALLS.md#stale-async-callback)
- [ ] Birden fazla input'u aynı frame'de bas (klavye + dokunma). Çift
      hareket veya state corruption oluyor mu?

### E. Görsel ≠ hitbox
- [ ] Çarpışma içeren oyunlarda bilerek **görsel kenarı çiz**. Çizilen
      sprite'ın **dış pikseli** ile collide ediliyor mu? (Hitbox daha küçük
      veya daha büyük olmamalı.)
      — pitfall: [visual-vs-hitbox](PITFALLS.md#visual-vs-hitbox)
- [ ] Hız maksimumdayken (level 10, max gravity, vb.) çarpışma hâlâ
      doğru — tunneling yok

### F. Shared layer duplication
- [ ] Body'de `<h1>`, `<p class="hint">`, "controls" listesi yok —
      `GameLayout` bunları zaten render ediyor
      — pitfall: [duplicate-with-shared-layer](PITFALLS.md#duplicate-with-shared-layer)
- [ ] Şüphedeysen başka bir oyunun (`snake.astro`) body'sine bak

### G. Persistence ve resize
- [ ] Yüksek skor / tercih bir oyundan sonra reload'da geri geliyor
- [ ] **Arşiv kartında thumbnail görünüyor**: `/games/` ana sayfasını aç,
      yeni oyunun kartında broken-img placeholder'ı yok (gerçek SVG render
      oluyor). Audit CI gate'i (`audit-games.mjs --ci`) JSON-thumbnail
      tutarlılığını kontrol eder, ama runtime'da da göz at — public/'a
      doğru dosya isminin yazıldığını doğrular.
      — pitfall: [dangling-thumbnail-reference](PITFALLS.md#dangling-thumbnail-reference)
- [ ] Pencere boyutu değiştirildiğinde canvas/grid overflow yapmıyor; HUD
      kırpılmıyor; mobil görünümde (preview_resize 375×667) oynanabilir
- [ ] Dark mode (varsa) — system tema değişikliğinde renkler kırılmıyor

---

## Oyun-tipi spesifik ek kontroller

### Realtime arcade (snake, tetris, flappy, breakout)
- [ ] Tek bir oyunu kazan'a/kaybet'e kadar oyna (ileri level / gameover)
- [ ] FPS hissi: ekranda görünür stutter, frame drop, particle leak yok
- [ ] Tab arka plana alındığında: `requestAnimationFrame` pause oluyor,
      tab geri geldiğinde **catch-up frame** yok (1 saniyede 60 tick gibi
      patlama olmamalı)

### Puzzle / turn-based (2048, minesweeper, tic-tac-toe)
- [ ] Win condition tam tetiklendiği anda overlay açılıyor (önceden veya
      sonradan değil)
- [ ] Geçersiz move'lar visual feedback veriyor ama state'i değiştirmiyor
- [ ] Çift-tıklama veya hızlı sıralı move'lar atlamıyor

### Score / progression
- [ ] Skor doğru artıyor (manual sayım ile match'lendir)
- [ ] High score sadece bittiğinde yazılıyor (mid-game leak yok)
- [ ] Storage devre dışıyken oyun hâlâ oynanabilir (sadece persistence
      kaybolur)

---

## PR'a ne eklenmeli?

PR description'ında "## Playtest" başlığı altında:

```markdown
## Playtest

- Cold boot OK (console temiz, ilk feedback <250ms): ekran görüntüsü
- State matrix (Ready/Playing/Paused/GameOver): tek-tıkta geçiş onaylandı
- Async restart: 10x spam restart sırasında bug yok
- localStorage disabled: sayfa yükleniyor (test edildi)
- (oyun-tipi spesifik kontroller)

Bilinen sınırlamalar: <varsa>
```

Eğer bu listenin bir maddesini test edemediysen "edemedim, sebep: …" yaz —
"test ettim" demektense açık olmak daha iyi.
