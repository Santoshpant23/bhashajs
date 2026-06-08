/**
 * Integration — round-10 audit regressions:
 *   B1  the regulated audit trail is a REAL chain under concurrency
 *   B3  compliance evidence is append-only (survives unlock + delete)
 *   H4  project create is atomic (a membership failure leaves no orphan/drift)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import mongoose from "mongoose";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";
import Translation from "../../models/Translation";
import TranslationHistory from "../../models/TranslationHistory";
import Project from "../../models/Project";
import ProjectMember from "../../models/ProjectMember";
import User from "../../models/User";

describe("round-10 audit regressions", () => {
  useIntegrationServer();
  afterEach(() => vi.restoreAllMocks());

  async function project(owner: { token: string }) {
    const r = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "RB", supportedLanguages: ["en", "hi"] });
    expect(r.status).toBe(201);
    return r.body.data._id as string;
  }

  async function regulatedKey(owner: { token: string }, projectId: string) {
    const k = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({ key: "kyc.x", translations: { en: "E" }, regulated: true, mandatedBy: "RBI" });
    expect(k.status).toBe(201);
    return k.body.data._id as string;
  }

  it("B1: concurrent regulated edits form a real audit chain (oldValue = committed predecessor)", async () => {
    const owner = await registerUser();
    const projectId = await project(owner);
    const id = await regulatedKey(owner, projectId);
    const auth = bearer(owner.token);

    // Seed an initial hi value.
    await request().put(`/api/translations/${id}`).set("Authorization", auth)
      .send({ editedLang: "hi", translations: { hi: "v0" } });

    // Fire N concurrent edits to the SAME cell with distinct values.
    const N = 5;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request().put(`/api/translations/${id}`).set("Authorization", auth)
          .send({ editedLang: "hi", translations: { hi: `v${i + 1}` } })
      )
    );

    const hist = await TranslationHistory.find({ translationId: id, lang: "hi" }).sort({ createdAt: 1 });
    const editRows = hist.filter((h) => /^v[1-9]$/.test(h.newValue || ""));
    expect(editRows.length).toBe(N);
    // The fix: exactly ONE edit saw the initial "v0" predecessor. (The bug read
    // oldValue before the transaction, so ALL N rows claimed oldValue "v0".)
    expect(editRows.filter((h) => h.oldValue === "v0").length).toBe(1);
    // Every edit's oldValue is a real prior value (v0 or another edit's newValue),
    // never its own newValue (no self-referential no-op chain).
    const written = new Set(["v0", ...editRows.map((h) => h.newValue)]);
    for (const h of editRows) {
      expect(h.oldValue).not.toBe(h.newValue);
      expect(written.has(h.oldValue || "")).toBe(true);
    }
    // The final committed value is one of the writes.
    const fresh = await Translation.findById(id).lean();
    expect(/^v[1-9]$/.test((fresh!.translations as any).hi.default)).toBe(true);
  }, 40000);

  it("B3: UNLOCKING a regulated key keeps it (and an 'unlocked' event) in the compliance audit", async () => {
    const owner = await registerUser();
    const projectId = await project(owner);
    const id = await regulatedKey(owner, projectId);
    const auth = bearer(owner.token);

    let audit = await request().get(`/api/projects/${projectId}/compliance/audit`).set("Authorization", auth);
    expect(audit.body.data.keys.some((k: any) => k.key === "kyc.x")).toBe(true);

    // Unlock it.
    const unlock = await request().put(`/api/translations/${id}`).set("Authorization", auth)
      .send({ regulated: false });
    expect(unlock.status).toBe(200);

    // Still present (ever-regulated), with the unlock event recorded.
    audit = await request().get(`/api/projects/${projectId}/compliance/audit`).set("Authorization", auth);
    const k = audit.body.data.keys.find((x: any) => x.key === "kyc.x");
    expect(k).toBeTruthy();
    expect(k.history.some((h: any) => h.source === "unlocked")).toBe(true);
    expect(await TranslationHistory.countDocuments({ translationId: id, source: "unlocked" })).toBe(1);
  });

  it("B3: DELETING a regulated key retains its history tombstone and keeps it in the audit", async () => {
    const owner = await registerUser();
    const projectId = await project(owner);
    const id = await regulatedKey(owner, projectId);
    const auth = bearer(owner.token);

    const del = await request().delete(`/api/translations/${id}`).set("Authorization", auth);
    expect(del.status).toBe(200);

    // The Translation doc is gone, but its history evidence is RETAINED.
    expect(await Translation.countDocuments({ _id: id })).toBe(0);
    expect(await TranslationHistory.countDocuments({ translationId: id })).toBeGreaterThan(0);
    expect(await TranslationHistory.countDocuments({ translationId: id, source: "deleted" })).toBe(1);

    // The deleted key is reconstructed as a tombstone in the audit export.
    const audit = await request().get(`/api/projects/${projectId}/compliance/audit`).set("Authorization", auth);
    const k = audit.body.data.keys.find((x: any) => x.key === "kyc.x");
    expect(k).toBeTruthy();
    expect(k.deleted).toBe(true);
  });

  it("H4: a project-create whose membership write fails leaves NO orphan project and NO counter drift", async () => {
    const owner = await registerUser();

    // Force the owner-membership create to fail INSIDE the create transaction.
    vi.spyOn(ProjectMember, "create").mockRejectedValue(new Error("forced membership failure"));

    const res = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "Doomed", supportedLanguages: ["en", "hi"] });

    expect(res.status).toBe(500);
    // Rolled back: no orphan project, and the quota counter didn't drift.
    expect(await Project.countDocuments({ owner: owner.userId })).toBe(0);
    const u = await User.findById(owner.userId).lean();
    expect((u as any)?.projectCount || 0).toBe(0);
  });

  it("B1-legacy: a pre-upgrade regulated row missing everRegulated survives unlock in the audit", async () => {
    const owner = await registerUser();
    const projectId = await project(owner);
    const auth = bearer(owner.token);

    // Raw insert of a regulated doc WITHOUT the everRegulated field (bypasses the
    // model pre-save hook) — simulates a row created before the marker shipped.
    const raw = await Translation.collection.insertOne({
      projectId: new mongoose.Types.ObjectId(projectId),
      key: "legacy.kyc",
      translations: { hi: { default: "v" } },
      sources: { hi: { default: "human" } },
      source: "human",
      regulated: true,
      mandatedBy: "RBI legacy",
      updatedAt: new Date(),
    });
    const id = raw.insertedId.toString();

    // Unlock it (regulated → false).
    const unlock = await request().put(`/api/translations/${id}`).set("Authorization", auth)
      .send({ regulated: false });
    expect(unlock.status).toBe(200);

    // everRegulated was set on unlock (wasRegulated), so it stays in the audit.
    const fresh = await Translation.findById(id).lean();
    expect((fresh as any).everRegulated).toBe(true);
    const audit = await request().get(`/api/projects/${projectId}/compliance/audit`).set("Authorization", auth);
    expect(audit.body.data.keys.some((k: any) => k.key === "legacy.kyc")).toBe(true);
  });

  it("H1: a failed quota decrement during project delete rolls back the whole delete (no desync)", async () => {
    const owner = await registerUser();
    const projectId = await project(owner); // projectCount = 1

    // Force the in-transaction decrement (User.updateOne) to fail.
    vi.spyOn(User, "updateOne").mockRejectedValueOnce(new Error("forced decrement failure"));

    const del = await request().delete(`/api/projects/${projectId}`).set("Authorization", bearer(owner.token));
    expect(del.status).toBe(500);

    // Atomic: the project is NOT gone and the counter is NOT desynced.
    expect(await Project.countDocuments({ _id: projectId })).toBe(1);
    const u = await User.findById(owner.userId).lean();
    expect((u as any).projectCount).toBe(1);
  });
});
