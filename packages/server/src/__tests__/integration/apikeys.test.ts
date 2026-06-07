/**
 * Integration — scoped, rotatable API keys (v0.4 hardening).
 *
 * Drives everything over real HTTP:
 *   - owner creates a project, then mints a scoped key (full secret returned once)
 *   - the scoped key authenticates GET /api/sdk/translations
 *   - GET /keys returns the key MASKED, never the raw secret
 *   - revoking the key makes the SDK reject it (401)
 *   - an origin-allowlisted key rejects a request from the wrong Origin (403)
 *     and accepts the right one
 *   - the project's LEGACY Project.apiKey still resolves (back-compat)
 *
 * No AI is called. The compliance lock is untouched — these keys are just an
 * auth layer in front of the same SDK read path.
 */

import { describe, it, expect } from "vitest";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

/** Create a project and a translation key the SDK can serve, return ids + legacy key. */
async function setupProject(token: string) {
  const projRes = await request()
    .post("/api/projects")
    .set("Authorization", bearer(token))
    .send({ name: "KeyTest", supportedLanguages: ["en", "hi"] });
  expect(projRes.status).toBe(201);
  const projectId = projRes.body.data._id;
  const legacyKey = projRes.body.data.apiKey as string;

  // A plain (non-regulated) translation so the SDK bundle is non-empty.
  const trRes = await request()
    .post(`/api/translations/${projectId}`)
    .set("Authorization", bearer(token))
    .send({ key: "greeting", translations: { en: "Hello", hi: "नमस्ते" } });
  expect(trRes.status).toBe(201);

  return { projectId, legacyKey };
}

describe("scoped API keys", () => {
  useIntegrationServer();

  it("mints a scoped key, returns the full secret ONCE, and authenticates the SDK", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await setupProject(owner.token);

    const createRes = await request()
      .post(`/api/projects/${projectId}/keys`)
      .set("Authorization", bearer(owner.token))
      .send({ name: "Production web" });
    expect(createRes.status).toBe(201);
    const fullKey = createRes.body.data.key as string;
    expect(fullKey).toMatch(/^bjs_[0-9a-f]{48}$/);
    expect(createRes.body.data.note).toMatch(/not be shown again/i);
    expect(createRes.body.data.readOnly).toBe(true);

    // The scoped key works on the SDK read path.
    const sdkRes = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", fullKey);
    expect(sdkRes.status).toBe(200);
    expect(sdkRes.body.data.greeting).toBe("नमस्ते");
  });

  it("lists keys MASKED — never the raw secret", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await setupProject(owner.token);

    const createRes = await request()
      .post(`/api/projects/${projectId}/keys`)
      .set("Authorization", bearer(owner.token))
      .send({ name: "CI" });
    const fullKey = createRes.body.data.key as string;

    const listRes = await request()
      .get(`/api/projects/${projectId}/keys`)
      .set("Authorization", bearer(owner.token));
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);
    expect(listRes.body.data).toHaveLength(1);

    const item = listRes.body.data[0];
    expect(item.name).toBe("CI");
    expect(item.revoked).toBe(false);
    expect(item.maskedKey).toMatch(/^bjs_.+….+$/);
    // The raw secret must never appear in the list response.
    expect(item.key).toBeUndefined();
    expect(JSON.stringify(listRes.body)).not.toContain(fullKey);
  });

  it("rejects a revoked key on the SDK (401)", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await setupProject(owner.token);

    const createRes = await request()
      .post(`/api/projects/${projectId}/keys`)
      .set("Authorization", bearer(owner.token))
      .send({ name: "Throwaway" });
    const keyId = createRes.body.data.id;
    const fullKey = createRes.body.data.key as string;

    // Works before revoke.
    const before = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", fullKey);
    expect(before.status).toBe(200);

    const revokeRes = await request()
      .post(`/api/projects/${projectId}/keys/${keyId}/revoke`)
      .set("Authorization", bearer(owner.token));
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.data.revoked).toBe(true);

    // Rejected after revoke (no legacy field matches a scoped secret).
    const after = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", fullKey);
    expect(after.status).toBe(401);
  });

  it("enforces the origin allowlist (wrong Origin → 403, right Origin → 200)", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await setupProject(owner.token);

    const createRes = await request()
      .post(`/api/projects/${projectId}/keys`)
      .set("Authorization", bearer(owner.token))
      // Mix a bare host and a full URL to exercise normalization.
      .send({ name: "Scoped", allowedOrigins: ["app.example.com", "https://www.example.com"] });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.allowedOrigins).toEqual(["app.example.com", "www.example.com"]);
    const fullKey = createRes.body.data.key as string;

    // Wrong origin → 403.
    const wrong = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", fullKey)
      .set("Origin", "https://evil.example.org");
    expect(wrong.status).toBe(403);

    // No origin at all (server-to-server) → 403 for a scoped key.
    const none = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", fullKey);
    expect(none.status).toBe(403);

    // Right origin → 200.
    const right = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", fullKey)
      .set("Origin", "https://app.example.com");
    expect(right.status).toBe(200);
    expect(right.body.data.greeting).toBe("नमस्ते");
  });

  it("keeps the LEGACY Project.apiKey working (back-compat fallback)", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { legacyKey } = await setupProject(owner.token);

    // No scoped key exists — the legacy single key must still resolve.
    const res = await request()
      .get("/api/sdk/translations?lang=hi")
      .set("x-api-key", legacyKey);
    expect(res.status).toBe(200);
    expect(res.body.data.greeting).toBe("नमस्ते");
  });

  it("does not let a non-owner manage keys (403)", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const stranger = await registerUser({ email: "stranger@example.com" });
    const { projectId } = await setupProject(owner.token);

    const res = await request()
      .post(`/api/projects/${projectId}/keys`)
      .set("Authorization", bearer(stranger.token))
      .send({ name: "Sneaky" });
    expect(res.status).toBe(403);
  });

  it("scopes revoke to the owning project (cross-project keyId → 404)", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId: projectA } = await setupProject(owner.token);
    const { projectId: projectB } = await setupProject(owner.token);

    const createRes = await request()
      .post(`/api/projects/${projectA}/keys`)
      .set("Authorization", bearer(owner.token))
      .send({ name: "A key" });
    const keyId = createRes.body.data.id;

    // Trying to revoke project A's key via project B's path → not found.
    const res = await request()
      .post(`/api/projects/${projectB}/keys/${keyId}/revoke`)
      .set("Authorization", bearer(owner.token));
    expect(res.status).toBe(404);
  });
});
