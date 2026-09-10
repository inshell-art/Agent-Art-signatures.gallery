import {
  describeSignatureComposition,
  renderSignatureCompositionSvg,
  restoreSignatureCompositionSnapshot,
  type SignatureCompositionPresentation,
} from "./signatureComposition.js";
import { SLOGAN_SHAPE_LOCK } from "./sloganShapeLock.js";
import { OPEN_FLOW_QUESTION_MARK } from "./sloganQuestionMark.js";

export const SLOGAN_SIGNATURE_VERSION = "sg-slogan-composition-8.0.0";

/**
 * The renderer-free side of the composition boundary. Importing this module
 * validates every stored token, drawing, and hash but never calls a renderer.
 */
const LOCKED_SLOGAN = restoreSignatureCompositionSnapshot(SLOGAN_SHAPE_LOCK);

// The tooltip, accessible heading, and captured renderer input share one literal.
export const SLOGAN_DISPLAY_TEXT = LOCKED_SLOGAN.displayText;

const curveWidth = LOCKED_SLOGAN.glyphs[0].width;
const DESKTOP_PRESENTATION = {
  viewBox: [35, 145, curveWidth - 50, 120],
  width: Math.round((curveWidth - 50) * 3),
  height: 360,
  placements: [
    { tokenIndex: 0, translateX: 0, translateY: 0, scale: 1 },
  ],
} as const satisfies SignatureCompositionPresentation;

// A connected phrase stays intact at every viewport size.
const MOBILE_PRESENTATION = DESKTOP_PRESENTATION;

export type SloganSignatureLayout = "desktop" | "mobile";

// Readable punctuation is a presentation annotation, not part of the shape lock.
// SVG coordinates keep it beside the curve at every responsive size.
const QUESTION_MARK = `<g class="slogan-signature-punctuation" data-punctuation-id="${OPEN_FLOW_QUESTION_MARK.id}" transform="translate(${curveWidth - 47} 169)" aria-hidden="true">${OPEN_FLOW_QUESTION_MARK.svgMarkup}</g>`;

/** Composes locked drawings, then adds the separate readable question mark. */
export function renderSloganSignatureSvg(layout: SloganSignatureLayout = "desktop"): string {
  const svg = renderSignatureCompositionSvg(
    LOCKED_SLOGAN,
    layout === "mobile" ? MOBILE_PRESENTATION : DESKTOP_PRESENTATION,
  );
  return svg.replace("</svg>", `${QUESTION_MARK}</svg>`);
}

const desktopDescription = describeSignatureComposition(LOCKED_SLOGAN, DESKTOP_PRESENTATION);
const mobileDescription = describeSignatureComposition(LOCKED_SLOGAN, MOBILE_PRESENTATION);

export const SLOGAN_SIGNATURE_MANIFEST = Object.freeze({
  version: SLOGAN_SIGNATURE_VERSION,
  compositionId: LOCKED_SLOGAN.id,
  shapeLockSchema: LOCKED_SLOGAN.shapeLockSchema,
  displayText: SLOGAN_DISPLAY_TEXT,
  rendererInputs: Object.freeze(LOCKED_SLOGAN.tokens.map((token) => token.rendererInput)),
  wordCount: LOCKED_SLOGAN.tokens.length,
  distinctGlyphCount: LOCKED_SLOGAN.glyphs.length,
  sourceRendererVersion: LOCKED_SLOGAN.rendererVersion,
  sourceRendererApproved: LOCKED_SLOGAN.rendererApproved,
  sourceGr0kRaw: LOCKED_SLOGAN.gr0kRaw,
  sourceGr0kScale: LOCKED_SLOGAN.gr0kScale,
  runtimeBoundary: "checked-in-shape-lock",
  normalization: "signature-composition/2: case-preserving underscore-joined phrase as one presentation input; underscores and the trailing question mark enter geometry. Capitals reach the algorithm unchanged.",
  presentationAnnotation: "The authored Open flow ? follows the locked curve; it is not renderer output.",
  punctuation: Object.freeze({ id: OPEN_FLOW_QUESTION_MARK.id, version: OPEN_FLOW_QUESTION_MARK.version }),
  layouts: Object.freeze({
    desktop: desktopDescription,
    mobile: mobileDescription,
  }),
  transparent: true,
} as const);

export const SLOGAN_SIGNATURE_SVG = renderSloganSignatureSvg("desktop");
export const SLOGAN_SIGNATURE_MOBILE_SVG = renderSloganSignatureSvg("mobile");
