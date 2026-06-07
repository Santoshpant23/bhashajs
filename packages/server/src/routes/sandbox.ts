/**
 * Public Sandbox Route — instant, no-signup "try the SDK" key.
 *
 * POST /api/sandbox   (NO auth, heavily rate-limited — see sandboxLimiter in
 *                      index.ts: 5/hour/IP)
 *
 * Mints an ephemeral, ownerless Project pre-seeded with realistic sample
 * translations across en/hi/bn/ur/ta and a read-only scoped ApiKey, then
 * returns `{ projectKey, projectId, sampleKeys, expiresAt }`. A developer (or
 * the /demo page) can drive the SDK with this key immediately — closing the
 * activation funnel.
 *
 * The project is flagged `isSandbox: true` and `expiresAt: now + 24h`.
 * cleanupExpiredSandboxes() (called from start()) sweeps expired ones plus
 * their dependents via the same withTransactionOrFallback cascade the
 * project-delete route uses, so sandboxes never accumulate.
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import Project from "../models/Project";
import ApiKey, { generateApiKey } from "../models/ApiKey";
import Translation from "../models/Translation";
import TranslationMemory from "../models/TranslationMemory";
import TranslationHistory from "../models/TranslationHistory";
import Comment from "../models/Comment";
import GlossaryEntry from "../models/GlossaryEntry";
import Notification from "../models/Notification";
import ProjectMember from "../models/ProjectMember";
import { sendSuccess, sendError } from "../utils/response";
import { writeValue } from "../utils/registers";
import { withTransactionOrFallback } from "../utils/transaction";
import { DEFAULT_REGISTER } from "../utils/registers";

const router = Router();

/** A sandbox lives for 24 hours, then the cleanup sweep deletes it. */
const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;

const SANDBOX_LANGUAGES = ["en", "hi", "bn", "ur", "ta"];

/**
 * Realistic sample keys spanning the demo UI (nav, hero, cart, auth) plus an
 * interpolation key ({name}) and a plural pair (items_one/items_other). Values
 * are filled across en + hi + bn + ur + ta so a language switch in the demo
 * visibly changes everything. These are stamped "approved"/"human" below so the
 * SDK's compliance gate serves them.
 */
const SAMPLE_TRANSLATIONS: Record<string, Record<string, string>> = {
  "hero.title": {
    en: "Ship in every language",
    hi: "हर भाषा में लॉन्च करें",
    bn: "প্রতিটি ভাষায় চালু করুন",
    ur: "ہر زبان میں لانچ کریں",
    ta: "ஒவ்வொரு மொழியிலும் வெளியிடுங்கள்",
  },
  "hero.cta": {
    en: "Get started",
    hi: "शुरू करें",
    bn: "শুরু করুন",
    ur: "شروع کریں",
    ta: "தொடங்குங்கள்",
  },
  "cart.add": {
    en: "Add to cart",
    hi: "कार्ट में जोड़ें",
    bn: "কার্টে যোগ করুন",
    ur: "کارٹ میں شامل کریں",
    ta: "கூடையில் சேர்",
  },
  greeting: {
    en: "Welcome back, {name}!",
    hi: "वापसी पर स्वागत है, {name}!",
    bn: "আবার স্বাগতম, {name}!",
    ur: "واپسی پر خوش آمدید، {name}!",
    ta: "மீண்டும் வரவேற்கிறோம், {name}!",
  },
  items_one: {
    en: "{count} item",
    hi: "{count} वस्तु",
    bn: "{count}টি জিনিস",
    ur: "{count} چیز",
    ta: "{count} பொருள்",
  },
  items_other: {
    en: "{count} items",
    hi: "{count} वस्तुएँ",
    bn: "{count}টি জিনিস",
    ur: "{count} چیزیں",
    ta: "{count} பொருட்கள்",
  },
  "nav.home": {
    en: "Home",
    hi: "होम",
    bn: "হোম",
    ur: "ہوم",
    ta: "முகப்பு",
  },
  "auth.login": {
    en: "Log in",
    hi: "लॉग इन करें",
    bn: "লগ ইন করুন",
    ur: "لاگ ان کریں",
    ta: "உள்நுழைய",
  },
};

const SAMPLE_KEYS = Object.keys(SAMPLE_TRANSLATIONS);

