/**
 * Integration — Auth + token revocation (Phase 4).
 *
 * Validates:
 *   - register issues a working token (protected route returns 200)
 *   - a tampered token is rejected (401)
 *   - logout-all bumps tokenVersion → the same token is revoked (401)
 *   - deleting the user doc locks out any previously-issued token (401)
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import User from "../../models/User";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

describe("auth + revocation", () => {
  useIntegrationServer();

  it("register returns 201 + token, and the token works on a protected route", async () => {
    const res = await request()
      .post("/api/auth/register")
      .send({ name: "Alice", email: "alice@example.com", password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.token).toBe("string");

    const token = res.body.data.token;
    const protectedRes = await request().get("/api/projects").set("Authorization", bearer(token));
    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body.success).toBe(true);
  });

  it("rejects a garbage / tampered token with 401", async () => {
    const { token } = await registerUser();

    // Flip the last char of the signature so the JWT signature no longer verifies.
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");

    const garbageRes = await request()
      .get("/api/projects")
      .set("Authorization", bearer("not.a.jwt"));
    expect(garbageRes.status).toBe(401);

    const tamperedRes = await request()
      .get("/api/projects")
      .set("Authorization", bearer(tampered));
    expect(tamperedRes.status).toBe(401);
  });

  it("logout revokes the token (tokenVersion bump) — same token then 401", async () => {
    const { token } = await registerUser();

    // Token works before logout.
    const before = await request().get("/api/projects").set("Authorization", bearer(token));
    expect(before.status).toBe(200);

    const logout = await request().post("/api/auth/logout").set("Authorization", bearer(token));
    expect(logout.status).toBe(200);

    // Same token after logout → revoked.
    const after = await request().get("/api/projects").set("Authorization", bearer(token));
    expect(after.status).toBe(401);
  });

  it("deleting the user doc locks out a previously-issued token with 401", async () => {
    const { token, userId } = await registerUser();

    const before = await request().get("/api/projects").set("Authorization", bearer(token));
    expect(before.status).toBe(200);

    // Hard-delete the user directly (account closure / GDPR erasure).
    await User.deleteOne({ _id: new mongoose.Types.ObjectId(userId) });

    const after = await request().get("/api/projects").set("Authorization", bearer(token));
    expect(after.status).toBe(401);
  });
});
