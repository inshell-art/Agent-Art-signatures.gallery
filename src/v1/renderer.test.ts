import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderSignatureSvg, renderTextSvg, reusableTextCurveLayout } from "../algorithmV1/index.js";
import { GR0K_SCALE } from "./input.js";
import { CARD_RENDERER_VERSION, RENDERER_VERSION, RendererRegistry, RendererUnavailableError, formalSignatureRenderer, renderCardPng, sha256Hex } from "./renderer.js";

const input = { handle: "Alice", gr0kRaw: 22, gr0kScale: GR0K_SCALE, rendererVersion: RENDERER_VERSION };
const utf8 = (value: Uint8Array) => Buffer.from(value).toString("utf8");

describe("formal v1.0.0 renderer adapter", () => {
  it("registers the approved frozen version, not an obsolete development renderer", () => {
    expect(RENDERER_VERSION).toBe("sg-renderer-1.0.0");
    expect(CARD_RENDERER_VERSION).toBe("sg-card-1.0.0");
    expect(formalSignatureRenderer.approved).toBe(true);
    expect(formalSignatureRenderer.version).toBe(RENDERER_VERSION);
    const registry = new RendererRegistry([formalSignatureRenderer]);
    expect(registry.get(RENDERER_VERSION)).toBe(formalSignatureRenderer);
    expect(() => registry.get("sg-renderer-dev-fixture")).toThrow(RendererUnavailableError);
    expect(() => formalSignatureRenderer.render({ ...input, rendererVersion: "sg-renderer-dev-fixture" })).toThrow();
  });

  it("passes the exact handle and unscaled integer seed to the source-of-truth algorithm", () => {
    const rendered = formalSignatureRenderer.render(input);
    expect(utf8(rendered.svgUtf8)).toBe(renderSignatureSvg(input.handle, input.gr0kRaw));
    expect(GR0K_SCALE).toBe(1);
    expect(rendered.width).toBe(1080);
    expect(rendered.height).toBe(1080);
  });

  it("preserves formal labels, paper and ink in the immutable SVG bytes", () => {
    const svg = utf8(formalSignatureRenderer.render(input).svgUtf8);
    expect(svg).toContain('viewBox="0 0 420 420"');
    expect(svg).toContain('width="1080" height="1080"');
    expect(svg).toContain('fill="#f4e7c7"');
    expect(svg).toContain('fill="#000000" stroke="none"');
    expect(svg).toContain('font-size="10" font-weight="200"');
    expect(svg).toContain(">@Alice</text>");
  });

  it("is deterministic without folding the artwork handle's case", () => {
    const first = formalSignatureRenderer.render(input);
    const second = formalSignatureRenderer.render(input);
    expect(sha256Hex(first.svgUtf8)).toBe(sha256Hex(second.svgUtf8));
    const lower = formalSignatureRenderer.render({ ...input, handle: "alice" });
    expect(sha256Hex(first.svgUtf8)).not.toBe(sha256Hex(lower.svgUtf8));
    expect(utf8(first.svgUtf8).match(/<path d="([^"]+)"/)?.[1])
      .not.toBe(utf8(lower.svgUtf8).match(/<path d="([^"]+)"/)?.[1]);
  });

  it("accepts both ends of the formal 1–100 seed range with distinct output", () => {
    const low = formalSignatureRenderer.render({ ...input, gr0kRaw: 1 });
    const high = formalSignatureRenderer.render({ ...input, gr0kRaw: 100 });
    expect(sha256Hex(low.svgUtf8)).not.toBe(sha256Hex(high.svgUtf8));
  });

  it.each([0, 101, -1, 0.5, 500_000, 1_000_000, NaN, Infinity])("rejects obsolete or invalid seed %s", (gr0kRaw) => {
    expect(() => formalSignatureRenderer.render({ ...input, gr0kRaw })).toThrow();
  });

  it("rejects the obsolete decimal fixed-point scale", () => {
    expect(() => formalSignatureRenderer.render({ ...input, gr0kScale: 1_000_000 as typeof GR0K_SCALE })).toThrow();
  });

  it.each(["", "@Alice", "Alice!", "a b", "abcdefghijklmnop", "Alice\n"])("rejects invalid strict handle %s", (handle) => {
    expect(() => formalSignatureRenderer.render({ ...input, handle })).toThrow();
  });

  it("keeps expanded branding reuse separate from strict claimed signatures", () => {
    const text = "What_shape_do_you_go_by?";
    const rendered = formalSignatureRenderer.renderText({ text, gr0kRaw: 22, gr0kScale: GR0K_SCALE, rendererVersion: RENDERER_VERSION });
    const layout = reusableTextCurveLayout(text.length);
    expect(utf8(rendered.svgUtf8)).toBe(renderTextSvg(text, 22));
    expect(rendered.width).toBe(layout.proportionalOutputWidth);
    expect(rendered.height).toBe(1080);
    expect(rendered.width).toBeGreaterThan(1080);
    expect(utf8(rendered.svgUtf8)).toContain(`viewBox="0 0 ${layout.canonicalWidth} 420"`);
    expect(() => formalSignatureRenderer.render({ ...input, handle: text })).toThrow();
  });

  it("rasterizes deterministic 1080px cards with the formal paper color", async () => {
    const svg = formalSignatureRenderer.render(input).svgUtf8;
    const first = await renderCardPng(svg);
    const second = await renderCardPng(svg);
    expect(sha256Hex(first)).toBe(sha256Hex(second));
    const metadata = await sharp(first).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(1080);
    expect(metadata.height).toBe(1080);
    const corner = await sharp(first).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    expect([...corner]).toEqual([0xf4, 0xe7, 0xc7]);
  });
});
