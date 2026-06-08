/**
 * Integration — per-user project quota is ATOMIC (no TOCTOU race).
 *
 * The old POST /api/projects enforced MAX_PROJECTS_PER_USER with
 * `countDocuments({ owner }) >= cap` THEN `Project.create()` — a check-then-act
 * race. Under concurrency, N requests all read "under cap" and all created,
 * blowing well past the limit (audit: cap 3, 20 concurrent → 18 projects).
 *
 * The fix reserves a slot with a single conditional increment
 * `findOneAndUpdate({ projectCount: { $lt: cap } }, { $inc: { projectCount: 1 } })`,
 * which serializes concurrent creates on one document write. This test fires a
 * burst of concurrent creates against cap=3 and asserts AT MOST 3 succeed and
 * the rest get 403 — proving the race is closed. It also verifies the counter
 * decrements on delete (deleting then creating one more succeeds).
 *
 * Note: writeLimiter is 50/15min, so 20 requests don't trip it — the limiter
 * can't mask the result.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import User from "../../models/User";
import Project from "../../models/Project";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

describe("per-user project quota (atomic, race-proof)", () => {
  useIntegrationServer();

  const CAP = 3;
  let prevMax: string | undefined;

  beforeAll(() => {
    prevMax = process.env.MAX_PROJECTS_PER_USER;
    process.env.MAX_PROJECTS_PER_USER = String(CAP);
  });

  afterAll(() => {
    if (prevMax === undefined) delete process.env.MAX_PROJECTS_PER_USER;
    else process.env.MAX_PROJECTS_PER_USER = prevMax;
  });

  it("rejects concurrent creates past the cap (no race)", async () => {
    const owner = await registerUser({ email: "quota@example.com" });

    const ATTEMPTS = 20;
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, i) =>
        request()
          .post("/api/projects")
          .set("Authorization", bearer(owner.token))
          .send({ name: `P${i}`, supportedLanguages: ["en", "hi"] })
      )
    );

    const created = results.filter((r) => r.status === 201);
    const forbidden = results.filter((r) => r.status === 403);

    // The race is closed: at most CAP creates ever succeed.
    expect(created.length).toBeLessThanOrEqual(CAP);
    // With 20 attempts against cap 3 we expect to actually fill it.
    expect(created.length).toBe(CAP);
    // Everyone else is rejected with 403 (none slipped through as 500/201).
    expect(forbidden.length).toBe(ATTEMPTS - CAP);

    // Ground truth in the DB matches: exactly CAP projects, counter == CAP.
    const projCount = await Project.countDocuments({ owner: owner.userId });
    expect(projCount).toBe(CAP);
    const user = await User.findById(owner.userId);
    expect((user as any).projectCount).toBe(CAP);
  });

  it("decrements the counter on delete so a freed slot can be reused", async () => {
    const owner = await registerUser({ email: "reuse@example.com" });

    // Fill the cap sequentially.
    const ids: string[] = [];
    for (let i = 0; i < CAP; i++) {
      const res = await request()
        .post("/api/projects")
        .set("Authorization", bearer(owner.token))
        .send({ name: `Q${i}`, supportedLanguages: ["en", "hi"] });
      expect(res.status).toBe(201);
      ids.push(res.body.data._id);
    }

    // At cap — the next create is rejected.
    const atCap = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "overflow", supportedLanguages: ["en", "hi"] });
    expect(atCap.status).toBe(403);

    // Delete one — frees a slot and decrements the counter.
    const delRes = await request()
      .delete(`/api/projects/${ids[0]}`)
      .set("Authorization", bearer(owner.token));
    expect(delRes.status).toBe(200);

    const afterDelete = await User.findById(owner.userId);
    expect((afterDelete as any).projectCount).toBe(CAP - 1);

    // The freed slot can now be reused.
    const reuse = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "reused", supportedLanguages: ["en", "hi"] });
    expect(reuse.status).toBe(201);

    const finalUser = await User.findById(owner.userId);
    expect((finalUser as any).projectCount).toBe(CAP);
  });
});
