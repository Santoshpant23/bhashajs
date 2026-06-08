import mongoose, { ClientSession } from "mongoose";

/**
 * Run a set of writes atomically when the deployment supports transactions
 * (a replica set / MongoDB Atlas), and fall back to a best-effort sequential
 * run on a standalone Mongo (local dev) that can't do multi-document
 * transactions.
 *
 * The callback MUST thread the (optional) session into every operation AND
 * order its writes children-before-parent — so that even on the fallback path,
 * a mid-run failure leaves the PARENT recoverable rather than orphaning
 * children (the bug this guards against was deleting the project before its
 * dependents).
 */
export async function withTransactionOrFallback(
  work: (session?: ClientSession) => Promise<void>
): Promise<void> {
  try {
    // mongoose.connection.transaction() (NOT raw session.withTransaction) is the
    // correct primitive when the callback re-saves a pre-fetched document.
    // session.withTransaction() RE-RUNS the callback on a transient error, but
    // after the first translation.save() Mongoose has cleared the document's
    // modifiedPaths — so the retry's save() is a no-op (the doc looks clean) and
    // the change is NOT re-committed even though recordHistory still inserts →
    // a phantom audit row with no actual translation change. connection.
    // transaction() snapshots and RESETS the state of documents modified inside
    // the transaction before each retry, so the retried save() re-persists. The
    // session is threaded into `work` exactly as before.
    await mongoose.connection.transaction(async (session) => {
      await work(session as ClientSession);
    });
  } catch (err: any) {
    const msg = String(err?.message || err);
    const transactionsUnsupported =
      /Transaction numbers are only allowed|replica set|Transactions are not supported|mongos|not supported/i.test(
        msg
      );
    if (transactionsUnsupported) {
      // Standalone Mongo — run the same ordered writes without a session. There
      // are no retries on this path, so the document-reset concern doesn't apply.
      await work();
    } else {
      throw err;
    }
  }
}
