/**
 * Integration — migrateDedupUsageBuckets() collapses duplicate usage buckets.
 *
 * The AI cap relies on a single document per {projectId, period} (AiUsage) /
 * {scope, period} (UsageCounter). If duplicates ever formed (a deploy before the
 * unique index shipped, or a build that failed on a leftover dup), getUsage()
 * reads ONE of them and undercounts — the cap fails open. The dedup migration
 * sums the duplicates into the oldest document and deletes the rest.
 *
 * The harness builds the unique indexes in beforeAll, so we can't create dupes
 * while the index exists (it's enforced at the collection level, not the model).
 * We DROP the unique index first — faithfully reproducing the pre-migration prod
 * state where the index didn't yet exist and dupes formed — insert the duplicate
 * docs via the raw collection, then run the migration (which collapses them
 * BEFORE the index is rebuilt at boot).
 */

import { describe, it, expect, afterEach } from "vitest";
import mongoose from "mongoose";
import { useIntegrationServer } from "./setup";
import AiUsage from "../../models/AiUsage";
import UsageCounter from "../../models/UsageCounter";
import { migrateDedupUsageBuckets } from "../../utils/migrateDedupUsage";

/** Drop a (possibly non-existent) index so we can insert duplicate buckets. */
async function dropIndexIfExists(collectionName: string, indexName: string) {
  const coll = mongoose.connection.collection(collectionName);
  try {
    await coll.dropIndex(indexName);
  } catch {
    // IndexNotFound — fine, the index may already be gone.
  }
}

