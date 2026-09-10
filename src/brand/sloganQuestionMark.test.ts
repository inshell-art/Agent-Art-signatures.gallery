import { describe, expect, it } from "vitest";
import { QUESTION_MARK_STUDIES } from "./sloganQuestionMark.js";

describe("authored slogan question-mark studies", () => {
  it("provides two distinct immutable candidates", () => {
    expect(QUESTION_MARK_STUDIES).toHaveLength(2);
    expect(new Set(QUESTION_MARK_STUDIES.map((study) => study.id)).size).toBe(2);
    expect(new Set(QUESTION_MARK_STUDIES.map((study) => study.svgMarkup)).size).toBe(2);
    expect(Object.isFrozen(QUESTION_MARK_STUDIES)).toBe(true);
    expect(QUESTION_MARK_STUDIES.every(Object.isFrozen)).toBe(true);
  });

  it.each(QUESTION_MARK_STUDIES)("keeps $id font-free, self-contained and in the local frame", (study) => {
    expect(study.label.length).toBeGreaterThan(0);
    expect(study.rationale.length).toBeGreaterThan(0);
    expect(study.svgMarkup).toMatch(/^<g fill="currentColor" aria-hidden="true">.*<\/g>$/);
    expect(study.svgMarkup).not.toMatch(/<(?:text|script|style|svg|image|use)\b|\b(?:font|href|src|transform)[-\w]*=|url\(/i);
    expect(study.svgMarkup.match(/<(?:path|circle)\b/g)).toHaveLength(2);

    // Every path uses absolute coordinates. Keeping even its control points
    // in this convex frame guarantees its Bézier curves stay inside it.
    for (const [, path] of study.svgMarkup.matchAll(/<path d="([^"]+)"/g)) {
      expect(path).toMatch(/^M[\d.,\sMCQLZ]+Z$/);
      const coordinates = path.match(/\d+(?:\.\d+)?/g)!.map(Number);
      expect(coordinates.length % 2).toBe(0);
      coordinates.forEach((coordinate, index) => {
        expect(coordinate).toBeGreaterThanOrEqual(0);
        expect(coordinate).toBeLessThanOrEqual(index % 2 === 0 ? 30 : 54);
      });
    }
    for (const [, cx, cy, r] of study.svgMarkup.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"\/>/g)) {
      expect(Number(cx) - Number(r)).toBeGreaterThanOrEqual(0);
      expect(Number(cx) + Number(r)).toBeLessThanOrEqual(30);
      expect(Number(cy) - Number(r)).toBeGreaterThanOrEqual(0);
      expect(Number(cy) + Number(r)).toBeLessThanOrEqual(54);
    }
  });
});
