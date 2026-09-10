import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureSignatureComposition, restoreSignatureCompositionSnapshot } from "./signatureComposition.js";
import {
  renderSloganSignatureSvg,
  SLOGAN_DISPLAY_TEXT,
  SLOGAN_SIGNATURE_MANIFEST,
  SLOGAN_SIGNATURE_MOBILE_SVG,
  SLOGAN_SIGNATURE_SVG,
  SLOGAN_SIGNATURE_VERSION,
} from "./sloganSignature.js";
import { SLOGAN_SHAPE_LOCK } from "./sloganShapeLock.js";
import { SLOGAN_COMPOSITION_SOURCE } from "./sloganCompositionSpec.js";
import { OPEN_FLOW_QUESTION_MARK } from "./sloganQuestionMark.js";
import { formalSignatureRenderer } from "../v1/renderer.js";

const EXPECTED_INPUTS = [
  "What_shape_do_you_go_by?",
] as const;
const EXPECTED_SHAPE_HASH = "cc0e4cea391e4f44e2d9f3fd4f4aeed8ad722ff40e9a8b2274c308ac24cd178f";
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("shape-locked brand slogan composition", () => {
  it("preserves the approved literal while documenting the canonical renderer stream", () => {
    expect(SLOGAN_DISPLAY_TEXT).toBe("What_shape_do_you_go_by?");
    expect(SLOGAN_DISPLAY_TEXT).toBe(SLOGAN_SHAPE_LOCK.displayText);
    expect(SLOGAN_DISPLAY_TEXT.match(/_/g)).toHaveLength(5);
    expect(SLOGAN_SIGNATURE_VERSION).toBe("sg-slogan-composition-8.0.0");
    expect(SLOGAN_SIGNATURE_MANIFEST).toMatchObject({
      version: SLOGAN_SIGNATURE_VERSION,
      compositionId: "agent-art-slogan-v8",
      shapeLockSchema: "signature-shape-lock/1",
      displayText: "What_shape_do_you_go_by?",
      rendererInputs: EXPECTED_INPUTS,
      wordCount: 1,
      distinctGlyphCount: 1,
      sourceRendererVersion: "sg-renderer-1.0.0",
      sourceRendererApproved: true,
      sourceGr0kRaw: 22,
      sourceGr0kScale: 1,
      runtimeBoundary: "checked-in-shape-lock",
      punctuation: {
        id: "open-flow",
        version: "sg-question-mark-open-flow-1",
      },
      transparent: true,
    });
    expect(SLOGAN_SIGNATURE_MANIFEST.normalization).toContain("underscore-joined phrase as one presentation input");
    expect(SLOGAN_SIGNATURE_MANIFEST.normalization).toContain("underscores and the trailing question mark enter geometry");
    expect(SLOGAN_SIGNATURE_MANIFEST.presentationAnnotation).toContain("not renderer output");
    expect(SLOGAN_COMPOSITION_SOURCE).toEqual({
      id: SLOGAN_SHAPE_LOCK.id,
      displayText: SLOGAN_SHAPE_LOCK.displayText,
      gr0kRaw: SLOGAN_SHAPE_LOCK.gr0kRaw,
    });
  });

  it("restores the checked-in drawings without a renderer and validates every lock", () => {
    const restored = restoreSignatureCompositionSnapshot(SLOGAN_SHAPE_LOCK);
    expect(restored.tokens.map((token) => token.rendererInput)).toEqual(EXPECTED_INPUTS);
    expect(restored.glyphs).toHaveLength(1);
    expect(Object.keys(restored.verifiedShapeLock)).toEqual(EXPECTED_INPUTS);
    expect(restored.verifiedShapeLock).toEqual({ [EXPECTED_INPUTS[0]]: EXPECTED_SHAPE_HASH });
    expect(restored.glyphs[0].shapeSha256).toBe(EXPECTED_SHAPE_HASH);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.glyphs)).toBe(true);
    expect(Object.isFrozen(restored.glyphs[0].drawing)).toBe(true);
  });

  it("reproduces the selected sentence-case drawing from the exact source literal", () => {
    const captured = captureSignatureComposition(
      {
        ...SLOGAN_COMPOSITION_SOURCE,
        displayText: SLOGAN_SHAPE_LOCK.tokens[0].rendererInput,
      },
      formalSignatureRenderer,
    );
    expect(captured.glyphs[0].drawing).toEqual(SLOGAN_SHAPE_LOCK.glyphs[0].drawing);
    expect(captured.glyphs[0].svgSha256).toBe(SLOGAN_SHAPE_LOCK.glyphs[0].svgSha256);
    expect(captured.proposedShapeLock).toEqual(SLOGAN_SHAPE_LOCK.verifiedShapeLock);
    const literal = captureSignatureComposition(SLOGAN_COMPOSITION_SOURCE, formalSignatureRenderer);
    expect(literal.schema).toBe("signature-composition/2");
    expect(literal.glyphs[0].rendererInput).toBe(SLOGAN_DISPLAY_TEXT);
    expect(literal.tokens).toEqual(SLOGAN_SHAPE_LOCK.tokens);
    expect(literal.glyphs).toEqual(SLOGAN_SHAPE_LOCK.glyphs);
  });

  it.each([
    ["desktop", SLOGAN_SIGNATURE_SVG, "35 145 562.8571428571429 120", 1_689, 360],
    ["mobile", SLOGAN_SIGNATURE_MOBILE_SVG, "35 145 562.8571428571429 120", 1_689, 360],
  ] as const)("renders the %s layout as one intact phrase", (layout, svg, viewBox, width, height) => {
    expect(renderSloganSignatureSvg(layout)).toBe(svg);
    expect(svg).toContain(`<svg viewBox="${viewBox}"`);
    expect(svg).toContain(`width="${width}" height="${height}"`);
    expect(svg.match(/<g transform="translate\([^)]*\) scale\(1\)">/g)).toHaveLength(1);
    expect(svg.match(/<path\b/g)).toHaveLength(2);
    expect(svg.match(/<circle\b/g)).toHaveLength(1);
    expect(svg.match(/fill="currentColor"/g)).toHaveLength(2);
    expect(svg).not.toContain("matrix(");
    expect(svg).not.toMatch(/scale\([^)]*[, ]+[^)]*\)/);
    expect(svg).not.toContain("<rect");
    expect(svg).not.toMatch(/<text\b|font-family=/);
    expect(svg).toContain('class="slogan-signature-punctuation"');
    expect(svg).toContain('transform="translate(565.8571428571429 169)"');
    expect(svg).toContain(OPEN_FLOW_QUESTION_MARK.svgMarkup);
    expect(svg).not.toContain("<script");
    expect(svg).not.toMatch(/\b(?:href|src)=/);
    expect(svg).not.toContain("url(");
    expect(svg).not.toContain(SLOGAN_DISPLAY_TEXT);
  });

  it("keeps all underscore connections and the question mark in the same locked path at both viewport sizes", () => {
    expect(SLOGAN_SIGNATURE_MOBILE_SVG).toBe(SLOGAN_SIGNATURE_SVG);
    expect(SLOGAN_SHAPE_LOCK.displayText).toBe("What_shape_do_you_go_by?");
    expect(SLOGAN_SHAPE_LOCK.tokens[0].rendererInput).toBe("What_shape_do_you_go_by?");
    expect(SLOGAN_SHAPE_LOCK.tokens[0].rendererInput).toHaveLength(24);
    const pathData = Array.from(SLOGAN_SIGNATURE_SVG.matchAll(/<path d="([^"]+)"/g), (match) => match[1]);
    expect(pathData).toHaveLength(2);
    expect(pathData[0]).toBe(SLOGAN_SHAPE_LOCK.glyphs[0].drawing.d);
    expect(SLOGAN_SIGNATURE_SVG).not.toContain("what_shape_is_your_name?");
  });

  it("freezes the approved font-free Open flow punctuation independently of the generated drawing", () => {
    expect(OPEN_FLOW_QUESTION_MARK).toMatchObject({
      id: "open-flow",
      version: "sg-question-mark-open-flow-1",
    });
    expect(Object.isFrozen(OPEN_FLOW_QUESTION_MARK)).toBe(true);
    expect(OPEN_FLOW_QUESTION_MARK.svgMarkup.match(/<path\b/g)).toHaveLength(1);
    expect(OPEN_FLOW_QUESTION_MARK.svgMarkup).toContain('<circle cx="12.5" cy="43" r="1.9"/>');
    expect(OPEN_FLOW_QUESTION_MARK.svgMarkup).toContain('aria-hidden="true"');
    expect(digest(OPEN_FLOW_QUESTION_MARK.svgMarkup)).toBe("c4787763b5c897944d9e32c39af80288abeaf9ec38bb9ab8f5d096d59b3a0ee7");
  });

  it("keeps layout transforms independent from the renderer and shape lock", () => {
    expect(SLOGAN_SIGNATURE_MANIFEST.layouts.desktop.placements).toHaveLength(1);
    expect(SLOGAN_SIGNATURE_MANIFEST.layouts.mobile.placements).toHaveLength(1);
    expect(SLOGAN_SIGNATURE_MANIFEST.layouts.desktop.placements.every((placement) => placement.scale === 1)).toBe(true);
    expect(SLOGAN_SIGNATURE_MANIFEST.layouts.mobile.placements.every((placement) => placement.scale === 1)).toBe(true);
    expect(SLOGAN_SIGNATURE_MANIFEST.layouts.desktop.viewBox).toBe("35 145 562.8571428571429 120");
    expect(SLOGAN_SIGNATURE_MANIFEST.layouts.mobile.viewBox).toBe("35 145 562.8571428571429 120");
  });

  it("has a renderer-free runtime presentation module", () => {
    const source = readFileSync(new URL("./sloganSignature.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["'][^"']*\/renderer\.(?:js|ts)["']/);
    expect(source).not.toContain("renderSvgForText");
    expect(source).toContain("restoreSignatureCompositionSnapshot");
  });

  it("matches frozen composite SVG hashes", () => {
    expect(digest(SLOGAN_SIGNATURE_SVG)).toBe("c914e3aa9c71c28e7298693ae1fd7b78a533ff20597367640592c2b31d7a0e44");
    expect(digest(SLOGAN_SIGNATURE_MOBILE_SVG)).toBe("c914e3aa9c71c28e7298693ae1fd7b78a533ff20597367640592c2b31d7a0e44");
  });
});
