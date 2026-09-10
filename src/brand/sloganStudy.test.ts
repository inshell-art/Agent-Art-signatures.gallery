import { describe, expect, it, vi } from "vitest";
import { developmentFixtureRenderer } from "../v1/renderer.js";
import { captureSignatureComposition } from "./signatureComposition.js";
import { OPEN_FLOW_QUESTION_MARK, QUESTION_MARK_STUDIES } from "./sloganQuestionMark.js";
import { SLOGAN_SHAPE_LOCK } from "./sloganShapeLock.js";
import { SLOGAN_SIGNATURE_MANIFEST, SLOGAN_SIGNATURE_SVG } from "./sloganSignature.js";
import { SLOGAN_CASE_STUDIES, SLOGAN_COPY_STUDIES, sloganStudyPage } from "./sloganStudy.js";

function article(html: string, kind: "copy" | "mark" | "case", id: string): string {
  const match = html.match(new RegExp(`<article\\b[^>]*data-${kind}-id="${id}"[^>]*>[\\s\\S]*?<\\/article>`));
  expect(match, `Expected the ${kind} study ${id}`).not.toBeNull();
  return match![0];
}

function generatedPath(html: string): string {
  const match = html.match(/<g class="study-generated-shape"><path d="([^"]+)"/);
  expect(match, "Expected an untransformed generated path").not.toBeNull();
  return match![1];
}

