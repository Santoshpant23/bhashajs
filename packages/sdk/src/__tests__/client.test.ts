import { describe, it, expect, beforeEach } from "vitest";
import { TranslationClient } from "../core/client";

describe("TranslationClient", () => {
  let client: TranslationClient;

  beforeEach(() => {
    client = new TranslationClient("test-project", "http://localhost:5000/api", "");
  });

  describe("preload", () => {
    it("loads translations into cache", () => {
      client.preload({
        en: { "hero.title": "Welcome" },
        hi: { "hero.title": "स्वागत" },
      });

      expect(client.translate("hero.title", "en")).toBe("Welcome");
      expect(client.translate("hero.title", "hi")).toBe("स्वागत");
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
      expect(client.translate("greeting", "en", { name: "Rohan", count: 5 })).toBe(
        "Hello Rohan, you have 5 items"
      );
    });

    it("replaces parameters in Hindi", () => {
      expect(client.translate("greeting", "hi", { name: "रोहन", count: 5 })).toBe(
        "नमस्ते रोहन, आपके पास 5 आइटम हैं"
      );
    });

    it("replaces all occurrences of same parameter", () => {
      client.preload({ en: { repeat: "{x} and {x}" } });
      expect(client.translate("repeat", "en", { x: "A" })).toBe("A and A");
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
      // "only.hindi" exists in Hindi but not Bengali
      expect(client.translate("only.hindi", "bn")).toBe("हिन्दी only");
    });

    it("Bengali falls back to English if not in Hindi either", () => {
      expect(client.translate("only.english", "bn")).toBe("English only");
    });

    it("Tamil does NOT fall back to Hindi (Dravidian language)", () => {
      // Tamil chain is ["ta", "en"] — no Hindi
      client.preload({ ta: {} });
      expect(client.translate("only.hindi", "ta")).toBe("only.hindi");
      // But it does fall back to English
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
      expect(client.translate("items_count", "en", { count: 1 })).toBe("1 item");
    });

    it("English: count=0 → plural", () => {
      expect(client.translate("items_count", "en", { count: 0 })).toBe("0 items");
    });

    it("English: count=5 → plural", () => {
      expect(client.translate("items_count", "en", { count: 5 })).toBe("5 items");
    });

    it("Hindi: count=0 → singular (the critical difference!)", () => {
      expect(client.translate("items_count", "hi", { count: 0 })).toBe("0 आइटम");
    });

    it("Hindi: count=1 → singular", () => {
      expect(client.translate("items_count", "hi", { count: 1 })).toBe("1 आइटम");
    });

    it("Hindi: count=5 → plural", () => {
      expect(client.translate("items_count", "hi", { count: 5 })).toBe("5 आइटमें");
    });

    it("falls back to _other if specific plural key missing", () => {
      client.preload({
        en: { messages_other: "{count} messages" },
      });
      // No messages_one exists, should fall back to messages_other
      expect(client.translate("messages", "en", { count: 1 })).toBe("1 messages");
    });

    it("falls back to original key if no plural keys exist", () => {
      client.preload({
        en: { greeting: "Hello" },
      });
      // "greeting" has no _one/_other variants
      expect(client.translate("greeting", "en", { count: 1 })).toBe("Hello");
    });

    it("no count param → no pluralization", () => {
      // Without count, should look for exact key "items_count" (which doesn't exist)
      expect(client.translate("items_count", "en", { name: "test" })).toBe("items_count");
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
