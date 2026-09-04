import { createHash } from "node:crypto";
import sharp from "sharp";
import { DEFAULT_SETTINGS, type Settings } from "../algorithm/settings.js";
import { renderSvgForText } from "../algorithm/svg.js";
import { GR0K_SCALE } from "./input.js";

export const DEV_RENDERER_VERSION = "sg-renderer-dev-fixture";
export const DEV_CARD_RENDERER_VERSION = "sg-card-sharp-dev-fixture";

export interface RenderInput {
  handleNormalized: string;
  gr0kRaw: number;
  gr0kScale: typeof GR0K_SCALE;
  rendererVersion: string;
}

export interface RenderOutput {
  svgUtf8: Uint8Array;
  width: number;
  height: number;
}

export interface SignatureRenderer {
  readonly version: string;
  readonly approved: boolean;
  render(input: RenderInput): RenderOutput;
}

export class RendererUnavailableError extends Error {
  constructor(version: string) {
    super(`Renderer ${version} is not available.`);
    this.name = "RendererUnavailableError";
  }
}

export class RendererRegistry {
  private readonly renderers = new Map<string, SignatureRenderer>();

  constructor(renderers: SignatureRenderer[]) {
    for (const renderer of renderers) this.renderers.set(renderer.version, renderer);
  }

  get(version: string): SignatureRenderer {
    const renderer = this.renderers.get(version);
    if (!renderer) throw new RendererUnavailableError(version);
    return renderer;
  }
}

function fixtureSettings(gr0kRaw: number): Settings {
  const centered = (gr0kRaw - GR0K_SCALE / 2) / (GR0K_SCALE / 2);
  const scaleRange = (range: [number, number], amount: number): [number, number] => {
    const midpoint = (range[0] + range[1]) / 2;
    const halfWidth = ((range[1] - range[0]) / 2) * amount;
    return [midpoint - halfWidth, midpoint + halfWidth];
  };
  return {
    ...DEFAULT_SETTINGS,
    geometry: {
      ...DEFAULT_SETTINGS.geometry,
      handleRotationDegrees: scaleRange(DEFAULT_SETTINGS.geometry.handleRotationDegrees, 1 + centered * 0.3),
      handleLengthPx: [DEFAULT_SETTINGS.geometry.handleLengthPx[0], DEFAULT_SETTINGS.geometry.handleLengthPx[1] * (1 + centered * 0.35)],
      pointYShiftPx: scaleRange(DEFAULT_SETTINGS.geometry.pointYShiftPx, 1 - centered * 0.35),
    },
    stroke: { ...DEFAULT_SETTINGS.stroke, baseWeightPx: DEFAULT_SETTINGS.stroke.baseWeightPx * (1 + centered * 0.28) },
  };
}

/**
 * Development-only adapter used to make the V1 product flow inspectable.
 * It is deliberately not named sg-renderer-1.0.0 and production startup
 * rejects it. The approved scalar mapping and golden hashes remain a launch
 * dependency supplied by the art project.
 */
export const developmentFixtureRenderer: SignatureRenderer = {
  version: DEV_RENDERER_VERSION,
  approved: false,
  render(input): RenderOutput {
    if (
      input.rendererVersion !== DEV_RENDERER_VERSION ||
      input.gr0kScale !== GR0K_SCALE ||
      !Number.isInteger(input.gr0kRaw) ||
      input.gr0kRaw < 0 ||
      input.gr0kRaw > GR0K_SCALE
    ) {
      throw new Error("Invalid development renderer input.");
    }

    const svg = renderSvgForText(input.handleNormalized, fixtureSettings(input.gr0kRaw)).svg
      .replace(/<text\b[^>]*>[\s\S]*?<\/text>/, "");

    return { svgUtf8: Buffer.from(svg, "utf8"), width: 420, height: 420 };
  },
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function renderCardPng(svgUtf8: Uint8Array): Promise<Buffer> {
  return sharp(svgUtf8)
    .resize(840, 840, { fit: "fill" })
    .png({ compressionLevel: 9, progressive: false, palette: false })
    .toBuffer();
}
