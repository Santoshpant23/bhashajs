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
  reserveUsage,
  refundUsage,
  wouldExceedCap,
} from "../../utils/usage";

describe("usage helper (DB-backed)", () => {
  useIntegrationServer();

  it("reserveUsage atomically enforces the cap (and voice consumes the keys budget)", async () => {
    const projectId = new mongoose.Types.ObjectId();
    // Within cap → reserved, keysTranslated incremented.
    expect(await reserveUsage(projectId, 100, 40)).toBe(true);
    expect((await getUsage(projectId)).keysTranslated).toBe(40);
    // Would exceed (40 + 70 > 100) → rejected, NOT applied.
    expect(await reserveUsage(projectId, 100, 70)).toBe(false);
    expect((await getUsage(projectId)).keysTranslated).toBe(40);
    // Voice reserves against the SAME keysTranslated budget (the bug was it didn't).
    expect(await reserveUsage(projectId, 100, 30, true)).toBe(true);
    const after = await getUsage(projectId);
    expect(after.keysTranslated).toBe(70);
    expect(after.voiceCalls).toBe(30);
    // Refund returns budget for failed/aborted work.
    await refundUsage(projectId, 10);
    expect((await getUsage(projectId)).keysTranslated).toBe(60);
  });

  it("reserveUsage with a non-positive cap means no cap", async () => {
    const projectId = new mongoose.Types.ObjectId();
    expect(await reserveUsage(projectId, 0, 9999)).toBe(true);
    expect((await getUsage(projectId)).keysTranslated).toBe(9999);
  });

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
    expect(res.body.message).toMatch(/cap reached for this project/i);
    expect(res.body.message).toContain("(1 keys)");
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
    expect(res.body.message).toMatch(/cap reached for this project/i);
    expect(res.body.message).toContain("(10 keys)");
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

describe("AI usage reservation is REFUNDED when the provider fails", () => {
  useIntegrationServer();

  // Seed an owner + project with a GENEROUS cap and English source keys, so the
  // route passes the cap check, RESERVES the candidates, then calls the AI
  // provider. We then force the provider construction to throw by unsetting the
  // Gemini credentials for the duration of the request: getAIProvider() builds a
  // GeminiProvider which throws "GEMINI_API_KEY is not set ..." — and crucially
  // it throws AFTER reserveUsage() has already incremented keysTranslated. This
  // exercises the exception exit path: the route's finally must refund the FULL
  // reservation, leaving keysTranslated back at 0. (No real network call — the
  // throw happens at provider construction, before any generate().)
  async function seedProject(cap: number, keys: string[]) {
    const owner = await registerUser();
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "RefundOnFail", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.data._id as string;

    const Project = (await import("../../models/Project")).default;
    await Project.updateOne({ _id: projectId }, { aiMonthlyCap: cap });

    for (const key of keys) {
      const r = await request()
        .post(`/api/translations/${projectId}`)
        .set("Authorization", bearer(owner.token))
        .send({ key, translations: { en: `English ${key}` } });
      expect(r.status).toBe(201);
    }
    return { owner, projectId };
  }

  /** Run `fn` with the AI credentials unset so getAIProvider() throws, then
   *  restore them no matter what (other tests in the run need real creds intact). */
  async function withBrokenProvider<T>(fn: () => Promise<T>): Promise<T> {
    const savedKey = process.env.GEMINI_API_KEY;
    const savedVertex = process.env.GEMINI_USE_VERTEX;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_USE_VERTEX; // ensure neither auth path is configured
    try {
      return await fn();
    } finally {
      if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedKey;
      if (savedVertex === undefined) delete process.env.GEMINI_USE_VERTEX;
      else process.env.GEMINI_USE_VERTEX = savedVertex;
    }
  }

  it("/ai-translate: a provider failure refunds the whole reservation (keysTranslated back to 0)", async () => {
    // Generous cap; 3 candidate keys. Reservation will set keysTranslated=3,
    // then the provider throws → settlement must refund all 3 → back to 0.
    const { owner, projectId } = await seedProject(1000, ["a.one", "a.two", "a.three"]);

    const res = await withBrokenProvider(() =>
      request()
        .post(`/api/translations/${projectId}/ai-translate`)
        .set("Authorization", bearer(owner.token))
        .send({ targetLang: "hi" })
    );

    // The provider construction threw → outer catch returns 500 (not 429).
    expect(res.status).toBe(500);

    // The reservation incremented keysTranslated to 3 then the finally refunded
    // all 3 (nothing was persisted), so the bucket is back to 0. aiCalls stays
    // at 1 (reserveUsage bumped it; refunds don't touch it) — the call was
    // attempted, it just failed. The KEY assertion is keysTranslated === 0.
    const usage = await getUsage(projectId);
    expect(usage.keysTranslated).toBe(0);

    // And no translation was actually written for hi.
    const Translation = (await import("../../models/Translation")).default;
    const docs = await Translation.find({ projectId });
    for (const d of docs) {
      const t = (d.translations as any);
      const hi = t instanceof Map ? t.get("hi") : t?.hi;
      expect(hi == null || Object.keys(hi instanceof Map ? Object.fromEntries(hi) : hi).length === 0).toBe(true);
    }
  });

  it("/generate-voice: a provider failure refunds the whole voice reservation", async () => {
    // Seed an owner + project, then create translations that ALREADY have hi
    // text (via the normalizing HTTP route) so generate-voice has candidates
    // (translated + missing voice data). Two candidates → voice reserves 2.
    const owner = await registerUser();
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "VoiceRefund", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.data._id as string;
    const Project = (await import("../../models/Project")).default;
    await Project.updateOne({ _id: projectId }, { aiMonthlyCap: 1000 });

    for (const key of ["v.one", "v.two"]) {
      const r = await request()
        .post(`/api/translations/${projectId}`)
        .set("Authorization", bearer(owner.token))
        .send({ key, translations: { en: `English ${key}`, hi: "नमस्ते" } });
      expect(r.status).toBe(201);
    }

    const res = await withBrokenProvider(() =>
      request()
        .post(`/api/translations/${projectId}/generate-voice`)
        .set("Authorization", bearer(owner.token))
        .send({ lang: "hi" })
    );

    expect(res.status).toBe(500);

    // reserveUsage(voice=true) bumped keysTranslated AND voiceCalls by the
    // candidate count; the finally must refund BOTH back to 0.
    const usage = await getUsage(projectId);
    expect(usage.keysTranslated).toBe(0);
    expect(usage.voiceCalls).toBe(0);
  });

  it("settlement arithmetic: refund == reserved - written (partial write keeps written work)", async () => {
    // A focused unit check of the exact arithmetic the routes use, against a
    // real Mongo. Models the "abort/failure AFTER some persistence" case:
    // reserve N, treat W as written, refund (N - W) → only the unwritten is
    // returned and the written work stays metered. Proves no double-refund and
    // that written cells are never clawed back.
    const projectId = new mongoose.Types.ObjectId();
    const reserved = 10;
    const written = 4;

    expect(await reserveUsage(projectId, 1000, reserved)).toBe(true);
    expect((await getUsage(projectId)).keysTranslated).toBe(reserved);

    const refund = reserved - written;
    await refundUsage(projectId, refund);

    // Exactly the written work remains; the unwritten reservation was returned.
    expect((await getUsage(projectId)).keysTranslated).toBe(written);
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
