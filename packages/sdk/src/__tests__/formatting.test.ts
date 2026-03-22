import { describe, it, expect } from "vitest";
import { formatNumber, formatCurrency, formatDate } from "../utils/formatting";

// ─── Number Formatting ─────────────────────────────────────────

describe("formatNumber", () => {
  describe("lakh/crore grouping", () => {
    it("Hindi uses lakh/crore: 12,34,567", () => {
      const result = formatNumber(1234567, "hi");
      expect(result).toBe("12,34,567");
    });

    it("English-IN uses lakh/crore: 12,34,567", () => {
      const result = formatNumber(1234567, "en");
      expect(result).toBe("12,34,567");
    });

    it("small numbers format normally", () => {
      const result = formatNumber(999, "hi");
      expect(result).toBe("999");
    });

    it("handles zero", () => {
      expect(formatNumber(0, "hi")).toBe("0");
    });

    it("handles negative numbers", () => {
      const result = formatNumber(-1234567, "hi");
      expect(result).toContain("12,34,567");
    });
  });

  describe("native digits", () => {
    it("Hindi: renders Devanagari digits", () => {
      const result = formatNumber(1234567, "hi", undefined, { useNativeDigits: true });
      expect(result).toMatch(/[०-९]/);
      expect(result).toBe("१२,३४,५६७");
    });

    it("Bengali: renders Bengali digits", () => {
      const result = formatNumber(1234567, "bn", undefined, { useNativeDigits: true });
      expect(result).toMatch(/[০-৯]/);
    });

    it("English: no native digits (latn stays latn)", () => {
      const result = formatNumber(123, "en", undefined, { useNativeDigits: true });
      expect(result).toBe("123");
    });
  });

  describe("compact notation", () => {
    it("Hindi: 15 lakh", () => {
      const result = formatNumber(1500000, "hi", undefined, { compact: true });
      expect(result).toContain("लाख");
    });

    it("Hindi: crore", () => {
      const result = formatNumber(10000000, "hi", undefined, { compact: true });
      expect(result).toContain("करोड़");
    });
  });
});

// ─── Currency Formatting ────────────────────────────────────────

describe("formatCurrency", () => {
  describe("auto-detects currency from language", () => {
    it("Hindi → ₹ (INR)", () => {
      const result = formatCurrency(1234567, "hi");
      expect(result).toContain("₹");
    });

    it("Bengali → ৳ (BDT)", () => {
      const result = formatCurrency(1234567, "bn");
      expect(result).toMatch(/৳|BDT/);
    });

    it("Urdu → Rs (PKR)", () => {
      const result = formatCurrency(1234567, "ur");
      expect(result).toMatch(/Rs|PKR/);
    });

    it("Nepali → NPR", () => {
      const result = formatCurrency(1234567, "ne");
      // Intl renders NPR as "नेरू" (Devanagari) in Nepali locale
      expect(result).toMatch(/Rs|NPR|रु|नेरू/);
    });
  });

  describe("region override", () => {
    it("Bengali in India → ₹", () => {
      const result = formatCurrency(1234567, "bn", "IN");
      expect(result).toContain("₹");
    });

    it("Urdu in India → ₹", () => {
      const result = formatCurrency(1234567, "ur", "IN");
      expect(result).toContain("₹");
    });

    it("Tamil in Sri Lanka → LKR/Rs", () => {
      const result = formatCurrency(1234567, "ta", "LK");
      expect(result).toMatch(/Rs|LKR/);
    });
  });

  describe("explicit currency override", () => {
    it("override to USD", () => {
      const result = formatCurrency(100, "hi", undefined, { currency: "USD" });
      expect(result).toMatch(/\$|USD/);
    });
  });

  describe("display modes", () => {
    it('display: "code" shows INR', () => {
      const result = formatCurrency(100, "hi", undefined, { display: "code" });
      expect(result).toContain("INR");
    });

    it('display: "name" shows currency name', () => {
      const result = formatCurrency(100, "hi", undefined, { display: "name" });
      expect(result).toMatch(/rupee|रुपए|रुपये/i);
    });
  });

  describe("native digits", () => {
    it("Hindi currency with Devanagari digits", () => {
      const result = formatCurrency(1234, "hi", undefined, { useNativeDigits: true });
      expect(result).toMatch(/[०-९]/);
      expect(result).toContain("₹");
    });
  });
});

// ─── Date Formatting ────────────────────────────────────────────

describe("formatDate", () => {
  const testDate = new Date("2026-03-19T12:00:00Z");

  describe("presets", () => {
    it("medium (default): 19 Mar 2026 style", () => {
      const result = formatDate(testDate, "hi");
      expect(result).toContain("2026");
      expect(result).toContain("19");
    });

    it("short: DD/MM/YY style", () => {
      const result = formatDate(testDate, "hi", undefined, { preset: "short" });
      expect(result).toMatch(/19/);
    });

    it("long: full month name", () => {
      const result = formatDate(testDate, "hi", undefined, { preset: "long" });
      expect(result).toContain("2026");
    });

    it("full: includes weekday", () => {
      const result = formatDate(testDate, "hi", undefined, { preset: "full" });
      expect(result).toContain("2026");
      // Should have the weekday name in Hindi
      expect(result.length).toBeGreaterThan(15);
    });
  });

  describe("native digits", () => {
    it("Hindi date with Devanagari digits", () => {
      const result = formatDate(testDate, "hi", undefined, { useNativeDigits: true });
      expect(result).toMatch(/[०-९]/);
    });

    it("Bengali date with Bengali digits", () => {
      const result = formatDate(testDate, "bn", undefined, { useNativeDigits: true });
      expect(result).toMatch(/[০-৯]/);
    });
  });

  describe("input types", () => {
    it("accepts Date object", () => {
      const result = formatDate(new Date("2026-03-19"), "en");
      expect(result).toContain("2026");
    });

    it("accepts ISO string", () => {
      const result = formatDate("2026-03-19", "en");
      expect(result).toContain("2026");
    });

    it("accepts timestamp number", () => {
      const result = formatDate(testDate.getTime(), "en");
      expect(result).toContain("2026");
    });
  });
});
