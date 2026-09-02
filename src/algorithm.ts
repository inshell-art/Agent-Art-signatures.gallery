/**
 * Algorithm interface — handoff §6.
 *
 * The generation algorithm is out of scope for this repo and is supplied
 * separately. This file only pins the interface this service codes against
 * so the rest of the service (mapping, minting, rendering pipeline) can be
 * built and typechecked before the real implementation lands.
 *
 * Do not implement render_canonical / render_instance here. Replace this
 * file's body wholesale when the algorithm is supplied — the surrounding
 * service should not need to change.
 */

/** Fixed keys, fixed order, bounded per ENVELOPE (handoff §6). */
export type OffsetVector = Record<string, number>;

/** Per-axis bounds, used to validate the mapping table at startup (§5, §6). */
export type Envelope = Record<string, { min: number; max: number }>;

// TODO(algorithm): supplied with the real implementation.
export const SPEC_VERSION: string | undefined = undefined;

// TODO(algorithm): supplied with the real implementation.
export const ENVELOPE: Envelope | undefined = undefined;

/** Pure function of handle. Returns raw SVG for the zero-offset signature. */
export function renderCanonical(_handle: string): string {
  throw new Error("renderCanonical is not implemented — supplied separately with the algorithm (handoff §6)");
}

/** Pure function of its arguments. Returns raw SVG for an offset signature. */
export function renderInstance(_handle: string, _offsets: OffsetVector): string {
  throw new Error("renderInstance is not implemented — supplied separately with the algorithm (handoff §6)");
}
