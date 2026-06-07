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
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await work(session);
    });
  } catch (err: any) {
    const msg = String(err?.message || err);
    const transactionsUnsupported =
      /Transaction numbers are only allowed|replica set|Transactions are not supported|mongos|not supported/i.test(
        msg
      );
    if (transactionsUnsupported) {
      // Standalone Mongo — run the same ordered deletes without a session.
      await work();
    } else {
      throw err;
    }
  } finally {
    await session.endSession();
  }
}
