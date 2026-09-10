import { createHash } from "node:crypto";
import sharp from "sharp";
import { renderSignatureSvg, renderTextSvg } from "../algorithmV1/index.js";
import { GR0K_SCALE, formatGr0k } from "./input.js";

export const RENDERER_VERSION = "sg-renderer-1.0.0";
export const CARD_RENDERER_VERSION = "sg-card-1.0.0";

export interface RenderInput {
  /** Exact, case-sensitive artwork input; not a normalized account identifier. */
  handle: string;
  gr0kRaw: number;
  gr0kScale: typeof GR0K_SCALE;
  rendererVersion: string;
}
export interface RenderOutput { svgUtf8: Uint8Array; width: number; height: number }
export interface SignatureRenderer {
  readonly version: string;
  readonly approved: boolean;
  render(input: RenderInput): RenderOutput;
}
export interface TextRenderInput {
  text: string;
  gr0kRaw: number;
  gr0kScale: typeof GR0K_SCALE;
  rendererVersion: string;
}
export interface SignatureTextRenderer {
  readonly version: string;
  readonly approved: boolean;
  renderText(input: TextRenderInput): RenderOutput;
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
function validate(input: Pick<RenderInput, "gr0kRaw" | "gr0kScale" | "rendererVersion">): void {
  if (input.rendererVersion !== RENDERER_VERSION || input.gr0kScale !== GR0K_SCALE) throw new Error("Invalid formal renderer input.");
  formatGr0k(input.gr0kRaw);
}
function output(svg: string): RenderOutput {
  const width = Number(/\bwidth="([\d.]+)"/.exec(svg)?.[1]);
  const height = Number(/\bheight="([\d.]+)"/.exec(svg)?.[1]);
  if (!width || !height) throw new Error("Renderer output dimensions are missing.");
  return { svgUtf8: Buffer.from(svg, "utf8"), width, height };
}
/** Frozen Signature Algorithm v1.0.0. Geometry, labels and colors match its reference SVG. */
export const formalSignatureRenderer: SignatureRenderer & SignatureTextRenderer = {
  version: RENDERER_VERSION,
  approved: true,
  render(input) {
    validate(input);
    return output(renderSignatureSvg(input.handle, input.gr0kRaw));
  },
  renderText(input) {
    validate(input);
    return output(renderTextSvg(input.text, input.gr0kRaw));
  },
};
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function renderCardPng(svgUtf8: Uint8Array): Promise<Buffer> {
  return sharp(svgUtf8).resize(1080, 1080, { fit: "fill" })
    .png({ compressionLevel: 9, progressive: false, palette: false }).toBuffer();
}
