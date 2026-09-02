import { describe, expect, it } from "vitest";
import { applyOffsets, ENVELOPE } from "./offsets.js";
import { DEFAULT_SETTINGS } from "./settings.js";

describe("applyOffsets", () => {
  it("reproduces the canonical settings exactly at the zero vector", () => {
    const settings = applyOffsets({ tempo: 0, weight: 0, steadiness: 0, reach: 0 });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("treats missing axes as zero", () => {
    expect(applyOffsets({})).toEqual(DEFAULT_SETTINGS);
    expect(applyOffsets({ tempo: 0 })).toEqual(DEFAULT_SETTINGS);
  });

  it("widens the rotation range for a positive tempo offset, symmetric around 0deg", () => {
    const settings = applyOffsets({ tempo: 1, weight: 0, steadiness: 0, reach: 0 });
    const [min, max] = settings.geometry.handleRotationDegrees;
    const [defaultMin, defaultMax] = DEFAULT_SETTINGS.geometry.handleRotationDegrees;
    expect(max - min).toBeGreaterThan(defaultMax - defaultMin);
    expect(min + max).toBeCloseTo(defaultMin + defaultMax, 10); // center unchanged
  });

  it("narrows the rotation range for a negative tempo offset", () => {
    const settings = applyOffsets({ tempo: -1, weight: 0, steadiness: 0, reach: 0 });
    const [min, max] = settings.geometry.handleRotationDegrees;
    const [defaultMin, defaultMax] = DEFAULT_SETTINGS.geometry.handleRotationDegrees;
    expect(max - min).toBeLessThan(defaultMax - defaultMin);
  });

  it("scales stroke weight directly with the weight axis", () => {
    const heavier = applyOffsets({ tempo: 0, weight: 1, steadiness: 0, reach: 0 });
    const lighter = applyOffsets({ tempo: 0, weight: -1, steadiness: 0, reach: 0 });
    expect(heavier.stroke.baseWeightPx).toBeGreaterThan(DEFAULT_SETTINGS.stroke.baseWeightPx);
    expect(lighter.stroke.baseWeightPx).toBeLessThan(DEFAULT_SETTINGS.stroke.baseWeightPx);
  });

  it("widens the Y-shift range for a positive steadiness offset", () => {
    const settings = applyOffsets({ tempo: 0, weight: 0, steadiness: 1, reach: 0 });
    const [min, max] = settings.geometry.pointYShiftPx;
    const [defaultMin, defaultMax] = DEFAULT_SETTINGS.geometry.pointYShiftPx;
    expect(max - min).toBeGreaterThan(defaultMax - defaultMin);
  });

  it("scales the handle-length max while pinning the min at 0 for a reach offset", () => {
    const settings = applyOffsets({ tempo: 0, weight: 0, steadiness: 0, reach: 1 });
    expect(settings.geometry.handleLengthPx[0]).toBe(0);
    expect(settings.geometry.handleLengthPx[1]).toBeGreaterThan(DEFAULT_SETTINGS.geometry.handleLengthPx[1]);
  });

  it("never produces a non-positive width or negative weight at the envelope's extremes", () => {
    for (const sign of [-1, 1] as const) {
      const settings = applyOffsets({
        tempo: sign * ENVELOPE.tempo.max,
        weight: sign * ENVELOPE.weight.max,
        steadiness: sign * ENVELOPE.steadiness.max,
        reach: sign * ENVELOPE.reach.max,
      });
      const [rotMin, rotMax] = settings.geometry.handleRotationDegrees;
      const [yMin, yMax] = settings.geometry.pointYShiftPx;
      expect(rotMax - rotMin).toBeGreaterThan(0);
      expect(yMax - yMin).toBeGreaterThan(0);
      expect(settings.geometry.handleLengthPx[1]).toBeGreaterThan(0);
      expect(settings.stroke.baseWeightPx).toBeGreaterThan(0);
    }
  });

  it("axes are independent: changing one leaves the others at their default value", () => {
    const settings = applyOffsets({ tempo: 1, weight: 0, steadiness: 0, reach: 0 });
    expect(settings.stroke.baseWeightPx).toBe(DEFAULT_SETTINGS.stroke.baseWeightPx);
    expect(settings.geometry.pointYShiftPx).toEqual(DEFAULT_SETTINGS.geometry.pointYShiftPx);
    expect(settings.geometry.handleLengthPx).toEqual(DEFAULT_SETTINGS.geometry.handleLengthPx);
  });
});
