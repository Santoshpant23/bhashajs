/**
 * Integration — a retried transaction re-persists a reused document.
 *
 * withTransactionOrFallback wraps the PUT/review pattern: fetch a document,
 * mutate it in memory, then save it inside the transaction. A transient error
 * makes the driver RE-RUN the transaction callback. The bug (external audit):
 * with raw session.withTransaction(), the first save clears the document's
 * modifiedPaths, so the retried save is a silent NO-OP — the value is lost while
 * the history insert still lands (phantom audit). The fix uses
 * mongoose.connection.transaction(), which resets document state between
 * retries so the retried save re-persists. This test forces a transient retry
 * and asserts the mutation survived.
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import { useIntegrationServer } from "./setup";
import Translation from "../../models/Translation";
import { withTransactionOrFallback } from "../../utils/transaction";

describe("withTransactionOrFallback re-persists a reused document across a transient retry", () => {
  useIntegrationServer();

  it("re-applies the document's change on retry (no silent no-op save)", async () => {
    const created = await Translation.create({
      projectId: new mongoose.Types.ObjectId(),
      key: "retry-key",
      translations: {},
      sources: {},
    });

    // Fetch + mutate BEFORE the transaction — exactly the route shape (the cell
    // writes happen, then the save is wrapped in withTransactionOrFallback).
    const doc = await Translation.findById(created._id);
    doc!.key = "retry-key-edited";

    let attempts = 0;
    await withTransactionOrFallback(async (session) => {
      attempts++;
      await doc!.save({ session });
      if (attempts === 1) {
        // Abort the first attempt with a real transient error so the driver
        // retries the whole callback. On the old primitive the retried save was
        // a no-op (doc clean) — this is what regresses.
        const e = new mongoose.mongo.MongoError("forced transient");
        e.addErrorLabel("TransientTransactionError");
        throw e;
      }
    });

    expect(attempts).toBeGreaterThanOrEqual(2); // it actually retried

    const fresh = await Translation.findById(created._id).lean();
    expect(fresh!.key).toBe("retry-key-edited"); // the change PERSISTED after the retry
  });
});
