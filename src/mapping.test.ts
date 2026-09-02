import { describe, expect, it } from "vitest";
import { deriveOffsetVector, EnvelopeViolationError } from "./mapping.js";
import { parseReadingCode } from "./reading.js";
import type { Envelope } from "./algorithm.js";

const baseParams = {
  specVersion: "test-v0",
  handle: "alice",
  sourcePostId: "12345",
};

describe("mapping (placeholder table)", () => {
  it("maps xxxx to the zero vector, no jitter (§4.2, §5)", () => {
    const vector = deriveOffsetVector({ ...baseParams, code: parseReadingCode("xxxx") });
    expect(Object.values(vector)).toEqual([0, 0, 0, 0]);
  });

  it("is deterministic: same inputs, same output", () => {
    const code = parseReadingCode("hfwo");
    const a = deriveOffsetVector({ ...baseParams, code });
    const b = deriveOffsetVector({ ...baseParams, code });
    expect(a).toEqual(b);
  });

  it("differs per source_post_id (within-cell jitter), never chains from a prior instance", () => {
    const code = parseReadingCode("hfwo");
    const a = deriveOffsetVector({ ...baseParams, code, sourcePostId: "111" });
    const b = deriveOffsetVector({ ...baseParams, code, sourcePostId: "222" });
    expect(a).not.toEqual(b);
  });

  it("asserts inside the envelope when one is supplied, and rejects out-of-bounds output", () => {
    const code = parseReadingCode("hfwo"); // tempo +1, weight +1, steadiness 0, reach +1 before jitter
    const tightEnvelope: Envelope = {
      tempo: { min: -0.1, max: 0.1 }, // narrower than the placeholder table can produce
      weight: { min: -10, max: 10 },
      steadiness: { min: -10, max: 10 },
      reach: { min: -10, max: 10 },
    };
    expect(() => deriveOffsetVector({ ...baseParams, code, envelope: tightEnvelope })).toThrow(
      EnvelopeViolationError,
    );
  });

  it("skips the envelope assertion when no envelope is supplied (algorithm not yet wired)", () => {
    const code = parseReadingCode("hfwo");
    expect(() => deriveOffsetVector({ ...baseParams, code })).not.toThrow();
  });
});
