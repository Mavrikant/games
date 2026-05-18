<!--
  PR ŞABLONU
  Lütfen ilgili olmayan bölümleri sil; gerisini doldur.
-->

## Tür

<!-- Bir tanesini "x" ile işaretle -->
- [ ] Yeni oyun (`add-<slug>`)
- [ ] Mevcut oyunda bug fix (`fix-<slug>-…`)
- [ ] Mevcut oyunda görsel polish (`polish-<slug>`)
- [ ] Shared layer / altyapı (human review zorunlu)

## Değişen dosyalar

<!-- Yalnızca senin oyununa ait dosyalar olmalı; shared layer'a dokunduysan
     gerekçeyi "Notlar" bölümünde yaz. -->
- `src/content/games/<slug>.json`
- `src/game-bodies/<slug>.astro`
- `src/game-logic/<slug>.ts`
- `src/styles/games/<slug>.css`     <!-- opsiyonel -->
- `public/thumbs/<slug>.svg`         <!-- opsiyonel -->

## Özet

<!-- 1-3 cümle: oyun ne, nasıl oynanıyor, neden ilginç. -->

## Lokal doğrulama

- [ ] `npm run build` sıfır error
- [ ] `npm run dev` ile `http://localhost:4321/games/` arşivde kart göründü
- [ ] Karta tıklayınca iframe içinde oyun başarıyla yüklendi
- [ ] `http://localhost:4321/games/<slug>/` direkt URL'i çalışıyor
- [ ] Klavye / mouse / touch kontrolleri reactif
- [ ] localStorage state refresh sonrası korunuyor (varsa)

## Kapsama dışı kontrol

<!-- Aşağıdakilerin **hiçbirini yapmadın** mı? Hepsine "evet" ise PR mergeable. -->
- [ ] `package.json` / `package-lock.json` değişmedi
- [ ] `src/layouts/`, `src/styles/{tokens,base,game-shell,archive}.css`,
      `src/pages/`, `src/components/`, `src/content/config.ts`,
      `src/archive/main.ts` değişmedi
- [ ] Başka bir oyunun (`<other-slug>.*`) dosyasına dokunulmadı
- [ ] Yeni dependency eklenmedi
- [ ] Remote API / fetch çağrısı yok

## Ekran görüntüsü / gif (opsiyonel)

<!-- Sürükle-bırak ile ekle. -->

## Notlar

<!-- Tasarım kararları, bilinen sınırlamalar, gelecek iyileştirmeler. -->
