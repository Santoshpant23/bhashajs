/**
 * BhashaJS Server — Entry Point
 *
 * Connects to MongoDB, sets up middleware, mounts routes,
 * and starts the Express server.
 */

import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth";
import projectRoutes from "./routes/projects";
import translationRoutes from "./routes/translations";
import teamRoutes from "./routes/team";
import notificationRoutes from "./routes/notifications";
import commentRoutes from "./routes/comments";
import glossaryRoutes from "./routes/glossary";
import apiKeyRoutes from "./routes/apiKeys";
import sdkRoutes from "./routes/sdk";
import sandboxRoutes, { cleanupExpiredSandboxes } from "./routes/sandbox";
import packRoutes from "./routes/packs";
import complianceRoutes from "./routes/compliance";
import { migrateRegisters } from "./utils/migrateRegisters";
import { seedVerticalPacks } from "./utils/seedPacks";

dotenv.config();

// ─── Env validation ─────────────────────────────────────────
// Runs from start(), NOT on import — so tests can `createApp()` against an
// in-memory DB without the real server's process.exit guards firing.
function validateEnv() {
  const REQUIRED_ENV = ["JWT_SECRET", "MONGO_CONNECTION_URL"];
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      console.error(`FATAL: Missing required environment variable: ${key}`);
      console.error("Copy .env.example to .env and fill in your values.");
      process.exit(1);
    }
  }

  // JWT secret strength. A present-but-weak secret (e.g. the dev placeholder
  // "something-todo") passes the presence check above and boots clean, leaving
  // every user's token trivially forgeable. Refuse to start on a weak secret.
  const jwtSecret = process.env.JWT_SECRET || "";
  const WEAK_JWT_SECRETS = new Set(["something-todo", "changeme", "secret", "jwt_secret", "your-secret-here"]);
  // The .env.example placeholder is >32 chars and not in the set above, so it
  // would otherwise pass — reject any placeholder-looking secret too, so copying
  // .env.example can't boot with a publicly-known signing key.
  const PLACEHOLDER_RE = /replace|placeholder|example|changeme|your-secret|openssl|rand-hex|xxxx/i;
  if (
    jwtSecret.length < 32 ||
    WEAK_JWT_SECRETS.has(jwtSecret.toLowerCase()) ||
    PLACEHOLDER_RE.test(jwtSecret)
  ) {
    console.error(
      "FATAL: JWT_SECRET is weak or still the placeholder. Use at least 32 random characters.\n" +
      "Generate one with:  openssl rand -hex 32"
    );
    process.exit(1);
  }

  // AI translation is optional at boot but the dashboard's AI/voice endpoints
  // fail at call time without a key — warn loudly rather than crash.
  if (!process.env.GEMINI_API_KEY && String(process.env.GEMINI_USE_VERTEX).toLowerCase() !== "true") {
    console.warn(
      "[BhashaJS] No AI credentials set — AI translation and voice generation will fail until configured."
    );
  }
}

// ─── App factory ────────────────────────────────────────────
// Builds the Express app (middleware + routes + error handler) WITHOUT
// connecting to Mongo or listening — so integration tests can drive it with
// supertest against mongodb-memory-server. start() wires up the bootstrap.
export function createApp() {
  const app = express();

// Trust the first proxy hop (nginx / Vercel / Railway) so req.ip and
// express-rate-limit resolve the real client IP. Without this, behind a proxy
// every request shares one bucket, so a single attacker can exhaust the auth
// or AI rate limit and lock out / block every tenant.
app.set("trust proxy", 1);

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));

// CORS — accept a comma-separated allowlist, or "*" for any origin.
// In production set CORS_ORIGIN="https://bhashajs.com,https://app.bhashajs.com".
//
// `Access-Control-Allow-Origin: *` combined with `Allow-Credentials: true` is an
// INVALID combination the browser rejects. The app authenticates with HEADERS
// (the SDK's x-api-key, the dashboard's Authorization: Bearer) — never cookies —
// so credentials aren't needed. We therefore only enable `credentials` when an
// explicit origin allowlist is configured; the wildcard is served WITHOUT
// credentials so it stays valid.
const rawOrigin = (process.env.CORS_ORIGIN || "*").trim();
if (rawOrigin === "*") {
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[BhashaJS] CORS_ORIGIN is not set — allowing all origins without credentials. " +
      "Set CORS_ORIGIN to your dashboard/site origins in production."
    );
  }
  app.use(cors({ origin: "*", credentials: false }));
} else {
  const allowedOrigins = rawOrigin.split(",").map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: allowedOrigins, credentials: true }));
}
app.use(helmet());

