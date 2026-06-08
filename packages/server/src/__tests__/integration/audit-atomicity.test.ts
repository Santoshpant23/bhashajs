/**
 * Integration — the audit trail is ATOMIC with the translation write (v0.4).
 *
 * The compliance MOAT is a "guaranteed audit trail": every change to a REGULATED
 * cell must leave an immutable history row, and that row must be written
 * atomically with the value/approval — never one without the other. This suite
 * proves the guarantee by FORCING the audit write (TranslationHistory.create) to
 * fail and asserting the WHOLE operation rolls back: the translation value /
 * approval is NOT persisted and the route returns an error.
 *
 * It runs on the replica-set harness (see setup.ts), so the route's
 * withTransactionOrFallback takes the REAL transaction path — exactly like prod
 * (Atlas + the bundled single-node RS). On the old standalone harness these
 * forced-failure cases would NOT roll back (the route would 200 with the value
 * live and zero history rows — the silent audit gap the external audit flagged),
 * which is precisely what this suite now prevents.
 *
 * The final case asserts the converse: a NON-regulated history failure stays
 * best-effort and does NOT fail the edit (only regulated/transactional audit is
 * load-bearing).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import mongoose from "mongoose";
import TranslationHistory from "../../models/TranslationHistory";
import Translation from "../../models/Translation";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

/**
 * Force the route's withTransactionOrFallback onto its STANDALONE fallback path
 * (the bug surface on a self-host standalone Mongo) by making the very next
 * connection.transaction() reject with a "transactions not supported" error —
 * exactly the signal the helper sniffs for. (The helper uses
 * mongoose.connection.transaction(), the correct primitive that resets document
 * state between retries; the fallback catch then re-runs the work callback with
 * NO session, so recordHistory sees session=undefined and its
 * best-effort-vs-regulated branch is what's under test.)
 */
function forceStandaloneFallbackOnce() {
  const spy = vi.spyOn(mongoose.connection, "transaction").mockImplementation(async () => {
    // Restore real transaction behavior for any later transaction in the request.
    spy.mockRestore();
    throw new Error("Transaction numbers are only allowed on a replica set member or mongos");
  });
}

