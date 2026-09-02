/**
 * Deterministic hashing primitives ported from the signature prototype
 * (inshell-art/agent-art-Signature-prototype, src/text-seeded-bezier-line.html).
 *
 * The prototype hand-rolls SHA-256 in the browser (no Web Crypto access to
 * a suitable synchronous digest at the time it was written). Node's
 * `crypto` module implements the same standardized SHA-256 algorithm, so
 * hashing the same canonical JSON string here produces byte-identical
 * digests — this is not a re-derivation, just a shorter route to the same
 * bytes.
 */

import { createHash } from "node:crypto";

/** Deterministic, sorted-key JSON stringification — the hash input contract. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const RANDOM_SCHEME = "sha256-labeled-u53";
export const RANDOM_NAMESPACE = "personal-field";

/**
 * Hashes a labeled, scoped request into a uniform float in [0, 1), using
 * the first 53 bits of the SHA-256 digest (the full mantissa precision of
 * a JS double).
 */
export function hashToUnitFloat(scope: unknown, parameter: string): number {
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        namespace: RANDOM_NAMESPACE,
        parameter,
        scheme: RANDOM_SCHEME,
        scope,
      }),
    )
    .digest();
  const first53Bits = digest.readUInt32BE(0) * 2097152 + (digest.readUInt32BE(4) >>> 11);
  return first53Bits / 9007199254740992;
}

export function mapRange(unitValue: number, minimum: number, maximum: number): number {
  return minimum + unitValue * (maximum - minimum);
}
