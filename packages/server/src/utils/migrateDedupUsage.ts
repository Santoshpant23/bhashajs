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
 * Idempotent: a collection with no duplicates makes no writes, so it's safe to
 * re-run on every gated migration pass.
 */

import type { Model } from "mongoose";
import AiUsage from "../models/AiUsage";
import UsageCounter from "../models/UsageCounter";

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

    // Sum every counter across the whole group (survivor included) so the
    // survivor ends up holding the combined total.
    const docs = await model
      .find({ _id: { $in: g.ids } }, SUM_FIELDS.join(" "))
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

    await model.updateOne(
      { _id: survivorId },
      { $set: { ...totals, updatedAt: new Date() } }
    );
    const del = await model.deleteMany({ _id: { $in: losers } });
    removed += del.deletedCount ?? losers.length;
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