describe("audit trail is atomic with the translation write", () => {
  useIntegrationServer();

  afterEach(() => {
    // Restore TranslationHistory.create after every test so a forced-failure
    // mock can't leak into the next case.
    vi.restoreAllMocks();
  });

  // An owner + a project with one regulated key (en authored) plus a
  // non-regulated key, all over real HTTP. Returns the ids we edit/approve.
  async function seedRegulated() {
    const owner = await registerUser({ name: "Olivia Owner", email: "owner@example.com" });

    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "RegBank", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.data._id;

    // Regulated key: owner authors en, then drafts a hi cell to later approve.
    const k = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({
        key: "kyc.disclosure",
        translations: { en: "Your KYC details are required by law." },
        regulated: true,
        mandatedBy: "RBI Master Directions on KYC, 2023",
      });
    expect(k.status).toBe(201);
    const regulatedId = k.body.data._id;

    // Non-regulated key for the best-effort case.
    const nr = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({ key: "hero.title", translations: { en: "Welcome" } });
    expect(nr.status).toBe(201);
    const plainId = nr.body.data._id;

    return { owner, projectId, regulatedId, plainId };
  }

  it("(a) a REGULATED PUT whose history write fails rolls back — value NOT persisted, route errors", async () => {
    const { owner, regulatedId } = await seedRegulated();

    // Force the audit write to throw. Because the key is regulated AND the
    // replica-set harness runs inside a real transaction, recordHistory
    // propagates and the save is rolled back.
    const spy = vi
      .spyOn(TranslationHistory, "create")
      .mockRejectedValue(new Error("forced audit-write failure"));

    const putRes = await request()
      .put(`/api/translations/${regulatedId}`)
      .set("Authorization", bearer(owner.token))
      .send({ editedLang: "hi", translations: { hi: "आपके केवाईसी विवरण कानून द्वारा आवश्यक हैं।" } });

    // The whole operation failed, so the route does NOT return success.
    expect(putRes.status).toBe(500);
    expect(spy).toHaveBeenCalled();

    // ATOMICITY: neither the value nor a hi history row persisted. (The seed's
    // en authoring left ONE pre-existing history row; the rolled-back PUT must
    // add NO hi row.)
    const fresh = await Translation.findById(regulatedId).lean();
    const hi = (fresh!.translations as any)?.hi;
    expect(hi?.default).toBeUndefined(); // the hi cell was rolled back
    expect(
      await TranslationHistory.countDocuments({ translationId: regulatedId, lang: "hi" })
    ).toBe(0);
  });

  it("(b) an APPROVAL whose history write fails rolls back — source NOT flipped to approved, route errors", async () => {
    const { owner, regulatedId } = await seedRegulated();

    // First put a hi draft WITHOUT the mock so it persists normally (owner edit
    // on a regulated key is published directly, so it's already 'human'; we make
    // it pending by editing as... actually owner writes 'human'/'approved'.
    // Simpler: owner edits hi (stamped 'human' since owner), then we approve it —
    // the approval still records a provenance history event we can fail.)
    const draft = await request()
      .put(`/api/translations/${regulatedId}`)
      .set("Authorization", bearer(owner.token))
      .send({ editedLang: "hi", translations: { hi: "केवाईसी विवरण आवश्यक हैं।" } });
    expect(draft.status).toBe(200);

    const beforeSource = (await Translation.findById(regulatedId).lean())!;
    const beforeHi = (beforeSource.sources as any)?.hi?.default;

    // Now force the audit write to fail and approve.
    vi.spyOn(TranslationHistory, "create").mockRejectedValue(new Error("forced audit-write failure"));

    const reviewRes = await request()
      .post(`/api/translations/${regulatedId}/review`)
      .set("Authorization", bearer(owner.token))
      .send({ lang: "hi", action: "approve" });

    expect(reviewRes.status).toBe(500);

    // ATOMICITY: the source was NOT flipped to "approved" (no phantom approval),
    // and no new history row landed for this approval.
    const after = (await Translation.findById(regulatedId).lean())!;
    const afterHi = (after.sources as any)?.hi?.default;
    expect(afterHi).toBe(beforeHi); // unchanged — approval rolled back
    expect(afterHi).not.toBe("approved");
    // The only history rows are the ones from the successful draft edit; the
    // approval event did NOT persist.
    const approvals = await TranslationHistory.countDocuments({
      translationId: regulatedId,
      source: "approved",
    });
    expect(approvals).toBe(0);
  });

  it("(c) on STANDALONE (no txn), a NON-regulated PUT whose history write fails still SUCCEEDS (best-effort)", async () => {
    const { owner, plainId } = await seedRegulated();

    // Simulate a self-host standalone Mongo: the route falls back to a
    // session-less write. With no session AND a non-regulated key, a history
    // failure is swallowed and the edit stands (history stays best-effort).
    forceStandaloneFallbackOnce();
    const spy = vi
      .spyOn(TranslationHistory, "create")
      .mockRejectedValue(new Error("forced audit-write failure"));

    const putRes = await request()
      .put(`/api/translations/${plainId}`)
      .set("Authorization", bearer(owner.token))
      .send({ editedLang: "hi", translations: { hi: "स्वागत है" } });

    // The edit succeeds despite the history failure.
    expect(putRes.status).toBe(200);
    expect(spy).toHaveBeenCalled();

    // The VALUE persisted (best-effort history did not block it).
    const fresh = (await Translation.findById(plainId).lean())!;
    expect((fresh.translations as any)?.hi?.default).toBe("स्वागत है");
  });

  it("(d) DEFENSE: on STANDALONE, a REGULATED PUT whose history write fails FAILS the request (never silently servable)", async () => {
    const { owner, regulatedId } = await seedRegulated();

    // Simulate a misconfigured standalone self-host. There is NO transaction to
    // roll back the save, BUT because the key is regulated the recordHistory
    // hardening (isRegulated flag) propagates the failure so the request errors
    // loudly instead of returning 200 with a live-but-unaudited regulated cell.
    forceStandaloneFallbackOnce();
    vi.spyOn(TranslationHistory, "create").mockRejectedValue(
      new Error("forced audit-write failure")
    );

    const putRes = await request()
      .put(`/api/translations/${regulatedId}`)
      .set("Authorization", bearer(owner.token))
      .send({ editedLang: "hi", translations: { hi: "केवाईसी विवरण आवश्यक हैं।" } });

    // The request FAILS (not a silent 200) — the operator is told the audit
    // write didn't land. (On standalone the value may have been saved already;
    // the contract here is "fail loudly", and the RS path above is what makes it
    // truly atomic. No hi audit row exists.)
    expect(putRes.status).toBe(500);
    expect(
      await TranslationHistory.countDocuments({ translationId: regulatedId, lang: "hi" })
    ).toBe(0);
  });
});
