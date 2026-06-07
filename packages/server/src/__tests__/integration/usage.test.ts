/**
 * Integration — AI usage metering + monthly cap (Phase v0.4).
 *
 * Two concerns, no real AI:
 *   1. The usage helper (utils/usage.ts) against a real Mongo — record →
 *      $inc increment, getUsage zeros, and the wouldExceedCap boundary.
 *   2. The route-level cap: POST /ai-translate must return 429 BEFORE any AI
 *      provider call once the project would exceed its monthly cap. We force
 *      this by pre-seeding AiUsage at the cap (and by setting a tiny cap), so
 *      the test never needs Gemini/Vertex — the 429 fires on the cap check.
 *
 * The /usage read endpoint is also exercised end-to-end over HTTP.
 */

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";
import AiUsage from "../../models/AiUsage";
import {
  currentPeriod,
  getUsage,
  recordUsage,
  wouldExceedCap,
} from "../../utils/usage";

describe("usage helper (DB-backed)", () => {
  useIntegrationServer();

  it("getUsage returns zeros when nothing recorded", async () => {
    const projectId = new mongoose.Types.ObjectId();
    const usage = await getUsage(projectId);
    expect(usage).toEqual({ keysTranslated: 0, voiceCalls: 0, aiCalls: 0 });
  });

  it("recordUsage creates then atomically increments the (project, period) bucket", async () => {
    const projectId = new mongoose.Types.ObjectId();

    await recordUsage(projectId, { keys: 10, calls: 1 });
    let usage = await getUsage(projectId);
    expect(usage.keysTranslated).toBe(10);
    expect(usage.aiCalls).toBe(1);
    expect(usage.voiceCalls).toBe(0);

    // Second call increments rather than overwriting.
    await recordUsage(projectId, { keys: 5, voice: 3, calls: 1 });
    usage = await getUsage(projectId);
    expect(usage.keysTranslated).toBe(15);
    expect(usage.voiceCalls).toBe(3);
    expect(usage.aiCalls).toBe(2);

    // Exactly one bucket for this project this month.
    const count = await AiUsage.countDocuments({ projectId, period: currentPeriod() });
    expect(count).toBe(1);
  });

  it("recordUsage is a no-op when all deltas are zero/absent", async () => {
    const projectId = new mongoose.Types.ObjectId();
    await recordUsage(projectId, {});
    await recordUsage(projectId, { keys: 0 });
    const count = await AiUsage.countDocuments({ projectId });
    expect(count).toBe(0);
  });

  it("concurrent recordUsage calls don't lose increments", async () => {
    const projectId = new mongoose.Types.ObjectId();
    await Promise.all(
      Array.from({ length: 20 }, () => recordUsage(projectId, { keys: 1, calls: 1 }))
    );
    const usage = await getUsage(projectId);
    expect(usage.keysTranslated).toBe(20);
    expect(usage.aiCalls).toBe(20);
  });

  it("wouldExceedCap respects the boundary (== cap is OK, > cap is not)", async () => {
    const projectId = new mongoose.Types.ObjectId();
    await recordUsage(projectId, { keys: 90 }); // 90 used

    // 90 + 10 == 100 → not exceeding.
    expect(await wouldExceedCap(projectId, 100, 10)).toBe(false);
    // 90 + 11 == 101 > 100 → exceeding.
    expect(await wouldExceedCap(projectId, 100, 11)).toBe(true);
  });

  it("wouldExceedCap treats a non-positive cap as no cap", async () => {
    const projectId = new mongoose.Types.ObjectId();
    await recordUsage(projectId, { keys: 999999 });
    expect(await wouldExceedCap(projectId, 0, 1)).toBe(false);
    expect(await wouldExceedCap(projectId, -5, 1)).toBe(false);
  });
});

describe("AI translate monthly cap (429, no AI call)", () => {
  useIntegrationServer();

  // Spin up an owner + project with a known low cap. Seed English source keys
  // so /ai-translate has candidates to translate (and would otherwise call AI).
  async function seedProject(cap: number) {
    const owner = await registerUser();
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "Capped", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.data._id as string;

    // Force the cap low via the project document (default would be 5000).
    const Project = (await import("../../models/Project")).default;
    await Project.updateOne({ _id: projectId }, { aiMonthlyCap: cap });

    // Two English source keys → two translation candidates for hi.
    for (const key of ["hero.title", "hero.subtitle"]) {
      const r = await request()
        .post(`/api/translations/${projectId}`)
        .set("Authorization", bearer(owner.token))
        .send({ key, translations: { en: `English ${key}` } });
      expect(r.status).toBe(201);
    }

    return { owner, projectId };
  }

  it("returns 429 when the candidate set would exceed a tiny cap", async () => {
    // cap = 1, but 2 keys need translation → 0 + 2 > 1 → 429 before any AI call.
    const { owner, projectId } = await seedProject(1);

    const res = await request()
      .post(`/api/translations/${projectId}/ai-translate`)
      .set("Authorization", bearer(owner.token))
      .send({ targetLang: "hi" });

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Monthly AI translation cap reached/i);
    expect(res.body.message).toContain("/1");
  });

  it("returns 429 when the period is already pre-seeded at the cap", async () => {
    // Generous cap (10) but pre-seed usage AT the cap so any new work exceeds it.
    const { owner, projectId } = await seedProject(10);
    await recordUsage(projectId, { keys: 10 });

    const res = await request()
      .post(`/api/translations/${projectId}/ai-translate`)
      .set("Authorization", bearer(owner.token))
      .send({ targetLang: "hi" });

    expect(res.status).toBe(429);
    expect(res.body.message).toContain("(10/10)");
  });

  it("does NOT 429 (and skips AI) when there are no keys to translate", async () => {
    // No English source keys at all → toTranslate is empty → the route short
    // -circuits with 200 'nothing to translate' BEFORE the cap check, so a
    // zero-candidate request never trips the cap.
    const owner = await registerUser();
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "Empty", supportedLanguages: ["en", "hi"] });
    const projectId = projRes.body.data._id as string;
    const Project = (await import("../../models/Project")).default;
    await Project.updateOne({ _id: projectId }, { aiMonthlyCap: 1 });

    const res = await request()
      .post(`/api/translations/${projectId}/ai-translate`)
      .set("Authorization", bearer(owner.token))
      .send({ targetLang: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.data.translated).toBe(0);
  });
});

describe("GET /api/projects/:projectId/usage", () => {
  useIntegrationServer();

  it("returns the current period usage + cap for a member", async () => {
    const owner = await registerUser();
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "UsageRead", supportedLanguages: ["en", "hi"] });
    const projectId = projRes.body.data._id as string;

    await recordUsage(projectId, { keys: 42, voice: 7, calls: 3 });

    const res = await request()
      .get(`/api/projects/${projectId}/usage`)
      .set("Authorization", bearer(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe(currentPeriod());
    expect(res.body.data.keysTranslated).toBe(42);
    expect(res.body.data.voiceCalls).toBe(7);
    expect(res.body.data.aiCalls).toBe(3);
    expect(typeof res.body.data.cap).toBe("number");
    expect(res.body.data.percentUsed).toBeGreaterThanOrEqual(0);
    expect(res.body.data.percentUsed).toBeLessThanOrEqual(100);
  });

  it("403s for a non-member", async () => {
    const owner = await registerUser();
    const stranger = await registerUser();
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "Private", supportedLanguages: ["en", "hi"] });
    const projectId = projRes.body.data._id as string;

    const res = await request()
      .get(`/api/projects/${projectId}/usage`)
      .set("Authorization", bearer(stranger.token));

    expect(res.status).toBe(403);
  });
});
