import { describe, it, expect } from "vitest";
import Translation from "../../models/Translation";
import TranslationHistory from "../../models/TranslationHistory";
import { readValue } from "../../utils/registers";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

async function createProject(token: string) {
  const res = await request()
    .post("/api/projects")
    .set("Authorization", bearer(token))
    .send({ name: "PushTest", supportedLanguages: ["en", "hi"] });
  expect(res.status).toBe(201);
  return { projectId: res.body.data._id as string, legacyKey: res.body.data.apiKey as string };
}

async function createScopedKey(token: string, projectId: string, readOnly: boolean) {
  const res = await request()
    .post(`/api/projects/${projectId}/keys`)
    .set("Authorization", bearer(token))
    .send({ name: readOnly ? "read" : "write", readOnly });
  expect(res.status).toBe(201);
  return res.body.data.key as string;
}

describe("SDK push", () => {
  useIntegrationServer();

  it("write-key push creates and updates keys, with history attributed to the owner", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await createProject(owner.token);
    const key = await createScopedKey(owner.token, projectId, false);

    const create = await request()
      .post("/api/sdk/push")
      .set("x-api-key", key)
      .send({
        lang: "hi",
        translations: {
          "hero.title": "Namaste",
          "nav.home": "Home",
        },
      });
    expect(create.status).toBe(200);
    expect(create.body.data.created).toBe(2);
    expect(create.body.data.updated).toBe(0);

    const update = await request()
      .post("/api/sdk/push")
      .set("x-api-key", key)
      .send({ lang: "hi", translations: { "hero.title": "Namaste again" } });
    expect(update.status).toBe(200);
    expect(update.body.data.created).toBe(0);
    expect(update.body.data.updated).toBe(1);

    const row = await Translation.findOne({ projectId, key: "hero.title" });
    expect(row).toBeTruthy();
    expect(readValue(row!.translations as any, "hi", "default")).toBe("Namaste again");
    expect(readValue(row!.sources as any, "hi", "default")).toBe("human");

    const history = await TranslationHistory.findOne({
      projectId,
      key: "hero.title",
      newValue: "Namaste again",
    });
    expect(history).toBeTruthy();
    expect(String(history!.changedBy)).toBe(owner.userId);
  });

  it("rejects read-only scoped keys", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await createProject(owner.token);
    const key = await createScopedKey(owner.token, projectId, true);

    const res = await request()
      .post("/api/sdk/push")
      .set("x-api-key", key)
      .send({ lang: "hi", translations: { greeting: "Hello" } });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("This key cannot write. Create a scoped API key with read-only OFF.");
  });

  it("rejects legacy Project.apiKey", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { legacyKey } = await createProject(owner.token);

    const res = await request()
      .post("/api/sdk/push")
      .set("x-api-key", legacyKey)
      .send({ lang: "hi", translations: { greeting: "Hello" } });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("This key cannot write. Create a scoped API key with read-only OFF.");
  });

  it("skips regulated keys and leaves their values unchanged", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await createProject(owner.token);
    const key = await createScopedKey(owner.token, projectId, false);

    const regulated = await request()
      .post(`/api/translations/${projectId}`)
      .set("Authorization", bearer(owner.token))
      .send({
        key: "kfs.apr",
        translations: { hi: "Purana APR" },
        regulated: true,
        mandatedBy: "RBI Guidelines on Digital Lending, 2022 - Key Facts Statement",
      });
    expect(regulated.status).toBe(201);

    const res = await request()
      .post("/api/sdk/push")
      .set("x-api-key", key)
      .send({ lang: "hi", translations: { "kfs.apr": "Naya APR" } });

    expect(res.status).toBe(200);
    expect(res.body.data.skipped).toBe(1);
    expect(res.body.data.skippedRegulated).toEqual(["kfs.apr"]);
    expect(res.body.data.skippedKeys).toContain("kfs.apr");

    const row = await Translation.findOne({ projectId, key: "kfs.apr" });
    expect(readValue(row!.translations as any, "hi", "default")).toBe("Purana APR");
  });

  it("flattens nested payloads", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await createProject(owner.token);
    const key = await createScopedKey(owner.token, projectId, false);

    const res = await request()
      .post("/api/sdk/push")
      .set("x-api-key", key)
      .send({ lang: "hi", translations: { checkout: { title: "Checkout" } } });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    const row = await Translation.findOne({ projectId, key: "checkout.title" });
    expect(row).toBeTruthy();
    expect(readValue(row!.translations as any, "hi", "default")).toBe("Checkout");
  });

  it("rejects unsupported languages", async () => {
    const owner = await registerUser({ email: "owner@example.com" });
    const { projectId } = await createProject(owner.token);
    const key = await createScopedKey(owner.token, projectId, false);

    const res = await request()
      .post("/api/sdk/push")
      .set("x-api-key", key)
      .send({ lang: "ta", translations: { greeting: "Vanakkam" } });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('"ta" is not a supported language for this project');
  });
});
