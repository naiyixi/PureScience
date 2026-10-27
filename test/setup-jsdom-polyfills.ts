// jsdom doesn't implement ResizeObserver, but react-zoom-pan-pinch constructs one on mount.
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {
      /* no-op: layout measurement isn't meaningful in jsdom */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
}

// React's `act()` only takes its concurrent path when this flag is set, and warns on EVERY update it
// sees otherwise: "The current testing environment is not configured to support act(...)". That
// message is not per-file noise we want to live with -- measured on a green Verify job it was 77,419
// lines and 62% of the 12.4MB job log, which is past the point where the job log still carries the
// failure reason. Declaring it once here replaces the per-file declarations this suite used to need
// (they stay harmlessly redundant) and, more importantly, puts every jsdom test on the code path
// React intends for an act environment instead of the degraded one.
//
// Gated on `window`: only jsdom tests run React, and a node-environment test must not claim to be an
// act environment. Tests may still flip it themselves; nothing here re-asserts it later.
if (typeof window !== 'undefined') {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
}

// Node 26 exposes an unusable experimental localStorage getter unless --localstorage-file is set,
// which can shadow jsdom's implementation and fail renderer tests before their first assertion.
// Install the browser-compatible in-memory surface only when the active environment has none.
if (typeof globalThis.localStorage === 'undefined') {
  const values = new Map<string, string>()
  const localStorage: Storage = {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(String(key)),
    setItem: (key, value) => values.set(String(key), String(value))
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorage
  })
}
