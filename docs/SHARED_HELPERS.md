# Shared Helpers — `@shared/*`

> Yeni oyun yazarken **bu helper'ları kullan**. Aksi halde 46 oyunun
> tekrarladığı boilerplate'i (50+ LOC) sıfırdan yazarsın ve PITFALLS'ı
> kaçırma riskine girersin.

Bu modüller `src/shared/`'da bulunur ve **import-only**'dir — modify etmek
shared layer değişikliğidir (AGENTS.md).

## `@shared/game-module`

Oyunun lifecycle entry point'i. Module-level side effect yerine **explicit
`init()` boundary** kurar.

```ts
import { defineGame } from '@shared/game-module';

function init(): void {
  // Buraya tüm querySelector + addEventListener + localStorage erişimi.
  const canvas = document.querySelector<HTMLCanvasElement>('#board')!;
  // ...
}

function reset(): void {
  // Sıfırlama mantığı. Opsiyonel ama tavsiye edilir.
}

export const game = defineGame({ init, reset });
```

**Neden?**
- `init()` browser'da DOM parse sonrası `queueMicrotask` ile otomatik çağrılır.
  Manuel çağrıya gerek **yok**.
- Module-level `document.querySelector` veya `localStorage.getItem` yazma —
  Safari private mode bunları throw eder ve oyun hiç yüklenmez
  (PITFALLS#unguarded-storage).
- `init` zorunlu, `reset`/`destroy` opsiyonel — TS, `init` unutulursa
  build-time'da hata verir.

## `@shared/storage`

`localStorage` etrafında safe wrapper. **Asla** `localStorage.getItem`/
`setItem` çağırma — bunları kullan.

```ts
import { safeRead, safeWrite, safeRemove } from '@shared/storage';

// JSON-encoded. Generic — istediğin tipi T olarak ver.
const best = safeRead<number>('myslug.best', 0);
const stats = safeRead<{ wins: number; losses: number }>('myslug.stats', {
  wins: 0,
  losses: 0,
});

// JSON-encoded write. Throw etmez.
safeWrite('myslug.best', 47);
safeWrite('myslug.stats', { wins: 3, losses: 1 });

// Silme (rare).
safeRemove('myslug.stats');
```

**Önemli**: `safeRead`/`safeWrite` JSON-encoded değer saklar. Eğer eski bir
oyun raw string (örn. `localStorage.setItem('foo', 'hello')`) ile yazmış ve
oyunu migrate ediyorsan, **veri formatı değişir**. Eski kullanıcı verisini
korumak istiyorsan local `try/catch` ile devam et (örnek:
`src/game-logic/memory.ts`).

PITFALLS#unguarded-storage'ı yapısal olarak engeller.

## `@shared/overlay`

Standart overlay göster/gizle. `.overlay--hidden` class + `aria-hidden`
attribute'unu **atomik** toggle eder — manuel bir-birini-unutma sorununu
ortadan kaldırır.

```ts
import { showOverlay, hideOverlay, isOverlayHidden } from '@shared/overlay';

const overlay = document.querySelector<HTMLElement>('#overlay')!;
showOverlay(overlay);  // .overlay--hidden kaldır, aria-hidden="false"
hideOverlay(overlay);  // .overlay--hidden ekle, aria-hidden="true"

if (isOverlayHidden(overlay)) {
  // ...
}
```

**Required CSS**: Senin per-game CSS'inde `.overlay--hidden { display: none }`
(veya `visibility: hidden`) tanımlı olmalı. Mevcut oyunlar bu kalıbı zaten
kullanıyor.

**Per-game prefix yapıyorsan** (örn. `.aa-overlay--hidden`,
`.vd-overlay--open`): @shared/overlay bu class'larla çalışmaz — kendi local
`showOverlay`/`hideOverlay` fonksiyonlarını yaz (örnek:
`src/game-logic/adam-asmaca.ts`). Veya CSS'i standart `.overlay--hidden`
adına refactor et.

## `@shared/gen-token`

Reset sırasında in-flight async callback'leri iptal etmek için **generation
token**. PITFALLS#stale-async-callback'i çözer.

```ts
import { createGenToken } from '@shared/gen-token';

const gen = createGenToken();

function startAITurn(): void {
  const myGen = gen.current();
  setTimeout(() => {
    if (!gen.isCurrent(myGen)) return;  // reset edildi → no-op
    aiMove();
  }, 300);
}

function reset(): void {
  gen.bump();  // bekleyen tüm callback'ler artık no-op
  // ... fresh state
}
```

**Ne zaman kullan**:
- `setTimeout` veya `setInterval` ile gecikmiş callback'in
- Promise zinciri (`fetch().then(...)`)
- `requestAnimationFrame` çağrısı bir state'i mutate edecek
- ResizeObserver / IntersectionObserver callback

**Ne zaman kullanma**:
- Tek bir `setInterval` ki `clearInterval` ile zaten yönetiyorsun (örn.
  snake'in tick loop'u)
- `requestAnimationFrame(loop)` ki `loop` kendisi state flag'lere bakıp
  early return ediyor (örn. flappy)

Aşırı kullanım dead code yaratır — yalnız gerçek async race olduğunda.

## Mevcut oyun örnekleri

`@shared/*` adoption'a örnek için bak:
- `src/game-logic/tic-tac-toe.ts` — basit DOM tabanlı (192 LOC)
- `src/game-logic/2048.ts` — gen-token + animation timer (438 LOC)
- `src/game-logic/tetris.ts` — büyük canvas oyun, DAS input (1030 LOC)
- `src/game-logic/vardiya.ts` — multi-level state machine (~600 LOC)

## Yeni helper eklemek istiyorsan

`src/shared/`'a yeni dosya eklemek **shared layer** değişikliğidir:

1. Önce ihtiyacı kanıtla: en az 3 oyunda aynı pattern duplicate ediyor mu?
2. AGENTS.md'nin "human review" kuralı: PR'da insan onayı iste, kendi
   başına merge etme.
3. API minimal olsun — 3'ten fazla export bir bölünme sinyali.
4. Inline JSDoc + bir-iki kullanım örneği commit message'a koy.
