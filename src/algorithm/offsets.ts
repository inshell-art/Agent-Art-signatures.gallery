/**
 * Offset application — NOT part of the ported prototype.
 *
 * The prototype (inshell-art/agent-art-Signature-prototype) only defines a
 * canonical, handle-seeded mark; it has no notion of an "instance" or an
 * offset vector; those are this service's concepts (handoff §5, §6). This
 * module is the bridge: it says what each reading axis perturbs, so that
 * `renderInstance(handle, offsets)` varies the *same* canonical geometry
 * along four axes that already exist in the ported algorithm's own
 * settings, rather than introducing new ones.
 *
 * The mapping is deliberately literal-minded, not a final aesthetic
 * decision (the handoff explicitly reserves that call for whoever supplies
 * the algorithm, §5): each axis nudges the one canonical parameter its
 * name most directly describes.
 *
 *   tempo       -> handle rotation range (the hand's angular energy)
 *   weight      -> stroke base weight (literally "weight")
 *   steadiness  -> point Y-shift range (variance along the line)
 *   reach       -> handle length range (how far each stroke extends)
 *
 * Every sensitivity below is chosen so that even the widest offset this
 * service can produce (ENVELOPE bounds) leaves every derived parameter
 * comfortably positive and within the prototype's own slider bounds —
 * offset=0 on every axis reproduces the canonical settings exactly, and no
 * combination can collapse or invert a range. That inside-the-envelope
 * guarantee is what handoff §5 calls "structural" safety.
 */

import type { Envelope, OffsetVector } from "../algorithm.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";

const AXIS_BOUND = 1.5; // matches mapping.ts's worst case (±1 base + ±0.4 jitter = ±1.4, with margin)

export const ENVELOPE: Envelope = {
  tempo: { min: -AXIS_BOUND, max: AXIS_BOUND },
  weight: { min: -AXIS_BOUND, max: AXIS_BOUND },
  steadiness: { min: -AXIS_BOUND, max: AXIS_BOUND },
  reach: { min: -AXIS_BOUND, max: AXIS_BOUND },
};

const SENSITIVITY = {
  tempo: 0.3, // scales rotation-range width around its center of 0deg
  weight: 0.4, // scales stroke base weight around its canonical value
  steadiness: 0.35, // scales y-shift range width around its center
  reach: 0.35, // scales handle-length range width (min stays pinned at 0)
} as const;

function scaleWidthAroundCenter(range: [number, number], offset: number, sensitivity: number): [number, number] {
  const center = (range[0] + range[1]) / 2;
  const width = range[1] - range[0];
  const newWidth = width * (1 + offset * sensitivity);
  return [center - newWidth / 2, center + newWidth / 2];
}

function scaleMax(range: [number, number], offset: number, sensitivity: number): [number, number] {
  return [range[0], range[1] * (1 + offset * sensitivity)];
}

/**
 * Derives instance settings from the canonical defaults. `applyOffsets(s, zeroVector)`
 * is settings-equal to `s` — every scale factor above is exactly 1 at offset 0.
 */
export function applyOffsets(offsets: OffsetVector): Settings {
  const tempo = offsets.tempo ?? 0;
  const weight = offsets.weight ?? 0;
  const steadiness = offsets.steadiness ?? 0;
  const reach = offsets.reach ?? 0;

  return {
    ...DEFAULT_SETTINGS,
    geometry: {
      ...DEFAULT_SETTINGS.geometry,
      handleRotationDegrees: scaleWidthAroundCenter(DEFAULT_SETTINGS.geometry.handleRotationDegrees, tempo, SENSITIVITY.tempo),
      pointYShiftPx: scaleWidthAroundCenter(DEFAULT_SETTINGS.geometry.pointYShiftPx, steadiness, SENSITIVITY.steadiness),
      handleLengthPx: scaleMax(DEFAULT_SETTINGS.geometry.handleLengthPx, reach, SENSITIVITY.reach),
    },
    stroke: {
      ...DEFAULT_SETTINGS.stroke,
      baseWeightPx: DEFAULT_SETTINGS.stroke.baseWeightPx * (1 + weight * SENSITIVITY.weight),
    },
  };
}
