import type { SignatureCompositionSource } from "./signatureComposition.js";

/** Edit this intent first; the checked shape snapshot is a separate review gate. */
export const SLOGAN_COMPOSITION_SOURCE = Object.freeze({
  id: "agent-art-slogan-v7",
  displayText: "What_shape_do_you_go_by?",
  gr0kRaw: 500_000,
} as const satisfies SignatureCompositionSource);
