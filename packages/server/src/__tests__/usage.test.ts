/**
 * Unit — usage helper period-key format (no DB).
 *
 * currentPeriod() is the only piece of the metering helper that's a pure
 * function. The DB-backed pieces (record → increment, getUsage,
 * wouldExceedCap boundary) are covered in the integration suite where a real
 * Mongo is available (__tests__/integration/usage.test.ts).
 */

import { describe, it, expect } from "vitest";
import { currentPeriod } from "../utils/usage";

describe("usage — currentPeriod", () => {
  it("formats as YYYY-MM in UTC", () => {
    // 2026-06-06 — a month that needs zero-padding (06).
    expect(currentPeriod(new Date(Date.UTC(2026, 5, 6, 12, 0, 0)))).toBe("2026-06");
  });

  it("zero-pads single-digit months", () => {
    expect(currentPeriod(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01"); // Jan
    expect(currentPeriod(new Date(Date.UTC(2026, 8, 30)))).toBe("2026-09"); // Sep
  });

  it("uses two digits for double-digit months", () => {
    expect(currentPeriod(new Date(Date.UTC(2026, 11, 31)))).toBe("2026-12"); // Dec
  });

  it("rolls into the correct month at a UTC boundary (not local)", () => {
    // 2026-12-31T23:59:59Z is still December in UTC regardless of host TZ.
    expect(currentPeriod(new Date("2026-12-31T23:59:59.000Z"))).toBe("2026-12");
    // 2027-01-01T00:00:00Z is January.
    expect(currentPeriod(new Date("2027-01-01T00:00:00.000Z"))).toBe("2027-01");
  });

  it("matches the YYYY-MM shape with a regex", () => {
    expect(currentPeriod()).toMatch(/^\d{4}-\d{2}$/);
  });
});
