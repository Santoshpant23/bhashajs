import { describe, it, expect } from "vitest";
import {
  readValue,
  writeValue,
  coerceRegister,
  iterateCells,
  DEFAULT_REGISTER,
} from "../utils/registers";

// The whole data model is nested Maps (lang -> register -> string). These lock
// the helpers that read/write them in both shapes (live Mongoose Map and plain
// object from lean()/JSON).

describe("registers — readValue", () => {
  const nested = {
    hi: { default: "स्वागत", casual: "Welcome है" },
    bn: { default: "স্বাগতম" },
  };

  it("reads a (lang, register) cell from a plain object", () => {
    expect(readValue(nested as any, "hi", "default")).toBe("स्वागत");
    expect(readValue(nested as any, "hi", "casual")).toBe("Welcome है");
    expect(readValue(nested as any, "bn", "casual")).toBeUndefined();
    expect(readValue(nested as any, "ta", "default")).toBeUndefined();
  });

  it("reads from a real Map-of-Maps too", () => {
    const m = new Map([["hi", new Map([["default", "स्वागत"]])]]);
    expect(readValue(m as any, "hi", "default")).toBe("स्वागत");
  });
});

describe("registers — coerceRegister", () => {
  it("keeps valid registers, falls back to default for junk", () => {
    expect(coerceRegister("casual")).toBe("casual");
    expect(coerceRegister("formal")).toBe("formal");
    expect(coerceRegister("nope")).toBe(DEFAULT_REGISTER);
    expect(coerceRegister(undefined)).toBe(DEFAULT_REGISTER);
    expect(coerceRegister(42)).toBe(DEFAULT_REGISTER);
  });
});

describe("registers — iterateCells", () => {
  it("yields every valid (lang, register, value) triple", () => {
    const cells = [...iterateCells({
      hi: { default: "स्वागत", casual: "Welcome है" },
      bn: { default: "স্বাগতম" },
    } as any)];
    expect(cells).toContainEqual({ lang: "hi", register: "default", value: "स्वागत" });
    expect(cells).toContainEqual({ lang: "bn", register: "default", value: "স্বাগতম" });
    expect(cells.length).toBe(3);
  });

  it("skips invalid registers and non-string values", () => {
    const cells = [...iterateCells({ hi: { bogus: "x", default: "ok" } } as any)];
    expect(cells).toEqual([{ lang: "hi", register: "default", value: "ok" }]);
  });
});

describe("registers — writeValue", () => {
  it("creates the nested structure and sets the cell", () => {
    const doc: any = { translations: undefined, markModified: () => {} };
    writeValue(doc, "translations", "hi", "casual", "X");
    expect(doc.translations.get("hi").get("casual")).toBe("X");
  });

  it("preserves existing sibling cells when writing a new register", () => {
    const doc: any = { translations: new Map(), markModified: () => {} };
    writeValue(doc, "translations", "hi", "default", "A");
    writeValue(doc, "translations", "hi", "casual", "B");
    expect(doc.translations.get("hi").get("default")).toBe("A");
    expect(doc.translations.get("hi").get("casual")).toBe("B");
  });
});
