import { describe, it, expect } from "vitest";
import { getErrorMessage } from "../utils/api";

describe("getErrorMessage", () => {
  it("extracts the API's { success:false, message } error", () => {
    expect(
      getErrorMessage({ response: { data: { message: "Project not found" } } })
    ).toBe("Project not found");
  });

  it("falls back to a generic message for unknown error shapes", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("Something went wrong");
    expect(getErrorMessage(undefined)).toBe("Something went wrong");
    expect(getErrorMessage({})).toBe("Something went wrong");
    expect(getErrorMessage({ response: {} })).toBe("Something went wrong");
  });
});
