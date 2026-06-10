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
import UsageCounter from "../models/UsageCounter";

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
  // Retry transient conflicts so concurrent recorders never lose an increment:
  //   E11000 (11000)     — two first-of-month upserts race the unique index;
  //   WriteConflict (112) — concurrent $inc on the same bucket on a replica set.
  // The $inc is idempotent-safe to retry (it applies exactly once per success).
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await AiUsage.updateOne(filter, update, { upsert: true });
      return;
    } catch (e: any) {
      if ((e?.code === 11000 || e?.code === 112) && attempt < 5) continue;
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
  voice = false,
  period: string = currentPeriod()
): Promise<boolean> {
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
    { returnDocument: "after" }
  );
  return updated != null;
}

/**
 * Refund a reservation for AI work that failed or was aborted. Defaults to the
 * current period, but the routes pass the period the reservation was MADE in so
 * a request that crosses the UTC month boundary refunds the right bucket.
 */
export async function refundUsage(
  projectId: string | mongoose.Types.ObjectId,
  count: number,
  voice = false,
  period: string = currentPeriod()
): Promise<void> {
  if (count <= 0) return;
  const inc: Record<string, number> = { keysTranslated: -count };
  if (voice) inc.voiceCalls = -count;
  await AiUsage.updateOne(
    { projectId, period },
    { $inc: inc, $set: { updatedAt: new Date() } }
  );
}

// ─── Wider AI-cost guardrails (per-account + global ceiling) ─────────────────
// The per-project cap above protects against ONE project running up the bill,
// but a user can spin up many projects (and many users exist), so the hosted
// "forever free" service needs two more layers, both env-tunable:
//   - per-ACCOUNT  : AI_ACCOUNT_MONTHLY_CAP — one owner's total across all their
//                    projects (default 5000). Stops the multi-project multiplier.
//   - GLOBAL       : AI_GLOBAL_MONTHLY_CAP — instance-wide ceiling on AI KEYS
//                    service-wide (default 100000): the kill-switch. Keys are the
//                    primary cost driver and, with the per-cell text limits in
//                    models/Translation.ts (MAX_CELL_TEXT_LEN), each key's token
//                    cost is bounded — so this keeps the monthly bill in a
//                    predictable range. It is a key-count ceiling, NOT an exact
//                    dollar guarantee (a provider retry can re-bill a batch).
// Set either to 0 to DISABLE it (e.g. self-hosting with your own key = unlimited).

export type BlockedScope = "project" | "account" | "global";
export interface ReserveResult {
  ok: boolean;
  blockedScope: BlockedScope | null;
}

/** Read an env-configured cap. Unset → fallback (caps ON by default); 0/neg = disabled. */
function envCap(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
function accountCap(): number {
  return envCap("AI_ACCOUNT_MONTHLY_CAP", 5000);
}
function globalCap(): number {
  return envCap("AI_GLOBAL_MONTHLY_CAP", 100000);
}

/**
 * Atomically reserve `count` against a UsageCounter scope's cap — same
 * conditional-$inc-upsert pattern as reserveUsage, but for the wider scopes.
 * A non-positive cap means "disabled" — always reserves.
 */
async function reserveCounter(
  scope: string,
  cap: number,
  count: number,
  period: string
): Promise<boolean> {
  // Ensure the bucket exists so the conditional update can match it.
  try {
    await UsageCounter.updateOne(
      { scope, period },
      { $setOnInsert: { keysTranslated: 0, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    await UsageCounter.updateOne(
      { scope, period },
      { $inc: { keysTranslated: count }, $set: { updatedAt: new Date() } }
    );
    return true;
  }
  const updated = await UsageCounter.findOneAndUpdate(
    { scope, period, keysTranslated: { $lte: cap - count } },
    { $inc: { keysTranslated: count }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return updated != null;
}

/** Undo a UsageCounter reservation (failed/aborted AI work). */
async function refundCounter(scope: string, count: number, period: string): Promise<void> {
  if (count <= 0) return;
  await UsageCounter.updateOne(
    { scope, period },
    { $inc: { keysTranslated: -count }, $set: { updatedAt: new Date() } }
  );
}

/**
 * Reserve `count` AI keys against ALL THREE scopes (project → account → global)
 * for one request. If a later scope is over its cap, the earlier reservations
 * are refunded and `blockedScope` says which limit was hit, so the route can
 * send a precise 429. The per-scope $lte checks guarantee no scope is exceeded;
 * a partial-failure refund keeps the buckets consistent. Voice and translate
 * share the budget (both bill the model). `ownerId` may be undefined for
 * ownerless projects (which can't reach AI anyway) — the account scope is then
 * skipped.
 */
export async function reserveAiBudget(
  projectId: string | mongoose.Types.ObjectId,
  ownerId: string | mongoose.Types.ObjectId | null | undefined,
  projectCap: number,
  count: number,
  voice = false,
  period: string = currentPeriod()
): Promise<ReserveResult> {
  // 1. Per-project (existing AiUsage meter — also bumps aiCalls/voiceCalls).
  if (!(await reserveUsage(projectId, projectCap, count, voice, period))) {
    return { ok: false, blockedScope: "project" };
  }

  // 2. Per-account.
  const acctCap = accountCap();
  const acctScope = ownerId ? `acct:${ownerId}` : null;
  if (acctScope && acctCap > 0) {
    if (!(await reserveCounter(acctScope, acctCap, count, period))) {
      await refundUsage(projectId, count, voice, period);
      return { ok: false, blockedScope: "account" };
    }
  }

  // 3. Global ceiling (the kill-switch).
  const gCap = globalCap();
  if (gCap > 0) {
    if (!(await reserveCounter("global", gCap, count, period))) {
      if (acctScope && acctCap > 0) await refundCounter(acctScope, count, period);
      await refundUsage(projectId, count, voice, period);
      return { ok: false, blockedScope: "global" };
    }
  }

  return { ok: true, blockedScope: null };
}

/** Refund an AI reservation across all three scopes (unused/aborted/failed keys). */
export async function refundAiBudget(
  projectId: string | mongoose.Types.ObjectId,
  ownerId: string | mongoose.Types.ObjectId | null | undefined,
  count: number,
  voice = false,
  period: string = currentPeriod()
): Promise<void> {
  if (count <= 0) return;
  await refundUsage(projectId, count, voice, period);
  if (ownerId && accountCap() > 0) await refundCounter(`acct:${ownerId}`, count, period);
  if (globalCap() > 0) await refundCounter("global", count, period);
}

/** Human-facing 429 message for the scope that blocked an AI reservation. */
export function aiCapMessage(scope: BlockedScope | null, projectCap: number): string {
  switch (scope) {
    case "account":
      return "You've reached your monthly free AI translation limit. It resets next month — or self-host for unlimited AI on your own key.";
    case "global":
      return "AI translation is temporarily paused — the service-wide monthly limit was reached. It resets next month; your existing translations keep serving.";
    case "project":
    default:
      return `Monthly AI translation cap reached for this project (${projectCap} keys). Resets next month.`;
  }
}
