/**
 * Per-project resource limits (abuse hardening for the forever-free hosted
 * service). Env-tunable; a non-positive value disables the limit (self-hosters
 * who want no ceiling set MAX_KEYS_PER_PROJECT=0).
 */

/** Max translation KEYS one project may hold. Default 20,000. */
export function maxKeysPerProject(): number {
  const raw = process.env.MAX_KEYS_PER_PROJECT;
  if (raw === undefined || raw === "") return 20000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 20000;
}

/** The 400 message shared by every key-creating path. */
export function keyCapMessage(cap: number): string {
  return `Project key limit reached (${cap} keys). Delete unused keys, or raise MAX_KEYS_PER_PROJECT when self-hosting.`;
}
