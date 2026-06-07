/**
 * Integration — invite expiry (Phase 4).
 *
 * An owner invites an email; we push the membership's inviteExpiresAt into the
 * past; the invited user (registered with the same email) accepts → 410 Gone.
 */

import { describe, it, expect } from "vitest";
import ProjectMember from "../../models/ProjectMember";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

describe("invite expiry", () => {
  useIntegrationServer();

  it("an expired pending invite cannot be accepted (410)", async () => {
    const owner = await registerUser({ email: "owner@example.com" });

    // Register the invitee FIRST. If they signed up AFTER the invite existed,
    // the register route would auto-claim the pending invite (status→active),
    // and accept-invite would hit the already-active branch (200) instead of
    // the expiry gate we're testing. With the user already present, the invite
    // is created as a genuine pending membership.
    const inviteEmail = "invitee@example.com";
    const invitee = await registerUser({ email: inviteEmail });

    // Owner creates a project.
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "Inviteville", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.data._id;

    // Owner invites the teammate by email.
    const inviteRes = await request()
      .post(`/api/projects/${projectId}/team/invite`)
      .set("Authorization", bearer(owner.token))
      .send({ email: inviteEmail, role: "translator", assignedLanguages: ["hi"] });
    expect(inviteRes.status).toBe(201);
    const inviteToken = inviteRes.body.data.inviteToken;
    expect(typeof inviteToken).toBe("string");

    // Sanity: the membership is genuinely pending (not auto-claimed).
    const pending = await ProjectMember.findOne({ inviteToken });
    expect(pending?.status).toBe("pending");

    // Force the invite to be expired by setting inviteExpiresAt to the past.
    await ProjectMember.updateOne(
      { inviteToken },
      { $set: { inviteExpiresAt: new Date(Date.now() - 60 * 60 * 1000) } }
    );

    // The invited user tries to accept → expired → 410 Gone.
    const acceptRes = await request()
      .post("/api/team/accept-invite")
      .set("Authorization", bearer(invitee.token))
      .send({ token: inviteToken });

    expect(acceptRes.status).toBe(410);
    expect(acceptRes.body.success).toBe(false);
  });
});
