/**
 * GET /s/{handle}/{code}/{post_id} — mint or fetch instance (handoff §9.1).
 *
 * Full pipeline: validate, idempotency lookup, map+jitter+envelope assert,
 * render, rasterize, persist. Rendering (`renderInstance` in algorithm.ts)
 * currently throws NotImplementedError — that's the expected, structural
 * stopping point until the real algorithm is supplied; everything before
 * and around it is real.
 */

import * as algorithm from "../algorithm.js";
import type { AssetStore } from "../assets/types.js";
import { ValidationError } from "../errors.js";
import { deriveOffsetVector, MAP_VERSION } from "../mapping.js";
import { rasterizeSvgToPng } from "../raster.js";
import { decodeReading, isValidReadingCode, parseReadingCode, type ReadingCode } from "../reading.js";
import type { Instance, Store } from "../store/types.js";

export function instanceAssetKey(id: string): string {
  return `instance:${id}`;
}

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

export async function mintOrFetchInstance(
  store: Store,
  assetStore: AssetStore,
  rawParams: MintParams,
  rationale: string | null = null,
): Promise<MintResult> {
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

  // Structural stopping point until the real algorithm lands:
  // renderInstance throws NotImplementedError, which propagates to the
  // HTTP layer as a 501. Nothing is persisted for an unrendered instance.
  const svg = algorithm.renderInstance(handle, offsetVector);

  const instance = await store.insertInstance({
    xUserId: null,
    seedHandle: handle,
    readingCode: code,
    readingJson: decodeReading(code),
    rationale,
    sourcePostId: postId,
    offsetVector,
    specVersion: algorithm.SPEC_VERSION ?? "unspecified",
    mapVersion: MAP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    provenance: "unverified",
    supersedes: null,
  });

  // SVG is the source of truth; PNG is what X's card unfurl requires
  // (§9.1: "SVG is not accepted by X").
  const png = await rasterizeSvgToPng(svg);
  const key = instanceAssetKey(instance.id);
  await assetStore.putSvg(key, svg);
  await assetStore.putPng(key, png);

  return { instance, isNew: true };
}
