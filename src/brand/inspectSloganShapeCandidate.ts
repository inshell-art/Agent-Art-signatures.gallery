import {
  captureSignatureComposition,
  createSignatureCompositionSnapshot,
  SIGNATURE_SHAPE_LOCK_SCHEMA,
  type CompiledSignatureComposition,
} from "./signatureComposition.js";
import { SLOGAN_COMPOSITION_SOURCE } from "./sloganCompositionSpec.js";
import { SLOGAN_SHAPE_LOCK } from "./sloganShapeLock.js";
import { developmentFixtureRenderer } from "../v1/renderer.js";
import { formatGr0k } from "../v1/input.js";

const capture = captureSignatureComposition(SLOGAN_COMPOSITION_SOURCE, developmentFixtureRenderer);
const candidate = createSignatureCompositionSnapshot({
  ...capture,
  shapeLockSchema: SIGNATURE_SHAPE_LOCK_SCHEMA,
  verifiedShapeLock: capture.proposedShapeLock,
} satisfies CompiledSignatureComposition);

const lockedGlyphs = new Map<string, (typeof SLOGAN_SHAPE_LOCK.glyphs)[number]>(
  SLOGAN_SHAPE_LOCK.glyphs.map((glyph) => [glyph.rendererInput, glyph]),
);
const candidateGlyphs = new Map(candidate.glyphs.map((glyph) => [glyph.rendererInput, glyph]));
const words = new Set([...lockedGlyphs.keys(), ...candidateGlyphs.keys()]);
const rows = Array.from(words, (word) => {
  const locked = lockedGlyphs.get(word);
  const next = candidateGlyphs.get(word);
  const status = !locked ? "ADDED" : !next ? "REMOVED" : locked.shapeSha256 === next.shapeSha256 ? "UNCHANGED" : "CHANGED";
  return `${status.padEnd(9)} ${word.padEnd(15)} ${next?.shapeSha256 ?? "-"}`;
});

const headerMatches =
  String(candidate.schema) === String(SLOGAN_SHAPE_LOCK.schema) &&
  candidate.id === SLOGAN_SHAPE_LOCK.id &&
  candidate.displayText === SLOGAN_SHAPE_LOCK.displayText &&
  candidate.rendererVersion === SLOGAN_SHAPE_LOCK.rendererVersion &&
  candidate.rendererApproved === SLOGAN_SHAPE_LOCK.rendererApproved &&
  candidate.gr0kRaw === SLOGAN_SHAPE_LOCK.gr0kRaw &&
  candidate.gr0kScale === SLOGAN_SHAPE_LOCK.gr0kScale;
const tokensMatch = JSON.stringify(candidate.tokens) === JSON.stringify(SLOGAN_SHAPE_LOCK.tokens);
const glyphsMatch = JSON.stringify(candidate.glyphs) === JSON.stringify(SLOGAN_SHAPE_LOCK.glyphs);
const lockMatches = JSON.stringify(candidate.verifiedShapeLock) === JSON.stringify(SLOGAN_SHAPE_LOCK.verifiedShapeLock);
const exactMatch = headerMatches && tokensMatch && glyphsMatch && lockMatches;

const output = [
  `Signature composition candidate: ${exactMatch ? "EXACT MATCH" : "REVIEW REQUIRED"}`,
  `Renderer ${candidate.rendererVersion} · gr0k ${formatGr0k(candidate.gr0kRaw)} (${candidate.gr0kRaw}/${candidate.gr0kScale})`,
  `Copy: ${candidate.displayText}`,
  `Input policy: ${candidate.schema} (literal case) · locked ${SLOGAN_SHAPE_LOCK.schema}`,
  `Occurrences ${candidate.tokens.length} · distinct shapes ${candidate.glyphs.length}`,
  "",
  ...rows,
];

if (process.argv.includes("--json")) {
  output.push("", "Candidate snapshot JSON:", JSON.stringify(candidate, null, 2));
}
process.stdout.write(`${output.join("\n")}\n`);
if (process.argv.includes("--check") && !exactMatch) process.exitCode = 1;
