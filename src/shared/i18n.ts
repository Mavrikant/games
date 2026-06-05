// Minimal i18n for UI strings. Game content (titles, descriptions,
// howToPlay) ships in the content collection — see src/content.config.ts
// `en` block. This module only carries the chrome around the content:
// nav, search placeholders, hero copy, footer labels.
//
// Lookup falls back to TR when an EN key is missing so the EN site stays
// functional even before every string is translated.

export type Lang = 'tr' | 'en';

const messages: Record<Lang, Record<string, string>> = {
  tr: {
    'site.title': 'Tarayıcı Oyunları — ücretsiz, indirmesiz, anında oyna',
    'site.description':
      'Tarayıcıda oynanan ücretsiz oyun arşivi. Snake, XOX, 2048 ve daha fazlası — indirme yok, hesap yok, anında oyna. Her hafta yeni oyun.',
    'site.brandPath': 'games',
    'hero.eyebrow': 'Her gün yeni oyun',
    'hero.title': 'Tarayıcıda oyna.',
    'hero.titleAlt': 'Klon değil.',
    'hero.subtitle':
      'Klasiklere taze mekanik twistleri ve hiç oynamadığın orijinal fikirler. Her oyun tek tıkla başlar — indirme yok, kayıt yok. Türkçe ve ücretsiz; arşive her hafta yeni bir oyun katılır.',
    'search.placeholder': 'Oyun ara…',
    'search.label': 'Oyun ara',
    'sort.label': 'Sırala',
    'sort.newest': 'En yeni',
    'sort.oldest': 'En eski',
    'sort.alpha': 'Alfabetik',
    'tags.all': 'Tümü',
    'games.count': '{n} oyun',
    'featured.eyebrow': 'Bugünün önerisi',
    'featured.done': 'Bugün oynadın',
    'featured.cta': 'Hemen oyna →',
    'breadcrumb.home': 'Ana Sayfa',
    'related.title': 'İlgili oyunlar',
    'footer.updated': 'Son güncelleme',
    'lang.switchToEn': 'English',
    'lang.switchToTr': 'Türkçe',
    'controls.heading': 'Kontroller',
    'howto.heading': 'Nasıl oynanır?',
    'howto.summary': 'İpuçları ve detaylı strateji',
    'category.intro.count': 'Bu kategoride {n} oyun var — en yeniden eskiye sıralı.',
    'nav.leaderboard': 'Sıralama',
    'leaderboard.title': 'Sıralama',
    'leaderboard.empty': 'Henüz skor yok',
    'leaderboard.signin': 'Giriş yap',
    'leaderboard.signout': 'Çıkış',
    'leaderboard.soon': 'Çevrimiçi sıralama yakında',
  },
  en: {
    'site.title': 'Browser Games — free, no install, play instantly',
    'site.description':
      'Free browser games archive. Snake, XOX, 2048 and more — no install, no signup, play instantly. New games every week.',
    'site.brandPath': 'games',
    'hero.eyebrow': 'New game every week',
    'hero.title': 'Play in your browser.',
    'hero.titleAlt': 'No clones.',
    'hero.subtitle':
      'Fresh mechanical twists on classics, plus originals you haven\'t played anywhere else. Every game starts in one click — no install, no signup. Free; new game every week.',
    'search.placeholder': 'Search games…',
    'search.label': 'Search games',
    'sort.label': 'Sort',
    'sort.newest': 'Newest',
    'sort.oldest': 'Oldest',
    'sort.alpha': 'A–Z',
    'tags.all': 'All',
    'games.count': '{n} games',
    'featured.eyebrow': "Today's pick",
    'featured.done': 'Played today',
    'featured.cta': 'Play now →',
    'breadcrumb.home': 'Home',
    'related.title': 'Related games',
    'footer.updated': 'Last updated',
    'lang.switchToEn': 'English',
    'lang.switchToTr': 'Türkçe',
    'controls.heading': 'Controls',
    'howto.heading': 'How to play',
    'howto.summary': 'Tips and detailed strategy',
    'category.intro.count': '{n} games in this category — newest first.',
    'nav.leaderboard': 'Leaderboard',
    'leaderboard.title': 'Leaderboard',
    'leaderboard.empty': 'No scores yet',
    'leaderboard.signin': 'Sign in',
    'leaderboard.signout': 'Sign out',
    'leaderboard.soon': 'Online leaderboard coming soon',
  },
};

export function t(
  key: string,
  lang: Lang = 'tr',
  params?: Record<string, string | number>,
): string {
  let text = messages[lang][key] ?? messages.tr[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}

// HTML lang attribute and OG locale per language.
export const htmlLang: Record<Lang, string> = {
  tr: 'tr',
  en: 'en',
};
export const ogLocale: Record<Lang, string> = {
  tr: 'tr_TR',
  en: 'en_US',
};
