import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { homePage, signInRequiredPage } from "../v1/pages.js";
import { formalSignatureRenderer } from "../v1/renderer.js";
import { sloganStudyPage } from "./sloganStudy.js";
import { FAVICON_CSP, FAVICON_LINK, FAVICON_MANIFEST, FAVICON_SVG, FAVICON_URL, FAVICON_VERSION } from "./favicon.js";
import { FAVICON_SHAPE_LOCK } from "./faviconShapeLock.js";
import { captureSignatureComposition, restoreSignatureCompositionSnapshot } from "./signatureComposition.js";

describe("renderer-derived signature favicon", () => {
  it("locks the exact capital S from the signature renderer without lowercasing or redrawing", () => {
    const capture = captureSignatureComposition({ id: FAVICON_SHAPE_LOCK.id, displayText: "S", gr0kRaw: 22 }, formalSignatureRenderer);
    const restored = restoreSignatureCompositionSnapshot(FAVICON_SHAPE_LOCK);
    expect(capture.tokens).toEqual(restored.tokens);
    expect(capture.glyphs).toEqual(restored.glyphs);
    expect(capture.proposedShapeLock).toEqual(restored.verifiedShapeLock);
    expect(FAVICON_MANIFEST).toMatchObject({
      rendererInput: "S",
      rendererVersion: capture.rendererVersion,
      rendererApproved: capture.rendererApproved,
      gr0kRaw: 22,
      sourceSvgSha256: capture.glyphs[0].svgSha256,
      shapeSha256: capture.glyphs[0].shapeSha256,
    });
    expect(FAVICON_SVG.match(/<path /g)).toHaveLength(1);
    expect(FAVICON_SVG).toContain(`d="${capture.glyphs[0].drawing.d}"`);
    expect(FAVICON_SVG).toContain('transform="translate(0 0) scale(1)"');
    const lowercase = captureSignatureComposition({ id: "lowercase-comparison", displayText: "s", gr0kRaw: 22 }, formalSignatureRenderer);
    expect(capture.glyphs[0].drawing.d).not.toBe(lowercase.glyphs[0].drawing.d);
  });

  it("uses a square paper frame and the artwork palette unchanged in both themes", () => {
    expect(FAVICON_SVG).toContain('viewBox="160 141.5 100 100"');
    expect(FAVICON_SVG).toContain('width="64" height="64"');
    expect(FAVICON_SVG).toContain('color="#000000"');
    expect(FAVICON_SVG).toContain('<rect x="160" y="141.5" width="100" height="100" fill="#f4e7c7"/>');
    expect(FAVICON_SVG).toContain('fill="currentColor" stroke="none"');
    expect(FAVICON_MANIFEST.background).toBe("#f4e7c7");
    expect(FAVICON_MANIFEST.ink).toBe("#000000");
    expect(FAVICON_SVG).not.toMatch(/<style|<text|<image|<script|href=|prefers-color-scheme/);
  });

  it("uses a content-versioned URL consistently across product and study pages", () => {
    expect(FAVICON_VERSION).toBe(createHash("sha256").update(FAVICON_SVG).update(FAVICON_CSP).digest("hex").slice(0, 16));
    expect(FAVICON_URL).toBe(`/assets/favicon.svg?v=${FAVICON_VERSION}`);
    for (const html of [homePage(true), signInRequiredPage(true), sloganStudyPage()]) {
      expect(html).toContain(FAVICON_LINK);
      expect(html.match(/rel="icon"/g)).toHaveLength(1);
      expect(html).not.toContain('href="/assets/favicon.svg"');
    }
  });

  it("does not need inline styles or external resources under its strict CSP", () => {
    expect(FAVICON_CSP).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });

  it.each([16, 32, 64])("renders visible ink and opaque paper margins without clipping at %dpx", async size => {
    const { data, info } = await sharp(Buffer.from(FAVICON_SVG)).resize(size, size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    let ink = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      expect(data[offset + 3]).toBe(255);
      if (data[offset] < 100) ink++;
      if (x === 0 || x === size - 1 || y === 0 || y === size - 1) expect([...data.subarray(offset, offset + 3)]).toEqual([244, 231, 199]);
    }
    expect(ink).toBeGreaterThan(size * size * .015);
    expect(ink).toBeLessThan(size * size * .2);
  });
});