// Lightweight structured request log (one JSON line per request on finish).
// Skips the health endpoint so uptime pings don't drown the logs.
app.use((req, res, next) => {
  if (req.path === "/api/health") return next();
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      })
    );
  });
  next();
});

// ─── Rate Limiting ───────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests, please try again later" },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many auth attempts, please try again later" },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "AI translation rate limit reached, please wait a moment" },
});

// Tighter cap on expensive/abusable writes that otherwise sat only under the
// generic 1000/15min limiter: bulk import (large payloads + history inserts),
// team invites (email fan-out / mail-reputation), and project creation.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many write requests, please slow down" },
});

// The public, no-signup sandbox mint (POST /api/sandbox) creates real DB docs
// (a project + ~8 translations + a key) with no auth, so it's the most abusable
// endpoint on the server. Cap it hard: 5 sandboxes per hour per IP. A genuine
// developer trying the SDK needs one; a script trying to flood the DB is
// stopped at five. Mounted ONLY on this route.
const sandboxLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Sandbox creation limit reached — please try again later" },
});

app.use("/api", generalLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/translations/:projectId/ai-translate", aiLimiter);
// generate-voice also calls Gemini per request — cap it on the same bucket so
// neither AI endpoint can be used to run up the model bill.
app.use("/api/translations/:projectId/generate-voice", aiLimiter);
app.use("/api/translations/:projectId/bulk", writeLimiter);
app.use("/api/projects/:projectId/team/invite", writeLimiter);
// Project creation is POST /api/projects — throttle it without touching the
// GET list on the same path.
app.use("/api/projects", (req, res, next) =>
  req.method === "POST" ? writeLimiter(req, res, next) : next()
);

// ─── Health check (before auth routes) ──────────────────────
// Reflects real readiness (Mongo connectivity) so uptime monitors and the
// Docker HEALTHCHECK detect a degraded server instead of a hardcoded "ok".
app.get("/api/health", (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({
    success: dbConnected,
    data: { status: dbConnected ? "ok" : "degraded", db: dbConnected ? "connected" : "disconnected" },
  });
});

// ─── Public SDK routes (API key auth, no JWT) ───────────────
app.use("/api/sdk", sdkRoutes);

// ─── Public sandbox mint (NO auth) ──────────────────────────
// Heavily rate-limited (sandboxLimiter, 5/hour/IP) since it creates real DB
// docs without authentication. Lets a developer (or the /demo page) try the
// SDK with a working bjs_ key + sample translations without signing up.
app.use("/api/sandbox", sandboxLimiter, sandboxRoutes);

// ─── Routes (JWT auth) ──────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/translations", translationRoutes);
app.use("/api", teamRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/translations", commentRoutes);
app.use("/api/projects/:projectId/glossary", glossaryRoutes);
app.use("/api/projects/:projectId/compliance", complianceRoutes);
app.use("/api/projects/:projectId/keys", apiKeyRoutes);
app.use("/api", packRoutes);

// ─── Global error handler ───────────────────────────────────
// Catch-all so a malformed JSON body or an error that escapes a route returns
// the { success, message } contract instead of Express's default HTML page.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const badJson = err?.type === "entity.parse.failed";
  // Real errors are logged here. This is also the single hook to add an error
  // tracker (e.g. Sentry.captureException(err)) when one is wired up.
  if (!badJson) console.error("[BhashaJS] unhandled route error:", err?.message || err);
  res.status(badJson ? 400 : 500).json({
    success: false,
    message: badJson ? "Invalid JSON body" : "Internal server error",
  });
});

  return app;
}