describe("local slogan design study", () => {
  it("presents the approved pair and retains two independently rendered copy comparisons", () => {
    const html = sloganStudyPage();
    expect(SLOGAN_COPY_STUDIES.map((item) => item.id)).toEqual(["go-by", "handle", "name"]);
    expect(html.match(/data-copy-id=/g)).toHaveLength(3);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain("The sentence-case version is now on the homepage.");
    expect(html).not.toContain("legacy lowercase rendering");
    expect(html).toContain("Further studies do not mutate the accepted shape lock.");
    expect(article(html, "copy", "go-by")).toContain("Selected · sentence case on homepage");
    expect(article(html, "copy", "name")).toContain("Previous wording · comparison");
    expect(html).toContain("Compare the approved homepage artwork");
    expect(html).not.toContain("Georgia question mark");
    expect(html).not.toContain("not published");
    expect(article(html, "copy", "go-by")).toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    expect(SLOGAN_SIGNATURE_SVG).toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    expect(html).toContain("not an identity or reputation score");
    expect(html).toContain("unapproved local renderer");
    expect(html).not.toContain("<script");
  });

  it.each(SLOGAN_COPY_STUDIES)("renders $id from its own complete, underscore-joined words", (item) => {
    const rendererInput = item.text.replaceAll(" ", "_");
    const expected = captureSignatureComposition({
      id: `independent-study-check-${item.id}`,
      displayText: item.text.replaceAll(" ", "_"),
      gr0kRaw: 500_000,
    }, developmentFixtureRenderer);
    const row = article(sloganStudyPage(), "copy", item.id);
    expect(expected.glyphs).toHaveLength(1);
    expect(expected.glyphs[0].rendererInput).toBe(rendererInput);
    expect(row).toContain(`data-renderer-input="${rendererInput}"`);
    expect(row).toContain(`data-shape-sha256="${expected.glyphs[0].shapeSha256}"`);
    expect(generatedPath(row)).toBe(expected.glyphs[0].drawing.d);
    expect(generatedPath(row) === SLOGAN_SHAPE_LOCK.glyphs[0].drawing.d).toBe(rendererInput === SLOGAN_SHAPE_LOCK.displayText);
  });

  it("passes the exact spelling of all new study inputs through the text interface", () => {
    const renderer = vi.spyOn(developmentFixtureRenderer, "renderText");
    const handleRenderer = vi.spyOn(developmentFixtureRenderer, "render");
    try {
      const html = sloganStudyPage();
      expect(handleRenderer).not.toHaveBeenCalled();
      expect(renderer).toHaveBeenCalledTimes(4);
      expect(renderer.mock.calls.map(([input]) => input.text)).toEqual([
        "What_shape_is_your_handle?",
        "What_shape_is_your_name?",
        "What_shape_do_you_go_by?",
        "What_Shape_Do_You_Go_By?",
      ]);
      for (const [input] of renderer.mock.calls) {
        expect(input).toMatchObject({
          gr0kRaw: 500_000,
          gr0kScale: 1_000_000,
          rendererVersion: developmentFixtureRenderer.version,
        });
      }
      expect(generatedPath(article(html, "copy", "go-by"))).toBe(SLOGAN_SHAPE_LOCK.glyphs[0].drawing.d);
      expect(html).toContain(SLOGAN_SIGNATURE_SVG);
    } finally {
      renderer.mockRestore();
      handleRenderer.mockRestore();
    }
  });

  it("compares current and title-case literals without erasing their case difference", () => {
    expect(SLOGAN_CASE_STUDIES.map((item) => item.text)).toEqual([
      "What_shape_do_you_go_by?",
      "What_Shape_Do_You_Go_By?",
    ]);
    const html = sloganStudyPage();
    const current = article(html, "case", "current");
    const proposed = article(html, "case", "title-case");
    expect(html.match(/data-case-id=/g)).toHaveLength(2);
    expect(html).toContain('href="#letter-case"');
    expect(html).toContain('data-identical-shapes="false"');
    expect(html).toContain("Different inputs. Different shapes. Case reaches the algorithm intact.");
    expect(generatedPath(current)).not.toBe(generatedPath(proposed));
    expect(html).not.toContain("adapter lowercases");
    for (const [index, row] of [current, proposed].entries()) {
      const literal = SLOGAN_CASE_STUDIES[index].text;
      const captured = captureSignatureComposition({
        id: `case-check-${index}`,
        displayText: literal,
        gr0kRaw: 500_000,
      }, developmentFixtureRenderer);
      expect(row).toContain(`data-source-literal="${literal}"`);
      expect(row).toContain(`title="${literal}"`);
      expect(row).toContain(`data-renderer-input="${literal}"`);
      expect(row).toContain(`data-shape-sha256="${captured.glyphs[0].shapeSha256}"`);
      expect(generatedPath(row)).toBe(captured.glyphs[0].drawing.d);
      if (index === 0) {
        expect(generatedPath(row)).toBe(SLOGAN_SHAPE_LOCK.glyphs[0].drawing.d);
        expect(row).toContain("Selected · sentence case on homepage");
      } else {
        expect(generatedPath(row)).not.toBe(SLOGAN_SHAPE_LOCK.glyphs[0].drawing.d);
        expect(row).toContain("Title case · comparison");
      }
      expect(row).toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
      expect(row).toContain('viewBox="35 145 370 100"');
    }
  });

  it.each(QUESTION_MARK_STUDIES)("shows $id beside the exact locked curve and as two font-free specimens", (mark) => {
    const row = article(sloganStudyPage(), "mark", mark.id);
    expect(generatedPath(row)).toBe(SLOGAN_SHAPE_LOCK.glyphs[0].drawing.d);
    expect(row).toContain(`<g class="study-punctuation" transform="translate(373 169)">${mark.svgMarkup}</g>`);
    expect(row.split(mark.svgMarkup)).toHaveLength(4);
    expect(row.match(/viewBox="0 0 30 54"/g)).toHaveLength(2);
    expect(row).toContain('viewBox="35 145 370 100"');
    expect(row).toContain('width="1110" height="300"');
    expect(row).toContain('class="study-mark-large"');
    expect(row).toContain('class="study-mark-small"');
    expect(row).not.toMatch(/<(?:text|script|image|use)\b|font-family=|matrix\(|scale\(/i);
  });

  it("does not mutate the homepage artwork, manifest, or accepted shape lock", () => {
    const lockBefore = JSON.stringify(SLOGAN_SHAPE_LOCK);
    const manifestBefore = JSON.stringify(SLOGAN_SIGNATURE_MANIFEST);
    const svgBefore = SLOGAN_SIGNATURE_SVG;
    const html = sloganStudyPage();
    expect(sloganStudyPage()).toBe(html);
    expect(JSON.stringify(SLOGAN_SHAPE_LOCK)).toBe(lockBefore);
    expect(JSON.stringify(SLOGAN_SIGNATURE_MANIFEST)).toBe(manifestBefore);
    expect(SLOGAN_SIGNATURE_SVG).toBe(svgBefore);
    expect(html).toContain(svgBefore);
    expect(SLOGAN_SHAPE_LOCK.displayText).toBe("What_shape_do_you_go_by?");
    expect(SLOGAN_SHAPE_LOCK.schema).toBe("signature-composition/2");
    expect(SLOGAN_SHAPE_LOCK.verifiedShapeLock).toEqual({
      "What_shape_do_you_go_by?": "142988f78977033590a0bd286f08e46392e99ef86e8da23aa80702304f883f4b",
    });
  });
});
