/**
 * Integration — public instant sandbox / "try the SDK" key (v0.4 hardening).
 *
 * Drives everything over real HTTP plus the cleanup helper directly:
 *   - POST /api/sandbox (NO auth) returns a projectKey + sampleKeys + expiresAt
 *   - that key authenticates GET /api/sdk/translations?lang=hi (x-api-key) and
 *     returns the SEEDED Hindi values
 *   - the minted project is flagged isSandbox with a FUTURE expiresAt
 *   - cleanupExpiredSandboxes() removes an EXPIRED sandbox + its translations
 *     (no orphans) but LEAVES a non-expired one untouched
 *
 * No AI is called — the sandbox pre-seeds plain (non-regulated) sample keys.
 */

import { describe, it, expect } from "vitest";
import Project from "../../models/Project";
import Translation from "../../models/Translation";
import ApiKey from "../../models/ApiKey";
import { cleanupExpiredSandboxes } from "../../routes/sandbox";
import { useIntegrationServer, request } from "./setup";

describe("public sandbox", () => {
  useIntegrationServer();

  it("mints a sandbox key + sample keys with no auth, and the key serves seeded Hindi via the SDK", async () => {
    const res = await request().post("/api/sandbox").send({});
    expect(res.status).toBe(201);

    const { projectKey, projectId, sampleKeys, expiresAt } = res.body.data;
    expect(projectKey).toMatch(/^bjs_[0-9a-f]{48}$/);
    expect(projectId).toBeTruthy();
    expect(Array.isArray(sampleKeys)).toBe(true);
    // The brief asks for ~8 realistic sample keys spanning the demo UI.
    expect(sampleKeys.length).toBeGreaterThanOrEqual(8);
    expect(sampleKeys).toEqual(
      expect.arrayContaining([
        "hero.title",
        "hero.cta",
        "cart.add",
        "greeting",
        "items_one",
        "items_other",
        "nav.home",
        "auth.login",
      ])
    );
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The sandbox key drives the PUBLIC SDK read path and returns Hindi values.
    const sdkRes = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", projectKey);
    expect(sdkRes.status).toBe(200);
    expect(sdkRes.body.data["hero.title"]).toBe("हर भाषा में लॉन्च करें");
    expect(sdkRes.body.data["nav.home"]).toBe("होम");
    // Interpolation placeholder is preserved verbatim for the SDK to fill.
    expect(sdkRes.body.data["greeting"]).toContain("{name}");

    // Other seeded locales resolve too (proves the cross-language seed).
    const taRes = await request()
      .get("/api/sdk/translations?lang=ta")
      .set("x-api-key", projectKey);
    expect(taRes.status).toBe(200);
    expect(taRes.body.data["nav.home"]).toBe("முகப்பு");
  });

  it("flags the project isSandbox with a future expiresAt and no owner", async () => {
    const res = await request().post("/api/sandbox").send({});
    expect(res.status).toBe(201);

    const project = await Project.findById(res.body.data.projectId);
    expect(project).toBeTruthy();
    expect(project!.get("isSandbox")).toBe(true);
    expect(project!.get("owner")).toBeNull();
    expect(project!.defaultLanguage).toBe("en");
    expect(project!.supportedLanguages).toEqual(["en", "hi", "bn", "ur", "ta"]);
    const exp = project!.get("expiresAt") as Date;
    expect(exp).toBeInstanceOf(Date);
    expect(exp.getTime()).toBeGreaterThan(Date.now());

    // A read-only, origin-unlocked key was minted for it.
    const keys = await ApiKey.find({ projectId: project!._id });
    expect(keys).toHaveLength(1);
    expect(keys[0].readOnly).toBe(true);
    expect(keys[0].allowedOrigins).toEqual([]);
  });

  it("cleanupExpiredSandboxes() removes an expired sandbox + its translations, leaves a live one", async () => {
    // Live sandbox via the real route.
    const liveRes = await request().post("/api/sandbox").send({});
    const liveId = liveRes.body.data.projectId;

    // Expired sandbox: mint then backdate its expiresAt into the past.
    const expiredRes = await request().post("/api/sandbox").send({});
    const expiredId = expiredRes.body.data.projectId;
    await Project.updateOne(
      { _id: expiredId },
      { expiresAt: new Date(Date.now() - 60_000) }
    );

    // Sanity: both have their seeded translations + key.
    expect(await Translation.countDocuments({ projectId: expiredId })).toBeGreaterThan(0);
    expect(await ApiKey.countDocuments({ projectId: expiredId })).toBe(1);

    const removed = await cleanupExpiredSandboxes();
    expect(removed).toBe(1);

    // Expired one is gone with no orphans.
    expect(await Project.countDocuments({ _id: expiredId })).toBe(0);
    expect(await Translation.countDocuments({ projectId: expiredId })).toBe(0);
    expect(await ApiKey.countDocuments({ projectId: expiredId })).toBe(0);

    // Live one is untouched and still serves the SDK.
    expect(await Project.countDocuments({ _id: liveId })).toBe(1);
    expect(await Translation.countDocuments({ projectId: liveId })).toBeGreaterThan(0);

    const sdkRes = await request()
      .get("/api/sdk/translations?lang=bn")
      .set("x-api-key", liveRes.body.data.projectKey);
    expect(sdkRes.status).toBe(200);
    expect(sdkRes.body.data["nav.home"]).toBe("হোম");
  });
});
