import { describe, it, expect, beforeEach } from "vitest";
import { TranslationClient } from "../core/client";

// Regression tests for the plural-across-fallback bug (v0.4):
// The plural category must be computed for the language whose cell is actually
// RESOLVED during the fallback walk — not for the requested language. Otherwise
// a Hindi count=0 (category "one") that falls back to English picks English's
// "_one" cell and renders English's SINGULAR ("0 item") instead of its correct
// plural ("0 items").

describe("translate — plural category follows the resolved language, not the requested one", () => {
  let client: TranslationClient;
  beforeEach(() => {
    client = new TranslationClient("test", "http://localhost:5000/api", "");
  });

  it("Hindi count=0 falling back to English returns English's PLURAL (0 notifications)", () => {
    // Only English has the plural cells; Hindi has none for this key.
    client.preload({
      en: {
        notif_count_one: "{count} notification",
        notif_count_other: "{count} notifications",
      },
    });
    expect(client.translate("notif_count", "hi", "default", { count: 0 })).toBe(
      "0 notifications"
    );
    expect(client.translate("notif_count", "hi", "default", { count: 1 })).toBe(
      "1 notification"
    );
  });

  it("Hindi keeps its own rule (0 is singular) when Hindi has the cells", () => {
    client.preload({
      hi: { box_count_one: "{count} डिब्बा", box_count_other: "{count} डिब्बे" },
      en: { box_count_one: "{count} box", box_count_other: "{count} boxes" },
    });
    expect(client.translate("box_count", "hi", "default", { count: 0 })).toBe("0 डिब्बा");
    expect(client.translate("box_count", "hi", "default", { count: 1 })).toBe("1 डिब्बा");
    expect(client.translate("box_count", "hi", "default", { count: 2 })).toBe("2 डिब्बे");
  });

  it("a language's own base key wins over a fallback language's plural form", () => {
    client.preload({
      hi: { cart_count: "{count} सामान" },
      en: { cart_count_one: "{count} item", cart_count_other: "{count} items" },
    });
    expect(client.translate("cart_count", "hi", "default", { count: 5 })).toBe("5 सामान");
  });
});
