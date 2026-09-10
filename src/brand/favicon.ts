import { createHash } from "node:crypto";
import { FORMAL_BACKGROUND, FORMAL_INK } from "../algorithmV1/index.js";
import { FAVICON_SHAPE_LOCK } from "./faviconShapeLock.js";
import { renderSignatureCompositionSvg, restoreSignatureCompositionSnapshot, type SignatureCompositionPresentation } from "./signatureComposition.js";

/** The same checked shape boundary as the slogan: no runtime rendering,
 * lowercasing, redrawing, or non-uniform scaling. This is not a claimed work. */
const composition = restoreSignatureCompositionSnapshot(FAVICON_SHAPE_LOCK);
const presentation = {
  viewBox: [160, 141.5, 100, 100],
  width: 64,
  height: 64,
  placements: [{ tokenIndex: 0, translateX: 0, translateY: 0, scale: 1 }],
} as const satisfies SignatureCompositionPresentation;
// Frozen Signature Algorithm v1.0.0 artwork palette.
const background = FORMAL_BACKGROUND;
const ink = FORMAL_INK;
const [x, y, width, height] = presentation.viewBox;
const composed = renderSignatureCompositionSvg(composition, presentation);

export const FAVICON_SVG = composed
  .replace('fill="none" aria-hidden="true" focusable="false"', `color="${ink}"`)
  .replace(">", `><title>Signatures Gallery</title><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${background}"/>`);

export const FAVICON_MANIFEST = Object.freeze({
  rendererInput: composition.tokens[0].rendererInput,
  rendererVersion: composition.rendererVersion,
  rendererApproved: composition.rendererApproved,
  gr0kRaw: composition.gr0kRaw,
  sourceSvgSha256: composition.glyphs[0].svgSha256,
  shapeSha256: composition.glyphs[0].shapeSha256,
  viewBox: presentation.viewBox,
  background,
  ink,
});

// Artwork colors remain the same in both themes; no embedded styles are needed.
export const FAVICON_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const FAVICON_VERSION = createHash("sha256").update(FAVICON_SVG).update(FAVICON_CSP).digest("hex").slice(0, 16);
export const FAVICON_URL = `/assets/favicon.svg?v=${FAVICON_VERSION}`;
export const FAVICON_LINK = `<link rel="icon" href="${FAVICON_URL}" type="image/svg+xml" sizes="any">`;
