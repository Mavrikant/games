# Küresel Sıralama (Global Leaderboard)

Çevrimiçi, oyuncular arası bir skor sıralaması. Statik site (GitHub Pages)
önünde tek bir **Supabase** projesi durur: Postgres + Auth (Google/GitHub OAuth)
+ otomatik REST. Frontend, Supabase'e yalnızca **giriş yapmış** oyuncular için
RLS korumalı yazma yapar.

> Özellik **bayrakla kapalı** gelir. `PUBLIC_SUPABASE_URL` veya
> `PUBLIC_SUPABASE_ANON_KEY` boşsa tüm çevrimiçi kod no-op olur, Supabase SDK'sı
> hiç yüklenmez, skorlar yalnızca `localStorage`'da kalır. Bu sayede smoke test
> (harici ağı bloklar, `console.error`'da patlar) yeşil kalır.

## Mimari

```
Statik frontend (base /games/)                      Supabase
  /siralama  ──OAuth login──▶ Auth (Google/GitHub)
  /siralama  ──select rows──▶ public.scores  (RLS: select herkese açık)
  /<slug>/ iframe ──submit_score RPC──▶ public.scores (insert: yalnız auth.uid())
```

- Oyun sayfaları **iframe** içinde çalışır ama parent ile **aynı origin**'dedir;
  bu yüzden `/siralama`'da kurulan Supabase oturumu (localStorage'da) iframe
  içindeki oyundan da okunur. Oyuncu **bir kez** giriş yapar.
- OAuth **üst pencerede** (siralama sayfası) başlatılmalı, iframe içinde değil.

## Kod tarafı (bu repoda)

| Dosya | Görev |
|---|---|
| `src/shared/leaderboard-client.ts` | Tüm Supabase ayrıntısı burada. SDK lazy `import()`. `getPlayer`, `signIn`, `signOut`, `submitScore`, `fetchLeaderboard`. Sağlayıcı değiştirmek = yalnız bu dosya + env. |
| `src/shared/leaderboard.ts` | `recordScore(desc, value)` — yerel best'i günceller **ve** çevrimiçi gönderir. Oyun mantığı bunu çağırır. |
| `src/pages/siralama.astro` + `src/archive/leaderboard.ts` | Sıralama sayfası ve runtime. |
| `src/content.config.ts` → `scoring` | Oyun başına skor tanımı (id, storageKey, label, unit, direction). |

## Yeni oyunu sıralamaya ekleme (adoption)

1. `src/content/games/<slug>.json` içine `scoring` bloğu ekle:
   ```json
   "scoring": { "storageKey": "<slug>.best", "label": "Skor", "direction": "higher" }
   ```
   Zaman tabanlı (düşük daha iyi) oyunlarda `"direction": "lower"`, `"unit": "sn"`.
2. `src/game-logic/<slug>.ts` içinde, oyun bittiği yerde:
   ```ts
   import { recordScore } from '@shared/leaderboard';
   const SCORE_DESC = { gameId: '<slug>', storageKey: '<slug>.best', direction: 'higher' as const };
   // ... oyun sonunda:
   recordScore(SCORE_DESC, finalScore);
   ```
3. Backend'de o `gameId` için bir `max_value` satırı ekle (aşağıdaki anti-cheat).

Referans uygulama: **2048** (`src/content/games/2048.json` + `src/game-logic/2048.ts`).

## Supabase kurulumu (tek seferlik, repo dışında)

1. **Proje oluştur**; Project URL + **anon** public key'i kopyala.
2. **OAuth sağlayıcılar**: Google ve/veya GitHub OAuth uygulaması oluştur,
   client id/secret'ı Supabase Auth'a gir. **Redirect URL**:
   `https://karaman.dev/games/siralama/` (ve dev için
   `http://localhost:4321/games/siralama/`).
3. **SQL** (aşağıdaki şema + RLS + RPC).
4. **GitHub** → Settings → Secrets and variables → Actions → **Variables**:
   `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`. (Lokal: `.env`.)