/**
 * Sweep expired sandboxes and ALL their dependents. Run best-effort from
 * start() so old sandboxes don't pile up. Uses the same
 * children-before-parent cascade as the project-delete route (via
 * withTransactionOrFallback) so a partial failure never orphans documents.
 *
 * Returns the number of sandbox projects removed (for logging).
 */
export async function cleanupExpiredSandboxes(): Promise<number> {
  const now = new Date();
  const expired = await Project.find({
    isSandbox: true,
    expiresAt: { $ne: null, $lt: now },
  }).select("_id");

  if (expired.length === 0) return 0;

  const ids = expired.map((p) => p._id);

  await withTransactionOrFallback(async (session) => {
    // Children-before-parent — identical ordering to the project-delete route.
    await Translation.deleteMany({ projectId: { $in: ids } }, { session });
    await TranslationMemory.deleteMany({ projectId: { $in: ids } }, { session });
    await TranslationHistory.deleteMany({ projectId: { $in: ids } }, { session });
    await Comment.deleteMany({ projectId: { $in: ids } }, { session });
    await GlossaryEntry.deleteMany({ projectId: { $in: ids } }, { session });
    await Notification.deleteMany({ projectId: { $in: ids } }, { session });
    await ProjectMember.deleteMany({ projectId: { $in: ids } }, { session });
    await ApiKey.deleteMany({ projectId: { $in: ids } }, { session });
    await Project.deleteMany({ _id: { $in: ids } }, { session });
  });

  return ids.length;
}

// ─── CREATE A SANDBOX ────────────────────────────────────────
// No auth. Heavily rate-limited at the mount (sandboxLimiter in index.ts).
router.post("/", async (_req: Request, res: Response) => {
  let projectId: any = null;
  try {
    const shortId = crypto.randomBytes(3).toString("hex");
    const expiresAt = new Date(Date.now() + SANDBOX_TTL_MS);

    // 1) The ownerless, short-lived project. `owner` is left null — the schema
    // makes it optional precisely for this path (normal creation always sets it).
    const project = await Project.create({
      name: `Sandbox ${shortId}`,
      owner: null,
      supportedLanguages: SANDBOX_LANGUAGES,
      defaultLanguage: "en",
      isSandbox: true,
      expiresAt,
    });
    projectId = project._id;

    // 2) Pre-seed the sample keys. Build each doc's nested Maps with writeValue
    // (the only safe way to mutate Mongoose Map<Map<>> — see registers.ts).
    // English is the source language → "human"; the other locales are stamped
    // "approved" so the SDK compliance gate serves them on regulated-or-not rows.
    for (const key of SAMPLE_KEYS) {
      const doc = new Translation({ projectId, key });
      for (const [lang, value] of Object.entries(SAMPLE_TRANSLATIONS[key])) {
        const source = lang === "en" ? "human" : "approved";
        writeValue(doc, "translations", lang, DEFAULT_REGISTER, value);
        writeValue(doc, "sources", lang, DEFAULT_REGISTER, source);
      }
      doc.source = "human";
      await doc.save();
    }

    // 3) A read-only key with NO origin lock — it's a public sandbox, meant to
    // be tried from anywhere (curl, the /demo page, a developer's localhost).
    const apiKey = await ApiKey.create({
      projectId,
      key: generateApiKey(),
      name: "Sandbox key",
      readOnly: true,
      allowedOrigins: [],
    });

    return sendSuccess(res, 201, {
      projectKey: apiKey.key,
      projectId,
      sampleKeys: SAMPLE_KEYS,
      expiresAt,
    });
  } catch (e) {
    // Best-effort cleanup of a partial create so a mid-run failure doesn't
    // leave an orphaned project/translations. Whatever we miss, the periodic
    // cleanupExpiredSandboxes() sweep eventually reaps (it's flagged isSandbox
    // with a 24h expiry).
    if (projectId) {
      try {
        await Translation.deleteMany({ projectId });
        await ApiKey.deleteMany({ projectId });
        await Project.deleteOne({ _id: projectId });
      } catch {
        /* the periodic sweep will catch any remainder */
      }
    }
    return sendError(res, 500, "Failed to create sandbox");
  }
});

export default router;
