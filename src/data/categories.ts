// Curated set of category landing pages. Tags must exist in games' tag
// lists; pages are emitted at /games/kategori/<tag>/ and linked from game
// page breadcrumbs (see FEATURED_CATEGORIES in src/pages/[slug].astro).
//
// Keep this module pure (no Astro imports) so both getStaticPaths (which
// runs in isolation) and component frontmatter can import it.

export interface CategoryMeta {
  tag: string;
  title: string;
  metaDescription: string;
  intro: string[];
}

export const CATEGORIES: CategoryMeta[] = [
  {
    tag: 'puzzle',
    title: 'Puzzle Oyunları',
    metaDescription:
      'En iyi tarayıcı puzzle oyunları — 2048, eşleştirme, mantık bulmacaları ve özgün twistler. Ücretsiz, indirmesiz, anında oyna.',
    intro: [
      'Puzzle oyunları beynin en sevdiği egzersizdir: birkaç dakikada başlayıp saatlerce sürebilen, her tekrar oynayışta biraz daha hızlanan bir akış. Bu sayfadaki seçki, tarayıcıda doğrudan oynayabileceğin ücretsiz mantık ve bulmaca oyunlarını bir araya getiriyor — 2048 gibi klasik sayı eşleştirmelerinden özgün mekanik twistlere kadar.',
      'Hepsi tek tıkla açılır; indirme gerekmez, hesap açmazsın, e-posta istenmez. Mobil dokunmatik kontroller, masaüstünde klavye ve fare — hangi cihazdaysan yormadan oynarsın. Mola anlarında zihni keskin tutmak, otobüste 5 dakika geçirmek veya iş öncesi ısınmak için ideal.',
      'Her oyunun kendi sayfasında nasıl oynanır ipuçları ve kontrol tablosu bulursun. En yenisinden eskiye doğru sıralı — yeni bir mekanik denemek istiyorsan üstten başla.',
    ],
  },
  {
    tag: 'arcade',
    title: 'Arcade Oyunları',
    metaDescription:
      'Tarayıcıda ücretsiz arcade oyunları — Snake, Tetris, Pong klasikleri ve hızlı refleks twistleri. İndirme yok, anında oyna.',
    intro: [
      'Arcade oyunları hız, dikkat ve zamanlama üçgeninde yaşar. Bu kategori, klasik atari salonu deneyiminin tarayıcıya taşınmış halidir: Snake, Tetris, Pong gibi büyüdüğümüz oyunlar ve onlara akrabalık eden modern tek-tuş twistler.',
      'Her oyun saniyeler içinde yüklenir; bir kahve molasında 3-5 tur döndürebilirsin. Skor takibi tarayıcının yerel hafızasında tutulur, kişisel rekorlarını izleyebilirsin. Hiçbir oyun pay-to-win değil — sadece refleks, ritim ve biraz adrenalin.',
      'Mobil dokunmatik kontroller her oyunda destekli. Otobüste, sırada beklerken veya öğle arasında 2 dakikayı dolduran kısa oyunlar arıyorsan en yenilerden başla.',
    ],
  },
  {
    tag: 'refleks',
    title: 'Refleks Oyunları',
    metaDescription:
      'Refleks ve zamanlama oyunları tarayıcıda. Hızlı kararlar, doğru tıklama — ücretsiz, indirmesiz, mobil uyumlu.',
    intro: [
      'Refleks oyunları "doğru anda doğru hareket" üzerine kuruludur. Bir saniyenin onda biri içinde basacağın tuş, ekrandaki hedefin yerini değiştirir. Bu sayfadaki seçki, tarayıcıda anında oynanan, hızlı tepki gerektiren ücretsiz oyunları topluyor.',
      'Hepsi tek-tuş veya iki-tuş tasarımı — kontrolleri öğrenmek 5 saniyeyi geçmez. Asıl ustalaşma süresi, hareketleri görmeden öncesinden tahmin edebilmekte. İlk denemende 30 puan alabilirsin; 50. denemende 300 hedefliyorsun.',
      'Mola oyunu olarak ideal: 2 dakika oyna, mola bitince kapat. Tüm oyunlar mobile dokunmatik ile çalışır; metro yolculuğunda veya kuyrukta beklerken zaman geçirmek için tasarlandı.',
    ],
  },
  {
    tag: 'strateji',
    title: 'Strateji Oyunları',
    metaDescription:
      'Sıralı strateji oyunları tarayıcıda — plan kur, hamleni düşün, kazan. Ücretsiz ve indirmesiz Türkçe seçki.',
    intro: [
      'Strateji oyunları sabır ve öngörü ister. Bu kategoride bulduğun oyunlarda her hamle bir sonraki hamleyi şekillendirir; doğru sıra, doğru yer, doğru zaman seninle birlikte kazanır. Reversi, Nim, taktik puzzle\'lar ve özgün strateji twistleri.',
      'Sıralı oyunlar olduğu için aceleci kararlara yer yok — istediğin kadar düşünebilirsin. Birkaç dakikalık kısa partiler ile uzun, kafa yorucu meydan okumalar arasında geçiş yapan bir seçki. Mantığı seven okuyucular ve satranç meraklıları için ideal başlangıç.',
      'Hepsi tarayıcıda; indirme gerekmez, hesap açılmaz. Mobil ve masaüstünde aynı performansla çalışır. Yeni bir tür denemek istersen "en yeniden" başla — her oyunun strateji çekirdeği farklı.',
    ],
  },
  {
    tag: 'bulmaca',
    title: 'Bulmaca Oyunları',
    metaDescription:
      'Tarayıcıda ücretsiz bulmaca oyunları — nonogram, sudoku, mantık bulmacaları. İndirmesiz, hesapsız, anında oyna.',
    intro: [
      'Bulmaca oyunları beynin "Aha!" anlarını arar. Bu sayfada nonogram, sudoku, çıkarım ve mantık bulmacalarının tarayıcıda oynanabilen en güzel örneklerini topluyoruz. Her birinde sabit bir kural seti var; çözüm tek, yol senin.',
      'Klasik kağıt-kalem bulmacalarının dijital versiyonları ile özgün twistler bir arada. Bir bulmacayı bırakıp diğerine geçebilirsin — ilerlemen tarayıcının yerel hafızasında saklanır, geri döndüğünde aynı seviyeden devam edersin.',
      'Bulmaca seven herkes için tasarlandı — başlangıç seviyesinden uzman tempolarına kadar bir spektrum. Düşünmeyi sevdiğin akşamlar veya zihin açmak istediğin sabahlar için ideal.',
    ],
  },
  {
    tag: 'klasik',
    title: 'Klasik Tarayıcı Oyunları',
    metaDescription:
      'Tüm zamanların klasik tarayıcı oyunları — Snake, 2048, Tetris, Sudoku. Ücretsiz, Türkçe, indirmesiz oyna.',
    intro: [
      'Klasikler, her nesilden insanın bildiği oyunlardır: Snake, Tetris, 2048, Sudoku, Tic-Tac-Toe. Bu kategoride bu klasiklerin sade, reklamsız, hızlı yüklenen sürümlerini bulursun — büyüdüğün oyunları yine tarayıcıda, ama bugünün ekran ve performans standartlarıyla.',
      'Hiçbir oyun reklam pop-up\'ları, kayıt ekranı veya beklenmeyen para isteği içermez. Skor takibi yerel hafızada; tarayıcı verisini silersen sıfırdan başlarsın. Mobile dokunmatik kontroller her klasikte var.',
      'Çocukluğunu hatırlamak veya çocuğuna eski klasikleri tanıtmak istiyorsan iyi bir başlangıç noktası. Türkçe arayüz, hızlı sayfa açılışı, ekstra hiçbir şey gerektirmez.',
    ],
  },
  {
    tag: 'kart',
    title: 'Kart Oyunları',
    metaDescription:
      'Tarayıcıda ücretsiz kart oyunları — solitaire, eşleştirme, hafıza ve özgün desteler. İndirmesiz, anında oyna.',
    intro: [
      'Kart oyunları sabırla şans arasında dans eder. Bu sayfada tarayıcıda doğrudan oynanan ücretsiz kart oyunlarını topluyoruz — klasik solitaire varyantlarından eşleştirme ve hafıza temalı twistlere kadar.',
      'Her oyun mobile ve masaüstünde aynı hız ve sadelikte çalışır. Dokunmatik sürükle-bırak desteklenir; klasik kart deneyimini telefonda da rahatça yaşarsın. Hiçbir oyun reklam içermez, indirme istemez veya hesap açmanı talep etmez.',
      'Kısa bir mola oyununa çıkmak istiyorsan birkaç dakikalık desteler; uzun bir partiye gireceksen sabırlı solitaire varyantları seni bekliyor. Türkçe arayüz, basit kurallar, anında başlangıç.',
    ],
  },
  {
    tag: 'kelime',
    title: 'Kelime Oyunları',
    metaDescription:
      'Türkçe kelime oyunları tarayıcıda — anagram, kelime bulma, harf tahmin. Ücretsiz ve indirmesiz oyna.',
    intro: [
      'Kelime oyunları dil sezgisini eğlenceye dönüştürür. Bu sayfada Türkçe kelime oyunlarının tarayıcıda anında oynanan ücretsiz seçkisini bulursun — anagram, kelime tahmin, harf bulma ve sözcük türetme oyunları.',
      'Hepsinin Türkçe sözlük desteği var; yabancı dil kuralları ile uğraşmadan kendi dilinde oynarsın. Geniş bir kelime havuzu üzerinden seviyeler ilerler; her başarılı tahmin yeni bir mantık katmanı açar.',
      'Beyin egzersizi olarak veya çocuklarla birlikte kelime hazinesini geliştirmek için ideal. Mobile dokunmatik klavye uyumlu, kısa partiler için tasarlandı.',
    ],
  },
];
