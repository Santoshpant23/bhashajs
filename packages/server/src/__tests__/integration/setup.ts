/**
 * Shared integration-test harness.
 *
 * Boots an in-memory MongoDB as a single-node REPLICA SET
 * (mongodb-memory-server's MongoMemoryReplSet), connects mongoose, and builds
 * the Express app via createApp() WITHOUT the real server's
 * listen()/process.exit guards.
 *
 * Why a replica set (not a standalone MongoMemoryServer)? Multi-document
 * transactions require a replica set; a standalone mongod cannot run them. The
 * production self-host stack now ships a 1-node RS (see docker-compose.yml), and
 * Atlas is always a replica set — so the tests must exercise the SAME real
 * transaction path the route's withTransactionOrFallback takes in prod, not the
 * standalone fallback. This is what makes the atomicity guarantee (the
 * translation write and its audit-history write commit or roll back together)
 * actually under test. The cascade-delete tests pass identically here —
 * transactions just commit instead of falling back to ordered non-session
 * writes.
 *
 * Each test file calls `useIntegrationServer()` at the top of its top-level
 * describe. That registers beforeAll/afterAll/afterEach hooks:
 *   - beforeAll: set env, boot mongo RS, connect, build app
 *   - afterEach: drop every collection so tests are independent
 *   - afterAll: disconnect + stop mongo
 *
 * `request()` returns a fresh supertest agent bound to the live app. The app
 * is built once per file in beforeAll, so call request() inside it()/beforeEach,
 * never at module load.
 */

import { beforeAll, afterAll, afterEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import supertest from "supertest";
import type { Express } from "express";
import { createApp } from "../../index";

let mongo: MongoMemoryReplSet | null = null;
let app: Express | null = null;

/** The live Express app — only valid after beforeAll has run. */
export function getApp(): Express {
  if (!app) throw new Error("App not initialized — call useIntegrationServer() in the describe block");
  return app;
}

/** A fresh supertest agent bound to the live app. */
export function request() {
  return supertest(getApp());
}

/**
 * Register the boot/teardown/cleanup lifecycle for an integration test file.
 * Call once near the top of the file's top-level describe block.
 */
export function useIntegrationServer() {
  beforeAll(async () => {
    // A real 40-char secret so index.ts's createApp() is happy and tokens
    // signed in tests verify with the exact same secret authMiddleware reads.
    process.env.JWT_SECRET = "test-jwt-secret-0123456789-abcdefghijklmnop";
    process.env.NODE_ENV = "test";
    // Short expiry is fine; default is 7d. Keep it explicit for determinism.
    process.env.JWT_EXPIRY = "1h";

    // 1-node replica set so multi-document transactions actually run (matches
    // prod: self-host RS + Atlas). `replSet.count: 1` keeps boot fast while
    // still giving mongod the oplog/replication machinery transactions need.
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    app = createApp();
  }, 120_000); // memory-server first-run can download/extract the binary — allow plenty of time.

  afterEach(async () => {
    // Wipe every collection between tests so each test starts from a clean DB.
    const collections = mongoose.connection.collections;
    for (const name of Object.keys(collections)) {
      await collections[name].deleteMany({});
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
    app = null;
    mongo = null;
  });
}

/**
 * Register a user via the real HTTP route and return its token + ids.
 * Most integration tests start from "an authenticated user", so this keeps
 * the per-test boilerplate down.
 */
export async function registerUser(
  overrides: { name?: string; email?: string; password?: string } = {}
): Promise<{ token: string; userId: string; email: string; password: string }> {
  const email = overrides.email ?? `user_${Math.random().toString(36).slice(2)}@example.com`;
  const password = overrides.password ?? "password123";
  const name = overrides.name ?? "Test User";

  const res = await request().post("/api/auth/register").send({ name, email, password });
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.data.token, userId: res.body.data.userId, email, password };
}

/** Authorization header value for a token. */
export function bearer(token: string): string {
  return `Bearer ${token}`;
}
