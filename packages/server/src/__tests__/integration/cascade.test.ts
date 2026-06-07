/**
 * Integration — cascade delete leaves no orphans (Phase 3).
 *
 * Deleting a project must remove every dependent document for that projectId:
 * Translation, Comment, GlossaryEntry, Notification, ProjectMember (and TM /
 * history). Deleting a single translation must remove its comments + history.
 *
 * On standalone mongodb-memory-server the route's withTransactionOrFallback
 * detects the lack of replica-set transactions and runs the same ordered,
 * children-before-parent deletes without a session — which is exactly what we
 * assert leaves zero orphans.
 */

import { describe, it, expect } from "vitest";
import Translation from "../../models/Translation";
import Comment from "../../models/Comment";
import GlossaryEntry from "../../models/GlossaryEntry";
import Notification from "../../models/Notification";
import ProjectMember from "../../models/ProjectMember";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

describe("cascade delete", () => {
  useIntegrationServer();

  it("deleting a project removes all dependents (no orphans)", async () => {
    const owner = await registerUser({ email: "owner@example.com" });

    // Project.
    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "Doomed", supportedLanguages: ["en", "hi"] });
    expect(projRes.status).toBe(201);
    const projectId = projRes.body.data._id;

    // Translation.
    const trRes = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({ key: "hero.title", translations: { en: "Welcome" } });
    expect(trRes.status).toBe(201);
    const translationId = trRes.body.data._id;

    // Comment on the translation (via HTTP).
    const commentRes = await request()
      .post(`/api/translations/${translationId}/comments`)
      .set("Authorization", bearer(owner.token))
      .send({ content: "Please double-check this one." });
    expect(commentRes.status).toBe(201);

    // Glossary entry (via HTTP).
    const glossaryRes = await request()
      .post(`/api/projects/${projectId}/glossary`)
      .set("Authorization", bearer(owner.token))
      .send({ term: "Welcome", translations: { hi: "स्वागत" } });
    expect(glossaryRes.status).toBe(201);

    // Notification — created directly (the app only mints these as side effects).
    await Notification.create({
      userId: owner.userId,
      type: "translator_edit",
      message: "n/a",
      projectId,
    });

    // Pre-delete sanity: everything exists.
    expect(await Translation.countDocuments({ projectId })).toBe(1);
    expect(await Comment.countDocuments({ projectId })).toBe(1);
    expect(await GlossaryEntry.countDocuments({ projectId })).toBe(1);
    expect(await Notification.countDocuments({ projectId })).toBe(1);
    // Owner membership was auto-created on project creation.
    expect(await ProjectMember.countDocuments({ projectId })).toBe(1);

    // DELETE the project.
    const delRes = await request()
      .delete(`/api/projects/${projectId}`)
      .set("Authorization", bearer(owner.token));
    expect(delRes.status).toBe(200);

    // No orphans remain for this projectId.
    expect(await Translation.countDocuments({ projectId })).toBe(0);
    expect(await Comment.countDocuments({ projectId })).toBe(0);
    expect(await GlossaryEntry.countDocuments({ projectId })).toBe(0);
    expect(await Notification.countDocuments({ projectId })).toBe(0);
    expect(await ProjectMember.countDocuments({ projectId })).toBe(0);
  });

  it("deleting a translation removes its comments", async () => {
    const owner = await registerUser({ email: "owner2@example.com" });

    const projRes = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "Trim", supportedLanguages: ["en", "hi"] });
    const projectId = projRes.body.data._id;

    const trRes = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({ key: "cart.checkout", translations: { en: "Checkout" } });
    expect(trRes.status).toBe(201);
    const translationId = trRes.body.data._id;

    const commentRes = await request()
      .post(`/api/translations/${translationId}/comments`)
      .set("Authorization", bearer(owner.token))
      .send({ content: "Comment that should be cleaned up." });
    expect(commentRes.status).toBe(201);

    expect(await Comment.countDocuments({ translationId })).toBe(1);

    const delRes = await request()
      .delete(`/api/translations/${translationId}`)
      .set("Authorization", bearer(owner.token));
    expect(delRes.status).toBe(200);

    expect(await Translation.countDocuments({ _id: translationId })).toBe(0);
    expect(await Comment.countDocuments({ translationId })).toBe(0);
  });
});
