/**
 * Integration — vertical-pack import writes an AUDIT TRAIL, atomically (v0.4).
 *
 * The compliance MOAT is a "guaranteed audit trail": a REGULATED cell may never
 * be created/populated without an immutable TranslationHistory row written
 * atomically with the value. Before this fix, `POST
 * /api/projects/:projectId/import-pack` stamped pack items with a `mandatedBy`
 * citation as `regulated: true` and wrote their cells, but recorded NO history —
 * a regulated key went live with no audit trail.
 *
 * This suite proves the fix over real HTTP against the replica-set harness (the
 * SAME real transaction path prod takes):
 *   (a) a NORMAL import of a regulated pack writes history rows for the imported
 *       regulated cells; and
 *   (b) when TranslationHistory.create is forced to fail, importing the regulated
 *       pack does NOT leave a regulated cell live with zero history rows — the
 *       per-item transaction rolls back (value not persisted) and the item is
 *       counted as failed, never silently imported.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import VerticalPack from "../../models/VerticalPack";
import Translation from "../../models/Translation";
import TranslationHistory from "../../models/TranslationHistory";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

const PACK_CODE = "test-fintech-kyc-reg";
const CITATION = "RBI Master Directions on KYC, 2023";
// The regulated key — has a mandatedBy citation, so the import locks it
// (regulated: true) and must produce an audit row per imported cell.
const REG_KEY = "kyc.aadhaar.consent_title";
const REG_VALUE = "आधार सत्यापन हेतु सहमति";
// A plain key — no citation, not regulated; history is best-effort.
const PLAIN_KEY = "kyc.pan.label";

describe("vertical-pack import records an atomic audit trail", () => {
  useIntegrationServer();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Insert a VerticalPack fixture directly (afterEach wipes collections, so the
  // boot-seeded packs don't survive between tests). One REGULATED item (has
  // mandatedBy) + one plain item, both Hindi/formal.
  async function seedPack() {
    await VerticalPack.create({
      code: PACK_CODE,
      name: "Test KYC Reg Pack",
      description: "fixture",
      vertical: "fintech",
      regulator: "RBI",
      jurisdiction: "IN",
      languages: ["hi"],
      registers: ["formal"],
      isSample: false,
      official: false,
      items: [
        {
          key: REG_KEY,
          context: "Aadhaar consent heading",
          mandatedBy: CITATION,
          translations: { hi: { formal: REG_VALUE } },
        },
        {
          key: PLAIN_KEY,
          context: "PAN label",
          translations: { hi: { formal: "स्थायी खाता संख्या (PAN)" } },
        },
      ],
    });
  }

  // An owner + a project that supports hi, ready to import into.
  async function seedOwnerProject() {
    const owner = await registerUser({ name: "Olivia Owner", email: "owner@example.com" });
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "RegBank", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    return { owner, projectId: projRes.body.data._id as string };
  }

  it("(a) a normal import records history rows for the imported regulated cells", async () => {
    await seedPack();
    const { owner, projectId } = await seedOwnerProject();

    const res = await request()
      .post(`/api/projects/${projectId}/import-pack`)
      .set("Authorization", bearer(owner.token))
      .send({ code: PACK_CODE });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    expect(res.body.data.failed).toBe(0);

    // The regulated key persisted, locked, with its hi/formal cell held pending.
    const reg = await Translation.findOne({ key: REG_KEY }).lean();
    expect(reg).toBeTruthy();
    expect(reg!.regulated).toBe(true);
    expect((reg!.translations as any)?.hi?.formal).toBe(REG_VALUE);
    expect((reg!.sources as any)?.hi?.formal).toBe("pending");

    // AUDIT TRAIL: a history row exists for the regulated key's imported cell.
    const regHistory = await TranslationHistory.countDocuments({
      translationId: reg!._id,
      lang: "hi",
      register: "formal",
    });
    expect(regHistory).toBeGreaterThan(0);

    // The plain key also got a history row (best-effort path still wrote it).
    const plain = await Translation.findOne({ key: PLAIN_KEY }).lean();
    expect(plain!.regulated).not.toBe(true);
    expect(
      await TranslationHistory.countDocuments({ translationId: plain!._id })
    ).toBeGreaterThan(0);
  });

  it("(b) when the audit write fails, the regulated cell is NOT left live without history", async () => {
    await seedPack();
    const { owner, projectId } = await seedOwnerProject();

    // Force EVERY audit insert to fail. On the replica-set harness the regulated
    // item's per-item transaction rolls back: its value is not persisted and it
    // is counted as failed — never a populated regulated cell with no history.
    const spy = vi
      .spyOn(TranslationHistory, "create")
      .mockRejectedValue(new Error("forced audit-write failure"));

    const res = await request()
      .post(`/api/projects/${projectId}/import-pack`)
      .set("Authorization", bearer(owner.token))
      .send({ code: PACK_CODE });

    // The route still responds 200 (one bad item must not abort the whole
    // import), but the regulated item is reported failed, not created.
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled();
    expect(res.body.data.failed).toBeGreaterThanOrEqual(1);

    // CORE INVARIANT: there is NO regulated cell live with zero history rows.
    // The regulated key's value must NOT have persisted (transaction rolled back).
    const reg = await Translation.findOne({ key: REG_KEY }).lean();
    const liveCell = reg ? (reg.translations as any)?.hi?.formal : undefined;
    const regHistory = reg
      ? await TranslationHistory.countDocuments({ translationId: reg._id })
      : 0;

    // Either the regulated value never persisted, OR (defensively) if it somehow
    // did it must have a history row — never value-live-with-zero-history.
    const liveWithoutAudit = liveCell === REG_VALUE && regHistory === 0;
    expect(liveWithoutAudit).toBe(false);
    // Concretely on the RS path: the rolled-back regulated cell is absent.
    expect(liveCell).toBeUndefined();
  });
});
