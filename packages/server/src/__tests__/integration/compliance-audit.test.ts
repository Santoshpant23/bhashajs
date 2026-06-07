/**
 * Integration — compliance audit trail (the sellable artifact, v0.4).
 *
 * The compliance lock already withholds non-approved copy on regulated keys.
 * This suite covers the AUDIT layer on top of it: per the real `/review`
 * approve flow (which records a history event with an approver), the owner-only
 * audit endpoint must surface every regulated key, its regulator citation, the
 * current per-cell status, and the resolved approver (name + email) for each
 * history event — in JSON and as a flat CSV. Plus the roll-up summary counts
 * and the owner-only access guarantee.
 *
 * Everything is driven over real HTTP. No AI is called.
 */

import { describe, it, expect } from "vitest";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

describe("compliance audit trail", () => {
  useIntegrationServer();

  // Shared fixture: an owner with a project containing one regulated key whose
  // hi cell has been approved by the owner via the real /review route, and a
  // second regulated key left with a pending (unapproved) cell.
  async function seed() {
    const owner = await registerUser({ name: "Olivia Owner", email: "owner@example.com" });
    const translator = await registerUser({ name: "Tariq Translator", email: "translator@example.com" });

    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "RegBank", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.data._id;

    // Invite + accept the translator (assigned to hi) so we can produce a
    // pending (non-owner) cell on a regulated key.
    const inviteRes = await request()
      .post(`/api/projects/${projectId}/team/invite`)
      .set("Authorization", bearer(owner.token))
      .send({ email: "translator@example.com", role: "translator", assignedLanguages: ["hi"] });
    expect(inviteRes.status).toBe(201);
    const acceptRes = await request()
      .post("/api/team/accept-invite")
      .set("Authorization", bearer(translator.token))
      .send({ token: inviteRes.body.data.inviteToken });
    expect(acceptRes.status).toBe(200);

    const citation = "RBI Master Directions on KYC, 2023";

    // Regulated key #1 — owner authors English, translator drafts hi (pending),
    // owner approves hi → "approved" with the owner as approver.
    const k1 = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({
        key: "kyc.disclosure",
        translations: { en: "Your KYC details are required by law." },
        regulated: true,
        mandatedBy: citation,
      });
    expect(k1.status).toBe(201);
    const k1Id = k1.body.data._id;

    const putRes = await request()
      .put(`/api/translations/${k1Id}`)
      .set("Authorization", bearer(translator.token))
      .send({ editedLang: "hi", translations: { hi: "आपके केवाईसी विवरण कानून द्वारा आवश्यक हैं।" } });
    expect(putRes.status).toBe(200);

    const reviewRes = await request()
      .post(`/api/translations/${k1Id}/review`)
      .set("Authorization", bearer(owner.token))
      .send({ lang: "hi", action: "approve" });
    expect(reviewRes.status).toBe(200);

    // Regulated key #2 — owner authors English only, translator drafts hi but it
    // is left PENDING (no approval). This key is "with pending".
    const k2 = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({
        key: "loan.terms",
        translations: { en: "Interest is calculated monthly." },
        regulated: true,
        mandatedBy: "RBI Fair Practices Code, 2015",
      });
    expect(k2.status).toBe(201);
    await request()
      .put(`/api/translations/${k2.body.data._id}`)
      .set("Authorization", bearer(translator.token))
      .send({ editedLang: "hi", translations: { hi: "ब्याज की गणना मासिक रूप से की जाती है।" } });

    // A non-regulated key — must NOT appear in the audit.
    await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({ key: "hero.title", translations: { en: "Welcome" } });

    return { owner, translator, projectId, citation, k1Id };
  }

  it("returns the regulated keys, citation, status, and resolved approver (JSON)", async () => {
    const { owner, projectId, citation } = await seed();

    const res = await request()
      .get(`/api/projects/${projectId}/compliance/audit`)
      .set("Authorization", bearer(owner.token));
    expect(res.status).toBe(200);

    const { totalRegulatedKeys, keys } = res.body.data;
    // Two regulated keys; the non-regulated "hero.title" is excluded.
    expect(totalRegulatedKeys).toBe(2);
    const auditedKeys = keys.map((k: any) => k.key).sort();
    expect(auditedKeys).toEqual(["kyc.disclosure", "loan.terms"]);

    const kyc = keys.find((k: any) => k.key === "kyc.disclosure");
    expect(kyc.mandatedBy).toBe(citation);

    // The hi cell is approved; the en cell is human → key is fully approved.
    expect(kyc.fullyApproved).toBe(true);
    const hiStatus = kyc.statuses.find((s: any) => s.lang === "hi");
    expect(hiStatus.status).toBe("approved");

    // History is present, newest-first, with the approver resolved to name+email.
    // The approval event (source "approved") was performed by the owner.
    const approvalEvent = kyc.history.find((h: any) => h.source === "approved");
    expect(approvalEvent).toBeTruthy();
    expect(approvalEvent.changedBy.name).toBe("Olivia Owner");
    expect(approvalEvent.changedBy.email).toBe("owner@example.com");
    expect(approvalEvent.lang).toBe("hi");
    // Newest-first ordering.
    const times = kyc.history.map((h: any) => new Date(h.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // The second key has a pending cell → not fully approved.
    const loan = keys.find((k: any) => k.key === "loan.terms");
    expect(loan.fullyApproved).toBe(false);
  });

  it("supports ?format=csv with citation, approver, and an attachment header", async () => {
    const { owner, projectId, citation } = await seed();

    const res = await request()
      .get(`/api/projects/${projectId}/compliance/audit?format=csv`)
      .set("Authorization", bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".csv");

    const csv = res.text;
    const lines = csv.trim().split(/\r\n/);
    // Header + at least the approval event row.
    expect(lines[0]).toBe(
      "key,citation,lang,register,oldValue,newValue,source,approverName,approverEmail,timestamp"
    );
    // The citation contains a comma → it must be quoted in the CSV.
    expect(csv).toContain(`"${citation}"`);
    // The approval row names the owner.
    const approvalRow = lines.find((l) => l.includes("approved") && l.includes("kyc.disclosure"));
    expect(approvalRow).toBeTruthy();
    expect(approvalRow).toContain("Olivia Owner");
    expect(approvalRow).toContain("owner@example.com");
  });

  it("summary returns correct total / fully-approved / with-pending counts", async () => {
    const { owner, projectId } = await seed();

    const res = await request()
      .get(`/api/projects/${projectId}/compliance/summary`)
      .set("Authorization", bearer(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      total: 2,
      fullyApproved: 1, // kyc.disclosure (en human + hi approved)
      withPending: 1, // loan.terms (hi pending)
    });
  });

  it("forbids a non-owner (translator) from the audit and summary (403)", async () => {
    const { translator, projectId } = await seed();

    const auditRes = await request()
      .get(`/api/projects/${projectId}/compliance/audit`)
      .set("Authorization", bearer(translator.token));
    expect(auditRes.status).toBe(403);

    const summaryRes = await request()
      .get(`/api/projects/${projectId}/compliance/summary`)
      .set("Authorization", bearer(translator.token));
    expect(summaryRes.status).toBe(403);
  });
});
