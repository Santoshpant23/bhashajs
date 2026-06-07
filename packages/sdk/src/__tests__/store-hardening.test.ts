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

describe("BhashaStore — locale is one atomic (lang, register) target", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  // A fetch spy that records the (lang, register) pair of every translations
  // request and returns an empty-but-valid bundle. The store uses projectKey so
  // it hits the public /sdk/translations endpoint with ?lang=&register=.
  function installFetchSpy(): { pairs: Set<string>; calls: string[] } {
    const pairs = new Set<string>();
    const calls: string[] = [];
    global.fetch = ((input: any) => {
      const url = String(input);
      const u = new URL(url);
      const lang = u.searchParams.get("lang") ?? "";
      const register = u.searchParams.get("register") ?? "";
      if (url.includes("/translations")) {
        const pair = `${lang}:${register}`;
        pairs.add(pair);
        calls.push(pair);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: {} }),
        text: () => Promise.resolve(""),
      } as Response);
    }) as typeof fetch;
    return { pairs, calls };
  }

  function makeNetworkStore() {
    // projectKey → public endpoints; no preloaded translations so every
    // (lang, register) bundle must be fetched.
    return new BhashaStore({
      projectKey: "bjs_test",
      defaultLang: "en",
      applyDocument: false,
    });
  }

  it("interleaved setLang+setRegister actually FETCHES the final (lang, register) pair", async () => {
    const store = makeNetworkStore();
    // Pre-seed supported langs so init() doesn't need project info.
    await store.init().catch(() => {});

    const { pairs } = installFetchSpy();

    // Interleave: kick off a language switch, then a register switch BEFORE the
    // first resolves. The committed state will be hi/formal — so the hi/formal
    // bundle MUST have been fetched. The old per-dimension-counter design
    // fetched only hi/default and en/formal and never hi/formal (the bug).
    const p1 = store.setLang("hi");
    const p2 = store.setRegister("formal");
    await Promise.all([p1, p2]);

    const s = store.getState();
    // Committed state matches the last-requested pair.
    expect(s.lang).toBe("hi");
    expect(s.register).toBe("formal");
    expect(s.isLoading).toBe(false);
    // The ACTUALLY-committed bundle was genuinely fetched (the regression).
    expect(pairs.has("hi:formal")).toBe(true);
  });

  it("the reverse interleave (register then lang) also fetches the final pair", async () => {
    const store = makeNetworkStore();
    await store.init().catch(() => {});

    const { pairs } = installFetchSpy();

    const p1 = store.setRegister("formal");
    const p2 = store.setLang("hi");
    await Promise.all([p1, p2]);

    const s = store.getState();
    expect(s.lang).toBe("hi");
    expect(s.register).toBe("formal");
    expect(pairs.has("hi:formal")).toBe(true);
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