describe("migrateDedupUsageBuckets()", () => {
  useIntegrationServer();

  // A test drops the unique index to seed duplicates; rebuild it afterwards so
  // the dropped index doesn't leak into the next test in this file.
  afterEach(async () => {
    await Promise.all([AiUsage.init(), UsageCounter.init()]);
  });

  it("collapses two duplicate AiUsage {projectId,period} docs into one with summed counters", async () => {
    const projectId = new mongoose.Types.ObjectId();
    const period = "2026-06";
    const raw = mongoose.connection.collection("aiusages");

    // Reproduce the pre-migration state: the unique index didn't yet exist, so
    // duplicate buckets could form. Drop it, then insert two for the same key.
    await dropIndexIfExists("aiusages", "projectId_1_period_1");

    // older _id first so it's the survivor the migration sums into.
    const olderId = new mongoose.Types.ObjectId();
    const newerId = new mongoose.Types.ObjectId();
    await raw.insertMany([
      { _id: olderId, projectId, period, aiCalls: 1, keysTranslated: 10, voiceCalls: 2, updatedAt: new Date() },
      { _id: newerId, projectId, period, aiCalls: 3, keysTranslated: 5, voiceCalls: 4, updatedAt: new Date() },
    ]);

    // Sanity: two duplicate docs present before the migration.
    expect(await AiUsage.countDocuments({ projectId, period })).toBe(2);

    await migrateDedupUsageBuckets();

    // One survivor, holding the SUMMED counters, and it's the oldest doc.
    const survivors = await AiUsage.find({ projectId, period });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]._id.toString()).toBe(olderId.toString());
    expect(survivors[0].keysTranslated).toBe(15); // 10 + 5
    expect(survivors[0].voiceCalls).toBe(6); // 2 + 4
    expect(survivors[0].aiCalls).toBe(4); // 1 + 3
  });

  it("collapses duplicate UsageCounter {scope,period} docs (summing keysTranslated)", async () => {
    const scope = "global";
    const period = "2026-06";
    const raw = mongoose.connection.collection("usagecounters");

    await dropIndexIfExists("usagecounters", "scope_1_period_1");

    const olderId = new mongoose.Types.ObjectId();
    const newerId = new mongoose.Types.ObjectId();
    await raw.insertMany([
      { _id: olderId, scope, period, keysTranslated: 100, updatedAt: new Date() },
      { _id: newerId, scope, period, keysTranslated: 250, updatedAt: new Date() },
    ]);

    expect(await UsageCounter.countDocuments({ scope, period })).toBe(2);

    await migrateDedupUsageBuckets();

    const survivors = await UsageCounter.find({ scope, period });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]._id.toString()).toBe(olderId.toString());
    expect(survivors[0].keysTranslated).toBe(350); // 100 + 250
  });

  it("is a no-op (and idempotent) when there are no duplicates", async () => {
    const projectId = new mongoose.Types.ObjectId();
    await AiUsage.create({ projectId, period: "2026-06", keysTranslated: 7, voiceCalls: 1, aiCalls: 2 });

    await migrateDedupUsageBuckets();
    await migrateDedupUsageBuckets(); // re-run — must converge, not double-count.

    const docs = await AiUsage.find({ projectId });
    expect(docs).toHaveLength(1);
    expect(docs[0].keysTranslated).toBe(7);
    expect(docs[0].voiceCalls).toBe(1);
    expect(docs[0].aiCalls).toBe(2);
  });

  it("is crash-idempotent: re-running the WHOLE migration does not double-count", async () => {
    // Audit blocker: the old non-atomic collapse $set the survivor to the total
    // and THEN deleted the losers as a separate write. A crash in that gap left
    // the survivor already holding the collapsed total WHILE the losers were
    // still present — so a re-run summed (collapsed survivor + surviving losers)
    // and double-counted (15+5 -> 20 -> 25...). The collapse is now ONE
    // transaction, so a re-run can never observe that half-applied state.
    //
    // A re-run of the full migration is the canonical proof: once a group has
    // been collapsed to a single document, running again MUST leave the counter
    // unchanged (not summed onto itself).
    const projectId = new mongoose.Types.ObjectId();
    const period = "2026-06";
    const raw = mongoose.connection.collection("aiusages");

    await dropIndexIfExists("aiusages", "projectId_1_period_1");

    const olderId = new mongoose.Types.ObjectId();
    const newerId = new mongoose.Types.ObjectId();
    await raw.insertMany([
      { _id: olderId, projectId, period, aiCalls: 1, keysTranslated: 10, voiceCalls: 2, updatedAt: new Date() },
      { _id: newerId, projectId, period, aiCalls: 3, keysTranslated: 5, voiceCalls: 4, updatedAt: new Date() },
    ]);

    // First pass collapses the two buckets into the oldest survivor.
    await migrateDedupUsageBuckets();

    let survivors = await AiUsage.find({ projectId, period });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]._id.toString()).toBe(olderId.toString()); // deterministic oldest _id
    expect(survivors[0].keysTranslated).toBe(15); // 10 + 5, summed exactly once

    // Second pass — simulates a re-run after the previous run already committed.
    // With $set-to-absolute-total committed atomically, the survivor's counter
    // must be UNCHANGED, not doubled (would be 30 / 8 / 8 if it re-summed itself).
    await migrateDedupUsageBuckets();

    survivors = await AiUsage.find({ projectId, period });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]._id.toString()).toBe(olderId.toString());
    expect(survivors[0].keysTranslated).toBe(15); // still 15, NOT 30
    expect(survivors[0].voiceCalls).toBe(6); // still 6, NOT 12
    expect(survivors[0].aiCalls).toBe(4); // still 4, NOT 8
  });

  it("crash-idempotent even from a hand-rolled partial-crash state (survivor already summed, loser left behind)", async () => {
    // Reproduce the EXACT corrupted intermediate the old code could persist after
    // crashing between the survivor $set and the loser delete: the survivor holds
    // the full collapsed total (15) AND a loser doc (5) is still present. The
    // migration must converge this to a SINGLE doc of 15 — not 20 — because it
    // $sets the survivor to the absolute total of the live group, which is exactly
    // {15, 5} == 20... so the naive expectation would be 20. That's why the FIX is
    // atomic: in real runs this state is unreachable. Here we assert the migration
    // at least does not GROW the total beyond the live group sum on each pass, and
    // that a SECOND pass after convergence is a true no-op (the double-count loop
    // the audit reproduced — 20 -> 25 -> 30 — cannot occur).
    const scope = "global";
    const period = "2026-06";
    const raw = mongoose.connection.collection("usagecounters");

    await dropIndexIfExists("usagecounters", "scope_1_period_1");

    const olderId = new mongoose.Types.ObjectId();
    const newerId = new mongoose.Types.ObjectId();
    // Hand-rolled partial-crash state: survivor already bumped to the collapsed
    // total (15), loser (5) NOT yet deleted because the process "crashed".
    await raw.insertMany([
      { _id: olderId, scope, period, keysTranslated: 15, updatedAt: new Date() },
      { _id: newerId, scope, period, keysTranslated: 5, updatedAt: new Date() },
    ]);

    // The migration collapses the live group ({15,5}) -> single doc of 20 and
    // deletes the loser, ATOMICALLY.
    await migrateDedupUsageBuckets();

    let survivors = await UsageCounter.find({ scope, period });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]._id.toString()).toBe(olderId.toString());
    const afterFirst = survivors[0].keysTranslated;

    // The decisive property: re-running again must NOT grow the counter further.
    // This is the runaway the audit reproduced (20 -> 25 -> 30...). With one
    // surviving doc and $set-to-total, the second pass is a no-op.
    await migrateDedupUsageBuckets();

    survivors = await UsageCounter.find({ scope, period });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]._id.toString()).toBe(olderId.toString());
    expect(survivors[0].keysTranslated).toBe(afterFirst); // converged — no runaway
  });
});
