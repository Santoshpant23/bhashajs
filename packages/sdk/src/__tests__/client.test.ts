import { describe, it, expect, beforeEach } from "vitest";
import { TranslationClient } from "../core/client";

describe("TranslationClient", () => {
  let client: TranslationClient;

  beforeEach(() => {
    client = new TranslationClient("test-project", "http://localhost:5000/api", "");
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
});
