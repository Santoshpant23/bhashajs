/**
 * Integration — concurrent REGULATED pack-import overwrites form a REAL audit
 * chain (v0.4 hardening, audit blocker B2).
 *
 * `POST /api/projects/:projectId/import-pack` records history atomically for
 * regulated items. The bug: it read `existing` (and the old cell value) BEFORE
 * the transaction and saved that captured doc INSIDE the transaction, so two
 * concurrent regulated overwrites both saw the same v0 predecessor → history
 * rows "v0→A" and "v0→B" while the committed value is B (the second should be
 * "A→B"). A WriteConflict retry replayed the STALE oldValue.
 *
 * The fix re-fetches the translation WITH the session inside the callback and
 * reads each cell's oldValue from that FRESH doc, so a retry re-reads the
 * actually-committed state and the chain is correct. This suite fires TWO
 * concurrent imports that overwrite the SAME regulated cell to DIFFERENT values
 * and asserts the resulting TranslationHistory forms a real chain (exactly one
 * row chains off the pre-existing value; the other chains off the first's new
 * value) — mirroring the chain assertion in round10.test.ts (B1).
 */

import { describe, it, expect } from "vitest";
import VerticalPack from "../../models/VerticalPack";
import Translation from "../../models/Translation";
import TranslationHistory from "../../models/TranslationHistory";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

const CITATION = "RBI Master Directions on KYC, 2023";
// One regulated key (mandatedBy citation → the import locks it regulated:true).
const REG_KEY = "kyc.aadhaar.consent_title";
const V0 = "आधार सहमति — v0"; // the pre-existing (seed) value
const VA = "आधार सहमति — A"; // overwrite from import A
const VB = "आधार सहमति — B"; // overwrite from import B

describe("concurrent regulated pack-import overwrites form a real audit chain", () => {
  useIntegrationServer();

  // A VerticalPack fixture whose single regulated hi/formal cell carries `value`.
  // afterEach wipes collections, so we re-create the pack per scenario with the
  // value we want this import to write.
  async function seedPack(code: string, value: string) {
    await VerticalPack.create({
      code,
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
          translations: { hi: { formal: value } },
        },
      ],
    });
  }

  async function seedOwnerProject() {
    const owner = await registerUser({ name: "Olivia Owner", email: "owner@example.com" });
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "RegBank", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    return { owner, projectId: projRes.body.data._id as string };
  }

  it(
    "two concurrent overwrites chain off the committed predecessor, not the same stale v0",
    async () => {
      const { owner, projectId } = await seedOwnerProject();
      const auth = bearer(owner.token);

      // 1) Import the V0 pack once so the regulated key exists & is locked, with
      //    its hi/formal cell = V0. This is the chain's root.
      await seedPack("pack-v0", V0);
      const seed = await request()
        .post(`/api/projects/${projectId}/import-pack`)
        .set("Authorization", auth)
        .send({ code: "pack-v0", overwrite: true });
      expect(seed.status).toBe(200);
      expect(seed.body.data.created).toBe(1);

      const reg = await Translation.findOne({ key: REG_KEY }).lean();
      expect(reg).toBeTruthy();
      expect(reg!.regulated).toBe(true);
      expect((reg!.translations as any)?.hi?.formal).toBe(V0);
      const regId = reg!._id;

      // 2) Two packs that overwrite the SAME cell to DIFFERENT values.
      await seedPack("pack-a", VA);
      await seedPack("pack-b", VB);

      // Fire BOTH imports concurrently with overwrite:true. One wins the cell
      // last; under the old bug both would record oldValue === V0.
      const [resA, resB] = await Promise.all([
        request()
          .post(`/api/projects/${projectId}/import-pack`)
          .set("Authorization", auth)
          .send({ code: "pack-a", overwrite: true }),
        request()
          .post(`/api/projects/${projectId}/import-pack`)
          .set("Authorization", auth)
          .send({ code: "pack-b", overwrite: true }),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      // Neither import failed its regulated item (both committed atomically).
      expect(resA.body.data.failed).toBe(0);
      expect(resB.body.data.failed).toBe(0);

      // 3) The audit trail for this cell must be a REAL chain.
      const hist = await TranslationHistory.find({
        translationId: regId,
        lang: "hi",
        register: "formal",
      }).sort({ createdAt: 1 });

      // Only the two overwrite rows (V0 was the seed import's own row → oldValue "").
      const overwriteRows = hist.filter((h) => h.newValue === VA || h.newValue === VB);
      expect(overwriteRows.length).toBe(2);

      // EXACTLY ONE overwrite chained off the pre-existing V0 (the bug: BOTH did).
      expect(overwriteRows.filter((h) => h.oldValue === V0).length).toBe(1);

      // The other overwrite chained off the FIRST overwrite's newValue — i.e. its
      // oldValue is the OTHER row's newValue (a real predecessor link).
      const rowA = overwriteRows.find((h) => h.newValue === VA)!;
      const rowB = overwriteRows.find((h) => h.newValue === VB)!;
      // One of {rowA, rowB} has oldValue V0; the other has oldValue equal to the
      // first's newValue. Verify both directions are covered.
      const oldValues = new Set([rowA.oldValue, rowB.oldValue]);
      expect(oldValues.has(V0)).toBe(true);
      const chained =
        (rowA.oldValue === V0 && rowB.oldValue === VA) ||
        (rowB.oldValue === V0 && rowA.oldValue === VB);
      expect(chained).toBe(true);

      // No row chains off itself (no self-referential no-op).
      for (const h of overwriteRows) {
        expect(h.oldValue).not.toBe(h.newValue);
      }

      // The committed cell is whichever overwrite landed last; it matches the
      // newValue of the row whose oldValue is the OTHER overwrite's value.
      const fresh = await Translation.findById(regId).lean();
      const finalValue = (fresh!.translations as any)?.hi?.formal;
      expect([VA, VB]).toContain(finalValue);
      const lastRow = overwriteRows.find((h) => h.oldValue !== V0)!;
      expect(lastRow.newValue).toBe(finalValue);
    },
    40000
  );
});
