import { describe, it, expect } from "vitest";
import { extractJsonObject, chunk, isNonLatinScript } from "../services/ai-provider";

// The AI path used to send the whole project in one prompt and JSON.parse the
// whole response, so one odd response 500'd everything. These lock the helpers
// that make it resilient + protect the code-mixed-locale moat.

describe("extractJsonObject (repair-tolerant parse)", () => {
  it("parses clean JSON", () => {
    expect(extractJsonObject('{"a":"b"}')).toEqual({ a: "b" });
  });
  it("strips ```json fences", () => {
    expect(extractJsonObject('```json\n{"a":"b"}\n```')).toEqual({ a: "b" });
  });
  it("extracts the object from surrounding prose", () => {
    expect(extractJsonObject('Sure! Here you go: {"a":"b"} — done')).toEqual({ a: "b" });
  });
  it("returns {} on garbage instead of throwing", () => {
    expect(extractJsonObject("not json at all")).toEqual({});
    expect(extractJsonObject("")).toEqual({});
  });
  it("returns {} for a top-level array (we only accept objects)", () => {
    expect(extractJsonObject("[1,2,3]")).toEqual({});
  });
});

describe("chunk (batching)", () => {
  it("splits into bounded batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("handles empty + exact multiples", () => {
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
});

describe("isNonLatinScript (Latin-locale script guard)", () => {
  it("detects native scripts that must NOT appear in a -Latn locale", () => {
    expect(isNonLatinScript("स्वागत")).toBe(true);     // Devanagari
    expect(isNonLatinScript("স্বাগতম")).toBe(true);    // Bengali
    expect(isNonLatinScript("வணக்கம்")).toBe(true);    // Tamil
    expect(isNonLatinScript("ಸ್ವಾಗತ")).toBe(true);     // Kannada
    expect(isNonLatinScript("خوش آمدید")).toBe(true);  // Arabic/Urdu
    expect(isNonLatinScript("\uFB8E")).toBe(true);     // Arabic Presentation Forms-A
    expect(isNonLatinScript("\uFE8D")).toBe(true);     // Arabic Presentation Forms-B
  });
  it("passes pure Latin / Hinglish / Roman Nepali", () => {
    expect(isNonLatinScript("Swagat hai")).toBe(false);
    expect(isNonLatinScript("Order karo, cart mein add karo")).toBe(false);
    expect(isNonLatinScript("Tapai lai swagat cha")).toBe(false);
  });
});
