/**
 * Rate limiting (handoff §9.1: "Rate-limit per handle and per source IP.
 * Minting is cheap but unbounded minting is a denial-of-wallet vector.").
 *
 * Sliding-window counter, in-memory. Real logic, not a placeholder — the
 * in-memory storage is the part to swap (e.g. for Redis) in a
 * multi-instance deployment, same as MemoryStore/MemoryAssetStore.
 */

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if `key` is still within its limit for the window (and records the hit). */
  tryConsume(key: string): boolean {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (timestamps.length >= this.limit) {
      this.hits.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }
}
