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
 *
 * Prefer `reserveUsage` on the hot path — `wouldExceedCap` is a non-atomic
 * read kept for the dashboard/tests.
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

/**
 * Atomically RESERVE `count` keys against the monthly cap in a single DB op,
 * closing the check-then-record race (two concurrent requests can't both pass).
 * Returns true if it fit within the cap (and was applied), false if it would
 * exceed. A non-positive/invalid cap means "no cap" — always reserves. Voice
 * generation hits the same model bill, so it reserves against the SAME
 * keysTranslated budget (and bumps the voiceCalls metric when `voice`).
 */
export async function reserveUsage(
  projectId: string | mongoose.Types.ObjectId,
  cap: number,
  count: number,
  voice = false
): Promise<boolean> {
  const period = currentPeriod();
  const inc: Record<string, number> = { keysTranslated: count, aiCalls: 1 };
  if (voice) inc.voiceCalls = count;

  // Ensure the bucket exists so the conditional update below can match it.
  try {
    await AiUsage.updateOne(
      { projectId, period },
      { $setOnInsert: { keysTranslated: 0, voiceCalls: 0, aiCalls: 0, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
  }

  if (!Number.isFinite(cap) || cap <= 0) {
    await AiUsage.updateOne({ projectId, period }, { $inc: inc, $set: { updatedAt: new Date() } });
    return true;
  }
  // Conditional $inc: only applies if the new total still fits under the cap.
  const updated = await AiUsage.findOneAndUpdate(
    { projectId, period, keysTranslated: { $lte: cap - count } },
    { $inc: inc, $set: { updatedAt: new Date() } },
    { new: true }
  );
  return updated != null;
}

/** Refund a reservation for AI work that failed or was aborted. */
export async function refundUsage(
  projectId: string | mongoose.Types.ObjectId,
  count: number,
  voice = false
): Promise<void> {
  if (count <= 0) return;
  const inc: Record<string, number> = { keysTranslated: -count };
  if (voice) inc.voiceCalls = -count;
  await AiUsage.updateOne(
    { projectId, period: currentPeriod() },
    { $inc: inc, $set: { updatedAt: new Date() } }
  );
}
