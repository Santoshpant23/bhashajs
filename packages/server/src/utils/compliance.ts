/**
 * Compliance lock — the single source of truth for the regulated-key guarantee.
 *
 * The promise: on a key marked `regulated`, the public SDK only ever serves a
 * cell that a human authored or a human approved. AI drafts and not-yet-approved
 * (non-owner) edits are withheld until a project owner approves them.
 *
 * Both the WRITE side (what provenance to stamp) and the READ side (what the SDK
 * may serve) go through these two functions so the rule can't drift between the
 * three write paths (single edit, bulk import, review) and the read path.
 */

export type WriteSource = "human" | "pending";

/**
 * What the public SDK may serve for a (regulated, source) cell.
 *   - non-regulated: anything servable.
 *   - regulated: only "human" or "approved". "ai" and "pending" are withheld.
 */
export function canServe(regulated: boolean, source: string | undefined): boolean {
  if (!regulated) return true;
  return source === "human" || source === "approved";
}

/**
 * The provenance to stamp when a cell is written.
 *   - regulated key + non-owner editor → "pending" (held by `canServe` until an
 *     owner approves via /review).
 *   - everything else → "human".
 */
export function resolveWriteSource(regulated: boolean, isOwner: boolean): WriteSource {
  return regulated && !isOwner ? "pending" : "human";
}
