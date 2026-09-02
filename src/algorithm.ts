/**
 * Algorithm interface — handoff §6.
 *
 * Implemented: ported from inshell-art/agent-art-Signature-prototype (the
 * design panel's frozen defaults — see algorithm/settings.ts). The port
 * itself lives in algorithm/{hash,geometry,svg,settings}.ts and is a
 * faithful translation of that prototype's JS, not a reinterpretation.
 *
 * `renderInstance`'s use of `offsets` is this service's own addition, not
 * part of the prototype — the prototype only ever produces one canonical
 * mark per handle. See algorithm/offsets.ts for what each axis perturbs
 * and why; treat that mapping as a first pass, since the handoff reserves
 * that aesthetic decision for whoever supplies "the algorithm" (§5).
 */

import { createHash } from "node:crypto";
import { applyOffsets, ENVELOPE as OFFSET_ENVELOPE } from "./algorithm/offsets.js";
import { canonicalJson } from "./algorithm/hash.js";
import { DEFAULT_SETTINGS, SPECIFICATION_VERSION } from "./algorithm/settings.js";
import { renderSvgForText } from "./algorithm/svg.js";

/** Fixed keys, fixed order, bounded per ENVELOPE (handoff §6). */
export type OffsetVector = Record<string, number>;

/** Per-axis bounds, used to validate the mapping table at startup (§5, §6). */
export type Envelope = Record<string, { min: number; max: number }>;

export const SPEC_VERSION: string = `personal-field-${SPECIFICATION_VERSION}`;

export const ENVELOPE: Envelope = OFFSET_ENVELOPE;

/**
 * "The published spec hash" (handoff §9.4) — a content hash of the exact
 * settings that determine every rendered byte, so a stranger can confirm
 * they're recomputing against the same published algorithm, not just a
 * same-numbered one.
 */
export const SPEC_HASH: string = createHash("sha256")
  .update(canonicalJson({ ...DEFAULT_SETTINGS, input: { ...DEFAULT_SETTINGS.input, pattern: DEFAULT_SETTINGS.input.pattern.source } }))
  .digest("hex");

const HANDLE_PATTERN = DEFAULT_SETTINGS.input.pattern;

function assertValidHandle(handle: string): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error(`invalid handle "${handle}" for signature generation`);
  }
}

/** Pure function of handle. Returns raw SVG for the zero-offset signature. */
export function renderCanonical(handle: string): string {
  assertValidHandle(handle);
  return renderSvgForText(handle, DEFAULT_SETTINGS).svg;
}

/** Pure function of its arguments. Returns raw SVG for an offset signature. */
export function renderInstance(handle: string, offsets: OffsetVector): string {
  assertValidHandle(handle);
  return renderSvgForText(handle, applyOffsets(offsets)).svg;
}
