import { describe, it, expect } from "vitest";
import { flattenTranslations } from "../utils/flatten";

describe("flattenTranslations", () => {
  it("passes flat string bundles through", () => {
    const { flat, skipped } = flattenTranslations({
      "hero.title": "Welcome",
      nav_home: "Home",
    });

    expect(flat["hero.title"]).toBe("Welcome");
    expect(flat.nav_home).toBe("Home");
    expect(skipped).toEqual([]);
  });

  it("flattens nested plain objects with dots", () => {
    const { flat, skipped } = flattenTranslations({
      checkout: {
        title: "Checkout",
        summary: { total: "Total" },
      },
    });

    expect(flat["checkout.title"]).toBe("Checkout");
    expect(flat["checkout.summary.total"]).toBe("Total");
    expect(skipped).toEqual([]);
  });

  it("records paths deeper than eight segments as skipped", () => {
    const { flat, skipped } = flattenTranslations({
      a: { b: { c: { d: { e: { f: { g: { h: { i: "too deep" } } } } } } } },
    });

    expect(Object.keys(flat)).toEqual([]);
    expect(skipped).toEqual(["a.b.c.d.e.f.g.h.i"]);
  });

  it("skips non-string leaves", () => {
    const { flat, skipped } = flattenTranslations({
      good: "yes",
      count: 3,
      enabled: true,
      list: ["x"],
      nested: { missing: null },
    });

    expect(flat.good).toBe("yes");
    expect(skipped).toEqual(["count", "enabled", "list", "nested.missing"]);
  });

  it("preserves legacy __proto__ keys without polluting prototypes", () => {
    const input = JSON.parse('{ "__proto__": "legacy", "safe": { "__proto__": "nested" } }');
    const { flat } = flattenTranslations(input);

    expect(Object.getPrototypeOf(flat)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(flat, "__proto__")).toBe(true);
    expect(flat["__proto__"]).toBe("legacy");
    expect(flat["safe.__proto__"]).toBe("nested");
    expect(({} as any).legacy).toBeUndefined();
  });
});
