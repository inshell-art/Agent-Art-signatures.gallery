/**
 * The reading contract — handoff §4.
 *
 * A "reading" is the agent's structured interpretation of a participant's
 * recent posts: four axes, one discrete level each. This module owns the
 * closed vocabulary, the 4-character URL encoding, and validation of both.
 *
 * This is the only part of the reading pipeline that lives in this service.
 * The classification itself (posts -> reading) happens upstream, in the
 * agent that replies on X; this service only ever receives the resulting
 * code as a URL path segment (handoff §3, §12.1: "the agent emits labels
 * and a URL, never numbers, never geometry").
 */

export const TEMPO_LEVELS = ["hurried", "steady", "measured", "insufficient"] as const;
export const WEIGHT_LEVELS = ["light", "even", "firm", "insufficient"] as const;
export const STEADINESS_LEVELS = ["unbroken", "wavering", "broken", "insufficient"] as const;
export const REACH_LEVELS = ["contained", "neutral", "open", "insufficient"] as const;

export type Tempo = (typeof TEMPO_LEVELS)[number];
export type Weight = (typeof WEIGHT_LEVELS)[number];
export type Steadiness = (typeof STEADINESS_LEVELS)[number];
export type Reach = (typeof REACH_LEVELS)[number];

export interface Reading {
  tempo: Tempo;
  weight: Weight;
  steadiness: Steadiness;
  reach: Reach;
}

/** A validated 4-character reading code, e.g. "hfwo" or "xxxx". */
export type ReadingCode = string & { readonly __brand: "ReadingCode" };

/** Fixed axis order, per §4.3: tempo · weight · steadiness · reach. */
const AXES = ["tempo", "weight", "steadiness", "reach"] as const;

// Per-position char <-> level, in the fixed axis order above.
const TEMPO_CHAR: Record<Tempo, string> = { hurried: "h", steady: "s", measured: "m", insufficient: "x" };
const WEIGHT_CHAR: Record<Weight, string> = { light: "l", even: "e", firm: "f", insufficient: "x" };
const STEADINESS_CHAR: Record<Steadiness, string> = { unbroken: "u", wavering: "w", broken: "b", insufficient: "x" };
const REACH_CHAR: Record<Reach, string> = { contained: "c", neutral: "n", open: "o", insufficient: "x" };

const CHAR_TEMPO = invert(TEMPO_CHAR);
const CHAR_WEIGHT = invert(WEIGHT_CHAR);
const CHAR_STEADINESS = invert(STEADINESS_CHAR);
const CHAR_REACH = invert(REACH_CHAR);

function invert<L extends string>(map: Record<L, string>): Record<string, L> {
  const out: Record<string, L> = {};
  for (const level in map) out[map[level]] = level;
  return out;
}

/** Per §4.4: exactly 4 characters, each drawn from its position's alphabet. */
const CODE_PATTERN = /^[hsmx][lefx][uwbx][cnox]$/;

export class InvalidReadingCodeError extends Error {
  constructor(code: string) {
    super(`"${code}" is not a valid reading code (expected 4 chars matching ${CODE_PATTERN})`);
    this.name = "InvalidReadingCodeError";
  }
}

export function isValidReadingCode(code: string): code is ReadingCode {
  return CODE_PATTERN.test(code);
}

/**
 * Parse and validate a URL-supplied code. Per §4.4, an out-of-vocabulary
 * reading is a failed read, not a novel value — callers should turn this
 * into an HTTP 400 and mint nothing.
 */
export function parseReadingCode(code: string): ReadingCode {
  if (!isValidReadingCode(code)) {
    throw new InvalidReadingCodeError(code);
  }
  return code as ReadingCode;
}

/** Expand a validated code into its axis->level object (for `reading_json`). */
export function decodeReading(code: ReadingCode): Reading {
  return {
    tempo: CHAR_TEMPO[code[0]],
    weight: CHAR_WEIGHT[code[1]],
    steadiness: CHAR_STEADINESS[code[2]],
    reach: CHAR_REACH[code[3]],
  };
}

/** Encode a Reading back into its 4-character code. Inverse of decodeReading. */
export function encodeReading(reading: Reading): ReadingCode {
  const code =
    TEMPO_CHAR[reading.tempo] +
    WEIGHT_CHAR[reading.weight] +
    STEADINESS_CHAR[reading.steadiness] +
    REACH_CHAR[reading.reach];
  return code as ReadingCode;
}

/** "xxxx" — nothing readable, maps to the canonical (handoff §4.3, §4.2, §5). */
export const CANONICAL_CODE = "xxxx" as ReadingCode;

export function isCanonicalCode(code: ReadingCode): boolean {
  return code === CANONICAL_CODE;
}

export { AXES };
