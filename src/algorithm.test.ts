import { describe, expect, it } from "vitest";
import { ENVELOPE, renderCanonical, renderInstance, SPEC_VERSION } from "./algorithm.js";

describe("renderCanonical", () => {
  it("is deterministic: same handle, same bytes", () => {
    expect(renderCanonical("grok")).toBe(renderCanonical("grok"));
  });

  it("differs across handles", () => {
    expect(renderCanonical("grok")).not.toBe(renderCanonical("erikswahn"));
  });

  it("produces a well-formed SVG with the expected canvas and displayed handle", () => {
    const svg = renderCanonical("Personal_Field");
    expect(svg).toContain('viewBox="0 0 420 420"');
    expect(svg).toContain(">@Personal_Field<");
  });

  it("rejects a handle outside the input pattern", () => {
    expect(() => renderCanonical("not a handle")).toThrow();
    expect(() => renderCanonical("")).toThrow();
  });
});

describe("renderInstance", () => {
  it("is byte-identical to renderCanonical at the zero offset vector (handoff §6)", () => {
    const zero = { tempo: 0, weight: 0, steadiness: 0, reach: 0 };
    expect(renderInstance("grok", zero)).toBe(renderCanonical("grok"));
  });

  it("also matches canonical when axes are simply omitted (defaults to 0)", () => {
    expect(renderInstance("grok", {})).toBe(renderCanonical("grok"));
  });

  it("differs from canonical at a non-zero offset, while staying well-formed SVG", () => {
    const svg = renderInstance("grok", { tempo: 1, weight: 1, steadiness: -1, reach: 1 });
    expect(svg).not.toBe(renderCanonical("grok"));
    expect(svg).toContain('viewBox="0 0 420 420"');
  });

  it("stays well-formed at the envelope's extremes", () => {
    for (const sign of [-1, 1] as const) {
      const svg = renderInstance("grok", {
        tempo: sign * ENVELOPE.tempo.max,
        weight: sign * ENVELOPE.weight.max,
        steadiness: sign * ENVELOPE.steadiness.max,
        reach: sign * ENVELOPE.reach.max,
      });
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
    }
  });
});

describe("SPEC_VERSION / ENVELOPE", () => {
  it("SPEC_VERSION is a non-empty string", () => {
    expect(typeof SPEC_VERSION).toBe("string");
    expect(SPEC_VERSION.length).toBeGreaterThan(0);
  });

  it("ENVELOPE covers all four reading axes", () => {
    expect(Object.keys(ENVELOPE).sort()).toEqual(["reach", "steadiness", "tempo", "weight"]);
  });
});
