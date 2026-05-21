// Safe localStorage wrappers. Use these instead of raw localStorage in
// game-logic modules. Guards against PITFALLS#unguarded-storage:
// Safari private mode, embedded WebView, and iframe sandboxes can throw
// on any localStorage access — direct calls crash module imports.
//
// JSON serialization is built-in: pass any structured-cloneable value.
// On read, returns `fallback` if key missing, JSON malformed, or storage
// throws. Never throws.

export function safeRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function safeWrite(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage disabled, full, or otherwise unavailable.
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // noop
  }
}
