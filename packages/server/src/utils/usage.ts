/**
 * AI Usage Metering Helpers
 *
 * Thin wrapper around the AiUsage model. The route layer uses these to:
 *   - read the current period's usage (dashboard + cap display),
 *   - record usage atomically after a successful AI call,
 *   - decide whether a pending call would blow the monthly cap.
 *
 * The "period" is a UTC "YYYY-MM" string. Buckets reset implicitly at the
 * month boundary — a new month simply has no document yet, so usage reads 0.
 */

import mongoose from "mongoose";
import AiUsage from "../models/AiUsage";

export interface UsageCounts {
  keysTranslated: number;
  voiceCalls: number;
  aiCalls: number;
}

/** Current UTC period as "YYYY-MM" (e.g. "2026-06"). */
export function currentPeriod(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Read the current period's usage for a project. Returns all-zeros when no
 * AI work has been recorded this month (no document yet).
 */
export async function getUsage(
  projectId: string | mongoose.Types.ObjectId
): Promise<UsageCounts> {
  const doc = await AiUsage.findOne({ projectId, period: currentPeriod() });
  return {
    keysTranslated: doc?.keysTranslated || 0,
    voiceCalls: doc?.voiceCalls || 0,
    aiCalls: doc?.aiCalls || 0,
  };
}

/**
 * Atomically increment this month's counters for a project. Uses an $inc
 * upsert keyed on { projectId, period } so concurrent AI calls never lose a
 * count and the first call this month creates the bucket. No-op when nothing
 * to add (all deltas zero/absent).
 */
export async function recordUsage(
  projectId: string | mongoose.Types.ObjectId,
  deltas: { keys?: number; voice?: number; calls?: number }
): Promise<void> {
  const inc: Record<string, number> = {};
  if (deltas.keys) inc.keysTranslated = deltas.keys;
  if (deltas.voice) inc.voiceCalls = deltas.voice;
  if (deltas.calls) inc.aiCalls = deltas.calls;
  if (Object.keys(inc).length === 0) return;

  const filter = { projectId, period: currentPeriod() };
  const update = { $inc: inc, $set: { updatedAt: new Date() } };
  try {
    await AiUsage.updateOne(filter, update, { upsert: true });
  } catch (e: any) {
    // Two concurrent first-of-month upserts can race the unique
    // { projectId, period } index — the loser throws E11000. The bucket now
    // exists, so a single retry (a plain $inc, no upsert) always succeeds.
    if (e?.code === 11000) {
      await AiUsage.updateOne(filter, update);
    } else {
      throw e;
    }
  }
}

/**
 * Would translating `additionalKeys` more keys push this project over its
 * monthly cap? Compares current keysTranslated + additionalKeys against `cap`.
 * A non-positive/invalid cap is treated as "no cap" (never exceeds).
 */
export async function wouldExceedCap(
  projectId: string | mongoose.Types.ObjectId,
  cap: number,
  additionalKeys: number
): Promise<boolean> {
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const { keysTranslated } = await getUsage(projectId);
  return keysTranslated + additionalKeys > cap;
}
