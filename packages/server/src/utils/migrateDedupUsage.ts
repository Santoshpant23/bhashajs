/**
 * Migration: collapse duplicate AI-usage buckets.
 *
 * The usage meters are keyed by a UNIQUE index — AiUsage on { projectId, period }
 * and UsageCounter on { scope, period } — which is what makes the $inc upserts in
 * utils/usage.ts race-safe (concurrent first-of-month writes collapse onto one
 * document instead of multiplying). But if those unique indexes were ever absent
 * (a deploy before they shipped, or a build that failed on a pre-existing dup),
 * a burst could have created MULTIPLE documents for the same key. With duplicate
 * buckets present, getUsage()/reserveAiBudget() read ONE of them and undercount —
 * the AI cap is silently weakened (fail-open).
 *
 * This migration runs BEFORE the unique index is (re)built at boot: it groups by
 * the natural key, SUMS the per-bucket counters into the OLDEST surviving document
 * (smallest _id), and deletes the rest. Once collapsed, the unique index builds
 * cleanly and the cap is enforced correctly again.
 *
 * Idempotent AND crash-safe: a collection with no duplicates makes no writes, so
 * it's safe to re-run on every gated migration pass. Critically, each group's
 * collapse — the survivor `$set`-to-total AND the loser deletes — runs inside ONE
 * transaction, so a crash commits BOTH or NEITHER. That's what makes a re-run
 * after a partial/crashed run NOT double-count: a half-applied group can't exist.
 *
 *   - Crash BEFORE the txn commits  -> survivor still holds its own pre-collapse
 *     value and every loser is still present; the re-run re-aggregates the full
 *     group and sums to the correct total exactly once.
 *   - Crash AFTER the txn commits    -> the group is already a single document;
 *     the re-run's `count > 1` filter skips it, so no further write happens.
 *
 * The earlier (non-atomic) version `$set` the survivor to the total and THEN
 * deleted the losers as a separate write. A crash in the gap left the survivor
 * already holding the collapsed total WHILE the losers were still present, so the
 * re-run summed (collapsed survivor + surviving losers) and double-counted. The
 * transaction closes that gap.
 *
 * The deployment is a replica set (bundled docker-compose 1-node RS + Atlas + the
 * test harness's MongoMemoryReplSet), so transactions are available; we go through
 * withTransactionOrFallback so a true standalone mongod still completes (best
 * effort) rather than hard-failing the migration.
 */

import type { Model } from "mongoose";
import AiUsage from "../models/AiUsage";
import UsageCounter from "../models/UsageCounter";
import { withTransactionOrFallback } from "../utils/transaction";

/** All counter fields that must be summed when collapsing duplicates. */
const SUM_FIELDS = ["keysTranslated", "voiceCalls", "aiCalls"] as const;

interface GroupedDup {
  _id: any; // the grouping key (e.g. { projectId, period })
  ids: any[]; // every document _id in this group, OLDEST first
  count: number;
}

/**
 * Collapse one model's duplicate buckets. `keyFields` are the fields that form
 * the unique index for this model. Returns the number of duplicate documents
 * removed.
 */
async function collapseModel(
  model: Model<any>,
  keyFields: string[]
): Promise<number> {
  // Build the $group _id from the unique-index fields, and aggregate the
  // document ids so we can pick the oldest survivor and delete the rest.
  const groupId: Record<string, string> = {};
  for (const f of keyFields) groupId[f] = `$${f}`;

  // Sort by _id ascending so `ids[0]` is the OLDEST document (ObjectIds are
  // monotonic in creation time) — that's the survivor we sum into.
  const groups = (await model.aggregate([
    { $sort: { _id: 1 } },
    {
      $group: {
        _id: groupId,
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ])) as GroupedDup[];

  let removed = 0;

  for (const g of groups) {
    const [survivorId, ...losers] = g.ids;
    if (losers.length === 0) continue;

    // Collapse this group ATOMICALLY: read the live members, $set the survivor to
    // the absolute summed total, and delete the losers — all in ONE transaction.
    //
    // Atomicity is what makes the re-run safe. We deliberately re-read the group
    // members INSIDE the transaction rather than trusting the totals from the
    // pre-loop aggregate: if a previous crashed run had partially mutated this
    // group it wouldn't matter anyway (a committed partial state is impossible),
    // but reading inside the txn keeps the summed total consistent with exactly
    // the documents this same transaction is about to delete.
    await withTransactionOrFallback(async (session) => {
      const docs = await model
        .find({ _id: { $in: g.ids } }, SUM_FIELDS.join(" "))
        .session(session ?? null)
        .lean();

      const totals: Record<string, number> = {};
      for (const field of SUM_FIELDS) {
        let sum = 0;
        let present = false;
        for (const d of docs as any[]) {
          if (typeof d[field] === "number") {
            sum += d[field];
            present = true;
          }
        }
        // Only set fields the model actually carries (UsageCounter has no
        // voiceCalls/aiCalls), so we don't write spurious zeros onto it.
        if (present) totals[field] = sum;
      }

      // $set (absolute total), NOT $inc — so even if this exact write were
      // replayed it lands the survivor on the same value. Combined with the
      // atomic loser delete below, a re-run can never see a "collapsed survivor +
      // surviving losers" state to re-sum.
      await model.updateOne(
        { _id: survivorId },
        { $set: { ...totals, updatedAt: new Date() } },
        { session: session ?? undefined }
      );
      await model.deleteMany(
        { _id: { $in: losers } },
        { session: session ?? undefined }
      );
    });

    removed += losers.length;
  }

  return removed;
}

/**
 * Collapse duplicate AiUsage ({projectId, period}) and UsageCounter
 * ({scope, period}) buckets, summing their counters into the oldest document.
 * Run this from the gated migration block BEFORE the unique indexes are built.
 */
export async function migrateDedupUsageBuckets(): Promise<void> {
  const aiRemoved = await collapseModel(AiUsage, ["projectId", "period"]);
  if (aiRemoved > 0) {
    console.log(`[Migration] Collapsed ${aiRemoved} duplicate AiUsage bucket(s)`);
  }

  const counterRemoved = await collapseModel(UsageCounter, ["scope", "period"]);
  if (counterRemoved > 0) {
    console.log(`[Migration] Collapsed ${counterRemoved} duplicate UsageCounter bucket(s)`);
  }
}
