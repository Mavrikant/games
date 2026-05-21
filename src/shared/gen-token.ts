// Generation token — cancels in-flight async callbacks after a reset.
// Guards against PITFALLS#stale-async-callback: setTimeout/RAF callbacks
// scheduled before reset() fire afterward and mutate the fresh state.
//
// Usage:
//   const gen = createGenToken();
//   const myGen = gen.current();
//   setTimeout(() => {
//     if (!gen.isCurrent(myGen)) return;  // canceled by reset
//     mutateState();
//   }, 100);
//
//   function reset(): void {
//     gen.bump();          // every in-flight callback now no-ops
//     // ... fresh state
//   }
//
// Prefer this pattern over `clearTimeout`/`cancelAnimationFrame` lists,
// which require tracking every handle.

export interface GenToken {
  bump(): number;
  current(): number;
  isCurrent(token: number): boolean;
}

export function createGenToken(): GenToken {
  let gen = 0;
  return {
    bump: () => ++gen,
    current: () => gen,
    isCurrent: (token: number) => token === gen,
  };
}