### Şema + RLS + RPC

```sql
-- Profiller: oyuncunun herkese görünen takma adı (e-posta DEĞİL).
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null
);
alter table public.profiles enable row level security;
create policy "profiles read"   on public.profiles for select using (true);
create policy "profiles upsert" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles update" on public.profiles for update using (auth.uid() = user_id);

-- Oyun başına oyuncunun EN İYİ skoru (tek satır).
create table public.scores (
  user_id    uuid not null references auth.users (id) on delete cascade,
  game_id    text not null,
  value      numeric not null,
  created_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
alter table public.scores enable row level security;
create policy "scores read" on public.scores for select using (true);
-- Yazma yalnızca RPC üzerinden (aşağıda). Doğrudan insert/update yok.

-- Anti-cheat: sunucu tarafı değer tavanı + yön bilgisi.
create table public.game_config (
  game_id   text primary key,
  direction text not null check (direction in ('higher','lower')),
  max_value numeric            -- üst sınır; null = sınırsız
);
alter table public.game_config enable row level security;
create policy "config read" on public.game_config for select using (true);
-- Örnek:
insert into public.game_config (game_id, direction, max_value)
values ('2048', 'higher', 4000000);

-- submit_score: auth.uid() damgalar, tavanı uygular, yöne göre en iyiyi tutar.
create or replace function public.submit_score(p_game_id text, p_value numeric)
returns void language plpgsql security definer set search_path = public as $$
declare cfg public.game_config%rowtype;
begin
  if auth.uid() is null then raise exception 'auth required'; end if;
  select * into cfg from public.game_config where game_id = p_game_id;
  if not found then raise exception 'unknown game'; end if;
  if cfg.max_value is not null and p_value > cfg.max_value then
    raise exception 'value out of range';
  end if;

  insert into public.scores (user_id, game_id, value)
  values (auth.uid(), p_game_id, p_value)
  on conflict (user_id, game_id) do update
    set value = excluded.value, created_at = now()
    where (cfg.direction = 'higher' and excluded.value > public.scores.value)
       or (cfg.direction = 'lower'  and excluded.value < public.scores.value);
end; $$;
```

> İlk girişte `profiles.display_name`'i sağlayıcı adından doldurabilir veya
> oyuncuya bir kez sordurabilirsiniz. Rate-limit için `submit_score` içine
> oyuncu başına son N saniyede sayım eklenebilir (v1'de opsiyonel).

## Anti-cheat — gerçekçi sınır

İstemci tarafı oyunlarda skorlar **doğası gereği taklit edilebilir**: güvenilir
bir sunucu oyunu yeniden oynamadığı için herhangi bir oyuncu devtools'tan sahte
skor gönderebilir. v1 yaklaşımı:

- **RLS**: oyuncu yalnız kendi `auth.uid()` satırını yazar.
- **`submit_score` RPC**: oyun başına `max_value` tavanı + yön mantığı sunucuda.
- (Sonraki) `submit_score` içinde oyuncu/oyun başına rate-limit; imzalı token.

Bu yüzden panolar "topluluk skorları" olarak etiketlenir, "doğrulanmış" değil.

## Test

- **Kapalı (varsayılan)**: env boş → `npm run dev`, `/games/siralama/` "yakında"
  gösterir; 2048 yine yerel best kaydeder, ağ trafiği yok.
- **Smoke**: `npm run test:smoke` (env boş ve erişilemez host ile) yeşil olmalı —
  `console.error` yok, SDK yüklenmez.
- **Açık**: Supabase projesini kur, `.env`'i doldur, `/siralama`'da Google/GitHub
  ile giriş yap, 2048'i oyun-sonuna kadar oyna, satırın geldiğini ve yenilemede
  kaldığını doğrula. RLS'in başka kullanıcının id'sini yazmayı, RPC'nin saçma
  değeri reddettiğini doğrula.
