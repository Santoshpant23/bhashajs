import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TranslationClient } from "../core/client";

const originalFetch = globalThis.fetch;
const originalLocalStorage = (globalThis as any).localStorage;

function installLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage = {
    get length() {
      return data.size;
    },
    clear: vi.fn(() => data.clear()),
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(data.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  return { storage, data };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TranslationClient", () => {
  let client: TranslationClient;

  beforeEach(() => {
    client = new TranslationClient("test-project", "http://localhost:5000/api", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", { value: originalLocalStorage, configurable: true });
    if (originalFetch === undefined) Reflect.deleteProperty(globalThis, "fetch");
    else Object.defineProperty(globalThis, "fetch", { value: originalFetch, configurable: true });
  });

  describe("preload — legacy flat shape", () => {
    it("loads flat translations into the default register", () => {
      client.preload({
        en: { "hero.title": "Welcome" },
        hi: { "hero.title": "स्वागत" },
      });

      expect(client.translate("hero.title", "en")).toBe("Welcome");
      expect(client.translate("hero.title", "hi")).toBe("स्वागत");
    });
  });

  describe("preload — nested register shape", () => {
    it("loads register-aware translations and reads them by register", () => {
      client.preload({
        hi: {
          default: { "cart.add": "जोड़ें" },
          casual: { "cart.add": "Add करो" },
          formal: { "cart.add": "जोड़ें (कृपया)" },
        },
      });

      expect(client.translate("cart.add", "hi", "default")).toBe("जोड़ें");
      expect(client.translate("cart.add", "hi", "casual")).toBe("Add करो");
      expect(client.translate("cart.add", "hi", "formal")).toBe("जोड़ें (कृपया)");
    });

    it("falls back to default register if requested register is missing", () => {
      client.preload({
        hi: {
          default: { "cart.add": "जोड़ें" },
          // no casual variant for this key
        },
      });
      expect(client.translate("cart.add", "hi", "casual")).toBe("जोड़ें");
    });
  });

  describe("translate — basic", () => {
    beforeEach(() => {
      client.preload({
        en: { "hero.title": "Welcome", "nav.home": "Home" },
        hi: { "hero.title": "स्वागत" },
        bn: { "hero.title": "স্বাগতম" },
      });
    });

    it("returns translation for current language", () => {
      expect(client.translate("hero.title", "hi")).toBe("स्वागत");
    });

    it("returns key itself when nothing found", () => {
      expect(client.translate("missing.key", "hi")).toBe("missing.key");
    });

    it("does not resolve inherited Object prototype keys as translations", () => {
      expect(client.translate("constructor", "hi")).toBe("constructor");
    });
  });

  describe("translate — interpolation", () => {
    beforeEach(() => {
      client.preload({
        en: { greeting: "Hello {name}, you have {count} items" },
        hi: { greeting: "नमस्ते {name}, आपके पास {count} आइटम हैं" },
      });
    });

    it("replaces single parameter", () => {
      expect(client.translate("greeting", "en", "default", { name: "Rohan", count: 5 })).toBe(
        "Hello Rohan, you have 5 items"
      );
    });

    it("replaces parameters in Hindi", () => {
      expect(client.translate("greeting", "hi", "default", { name: "रोहन", count: 5 })).toBe(
        "नमस्ते रोहन, आपके पास 5 आइटम हैं"
      );
    });

    it("replaces all occurrences of same parameter", () => {
      client.preload({ en: { repeat: "{x} and {x}" } });
      expect(client.translate("repeat", "en", "default", { x: "A" })).toBe("A and A");
    });
  });

  describe("translate — interpolation edge cases (regression)", () => {
    it("value containing $& is inserted literally, not as a replacement pattern", () => {
      client.preload({ en: { greeting: "Hello {name}" } });
      expect(client.translate("greeting", "en", "default", { name: "$& world" })).toBe(
        "Hello $& world"
      );
    });

    it("value containing $1 and $$ is inserted literally", () => {
      client.preload({ en: { code: "Coupon: {c}" } });
      expect(client.translate("code", "en", "default", { c: "$1OFF $$" })).toBe(
        "Coupon: $1OFF $$"
      );
    });

    it("param key with regex metacharacters does not throw and replaces literally", () => {
      client.preload({ en: { weird: "x {a(b} y" } });
      expect(() =>
        client.translate("weird", "en", "default", { "a(b": "Z" })
      ).not.toThrow();
      expect(client.translate("weird", "en", "default", { "a(b": "Z" })).toBe("x Z y");
    });

    it("dotted param key matches the literal placeholder", () => {
      client.preload({ en: { d: "val {a.b}" } });
      expect(client.translate("d", "en", "default", { "a.b": "1" })).toBe("val 1");
    });

    it("missing param leaves the placeholder untouched", () => {
      client.preload({ en: { g: "Hi {name}, {extra} left" } });
      expect(client.translate("g", "en", "default", { name: "Asha" })).toBe(
        "Hi Asha, {extra} left"
      );
    });
  });

  describe("translate — fallback chains", () => {
    beforeEach(() => {
      client.preload({
        en: { "hero.title": "Welcome", "only.english": "English only" },
        hi: { "hero.title": "स्वागत", "only.hindi": "हिन्दी only" },
        bn: { "hero.title": "স্বাগতম" },
      });
    });

    it("Bengali falls back to Hindi", () => {
      expect(client.translate("only.hindi", "bn")).toBe("हिन्दी only");
    });

    it("Bengali falls back to English if not in Hindi either", () => {
      expect(client.translate("only.english", "bn")).toBe("English only");
    });

    it("Tamil does NOT fall back to Hindi (Dravidian language)", () => {
      client.preload({ ta: {} });
      expect(client.translate("only.hindi", "ta")).toBe("only.hindi");
      expect(client.translate("only.english", "ta")).toBe("English only");
    });

    it("Telugu does NOT fall back to Hindi", () => {
      client.preload({ te: {} });
      expect(client.translate("only.hindi", "te")).toBe("only.hindi");
      expect(client.translate("only.english", "te")).toBe("English only");
    });

    it("Punjabi Shahmukhi falls back to Urdu, not Hindi", () => {
      client.preload({
        ur: { "only.urdu": "اردو only" },
        "pa-PK": {},
      });
      expect(client.translate("only.urdu", "pa-PK")).toBe("اردو only");
      expect(client.translate("only.hindi", "pa-PK")).toBe("only.hindi");
    });
  });

  describe("translate — register × language fallback", () => {
    it("prefers same-language default over different-language casual", () => {
      // Bengali has casual missing, default present. Hindi has casual present.
      // We should pick Bengali default, not Hindi casual — language affinity wins
      // over register affinity.
      client.preload({
        hi: {
          default: { "cart.add": "जोड़ें" },
          casual: { "cart.add": "Add करो" },
        },
        bn: {
          default: { "cart.add": "যোগ করুন" },
        },
      });
      expect(client.translate("cart.add", "bn", "casual")).toBe("যোগ করুন");
    });

    it("falls all the way through register and language", () => {
      // Only English default exists. Hindi-casual request walks: hi/casual → hi/default
      // → en/casual → en/default → resolved.
      client.preload({
        en: { "cart.add": "Add" },
      });
      expect(client.translate("cart.add", "hi", "casual")).toBe("Add");
    });
  });

  describe("translate — pluralization", () => {
    beforeEach(() => {
      client.preload({
        en: {
          items_count_one: "{count} item",
          items_count_other: "{count} items",
        },
        hi: {
          items_count_one: "{count} आइटम",
          items_count_other: "{count} आइटमें",
        },
      });
    });

    it("English: count=1 → singular", () => {
      expect(client.translate("items_count", "en", "default", { count: 1 })).toBe("1 item");
    });

    it("English: count=0 → plural", () => {
      expect(client.translate("items_count", "en", "default", { count: 0 })).toBe("0 items");
    });

    it("English: count=5 → plural", () => {
      expect(client.translate("items_count", "en", "default", { count: 5 })).toBe("5 items");
    });

    it("Hindi: count=0 → singular (the critical difference!)", () => {
      expect(client.translate("items_count", "hi", "default", { count: 0 })).toBe("0 आइटम");
    });

    it("Hindi: count=1 → singular", () => {
      expect(client.translate("items_count", "hi", "default", { count: 1 })).toBe("1 आइटम");
    });

    it("Hindi: count=5 → plural", () => {
      expect(client.translate("items_count", "hi", "default", { count: 5 })).toBe("5 आइटमें");
    });

    it("falls back to _other if specific plural key missing", () => {
      client.preload({
        en: { messages_other: "{count} messages" },
      });
      expect(client.translate("messages", "en", "default", { count: 1 })).toBe("1 messages");
    });

    it("falls back to original key if no plural keys exist", () => {
      client.preload({
        en: { greeting: "Hello" },
      });
      expect(client.translate("greeting", "en", "default", { count: 1 })).toBe("Hello");
    });

    it("no count param → no pluralization", () => {
      expect(client.translate("items_count", "en", "default", { name: "test" })).toBe("items_count");
    });
  });

  describe("supportedLangs", () => {
    it("starts empty", () => {
      expect(client.getSupportedLangs()).toEqual([]);
    });

    it("can be set", () => {
      client.setSupportedLangs(["en", "hi", "bn"]);
      expect(client.getSupportedLangs()).toEqual(["en", "hi", "bn"]);
    });
  });

  describe("localStorage persistence", () => {
    it("serves a stored bundle immediately without waiting for the network", async () => {
      installLocalStorage({
        "bhashajs:b1:test-project:hi:default": JSON.stringify({
          v: 1,
          t: Date.now(),
          data: { greeting: "cached" },
        }),
      });
      vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

      const data = await client.fetchTranslations("hi");

      expect(data.greeting).toBe("cached");
      expect(client.translate("greeting", "hi")).toBe("cached");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("refreshes stored bundles in the background and notifies listeners", async () => {
      const { data: stored } = installLocalStorage({
        "bhashajs:b1:test-project:hi:default": JSON.stringify({
          v: 1,
          t: Date.now(),
          data: { greeting: "cached" },
        }),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: { greeting: "fresh" } }),
        })
      );
      const onUpdate = vi.fn();
      client.setOnBundleUpdate(onUpdate);

      const data = await client.fetchTranslations("hi");
      expect(data.greeting).toBe("cached");

      await tick();

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(client.translate("greeting", "hi")).toBe("fresh");
      const saved = JSON.parse(stored.get("bhashajs:b1:test-project:hi:default")!);
      expect(saved.data.greeting).toBe("fresh");
    });

    it("ignores storage errors and still fetches from the network", async () => {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: vi.fn(() => {
            throw new Error("blocked");
          }),
          setItem: vi.fn(() => {
            throw new Error("quota");
          }),
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: { greeting: "network" } }),
        })
      );

      const data = await client.fetchTranslations("hi");

      expect(data.greeting).toBe("network");
      expect(client.translate("greeting", "hi")).toBe("network");
    });

    it("falls back to persisted supported langs when project info fails with a NETWORK error", async () => {
      installLocalStorage({
        "bhashajs:p1:test-project": JSON.stringify({ v: 1, t: Date.now(), langs: ["en", "hi"] }),
      });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

      const langs = await client.fetchProjectInfo();

      expect(langs).toEqual(["en", "hi"]);
      expect(client.getSupportedLangs()).toEqual(["en", "hi"]);
    });

    it("does NOT mask an HTTP error (e.g. revoked key) with persisted langs", async () => {
      installLocalStorage({
        "bhashajs:p1:test-project": JSON.stringify({ v: 1, t: Date.now(), langs: ["en", "hi"] }),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => "Invalid API key",
        })
      );

      await expect(client.fetchProjectInfo()).rejects.toThrow(/HTTP 401/);
    });

    it("persists supported langs after a successful project-info fetch", async () => {
      const { data: stored } = installLocalStorage();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: { supportedLanguages: ["en", "ta"] } }),
        })
      );

      await client.fetchProjectInfo();

      const saved = JSON.parse(stored.get("bhashajs:p1:test-project")!);
      expect(saved.langs).toEqual(["en", "ta"]);
    });

    it("skips storage entirely when persistCache is false", async () => {
      const { storage } = installLocalStorage({
        "bhashajs:b1:test-project:hi:default": JSON.stringify({
          v: 1,
          t: Date.now(),
          data: { greeting: "cached" },
        }),
      });
      client = new TranslationClient("test-project", "http://localhost:5000/api", "", "", {
        persistCache: false,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: { greeting: "network" } }),
        })
      );

      const data = await client.fetchTranslations("hi");

      expect(data.greeting).toBe("network");
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.setItem).not.toHaveBeenCalled();
    });
  });
});
