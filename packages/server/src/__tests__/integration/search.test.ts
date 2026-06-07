/**
 * Integration — search is ReDoS-safe + literal (Phase 3).
 *
 * The list endpoint's `search` param is escaped + length-capped, so it matches
 * as a literal case-insensitive substring on the key — never a user-controlled
 * regex. A literal dot finds "cart.checkout"; a catastrophic-backtracking
 * payload like "(a+)+$" returns 200 quickly with no match (no crash, no hang).
 */

import { describe, it, expect } from "vitest";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

describe("translation search", () => {
  useIntegrationServer();

  async function seedProject(token: string) {
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(token))
      .send({ name: "Searchable", supportedLanguages: ["en"] });
    const projectId = projRes.body.data._id;

    // "cartxcheckout" has no dot: a REGEX-wildcard "." in "cart.checkout"
    // would match the "x", but a properly-escaped LITERAL dot must not.
    for (const key of ["cart.checkout", "hero.title", "cartxcheckout"]) {
      const r = await request()
        .post(`/api/translations/${projectId}`)
        .set("Authorization", bearer(token))
        .send({ key, translations: { en: key } });
      expect(r.status).toBe(201);
    }
    return projectId;
  }

  it("literal dot matches the exact key (not treated as a wildcard)", async () => {
    const owner = await registerUser();
    const projectId = await seedProject(owner.token);

    const res = await request()
      .get(`/api/translations/${projectId}?search=cart.checkout`)
      .set("Authorization", bearer(owner.token));

    expect(res.status).toBe(200);
    const keys = res.body.data.data.map((t: any) => t.key);
    // "cart.checkout" matches; the dot is literal so "cartXcheckout" (where a
    // regex-wildcard dot WOULD match the X) must NOT appear.
    expect(keys).toContain("cart.checkout");
    expect(keys).not.toContain("cartxcheckout");
    expect(keys).not.toContain("hero.title");
  });

  it("a ReDoS payload returns 200 quickly with no match", async () => {
    const owner = await registerUser();
    const projectId = await seedProject(owner.token);

    const started = Date.now();
    const res = await request()
      .get(`/api/translations/${projectId}?search=${encodeURIComponent("(a+)+$")}`)
      .set("Authorization", bearer(owner.token));
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    // No key contains the literal substring "(a+)+$".
    expect(res.body.data.data).toHaveLength(0);
    // Should be near-instant — generous bound proves it didn't hang on backtracking.
    expect(elapsed).toBeLessThan(2000);
  });
});
