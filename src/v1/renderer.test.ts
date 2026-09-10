import { describe, expect, it } from "vitest";
import { GR0K_SCALE } from "./input.js";
import { DEV_RENDERER_VERSION, developmentFixtureRenderer, sha256Hex } from "./renderer.js";
import { DEFAULT_SETTINGS } from "../algorithm/settings.js";
import { pointsForSettings, renderSvgForText } from "../algorithm/svg.js";

describe("development fixture renderer", () => {
  it("passes literal artwork text to the algorithm without account normalization", () => {
    const text = "What_Shape_Do_You_Go_By?";
    const input = { text, gr0kRaw: 500_000, gr0kScale: GR0K_SCALE, rendererVersion: DEV_RENDERER_VERSION };
    const exact = developmentFixtureRenderer.renderText(input);
    const direct = renderSvgForText(text, DEFAULT_SETTINGS).svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/, "");
    expect(Buffer.from(exact.svgUtf8).toString()).toBe(direct);
    expect(sha256Hex(exact.svgUtf8)).not.toBe(sha256Hex(developmentFixtureRenderer.renderText({ ...input, text: text.toLowerCase() }).svgUtf8));
    expect(pointsForSettings(text, DEFAULT_SETTINGS).filter((point) => point.uppercase)).toHaveLength(6);
    expect(DEFAULT_SETTINGS.stroke.uppercaseExtraWeightPx).toBe(8);
  });

  it("keeps the account renderer byte-identical for already normalized handles", () => {
    const input = { gr0kRaw: 500_000, gr0kScale: GR0K_SCALE, rendererVersion: DEV_RENDERER_VERSION };
    expect(developmentFixtureRenderer.render({ ...input, handleNormalized: "alice" })).toEqual(
      developmentFixtureRenderer.renderText({ ...input, text: "alice" }),
    );
  });

  it("is deterministic and omits system-font labels from artwork bytes", () => {
    const input = { handleNormalized: "alice", gr0kRaw: 371924, gr0kScale: GR0K_SCALE, rendererVersion: DEV_RENDERER_VERSION };
    const first = developmentFixtureRenderer.render(input);
    const second = developmentFixtureRenderer.render(input);
    expect(sha256Hex(first.svgUtf8)).toBe(sha256Hex(second.svgUtf8));
    expect(Buffer.from(first.svgUtf8).toString()).not.toContain("<text");
  });

  it("uses gr0k as an explicit input in fixture mode", () => {
    const low = developmentFixtureRenderer.render({ handleNormalized: "alice", gr0kRaw: 0, gr0kScale: GR0K_SCALE, rendererVersion: DEV_RENDERER_VERSION });
    const high = developmentFixtureRenderer.render({ handleNormalized: "alice", gr0kRaw: GR0K_SCALE, gr0kScale: GR0K_SCALE, rendererVersion: DEV_RENDERER_VERSION });
    expect(sha256Hex(low.svgUtf8)).not.toBe(sha256Hex(high.svgUtf8));
  });
});
