/**
 * Short-lived state for in-flight OAuth claims: binds an opaque `state` to
 * the PKCE verifier that started it, so the callback can complete the
 * exchange and so a forged callback (wrong/unknown state) is rejected.
 * Single-use: consumed on lookup. In-memory — fine for one process; a
 * multi-instance deployment would need this shared (e.g. Redis).
 */

const TTL_MS = 5 * 60 * 1000;

interface PendingClaim {
  codeVerifier: string;
  expiresAt: number;
}

export class PendingClaims {
  private pending = new Map<string, PendingClaim>();

  start(state: string, codeVerifier: string): void {
    this.pending.set(state, { codeVerifier, expiresAt: Date.now() + TTL_MS });
  }

  /** Consumes and returns the verifier for `state`, or null if unknown/expired. */
  consume(state: string): string | null {
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.codeVerifier;
  }
}
