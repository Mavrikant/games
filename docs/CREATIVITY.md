# Yaratıcılık rehberi — klonlama yasaktır

> Mevcut arşivde **7 oyun var ve 7'si de** kanonik klasik klon: snake,
> tetris, breakout, flappy, 2048, minesweeper, tic-tac-toe. Bu yeterli.
> Sıradaki klon **kabul edilmez** — ya bir twist katacak, ya tamamen
> orijinal bir mekanik getireceksin.

## Neden bu kural var?

- "Yet another arcade clone" arşivin değerini düşürür; başka 1000 sitede
  aynı şey var.
- LLM'in default'u en sık görülen oyunları üretmektir — yani statistik
  olarak sıkıcı çıktı. Buna karşı **aktif** direnmen gerekiyor.
- Vanilla TS + canvas + 200-500 satır kod **inanılmaz** yaratıcı şeyler
  üretebilir. Sınırlama hayal gücün, framework değil.

## Yasak liste (direkt klon kabul edilmez)

Bu mekaniklerin **düz klonu** PR olarak açılırsa kapatılır:

- snake (ve varyantları: nibbles, slither, achtung die kurve hariç —
  multi-player twist)
- tetris (düz düşen blok)
- breakout / arkanoid
- pong
- flappy bird (tek-tuş infinite runner)
- 2048
- minesweeper
- tic-tac-toe / connect-four / gomoku
- pacman
- asteroids
- space invaders
- frogger
- simon-says (renk hatırlama)
- match-3 (candy crush)
- whack-a-mole

**İstisna**: bu listeden bir oyunu alıp aşağıdaki "kabul edilebilir twist"
formlarından en az birini **mekaniği değiştirecek** şekilde uyguladıysan
PR'da kabul edilir.

## Kabul edilebilir twist formları

Bir klasik üzerine yapıyorsan, twist **görsel değil mekanik** olmalı.
"Yılan ama kedi" reskin'dir, twist değildir. Aşağıdaki gibi olmalı:

- **Topology twist**: snake ama hareket yönü ızgara değil hex; breakout
  ama duvar silindir
- **Time twist**: tetris ama geri-zaman düşmesi (parçalar yukarı çıkıyor);
  flappy ama her tap zamanı 0.5s geri sarıyor
- **Resource twist**: minesweeper ama her açtığın hücre bir "enerji" tüketiyor;
  2048 ama belirli renklerden 5'i birleşince yok oluyor (mekanik
  ekonomisi değişir)
- **Multi-agent twist**: snake ama 4 yılanı aynı anda yönetiyorsun (tek tuş
  hepsini etkiliyor)
- **Observation twist**: minesweeper ama tahta ters çevrilmiş ve numaralar
  uzakta; 2048 ama tile değerleri gizli, sadece toplam görünüyor
- **Genre fusion**: tic-tac-toe + tower defense; tetris + sokoban; snake +
  text adventure (her elma kelime ekliyor)

Twist o kadar belirgin olmalı ki, **oyunun ismi de değişsin**. "Cat Snake"
yetersiz; "Quantum Snake" (yılan iki konumda aynı anda) iyi.

## Orijinal mekanik için tetikleyiciler

Twist'ten daha iyisi sıfırdan orijinal. Aşağıdaki tohumlardan birini seç:

### Tohum 1: alışılmadık bir fiil
Mainstream oyunlardaki fiil "zıpla, vur, topla, eşleştir, kaç"dır. Onun
yerine başla:

- **dene** (predict): bir desenin devamını tahmin et
- **dök** (pour): sıvıyı doğru kaba yönlendir
- **dengele** (balance): asimetrik ağırlıkları aynı tarafta tut
- **dokuma** (weave): çizgileri belirli desen çıkacak şekilde geçir
- **sırala** (sort): kaotik bir koleksiyonu mantıklı düzene koy
- **hatırla-tersine** (reverse-recall): biraz önce gördüklerini ters
  sırayla gir
- **eşgüdüm** (sync): iki ritmi birbirine bağla

### Tohum 2: tek bir tuhaf kısıtlama
Bir oyun **kısıtlama** ile başlar:

- "tek tuş" — sadece Space; her şey timing
- "sıfır skor" — kazanma yok, sadece ne kadar dayandığın
- "60 saniye" — tüm oyun 60 saniye sürer, defalarca oynanır
- "iki oyuncu, tek klavye" — paylaşılan input
- "sessiz" — hiçbir ses, hatta görsel feedback minimum
- "metin only" — emoji/ASCII; canvas yasak
- "1 piksel" — oyun alanı 1x1, oyun zamanlama
- "gözleri kapalı" — sadece ses ile oynanır (büyük accessibility kazancı)

### Tohum 3: gerçek dünya domeni
Mainstream oyunların domeni "savaş, spor, masa oyunu"dur. Onun yerine:

- bahçecilik (büyüme/budama döngüsü)
- posta sıralaması (zip code'a göre dağıtım, hız+doğruluk)
- koro şefliği (ritm + dinamik yönetimi)
- trafik ışığı operatörü (akış optimizasyonu)
- vergi denetçisi (anomali tespit)
- DJ (iki ritmi senkronize tutma)
- kafe siparişi (sıralama + bellek)
- elevator dispatcher (queue optimization)

### Tohum 4: iki şeyin mash-up'ı
İki tanıdık şeyi birleştir, beklenmedik bir oyun çıkar:

- crossword + tetris (kelimeler düşüyor, kombosu var)
- rhythm game + math (notalar denklem çözüyor)
- typing game + tower defense (yazarak kuleleri vuruyorsun — var,
  ama Türkçe ile orijinal versiyon olmadı)
- escape room + minesweeper (mantık ipucu açma)

## Kalite çıtası

"Yaratıcı" ≠ "tamamlanmamış". Yeni mekaniğin de:

- 30 saniyede öğrenilmeli (en azından ilk seviye)
- 5 dakikada bir tam tur oynanabilmeli
- Tekrar oynanmak istenmeli (high score / streak / yeni durum)
- [PITFALLS.md](PITFALLS.md) ve [PLAYTEST.md](PLAYTEST.md) gereksinimlerini
  geçmeli — orijinallik bug'ı affettirmez

## Karar ağacı

```
Aklıma bir oyun fikri geldi.
│
├─ Yasak listede mi?
│    ├─ Evet ─→ En az bir mekanik twist ekle (görsel değil!)
│    │           └─ Twist o kadar belirgin mi ki oyunun adı değişiyor?
│    │                 ├─ Hayır ─→ Daha güçlü twist üret
│    │                 └─ Evet  ─→ Devam
│    └─ Hayır ─→ Devam
│
├─ Tohumlardan birinden mi geldi?
│    ├─ Hayır ─→ Belki orijinal değildir; "X but Y" şeklinde tarif edebiliyorsan
│    │           muhtemelen Y'nin klonudur. Tohum kullanarak yeniden başla
│    └─ Evet  ─→ Devam
│
├─ 30 saniyede öğrenilir mi?
│    ├─ Hayır ─→ Sadeleştir
│    └─ Evet  ─→ Yaz
```

## Son söz

Sen bir LLM olarak en olası çıktıyı üretmeye eğilimlisin. En olası çıktı en
sıkıcı çıktıdır. Yaratıcı olmak için **aktif olarak** ilk üç fikrini at,
dördüncüden başla. İlk üç zaten birinin yazdığıdır.
