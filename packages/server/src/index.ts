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
import { migrateRegisters } from "./utils/migrateRegisters";

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

const app = express();

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

    // Run one-time migrations (idempotent)
    await migrateOwnerMemberships();
    await migrateRegisters();

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
