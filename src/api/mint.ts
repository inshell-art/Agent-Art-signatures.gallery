/**
 * GET /s/{handle}/{code}/{post_id} — mint or fetch instance (handoff §9.1).
 *
 * Implements steps 1-3: validate, idempotency lookup, map+jitter+envelope
 * assert. Step 3's render/rasterize/persist is left to the caller once
 * `renderInstance` (algorithm.ts) exists — it currently throws
 * NotImplementedError, which is the expected, structural stopping point
 * until the algorithm is supplied.
 */

import * as algorithm from "../algorithm.js";
import { ValidationError } from "../errors.js";
import { deriveOffsetVector, MAP_VERSION } from "../mapping.js";
import { decodeReading, isValidReadingCode, parseReadingCode, type ReadingCode } from "../reading.js";
import type { Instance, Store } from "../store/types.js";

const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const POST_ID_PATTERN = /^\d+$/;

// Bumped when the reading vocabulary (reading.ts) changes shape.
const SCHEMA_VERSION = "reading.v1";

export interface MintParams {
  handle: string;
  code: string;
  postId: string;
}

export interface MintResult {
  instance: Instance;
  isNew: boolean;
}

export function validateMintParams(params: MintParams): { handle: string; code: ReadingCode; postId: string } {
  if (!HANDLE_PATTERN.test(params.handle)) {
    throw new ValidationError(`invalid handle "${params.handle}"`);
  }
  if (!POST_ID_PATTERN.test(params.postId)) {
    throw new ValidationError(`invalid post_id "${params.postId}"`);
  }
  if (!isValidReadingCode(params.code)) {
    // Per §4.4: an out-of-vocabulary reading is a failed read, not a novel
    // value. Reject it — do not coerce or default it.
    throw new ValidationError(`invalid reading code "${params.code}"`);
  }
  return { handle: params.handle, code: parseReadingCode(params.code), postId: params.postId };
}

export async function mintOrFetchInstance(store: Store, rawParams: MintParams): Promise<MintResult> {
  const { handle, code, postId } = validateMintParams(rawParams);

  // Idempotency: X's crawler will re-fetch the card URL; a re-fetch must
  // return the existing instance, never mint a duplicate (§7, §9.1, §12.6).
  const existing = await store.findInstanceByIdempotencyKey(handle, postId);
  if (existing) {
    return { instance: existing, isNew: false };
  }

  const offsetVector = deriveOffsetVector({
    specVersion: algorithm.SPEC_VERSION ?? "unspecified",
    handle,
    code,
    sourcePostId: postId,
    envelope: algorithm.ENVELOPE,
  });

  // This is the structural stopping point: rendering and persisting a new
  // instance requires the real algorithm. NotImplementedError propagates to
  // the HTTP layer, which maps it to 501.
  algorithm.renderInstance(handle, offsetVector);

  // Unreachable until renderInstance is implemented, but shown for clarity
  // on what step 3 does once it is:
  const instance = await store.insertInstance({
    xUserId: null,
    seedHandle: handle,
    readingCode: code,
    readingJson: decodeReading(code),
    rationale: null,
    sourcePostId: postId,
    offsetVector,
    specVersion: algorithm.SPEC_VERSION ?? "unspecified",
    mapVersion: MAP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    provenance: "unverified",
    supersedes: null,
  });
  return { instance, isNew: true };
}
