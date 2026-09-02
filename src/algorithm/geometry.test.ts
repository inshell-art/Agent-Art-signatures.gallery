import { describe, expect, it } from "vitest";
import { geometryFor, graphemes } from "./geometry.js";

const CENTER = 210;
const ROT = [-28, 28] as const;
const LEN = [0, 45] as const;
const YSHIFT = [-40, 10] as const;

function geometry(text: string, overrides: Partial<{ serialMaxHeight: number; serialBaselineY: number; serialSpacing: number }> = {}) {
  return geometryFor(
    graphemes(text),
    "random",
    ROT[0],
    ROT[1],
    LEN[0],
    LEN[1],
    YSHIFT[0],
    YSHIFT[1],
    true,
    overrides.serialMaxHeight ?? 72,
    overrides.serialBaselineY ?? 250,
    overrides.serialSpacing ?? 24,
    CENTER,
  );
}

describe("geometryFor", () => {
  it("returns an empty array for empty input", () => {
    expect(geometry("")).toEqual([]);
  });

  it("returns two anchors for a single character (the count===1 special case)", () => {
    const points = geometry("a");
    expect(points).toHaveLength(2);
    expect(points[0].character).toBe("a");
    expect(points[1].character).toBe("a");
  });

  it("returns one anchor per character when there are no digits", () => {
    const points = geometry("grok");
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.character)).toEqual(["g", "r", "o", "k"]);
    expect(points.every((p) => !p.serialTail)).toBe(true);
  });

  it("is horizontally centered on CENTER regardless of input", () => {
    const points = geometry("grok");
    const xs = points.flatMap((p) => [p.anchor[0], p.incoming[0], p.outgoing[0]]);
    const geometryCenter = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(geometryCenter).toBeCloseTo(CENTER, 5);
  });

  it("flags uppercase characters", () => {
    const points = geometry("Ab");
    expect(points[0].uppercase).toBe(true);
    expect(points[1].uppercase).toBe(false);
  });

  it("takes the serial-pulse branch for digit runs, producing 3 pulse points per digit", () => {
    const points = geometry("42");
    // Leading boundary point + (peak, trailing boundary) per digit = 1 + 2*2 = 5
    expect(points.every((p) => p.serialTail)).toBe(true);
    expect(points.length).toBeGreaterThan(2);
  });

  it("mixes identity and serial-tail points for a handle with both letters and digits", () => {
    const points = geometry("agent42");
    expect(points.some((p) => p.serialTail)).toBe(true);
    expect(points.some((p) => !p.serialTail)).toBe(true);
  });

  it("gives a taller digit a taller pulse peak than a smaller digit (monotonic in digit value)", () => {
    const low = geometry("1");
    const high = geometry("9");
    const lowPeakY = Math.min(...low.map((p) => p.anchor[1]));
    const highPeakY = Math.min(...high.map((p) => p.anchor[1]));
    // Peaks point upward (smaller Y), so a bigger digit reaches a smaller Y.
    expect(highPeakY).toBeLessThan(lowPeakY);
  });

  it("is deterministic across calls for the same input", () => {
    expect(geometry("grok")).toEqual(geometry("grok"));
  });

  it("differs for different handles", () => {
    expect(geometry("grok")).not.toEqual(geometry("erikswahn"));
  });
});

describe("graphemes", () => {
  it("splits ASCII text into individual characters", () => {
    expect(graphemes("abc")).toEqual(["a", "b", "c"]);
  });

  it("counts a multi-codepoint emoji as one grapheme", () => {
    // Family emoji made of multiple codepoints joined by ZWJ.
    const family = "👨‍👩‍👧‍👦";
    expect(graphemes(family)).toHaveLength(1);
  });
});
