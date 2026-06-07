import { describe, it, expect, afterEach } from "vitest";
import { BhashaStore } from "../core/store";

// Regression tests for the v0.4 store hardening:
//  - setLang/setRegister surface errors and clear loading (no wedged spinner,
//    no unhandled rejection) — v0.3 only guarded init().
//  - emit() isolates a throwing subscriber so it can't starve the others.
//  - getState() returns a copy that can't poison internal state.

function makeStore() {
  return new BhashaStore({
    defaultLang: "en",
    applyDocument: false,
    preloadedTranslations: {
      en: { greeting: "Hello", "hero.title": "Welcome" },
      hi: { greeting: "नमस्ते", "hero.title": "स्वागत" },
    },
  });
}

describe("BhashaStore — error handling on switches", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("setLang surfaces an error and clears loading when the fetch fails", async () => {
    const store = makeStore();
    await store.init();
    // "bn" isn't preloaded → setLang triggers a network fetch, which we fail.
    global.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;

    await expect(store.setLang("bn")).resolves.toBeUndefined(); // does NOT reject
    const s = store.getState();
    expect(s.isLoading).toBe(false); // not wedged
    expect(s.error).toBeTruthy(); // surfaced
    expect(s.lang).toBe("en"); // did not switch to the failed language
  });

  it("setRegister surfaces an error and clears loading when the fetch fails", async () => {
    const store = makeStore();
    await store.init();
    global.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;

    await expect(store.setRegister("formal")).resolves.toBeUndefined();
    const s = store.getState();
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeTruthy();
    expect(s.register).toBe("default");
  });
});

describe("BhashaStore — subscriber isolation & immutable state", () => {
  it("a throwing subscriber does not starve the others", async () => {
    const store = makeStore();
    await store.init();
    const received: string[] = [];
    store.subscribe(() => {
      throw new Error("bad subscriber");
    });
    store.subscribe((s) => {
      received.push(s.segment ?? "");
    });
    // setSegment emits synchronously; the throwing first listener must not stop
    // the second from being notified.
    await store.setSegment("power-user");
    expect(received.length).toBeGreaterThan(0);
  });

  it("getState returns a copy that cannot mutate internal state", async () => {
    const store = makeStore();
    await store.init();
    const snapshot = store.getState();
    (snapshot as { lang: string }).lang = "MUTATED";
    expect(store.getState().lang).not.toBe("MUTATED");
    expect(store.getState().lang).toBe("en");
  });
});
