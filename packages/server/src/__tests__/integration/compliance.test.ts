/**
 * Integration — compliance lock end-to-end (Phase 1/3, the moat).
 *
 * On a `regulated` key the public SDK must only ever serve a cell whose source
 * provenance is "human" or "approved". A non-owner edit lands as "pending" and
 * is WITHHELD by the SDK until an owner approves it via /review → "approved",
 * after which the SDK serves it.
 *
 * Everything here is driven over real HTTP — including producing the
 * non-human/non-approved cell via a translator's PUT (which the write-side
 * compliance gate stamps "pending"). No AI is called.
 */

import { describe, it, expect } from "vitest";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

describe("compliance lock (SDK read gate)", () => {
  useIntegrationServer();

  it("withholds a pending cell on a regulated key, serves it once approved", async () => {
    const owner = await registerUser({ email: "owner@example.com" });

    // Translator account must exist before the invite so the owner's invite is
    // a real pending membership; we then accept it as the translator.
    const translator = await registerUser({ email: "translator@example.com" });

    // Owner creates a project (hi supported).
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "RegBank", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const project = projRes.body.data;
    const projectId = project._id;
    const apiKey = project.apiKey;
    expect(typeof apiKey).toBe("string");

    // Invite the translator, assigned to hi, then accept the invite.
    const inviteRes = await request()
      .post(`/api/projects/${projectId}/team/invite`)
      .set("Authorization", bearer(owner.token))
      .send({ email: "translator@example.com", role: "translator", assignedLanguages: ["hi"] });
    expect(inviteRes.status).toBe(201);
    const inviteToken = inviteRes.body.data.inviteToken;

    const acceptRes = await request()
      .post("/api/team/accept-invite")
      .set("Authorization", bearer(translator.token))
      .send({ token: inviteToken });
    expect(acceptRes.status).toBe(200);

    // Owner creates a REGULATED key with the English source (human-authored).
    const createRes = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({
        key: "kyc.disclosure",
        translations: { en: "Your KYC details are required by law." },
        regulated: true,
        mandatedBy: "RBI Master Directions on KYC, 2023",
      });
    expect(createRes.status).toBe(201);
    const translationId = createRes.body.data._id;
    expect(createRes.body.data.regulated).toBe(true);

    // Translator writes the Hindi cell via PUT. On a regulated key a non-owner's
    // write is stamped "pending" by the write-side compliance gate.
    const putRes = await request()
      .put(`/api/translations/${translationId}`)
      .set("Authorization", bearer(translator.token))
      .send({ editedLang: "hi", translations: { hi: "आपके केवाईसी विवरण कानून द्वारा आवश्यक हैं।" } });
    expect(putRes.status).toBe(200);

    // SDK read BEFORE approval → the regulated key is WITHHELD for hi.
    const sdkBefore = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", apiKey);
    expect(sdkBefore.status).toBe(200);
    expect(sdkBefore.body.data["kyc.disclosure"]).toBeUndefined();

    // Owner approves the pending hi cell → source becomes "approved".
    const reviewRes = await request()
      .post(`/api/translations/${translationId}/review`)
      .set("Authorization", bearer(owner.token))
      .send({ lang: "hi", action: "approve" });
    expect(reviewRes.status).toBe(200);

    // SDK read AFTER approval → the key is now served for hi.
    const sdkAfter = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", apiKey);
    expect(sdkAfter.status).toBe(200);
    expect(sdkAfter.body.data["kyc.disclosure"]).toBe(
      "आपके केवाईसी विवरण कानून द्वारा आवश्यक हैं।"
    );
  });
});
