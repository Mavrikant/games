// GameModule contract — opt-in TypeScript interface for game-logic modules.
// New games SHOULD export `const game = defineGame({ init, ... })` instead
// of relying on module-level side effects. This:
//
// 1. Catches missing init() at build time (TS error if `init` is omitted).
// 2. Moves all DOM/storage access into init(), avoiding PITFALLS#unguarded-
//    storage (module-level localStorage throw in Safari private mode).
// 3. Gives a single entry point for future reset/destroy lifecycle hooks.
//
// `defineGame()` auto-invokes init() on the next microtask when running in
// a browser context. The existing [slug].astro loader executes after the
// DOM is parsed, so DOM queries inside init() are safe. Test/SSR contexts
// (no `document`) skip the auto-init so modules can be imported safely.
//
// Existing games (no `defineGame` opt-in) continue to work unchanged via
// module-level side effects — migration is gradual (see strategy M6).

export interface GameModule {
  /** Called once after the DOM is ready. All setup goes here. */
  init: () => void;
  /** Restart current run/level without reloading the module. */
  reset?: () => void;
  /** Tear down for navigation away (rarely needed; pages are full reloads). */
  destroy?: () => void;
}

export function defineGame(module: GameModule): GameModule {
  if (typeof document !== 'undefined') {
    queueMicrotask(() => {
      module.init();
    });
  }
  return module;
}
