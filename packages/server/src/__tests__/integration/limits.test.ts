/**
 * Integration — cost-control limits: per-cell text length + explicit zero cap.
 *
 * (A) A translation cell is bounded in size (models/Translation.ts pre-save
 *     hook), so one key can't be tens of thousands of tokens — keeping the AI
 *     key-counter a meaningful cost proxy.
 * (B) AI_MONTHLY_CAP_DEFAULT=0 means UNLIMITED (no per-project cap), so the
 *     "self-host = unlimited" claim is actually true. Only an unset/invalid value
 *     falls back to 5000.
 */

import { describe, it, expect, afterEach } from "vitest";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";
import { MAX_CELL_TEXT_LEN } from "../../models/Translation";
import Translation from "../../models/Translation";

describe("cost-control limits", () => {
  useIntegrationServer();

  const ORIG_CAP = process.env.AI_MONTHLY_CAP_DEFAULT;
  const ORIG_KEY_CAP = process.env.MAX_KEYS_PER_PROJECT;
  afterEach(() => {
    if (ORIG_CAP === undefined) delete process.env.AI_MONTHLY_CAP_DEFAULT;
    else process.env.AI_MONTHLY_CAP_DEFAULT = ORIG_CAP;
    if (ORIG_KEY_CAP === undefined) delete process.env.MAX_KEYS_PER_PROJECT;
    else process.env.MAX_KEYS_PER_PROJECT = ORIG_KEY_CAP;
  });

  async function project(owner: { token: string }) {
    const r = await request()
      .post("/api/projects")
      .set("Authorization", bearer(owner.token))
      .send({ name: "P", supportedLanguages: ["en", "hi"] });
    expect(r.status).toBe(201);
    return r.body.data;
  }

  it("rejects a translation cell over the per-cell text limit (not persisted)", async () => {
    const owner = await registerUser();
    const proj = await project(owner);
    const huge = "x".repeat(MAX_CELL_TEXT_LEN + 1);

    const res = await request()
      .post(`/api/translations/${proj._id}`)
      .set("Authorization", bearer(owner.token))
      .send({ key: "big.key", translations: { en: huge } });

    expect(res.status).not.toBe(201); // the pre-save hook rejects it
    expect(await Translation.countDocuments({ projectId: proj._id, key: "big.key" })).toBe(0);
  });

  it("accepts a translation cell at exactly the limit", async () => {
    const owner = await registerUser();
    const proj = await project(owner);
    const atLimit = "x".repeat(MAX_CELL_TEXT_LEN);

    const res = await request()
      .post(`/api/translations/${proj._id}`)
      .set("Authorization", bearer(owner.token))
      .send({ key: "ok.key", translations: { en: atLimit } });

    expect(res.status).toBe(201);
  });

  it("AI_MONTHLY_CAP_DEFAULT=0 gives a new project an unlimited (0) cap", async () => {
    process.env.AI_MONTHLY_CAP_DEFAULT = "0";
    const owner = await registerUser();
    const proj = await project(owner);
    expect(proj.aiMonthlyCap).toBe(0);
  });

  it("an unset AI_MONTHLY_CAP_DEFAULT falls back to 5000", async () => {
    delete process.env.AI_MONTHLY_CAP_DEFAULT;
    const owner = await registerUser();
    const proj = await project(owner);
    expect(proj.aiMonthlyCap).toBe(5000);
  });

  it("MAX_KEYS_PER_PROJECT caps key creation on create and bulk import", async () => {
    process.env.MAX_KEYS_PER_PROJECT = "2";
    const owner = await registerUser();
    const proj = await project(owner);
    const auth = bearer(owner.token);

    for (const key of ["k.one", "k.two"]) {
      const r = await request()
        .post(`/api/translations/${proj._id}`)
        .set("Authorization", auth)
        .send({ key, translations: { en: "x" } });
      expect(r.status).toBe(201);
    }

    // Third single create is rejected at the cap.
    const third = await request()
      .post(`/api/translations/${proj._id}`)
      .set("Authorization", auth)
      .send({ key: "k.three", translations: { en: "x" } });
    expect(third.status).toBe(400);
    expect(third.body.message).toMatch(/key limit/i);

    // Bulk import is rejected at the cap too.
    const bulk = await request()
      .post(`/api/translations/${proj._id}/bulk`)
      .set("Authorization", auth)
      .send({ lang: "en", translations: { "k.four": "x" } });
    expect(bulk.status).toBe(400);
    expect(bulk.body.message).toMatch(/key limit/i);

    expect(await Translation.countDocuments({ projectId: proj._id })).toBe(2);
  });

  it("MAX_KEYS_PER_PROJECT=0 disables the key cap", async () => {
    process.env.MAX_KEYS_PER_PROJECT = "0";
    const owner = await registerUser();
    const proj = await project(owner);

    const r = await request()
      .post(`/api/translations/${proj._id}`)
      .set("Authorization", bearer(owner.token))
      .send({ key: "k.any", translations: { en: "x" } });
    expect(r.status).toBe(201);
  });
});