// ─── Migration: Ensure existing projects have owner membership ──
async function migrateOwnerMemberships() {
  const Project = (await import("./models/Project")).default;
  const ProjectMember = (await import("./models/ProjectMember")).default;
  const User = (await import("./models/User")).default;

  const projects = await Project.find();
  let migrated = 0;

  for (const p of projects) {
    const existing = await ProjectMember.findOne({
      projectId: p._id,
      role: "owner",
    });
    if (!existing) {
      const user = await User.findById(p.owner);
      if (user) {
        await ProjectMember.create({
          projectId: p._id,
          userId: p.owner,
          email: user.email,
          role: "owner",
          status: "active",
        });
        migrated++;
      }
    }
  }

  if (migrated > 0) {
    console.log(`[Migration] Created ${migrated} owner membership(s) for existing projects`);
  }
}

// ─── Start ───────────────────────────────────────────────────
async function start() {
  try {
    validateEnv();
    await mongoose.connect(process.env.MONGO_CONNECTION_URL || "");
    console.log("MongoDB connected successfully");

    // Run one-time migrations, gated by a stored version so the full-collection
    // scans don't run on every restart once they've completed.
    const Meta = (await import("./models/Meta")).default;
    const MIGRATION_VERSION = 1;
    const metaDoc = await Meta.findOne({ key: "migrationVersion" });
    const ranVersion = typeof metaDoc?.value === "number" ? metaDoc.value : 0;
    if (ranVersion < MIGRATION_VERSION) {
      // Migrations mutate prod data (full-collection scans, index changes), so
      // they only run when explicitly opted in — a deploy must not auto-apply a
      // new migration unattended against an unbacked-up database.
      if (process.env.RUN_MIGRATIONS === "true") {
        console.log(`[Migration] running migrations (have v${ranVersion}, want v${MIGRATION_VERSION})`);
        await migrateOwnerMemberships();
        await migrateRegisters();
        await Meta.findOneAndUpdate(
          { key: "migrationVersion" },
          { value: MIGRATION_VERSION, updatedAt: new Date() },
          { upsert: true }
        );
      } else {
        console.warn(
          `[Migration] PENDING (have v${ranVersion}, want v${MIGRATION_VERSION}) but RUN_MIGRATIONS!=true — skipping. ` +
            `Back up the DB, then set RUN_MIGRATIONS=true for one boot to apply.`
        );
      }
    }
    // Seeding vertical packs is small and idempotent — safe to run each boot.
    await seedVerticalPacks();

    // Sweep expired sandbox projects (24h TTL) at boot AND hourly thereafter,
    // so they don't accumulate on a long-running server (the demo's instant-key
    // path mints them with no auth). App-level cascade — a Mongo TTL index would
    // drop the project but NOT its Translations/ApiKeys. Best-effort: a failed
    // sweep never blocks boot or crashes the loop.
    const sweepSandboxes = async () => {
      try {
        const removed = await cleanupExpiredSandboxes();
        if (removed > 0) {
          console.log(`[Sandbox] Cleaned up ${removed} expired sandbox project(s)`);
        }
      } catch (e) {
        console.error("[Sandbox] Failed to clean up expired sandboxes:", e);
      }
    };
    await sweepSandboxes();
    const SANDBOX_SWEEP_MS = 60 * 60 * 1000; // hourly
    setInterval(sweepSandboxes, SANDBOX_SWEEP_MS).unref();

    const app = createApp();
    const port = process.env.PORT || 5000;
    app.listen(port, () => {
      console.log(`BhashaJS server running on port ${port}`);
    });
  } catch (e) {
    console.log("Failed to start server:", e);
    process.exit(1);
  }
}

// Only the real entrypoint registers crash handlers, connects, and listens.
// Importing this module (e.g. tests using createApp) must do none of that.
if (require.main === module) {
  // Don't let an unhandled async error silently kill (or zombie) the process.
  process.on("unhandledRejection", (reason) => {
    console.error("[BhashaJS] unhandledRejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[BhashaJS] uncaughtException:", err);
    // The process is in an undefined state — exit and let the container restart
    // policy bring up a clean one.
    process.exit(1);
  });

  start();
}
