import { describe, it, expect } from "vitest";
import { canServe, resolveWriteSource } from "../utils/compliance";

// The compliance lock is the product's load-bearing guarantee: a regulated key
// only ever serves human-authored or human-approved copy. These lock the rule
// that the write paths (single edit, bulk import, review) and the SDK read gate
// all route through.

describe("compliance — canServe (read gate)", () => {
  it("non-regulated cells are always servable", () => {
    expect(canServe(false, "ai")).toBe(true);
    expect(canServe(false, "pending")).toBe(true);
    expect(canServe(false, undefined)).toBe(true);
  });

  it("regulated cells serve ONLY human or approved", () => {
    expect(canServe(true, "human")).toBe(true);
    expect(canServe(true, "approved")).toBe(true);
    expect(canServe(true, "ai")).toBe(false);
    expect(canServe(true, "pending")).toBe(false);
    expect(canServe(true, undefined)).toBe(false);
  });
});

describe("compliance — resolveWriteSource (write stamp)", () => {
  it("a non-owner edit to a regulated key is held as 'pending' and is NOT servable", () => {
    const src = resolveWriteSource(true, /* isOwner */ false);
    expect(src).toBe("pending");
    expect(canServe(true, src)).toBe(false); // the end-to-end guarantee
  });

  it("an owner edit to a regulated key is 'human' and servable", () => {
    const src = resolveWriteSource(true, /* isOwner */ true);
    expect(src).toBe("human");
    expect(canServe(true, src)).toBe(true);
  });

  it("edits to non-regulated keys are always 'human'", () => {
    expect(resolveWriteSource(false, false)).toBe("human");
    expect(resolveWriteSource(false, true)).toBe("human");
  });
});
