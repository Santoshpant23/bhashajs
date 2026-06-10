import { describe, it, expect, vi } from "vitest";
import User from "../../models/User";
import { useIntegrationServer, request, registerUser, bearer } from "./setup";

async function requestResetToken(email: string): Promise<string> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  try {
    const res = await request().post("/api/auth/forgot-password").send({ email });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("If that account exists, a reset link has been sent.");

    const line = logs.find((entry) => entry.includes("/reset-password?token="));
    expect(line).toBeTruthy();
    const match = line!.match(/token=([0-9a-f]{64})/);
    expect(match).toBeTruthy();
    return match![1];
  } finally {
    logSpy.mockRestore();
  }
}

describe("password reset", () => {
  useIntegrationServer();

  it("forgot-password returns 200 for unknown email", async () => {
    const res = await request()
      .post("/api/auth/forgot-password")
      .send({ email: "missing@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("If that account exists, a reset link has been sent.");
  });

  it("runs the full reset flow and revokes old JWTs", async () => {
    const user = await registerUser({ email: "reset@example.com", password: "oldpass123" });
    const rawToken = await requestResetToken(user.email);

    const dbUserBefore = await User.findOne({ email: user.email });
    expect(dbUserBefore).toBeTruthy();
    expect((dbUserBefore as any).resetTokenHash).toBeTruthy();
    expect((dbUserBefore as any).resetTokenHash).not.toBe(rawToken);

    const reset = await request()
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "newpass123" });
    expect(reset.status).toBe(200);

    const oldJwt = await request().get("/api/projects").set("Authorization", bearer(user.token));
    expect(oldJwt.status).toBe(401);

    const login = await request()
      .post("/api/auth/login")
      .send({ email: user.email, password: "newpass123" });
    expect(login.status).toBe(200);
    expect(login.body.data.token).toBeTruthy();
  });

  it("rejects expired reset tokens", async () => {
    const user = await registerUser({ email: "expired@example.com" });
    const rawToken = await requestResetToken(user.email);

    await User.updateOne(
      { email: user.email },
      { $set: { resetTokenExpiresAt: new Date(Date.now() - 1000) } }
    );

    const reset = await request()
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "newpass123" });
    expect(reset.status).toBe(400);
    expect(reset.body.message).toBe("Invalid or expired reset link");
  });

  it("rejects token reuse after a successful reset", async () => {
    const user = await registerUser({ email: "reuse@example.com" });
    const rawToken = await requestResetToken(user.email);

    const first = await request()
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "newpass123" });
    expect(first.status).toBe(200);

    const second = await request()
      .post("/api/auth/reset-password")
      .send({ token: rawToken, password: "another123" });
    expect(second.status).toBe(400);
    expect(second.body.message).toBe("Invalid or expired reset link");
  });
});
