import { describe, it, expect } from "vitest";
import { BhashaStore } from "../core/store";

// The framework-agnostic engine. Driven entirely by preloaded translations so
// the tests touch no network. applyDocument:false keeps it headless.

function makeStore() {
  return new BhashaStore({
    defaultLang: "en",
    applyDocument: false,
    preloadedTranslations: {
      en: { greeting: "Hello {name}", "hero.title": "Welcome" },
      hi: { greeting: "नमस्ते {name}", "hero.title": "स्वागत" },
    },
  });
}

describe("BhashaStore", () => {
  it("initializes from preloaded translations with no network", async () => {
    const store = makeStore();
    await store.init();
    const s = store.getState();
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.supportedLangs.sort()).toEqual(["en", "hi"]);
  });

  it("t() translates + interpolates in the active language", async () => {
    const store = makeStore();
    await store.init();
    expect(store.t("greeting", { name: "Asha" })).toBe("Hello Asha");
    expect(store.t("hero.title")).toBe("Welcome");
  });

  it("setLang switches the active language and notifies subscribers", async () => {
    const store = makeStore();
    await store.init();

    const seen: string[] = [];
    const unsub = store.subscribe((s) => seen.push(s.lang));

    await store.setLang("hi");
    expect(store.getState().lang).toBe("hi");
    expect(store.t("greeting", { name: "Asha" })).toBe("नमस्ते Asha");
    expect(seen).toContain("hi"); // subscriber was notified
    const countAfterHi = seen.length;

    unsub();
    await store.setLang("en");
    // After unsubscribe the listener receives no further notifications.
    expect(seen.length).toBe(countAfterHi);
    expect(store.getState().lang).toBe("en"); // but the store still switched
  });

  it("formatters follow the active language", async () => {
    const store = makeStore();
    await store.init();
    await store.setLang("hi");
    const cur = store.formatCurrency(1234567);
    expect(cur).toContain("₹");
    expect(cur).toContain("12,34,567");
  });

  it("does nothing (no throw) when switching to the current language", async () => {
    const store = makeStore();
    await store.init();
    await expect(store.setLang("en")).resolves.toBeUndefined();
  });
});
