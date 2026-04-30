import { describe, it, expect } from "vitest";
import { resolveRegisterFromSegment } from "../components/I18nProvider";

describe("resolveRegisterFromSegment", () => {
  it("returns the rule's register when segment matches", () => {
    expect(
      resolveRegisterFromSegment("genz", { genz: "casual", enterprise: "formal" }, "default")
    ).toBe("casual");
    expect(
      resolveRegisterFromSegment("enterprise", { genz: "casual", enterprise: "formal" }, "default")
    ).toBe("formal");
  });

  it("falls back to the provider's `register` prop when segment isn't in rules", () => {
    expect(
      resolveRegisterFromSegment("unknown_segment", { genz: "casual" }, "formal")
    ).toBe("formal");
  });

  it("falls back to the provider's `register` prop when no segment is set", () => {
    expect(resolveRegisterFromSegment(undefined, { genz: "casual" }, "casual")).toBe("casual");
  });

  it("falls back to the provider's `register` prop when no rules are defined", () => {
    expect(resolveRegisterFromSegment("genz", undefined, "default")).toBe("default");
  });

  it("treats empty-string segment as 'no segment'", () => {
    expect(resolveRegisterFromSegment("", { "": "formal" }, "default")).toBe("default");
  });

  it("rules can map multiple segments to the same register", () => {
    const rules = { genz: "casual" as const, friends_and_family: "casual" as const };
    expect(resolveRegisterFromSegment("friends_and_family", rules, "default")).toBe("casual");
    expect(resolveRegisterFromSegment("genz", rules, "default")).toBe("casual");
  });
});
