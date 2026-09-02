/**
 * SVG -> PNG rasterization (handoff §9.1: "og:image must be PNG, JPEG, WEBP
 * or GIF. SVG is not accepted by X. Store both: SVG as the source of truth,
 * PNG for the card.").
 *
 * Real implementation (not a placeholder) — this step doesn't depend on the
 * algorithm's contents, only on it producing valid SVG text.
 */

import sharp from "sharp";

export async function rasterizeSvgToPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer();
}
