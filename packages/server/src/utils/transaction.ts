import mongoose, { ClientSession } from "mongoose";

export interface TxnOptions {
  /**
   * Audit-critical writes (regulated translation + its history) set this. When
   * true, the standalone fallback is DISABLED: if a transaction can't run, the
   * error propagates and the write FAILS rather than persisting unaudited. A
   * regulated cell must never go live without its atomically-committed history.
   */
  requireTransaction?: boolean;
}

/**
 * Narrow detection of "this deployment can't run multi-document transactions"
 * (a standalone mongod). Deliberately tight — the old broad "not supported"
 * substring could match unrelated errors and silently rerun a failed write
 * session-less. We only treat the EXACT topology signals as "no transactions":
 * the standalone IllegalOperation (code 20) "Transaction numbers are only
 * allowed on a replica set member or mongos", or the explicit
 * "Transactions are not supported" deployment message.
 */
function isTransactionsUnsupported(err: any): boolean {
  const msg = String(err?.message || err);
  return (
    (err?.code === 20 &&
      /Transaction numbers are only allowed on a replica set member or mongos/i.test(msg)) ||
    /Transaction numbers are only allowed on a replica set member or mongos/i.test(msg) ||
    /Transactions are not supported by this deployment/i.test(msg)
  );
}

/**
 * Run a set of writes atomically when the deployment supports transactions
 * (a replica set / MongoDB Atlas / the bundled single-node RS), and — UNLESS
 * `requireTransaction` is set — fall back to a best-effort sequential run on a
 * true standalone Mongo that can't do multi-document transactions.
 *
 * The callback MUST thread the (optional) session into every operation AND
 * order its writes children-before-parent — so that even on the fallback path,
 * a mid-run failure leaves the PARENT recoverable rather than orphaning
 * children (the bug this guards against was deleting the project before its
 * dependents).
 *
 * Uses mongoose.connection.transaction() (NOT raw session.withTransaction): it
 * snapshots and RESETS the state of documents modified inside the transaction
 * before each retry, so a retried save() re-persists instead of becoming a no-op
 * (which would leave a phantom audit row).
 */
export async function withTransactionOrFallback(
  work: (session?: ClientSession) => Promise<void>,
  opts: TxnOptions = {}
): Promise<void> {
  try {
    await mongoose.connection.transaction(async (session) => {
      await work(session as ClientSession);
    });
  } catch (err: any) {
    // Audit-critical writes NEVER fall back — a regulated change can't be
    // persisted without an atomic audit row, so the error propagates (the route
    // fails) rather than rerunning the write session-less.
    if (!opts.requireTransaction && isTransactionsUnsupported(err)) {
      // True standalone Mongo — run the same ordered writes without a session.
      // No retries on this path, so the document-reset concern doesn't apply.
      await work();
    } else {
      throw err;
    }
  }
}
