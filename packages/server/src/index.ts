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
import sdkRoutes from "./routes/sdk";
import packRoutes from "./routes/packs";
import { migrateRegisters } from "./utils/migrateRegisters";
import { seedVerticalPacks } from "./utils/seedPacks";

dotenv.config();

// ─── Validate required env vars ─────────────────────────────
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
if (jwtSecret.length < 32 || WEAK_JWT_SECRETS.has(jwtSecret.toLowerCase())) {
  console.error(
    "FATAL: JWT_SECRET is too weak. Use at least 32 random characters.\n" +
    "Generate one with:  openssl rand -hex 32"
  );
  process.exit(1);
}

// AI translation is optional at boot but the dashboard's AI/voice endpoints
// fail at call time without a key — warn loudly rather than crash.
if (!process.env.GEMINI_API_KEY) {
  console.warn(
    "[BhashaJS] GEMINI_API_KEY is not set — AI translation and voice generation will fail until it is."
  );
}

const app = express();

// Trust the first proxy hop (nginx / Vercel / Railway) so req.ip and
// express-rate-limit resolve the real client IP. Without this, behind a proxy
// every request shares one bucket, so a single attacker can exhaust the auth
// or AI rate limit and lock out / block every tenant.
app.set("trust proxy", 1);

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));

// CORS — accept a comma-separated list, or "*" for any origin.
// In production set CORS_ORIGIN="https://bhashajs.com,https://app.bhashajs.com"
const rawOrigin = process.env.CORS_ORIGIN || "*";
const allowedOrigins = rawOrigin === "*"
  ? "*"
  : rawOrigin.split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(helmet());

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

app.use("/api", generalLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/translations/:projectId/ai-translate", aiLimiter);
// generate-voice also calls Gemini per request — cap it on the same bucket so
// neither AI endpoint can be used to run up the model bill.
app.use("/api/translations/:projectId/generate-voice", aiLimiter);

// ─── Health check (before auth routes) ──────────────────────
app.get("/api/health", (req, res) => {
  res.json({ success: true, data: { status: "ok" } });
});

// ─── Public SDK routes (API key auth, no JWT) ───────────────
app.use("/api/sdk", sdkRoutes);

// ─── Routes (JWT auth) ──────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/translations", translationRoutes);
app.use("/api", teamRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/translations", commentRoutes);
app.use("/api/projects/:projectId/glossary", glossaryRoutes);
app.use("/api", packRoutes);

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
    await mongoose.connect(process.env.MONGO_CONNECTION_URL || "");
    console.log("MongoDB connected successfully");

    // Run one-time migrations, gated by a stored version so the full-collection
    // scans don't run on every restart once they've completed.
    const Meta = (await import("./models/Meta")).default;
    const MIGRATION_VERSION = 1;
    const metaDoc = await Meta.findOne({ key: "migrationVersion" });
    const ranVersion = typeof metaDoc?.value === "number" ? metaDoc.value : 0;
    if (ranVersion < MIGRATION_VERSION) {
      console.log(`[Migration] running migrations (have v${ranVersion}, want v${MIGRATION_VERSION})`);
      await migrateOwnerMemberships();
      await migrateRegisters();
      await Meta.findOneAndUpdate(
        { key: "migrationVersion" },
        { value: MIGRATION_VERSION, updatedAt: new Date() },
        { upsert: true }
      );
    }
    // Seeding vertical packs is small and idempotent — safe to run each boot.
    await seedVerticalPacks();

    const port = process.env.PORT || 5000;
    app.listen(port, () => {
      console.log(`BhashaJS server running on port ${port}`);
    });
  } catch (e) {
    console.log("Failed to start server:", e);
    process.exit(1);
  }
}

start();
