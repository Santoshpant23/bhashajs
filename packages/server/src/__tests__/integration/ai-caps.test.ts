/**
 * Integration — the forever-free AI cost guardrails (per-account + global caps).
 *
 * The per-project cap (covered in usage.test.ts) stops ONE project running up
 * the bill, but a user can spin up many projects, so the hosted service also
 * reserves every AI key against a per-ACCOUNT cap and a GLOBAL ceiling. These
 * tests pre-seed the wider buckets AT their default caps so the next reservation
 * is blocked BEFORE any AI call (no Gemini needed), and assert: the right
 * scope-specific 429 fires, and the partial reservation is fully refunded (the
 * project meter is left at zero) so a blocked request never consumes budget.
 */

import { describe, it, expect } from "vitest";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";
import UsageCounter from "../../models/UsageCounter";
import { getUsage, currentPeriod } from "../../utils/usage";

const ACCOUNT_CAP = 5000; // AI_ACCOUNT_MONTHLY_CAP default
const GLOBAL_CAP = 100000; // AI_GLOBAL_MONTHLY_CAP default

describe("AI cost guardrails (per-account + global caps)", () => {
  useIntegrationServer();

  // Owner + project with two English source keys → exactly two AI candidates.
  async function seedProject() {
    const owner = await registerUser();
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "Capped", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.data._id as string;
    for (const key of ["hero.title", "hero.subtitle"]) {
      const r = await request()
        .post(`/api/translations/${projectId}`)
        .set("Authorization", bearer(owner.token))
        .send({ key, translations: { en: `English ${key}` } });
      expect(r.status).toBe(201);
    }
    return { owner, projectId };
  }

  it("blocks with the ACCOUNT message once the per-account cap is reached (on a fresh project)", async () => {
    const { owner, projectId } = await seedProject();
    // Pre-seed the OWNER's account bucket at the cap — simulates the user's
    // other projects already having consumed the monthly allowance.
    await UsageCounter.create({
      scope: `acct:${owner.userId}`,
      period: currentPeriod(),
      keysTranslated: ACCOUNT_CAP,
    });

    const res = await request()
      .post(`/api/translations/${projectId}/ai-translate`)
      .set("Authorization", bearer(owner.token))
      .send({ targetLang: "hi" });

    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/monthly free AI translation limit/i);
    // The project reservation was refunded when the account scope blocked.
    expect((await getUsage(projectId)).keysTranslated).toBe(0);
  });

  it("blocks with the GLOBAL (service-wide) message once the global ceiling is reached", async () => {
    const { owner, projectId } = await seedProject();
    // Account bucket is empty (fresh owner), so the account scope passes and the
    // GLOBAL ceiling is what blocks — the instance-wide kill-switch.
    await UsageCounter.create({
      scope: "global",
      period: currentPeriod(),
      keysTranslated: GLOBAL_CAP,
    });

    const res = await request()
      .post(`/api/translations/${projectId}/ai-translate`)
      .set("Authorization", bearer(owner.token))
      .send({ targetLang: "hi" });

    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/temporarily paused|service-wide/i);
    // Project AND account reservations were refunded when the global scope blocked.
    expect((await getUsage(projectId)).keysTranslated).toBe(0);
    const acct = await UsageCounter.findOne({ scope: `acct:${owner.userId}`, period: currentPeriod() });
    expect(acct?.keysTranslated || 0).toBe(0);
  });
});
