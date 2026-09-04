import { describe, expect, it } from "vitest";
import { GR0K_SCALE } from "./input.js";
import { DEV_RENDERER_VERSION, developmentFixtureRenderer, sha256Hex } from "./renderer.js";

describe("development fixture renderer", () => {
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
