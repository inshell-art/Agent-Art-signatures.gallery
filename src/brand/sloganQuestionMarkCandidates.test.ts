import { describe, expect, it } from "vitest";
import { INK_HOOK_QUESTION_MARK, OPEN_FLOW_QUESTION_MARK } from "./sloganQuestionMark.js";
import { QUESTION_MARK_V2_CANDIDATES } from "./sloganQuestionMarkCandidates.js";

describe("v2 slogan punctuation proposals", () => {
  it("provides three immutable candidates in presentation order", () => {
    expect(QUESTION_MARK_V2_CANDIDATES.map(({ id }) => id)).toEqual([
      "ink-hook", "ribbon-fold", "quiet-solid",
    ]);
    expect(Object.isFrozen(QUESTION_MARK_V2_CANDIDATES)).toBe(true);
    expect(QUESTION_MARK_V2_CANDIDATES.every(Object.isFrozen)).toBe(true);
    expect(new Set(QUESTION_MARK_V2_CANDIDATES.map(({ svgMarkup }) => svgMarkup)).size).toBe(3);
    expect(QUESTION_MARK_V2_CANDIDATES[0]).toBe(INK_HOOK_QUESTION_MARK);
  });

  it("does not reuse or replace the approved Open flow outline", () => {
    expect(OPEN_FLOW_QUESTION_MARK.id).toBe("open-flow");
    expect(QUESTION_MARK_V2_CANDIDATES.some(({ svgMarkup }) => svgMarkup === OPEN_FLOW_QUESTION_MARK.svgMarkup)).toBe(false);
  });

  it.each(QUESTION_MARK_V2_CANDIDATES)("keeps $id font-free, two-part, and within a common frame", ({ label, rationale, svgMarkup }) => {
    expect(label.length).toBeGreaterThan(0);
    expect(rationale.length).toBeGreaterThan(0);
    expect(svgMarkup).toMatch(/^<g fill="currentColor" aria-hidden="true">.*<\/g>$/);
    expect(svgMarkup).not.toMatch(/<(?:text|script|style|svg|image|use)\b|\b(?:font|href|src|transform)[-\w]*=|url\(/i);
    expect(svgMarkup.match(/<(?:path|circle)\b/g)).toHaveLength(2);

    // All path coordinates are absolute. Bézier control points inside this
    // convex frame guarantee the complete curve cannot escape its bounds.
    for (const [, path] of svgMarkup.matchAll(/<path d="([^"]+)"\/>/g)) {
      expect(path).toMatch(/^M[\d.,\sMCQLZ]+Z$/);
      const coordinates = path.match(/\d+(?:\.\d+)?/g)!.map(Number);
      expect(coordinates.length % 2).toBe(0);
      coordinates.forEach((value, index) => {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(index % 2 === 0 ? 30 : 54);
      });
    }
    for (const [, cx, cy, radius] of svgMarkup.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"\/>/g)) {
      expect(Number(cx) - Number(radius)).toBeGreaterThanOrEqual(0);
      expect(Number(cx) + Number(radius)).toBeLessThanOrEqual(30);
      expect(Number(cy) - Number(radius)).toBeGreaterThanOrEqual(0);
      expect(Number(cy) + Number(radius)).toBeLessThanOrEqual(54);
    }
  });
});
