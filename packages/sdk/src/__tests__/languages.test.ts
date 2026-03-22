import { describe, it, expect } from "vitest";
import {
  LANGUAGES,
  FALLBACK_CHAINS,
  REGION_OVERRIDES,
  getLangInfo,
  getFallbackChain,
  resolveRegion,
} from "../utils/languages";

describe("LANGUAGES database", () => {
  const expectedLangs = [
    "en", "hi", "bn", "ur", "ta", "te", "mr", "ne", "pa", "pa-PK", "gu", "kn", "ml", "si",
  ];

  it("has 14 entries (13 languages, pa has 2 scripts)", () => {
    expect(Object.keys(LANGUAGES)).toHaveLength(14);
  });

  it("contains all expected language codes", () => {
    for (const code of expectedLangs) {
      expect(LANGUAGES[code]).toBeDefined();
    }
  });

  describe("every entry has all required fields", () => {
    for (const [code, info] of Object.entries(LANGUAGES)) {
      it(`${code} (${info.englishName})`, () => {
        expect(info.code).toBe(code);
        expect(info.name).toBeTruthy();
        expect(info.englishName).toBeTruthy();
        expect(["ltr", "rtl"]).toContain(info.dir);
        expect(info.font).toBeTruthy();
        expect(info.script).toBeTruthy();
        expect(info.defaultRegion).toBeTruthy();
        expect(info.intlLocale).toBeTruthy();
        expect(info.numberingSystem).toBeTruthy();
        expect(info.defaultCurrency).toBeTruthy();
      });
    }
  });

  describe("RTL languages", () => {
    it("Urdu is RTL", () => {
      expect(LANGUAGES.ur.dir).toBe("rtl");
    });

    it("Punjabi Shahmukhi is RTL", () => {
      expect(LANGUAGES["pa-PK"].dir).toBe("rtl");
    });

    it("all other languages are LTR", () => {
      const ltrLangs = expectedLangs.filter((l) => l !== "ur" && l !== "pa-PK");
      for (const code of ltrLangs) {
        expect(LANGUAGES[code].dir).toBe("ltr");
      }
    });
  });

  describe("script assignments", () => {
    it("Hindi, Marathi, Nepali share Devanagari", () => {
      expect(LANGUAGES.hi.script).toBe("Devanagari");
      expect(LANGUAGES.mr.script).toBe("Devanagari");
      expect(LANGUAGES.ne.script).toBe("Devanagari");
    });

    it("Urdu and pa-PK share Nastaliq/Shahmukhi font", () => {
      expect(LANGUAGES.ur.font).toContain("Nastaliq");
      expect(LANGUAGES["pa-PK"].font).toContain("Nastaliq");
    });
  });

  describe("currencies", () => {
    it("Indian languages default to INR", () => {
      for (const code of ["hi", "ta", "te", "mr", "pa", "gu", "kn", "ml"]) {
        expect(LANGUAGES[code].defaultCurrency).toBe("INR");
      }
    });

    it("Bengali defaults to BDT (Bangladesh)", () => {
      expect(LANGUAGES.bn.defaultCurrency).toBe("BDT");
    });

    it("Urdu defaults to PKR (Pakistan)", () => {
      expect(LANGUAGES.ur.defaultCurrency).toBe("PKR");
    });

    it("Sinhala defaults to LKR (Sri Lanka)", () => {
      expect(LANGUAGES.si.defaultCurrency).toBe("LKR");
    });

    it("Nepali defaults to NPR", () => {
      expect(LANGUAGES.ne.defaultCurrency).toBe("NPR");
    });
  });
});

describe("FALLBACK_CHAINS", () => {
  it("Dravidian languages do NOT fall back to Hindi", () => {
    const dravidian = ["ta", "te", "kn", "ml"];
    for (const lang of dravidian) {
      expect(FALLBACK_CHAINS[lang]).not.toContain("hi");
      expect(FALLBACK_CHAINS[lang]).toContain("en");
    }
  });

  it("Indo-Aryan languages fall back to Hindi", () => {
    const indoAryan = ["bn", "mr", "ne", "pa", "gu"];
    for (const lang of indoAryan) {
      expect(FALLBACK_CHAINS[lang]).toContain("hi");
    }
  });

  it("Punjabi Shahmukhi falls back to Urdu (not Hindi)", () => {
    expect(FALLBACK_CHAINS["pa-PK"]).toContain("ur");
    expect(FALLBACK_CHAINS["pa-PK"]).not.toContain("hi");
  });

  it("every chain ends with English", () => {
    for (const [lang, chain] of Object.entries(FALLBACK_CHAINS)) {
      if (lang !== "en") {
        expect(chain[chain.length - 1]).toBe("en");
      }
    }
  });

  it("every chain starts with the language itself", () => {
    for (const [lang, chain] of Object.entries(FALLBACK_CHAINS)) {
      expect(chain[0]).toBe(lang);
    }
  });
});

describe("getLangInfo", () => {
  it("returns correct info for known languages", () => {
    const hi = getLangInfo("hi");
    expect(hi.name).toBe("हिन्दी");
    expect(hi.dir).toBe("ltr");
  });

  it("returns safe default for unknown languages", () => {
    const unknown = getLangInfo("xx");
    expect(unknown.code).toBe("xx");
    expect(unknown.dir).toBe("ltr");
    expect(unknown.font).toBe("sans-serif");
    expect(unknown.script).toBe("Unknown");
    expect(unknown.numberingSystem).toBe("latn");
  });
});

describe("getFallbackChain", () => {
  it("returns defined chain for known languages", () => {
    expect(getFallbackChain("bn")).toEqual(["bn", "hi", "en"]);
  });

  it("returns [lang, 'en'] for unknown languages", () => {
    expect(getFallbackChain("xx")).toEqual(["xx", "en"]);
  });
});

describe("REGION_OVERRIDES", () => {
  it("Bengali in India overrides to INR", () => {
    expect(REGION_OVERRIDES["bn-IN"]).toEqual({ currency: "INR", intlLocale: "bn-IN" });
  });

  it("Tamil in Sri Lanka overrides to LKR", () => {
    expect(REGION_OVERRIDES["ta-LK"]).toEqual({ currency: "LKR", intlLocale: "ta-LK" });
  });

  it("Urdu in India overrides to INR", () => {
    expect(REGION_OVERRIDES["ur-IN"]).toEqual({ currency: "INR", intlLocale: "ur-IN" });
  });
});

describe("resolveRegion", () => {
  it("without region, uses language defaults", () => {
    const result = resolveRegion("hi");
    expect(result).toEqual({ intlLocale: "hi-IN", currency: "INR" });
  });

  it("with known region override, applies it", () => {
    const result = resolveRegion("bn", "IN");
    expect(result).toEqual({ intlLocale: "bn-IN", currency: "INR" });
  });

  it("with unknown region, swaps region in locale", () => {
    const result = resolveRegion("hi", "US");
    expect(result.intlLocale).toBe("hi-US");
  });

  it("Bengali default → BDT", () => {
    expect(resolveRegion("bn").currency).toBe("BDT");
  });

  it("Bengali + India → INR", () => {
    expect(resolveRegion("bn", "IN").currency).toBe("INR");
  });
});
