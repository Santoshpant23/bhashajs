import { describe, it, expect } from "vitest";
import { getLangInfo } from "../utils/languages";

// Regression test for the v0.4 RTL inference: getLangInfo used to return
// dir:"ltr" for ANY code outside the 14-entry table — so an unknown RTL variant
// (e.g. "ur-IN", "pa-Arab") would render left-to-right with broken shaping for
// exactly the South-Asian RTL audience the SDK targets.

describe("getLangInfo — direction inference for unknown codes", () => {
  it("infers RTL for an unknown Urdu region variant", () => {
    expect(getLangInfo("ur-IN").dir).toBe("rtl");
  });

  it("infers RTL for an Arabic-script subtag", () => {
    expect(getLangInfo("pa-Arab").dir).toBe("rtl");
  });

  it("keeps a Latin-script variant LTR", () => {
    expect(getLangInfo("xx-Latn").dir).toBe("ltr");
  });

  it("defaults a genuinely unknown code to LTR", () => {
    expect(getLangInfo("zz").dir).toBe("ltr");
  });

  it("still returns known languages directly", () => {
    expect(getLangInfo("ur").dir).toBe("rtl");
    expect(getLangInfo("hi").dir).toBe("ltr");
  });
});
