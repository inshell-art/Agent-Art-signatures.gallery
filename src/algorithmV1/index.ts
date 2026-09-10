/**
 * Exact port of Signature Field v1.0.0, frozen upstream commit
 * 1e1dab4ec093261006feb7879c109413c0b3ac6d. The checked-in Python is the oracle.
 * Do not add gallery-specific deformation, case folding, or seed scaling here.
 */
import { createHash } from "node:crypto";

export const FORMAL_ALGORITHM_VERSION = "1.0.0";
export const FORMAL_BACKGROUND = "#f4e7c7";
export const FORMAL_INK = "#000000";
export const DEFAULT_OUTPUT_SIZE = 1080;
export const DEFAULT_GR0K_RAW = 22;
const CANONICAL_HEIGHT = 420;
const REFERENCE_SPAN = 300;
const REFERENCE_SEGMENT_WIDTH = REFERENCE_SPAN / 14;
// Python fullmatch does not accept the final newline tolerated by JavaScript $.
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}(?![\s\S])/;

export type SvgSize = { width?: number; height?: number };
type Vector = [number, number];
type Scope = Record<string, unknown>;
type Point = {
  character: string;
  uppercase: boolean;
  serialTail: boolean;
  anchor: Vector;
  incoming: Vector;
  outgoing: Vector;
};
type SeededValue = {
  angle: number;
  angleDelta: number;
  incomingLength: number;
  outgoingLength: number;
  canonicalYShift: number;
  gr0kYShift: number;
};

/** Release-defined layout policy for reuse outside the strict X-handle API. */
export function reusableTextCurveLayout(characterCount: number) {
  if (!Number.isSafeInteger(characterCount) || characterCount < 1) {
    throw new RangeError("character_count must be a positive integer");
  }
  const extended = characterCount > 15;
  const curveSpan = extended ? REFERENCE_SEGMENT_WIDTH * (characterCount - 1) : REFERENCE_SPAN;
  const canonicalWidth = extended ? curveSpan + 120 : CANONICAL_HEIGHT;
  return {
    extended,
    characterCount,
    referenceCharacterLimit: 15,
    segmentWidth: REFERENCE_SEGMENT_WIDTH,
    curveSpan,
    canonicalWidth,
    canonicalHeight: CANONICAL_HEIGHT,
    proportionalOutputWidth: roundHalfEven(DEFAULT_OUTPUT_SIZE * canonicalWidth / CANONICAL_HEIGHT),
    proportionalOutputHeight: DEFAULT_OUTPUT_SIZE,
  };
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashToUnitFloat(scope: Scope, parameter: string): number {
  const payload = canonicalJson({ namespace: "signature-field", parameter, scheme: "sha256-labeled-u53", scope });
  const digest = createHash("sha256").update(payload, "utf8").digest();
  const first32 = digest.readUInt32BE(0);
  const next21 = digest.readUInt32BE(4) >>> 11;
  return (first32 * 2 ** 21 + next21) / 2 ** 53;
}

function variantSigned(scope: Scope, parameter: string, gr0kRaw: number): number {
  return 2 * hashToUnitFloat({ ...scope, gr0k_raw: gr0kRaw }, `gr0k/${parameter}`) - 1;
}

const characterScope = (character: string): Scope => ({ kind: "x-handle-character", value: character });
const isUppercase = (character: string) => character >= "A" && character <= "Z";
const isDigit = (character: string) => character >= "0" && character <= "9";
const mapRange = (unit: number, minimum: number, maximum: number) => minimum + unit * (maximum - minimum);
const radians = (degrees: number) => degrees * (Math.PI / 180);

function seededValues(characters: string[], gr0kRaw: number): SeededValue[] {
  return characters.map((character) => {
    const scope = characterScope(character);
    const incoming = mapRange(hashToUnitFloat(scope, "incoming-handle-length"), 10, 90);
    const outgoing = mapRange(hashToUnitFloat(scope, "outgoing-handle-length"), 10, 90);
    return {
      angle: radians(mapRange(hashToUnitFloat(scope, "handle-angle"), -45, 45)),
      angleDelta: radians(variantSigned(scope, "handle-angle", gr0kRaw) * 10),
      incomingLength: incoming * (1 + variantSigned(scope, "incoming-handle-length", gr0kRaw) * 0.2),
      outgoingLength: outgoing * (1 + variantSigned(scope, "outgoing-handle-length", gr0kRaw) * 0.2),
      canonicalYShift: mapRange(hashToUnitFloat(scope, "point-y-shift"), -30, 30),
      gr0kYShift: variantSigned(scope, "point-y", gr0kRaw) * 5,
    };
  });
}

function pairGapWeight(left: string, right: string, gr0kRaw: number): number {
  return 1 + variantSigned({ kind: "ordered-x-handle-character-pair", left: characterScope(left), right: characterScope(right) }, "point-gap", gr0kRaw) * 0.5;
}

function identityPoint(character: string, index: number, x: number, raw: SeededValue[], angles: number[]): Point {
  const yShift = raw[index].canonicalYShift + raw[index].gr0kYShift;
  const anchor: Vector = [x, 210 + yShift];
  const direction: Vector = [Math.cos(angles[index]), Math.sin(angles[index])];
  return {
    character,
    uppercase: isUppercase(character),
    serialTail: false,
    anchor,
    incoming: [anchor[0] - direction[0] * raw[index].incomingLength, anchor[1] - direction[1] * raw[index].incomingLength],
    outgoing: [anchor[0] + direction[0] * raw[index].outgoingLength, anchor[1] + direction[1] * raw[index].outgoingLength],
  };
}

function serialPoint(character: string, x: number, y: number, incoming: number, outgoing: number): Point {
  return { character, uppercase: false, serialTail: true, anchor: [x, y], incoming: [x - incoming, y], outgoing: [x + outgoing, y] };
}

function shiftPointX(point: Point, shiftX: number): Point {
  return { ...point, anchor: [point.anchor[0] + shiftX, point.anchor[1]], incoming: [point.incoming[0] + shiftX, point.incoming[1]], outgoing: [point.outgoing[0] + shiftX, point.outgoing[1]] };
}

function centerGeometry(points: Point[], centerX: number): Point[] {
  const xs = points.flatMap((point) => [point.anchor[0], point.incoming[0], point.outgoing[0]]);
  const shiftX = centerX - (Math.min(...xs) + Math.max(...xs)) / 2;
  return points.map((point) => shiftPointX(point, shiftX));
}

function geometryFor(text: string, gr0kRaw: number, canvasWidth: number, lineSpan: number): Point[] {
  const characters = [...text];
  const count = characters.length;
  const raw = seededValues(characters, gr0kRaw);
  const angles = raw.map((value, index) => (raw[Math.max(0, index - 1)].angle + 2 * value.angle + raw[Math.min(count - 1, index + 1)].angle) / 4 + value.angleDelta);
  const serialFlags = characters.map(isDigit);
  const centerX = canvasWidth / 2;
  const targetSpan = count <= 3 ? lineSpan * count / 4 : lineSpan;
  const targetStart = centerX - targetSpan / 2;
  const targetEnd = centerX + targetSpan / 2;
  if (!serialFlags.some(Boolean)) {
    if (count === 1) return centerGeometry([identityPoint(characters[0], 0, targetStart, raw, angles), identityPoint(characters[0], 0, targetEnd, raw, angles)], centerX);
    const gapWeights = characters.slice(0, -1).map((character, index) => pairGapWeight(character, characters[index + 1], gr0kRaw));
    const gapTotal = gapWeights.reduce((sum, weight) => sum + weight, 0);
    const positions = [targetStart];
    for (const weight of gapWeights) positions.push(positions[positions.length - 1] + targetSpan * weight / gapTotal);
    return centerGeometry(characters.map((character, index) => identityPoint(character, index, positions[index], raw, angles)), centerX);
  }

  const digitsScope = { kind: "x-handle-digits", value: characters.filter(isDigit).join("") };
  const digitsYShift = mapRange(hashToUnitFloat(digitsScope, "point-y-shift"), -30, 30) + variantSigned(digitsScope, "point-y", gr0kRaw) * 5;
  const flexibleBoundaries: number[] = [];
  const transitionBoundaries: number[] = [];
  for (let index = 0; index < count - 1; index++) {
    if (serialFlags[index] !== serialFlags[index + 1]) transitionBoundaries.push(index);
    if (!serialFlags[index] && !serialFlags[index + 1]) flexibleBoundaries.push(index);
  }
  const flexibleWeights = flexibleBoundaries.map((index) => pairGapWeight(characters[index], characters[index + 1], gr0kRaw));
  const serialWidthWeights = new Map<number, number>();
  for (const [index, character] of characters.entries()) {
    if (!serialFlags[index]) continue;
    const scope = characterScope(character);
    serialWidthWeights.set(index, mapRange(hashToUnitFloat(scope, "serial-width-weight"), 0.2, 1) * (1 + variantSigned(scope, "serial-width", gr0kRaw) * 0.2));
  }
  const serialMaxHeight = 40 * (1 + variantSigned(digitsScope, "serial-height", gr0kRaw) * 0.2);
  const transitionWeights = new Map(transitionBoundaries.map((boundary) => [boundary, serialWidthWeights.get(serialFlags[boundary] ? boundary : boundary + 1)! * 0.6]));
  const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0);
  const layoutWeightTotal = sum(serialWidthWeights.values()) + sum(transitionWeights.values()) + sum(flexibleWeights);
  const layoutScale = layoutWeightTotal > 0 ? targetSpan / layoutWeightTotal : 0;
  const transitionAdvance = new Map([...transitionWeights].map(([boundary, weight]) => [boundary, weight * layoutScale]));
  const flexibleAdvance = new Map(flexibleBoundaries.map((boundary, index) => [boundary, flexibleWeights[index] * layoutScale]));
  let cursorX = targetStart;
  const points: Point[] = [];
  for (const [index, character] of characters.entries()) {
    if (serialFlags[index]) {
      const serialSpacing = serialWidthWeights.get(index)! * layoutScale;
      const pulseHandle = serialSpacing * 0.28;
      const baselineY = 210 + serialMaxHeight * 0.5 + digitsYShift;
      if (index === 0 || !serialFlags[index - 1]) points.push(serialPoint(character, cursorX, baselineY, pulseHandle, pulseHandle));
      const pulseHeight = Number(character) / 9 * serialMaxHeight;
      points.push(serialPoint(character, cursorX + serialSpacing / 2, baselineY - pulseHeight, pulseHandle, pulseHandle));
      cursorX += serialSpacing;
      points.push(serialPoint(character, cursorX, baselineY, pulseHandle, pulseHandle));
      if (index < count - 1 && !serialFlags[index + 1]) cursorX += transitionAdvance.get(index)!;
    } else {
      points.push(identityPoint(character, index, cursorX, raw, angles));
      if (index < count - 1) cursorX += serialFlags[index + 1] ? transitionAdvance.get(index)! : (flexibleAdvance.get(index) ?? 0);
    }
  }
  return centerGeometry(points, centerX);
}

function cubicPoint(p0: Vector, p1: Vector, p2: Vector, p3: Vector, t: number): Vector {
  const u = 1 - t;
  return [0, 1].map((i) => u ** 3 * p0[i] + 3 * u ** 2 * t * p1[i] + 3 * u * t ** 2 * p2[i] + t ** 3 * p3[i]) as Vector;
}

function cubicDerivative(p0: Vector, p1: Vector, p2: Vector, p3: Vector, t: number): Vector {
  const u = 1 - t;
  return [0, 1].map((i) => 3 * u ** 2 * (p1[i] - p0[i]) + 6 * u * t * (p2[i] - p1[i]) + 3 * t ** 2 * (p3[i] - p2[i])) as Vector;
}

function weightAt(point: Point): number {
  if (point.serialTail) return 4;
  if (point.character === "_") return 0.15;
  return 4 + (point.uppercase ? 10 : 0);
}

function offsetPoint(current: Point, following: Point, t: number, side: number): Vector {
  const position = cubicPoint(current.anchor, current.outgoing, following.incoming, following.anchor, t);
  const derivative = cubicDerivative(current.anchor, current.outgoing, following.incoming, following.anchor, t);
  const length = Math.hypot(derivative[0], derivative[1]) || 1;
  const normal = [-derivative[1] / length, derivative[0] / length];
  const start = weightAt(current);
  const halfWidth = (start + (weightAt(following) - start) * (t * t * (3 - 2 * t))) / 2;
  return [position[0] + normal[0] * halfWidth * side, position[1] + normal[1] * halfWidth * side];
}

function centerPointsForOutline(points: Point[], centerX: number): Point[] {
  if (points.length < 2) return points;
  let minimumX = Infinity;
  let maximumX = -Infinity;
  for (let index = 0; index < points.length - 1; index++) {
    for (let sample = 0; sample <= 64; sample++) {
      const outer = offsetPoint(points[index], points[index + 1], sample / 64, 1);
      const inner = offsetPoint(points[index], points[index + 1], sample / 64, -1);
      minimumX = Math.min(minimumX, outer[0], inner[0]);
      maximumX = Math.max(maximumX, outer[0], inner[0]);
    }
  }
  const shiftX = centerX - (minimumX + maximumX) / 2;
  return points.map((point) => shiftPointX(point, shiftX));
}

function cubicThroughThirds(start: Vector, oneThird: Vector, twoThirds: Vector, end: Vector): [Vector, Vector] {
  const first = [27 * oneThird[0] - 8 * start[0] - end[0], 27 * oneThird[1] - 8 * start[1] - end[1]];
  const second = [27 * twoThirds[0] - start[0] - 8 * end[0], 27 * twoThirds[1] - start[1] - 8 * end[1]];
  return [[(2 * first[0] - second[0]) / 18, (2 * first[1] - second[1]) / 18], [(2 * second[0] - first[0]) / 18, (2 * second[1] - first[1]) / 18]];
}

function coordinate(value: number): string {
  return (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);
}
const pair = (point: Vector) => `${coordinate(point[0])},${coordinate(point[1])}`;

function bezierVariableWidthPath(points: Point[]): string {
  if (points.length < 2) return "";
  const lastSegment = points.length - 2;
  let path = `M${pair(offsetPoint(points[0], points[1], 0, 1))}`;
  for (let index = 0; index <= lastSegment; index++) {
    const current = points[index];
    const following = points[index + 1];
    const start = offsetPoint(current, following, 0, 1);
    const oneThird = offsetPoint(current, following, 1 / 3, 1);
    const twoThirds = offsetPoint(current, following, 2 / 3, 1);
    const end = offsetPoint(current, following, 1, 1);
    const [control1, control2] = cubicThroughThirds(start, oneThird, twoThirds, end);
    path += `C${pair(control1)} ${pair(control2)} ${pair(end)}`;
  }
  path += `L${pair(offsetPoint(points[lastSegment], points[lastSegment + 1], 1, -1))}`;
  for (let index = lastSegment; index >= 0; index--) {
    const current = points[index];
    const following = points[index + 1];
    const start = offsetPoint(current, following, 0, -1);
    const oneThird = offsetPoint(current, following, 1 / 3, -1);
    const twoThirds = offsetPoint(current, following, 2 / 3, -1);
    const end = offsetPoint(current, following, 1, -1);
    const [control1, control2] = cubicThroughThirds(start, oneThird, twoThirds, end);
    path += `C${pair(control2)} ${pair(control1)} ${pair(start)}`;
  }
  return `${path}Z`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

/** Python xml_number uses repr(float) for non-integers, including e-07 spelling. */
function xmlNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const text = Math.abs(value) < 0.0001 ? value.toExponential() : String(value);
  return text.replace(/e([+-])(\d)$/, "e$10$2");
}

function composeSizedSvg(pathElement: string, displayedText: string, outputWidth: number, outputHeight: number, canonicalWidth: number, retainCanonicalCanvas = false): string {
  if (!Number.isSafeInteger(outputWidth) || !Number.isSafeInteger(outputHeight) || outputWidth <= 0 || outputHeight <= 0) {
    throw new RangeError("output width and height must be positive integers");
  }
  const namespace = 'xmlns="http://www.w3.org/2000/svg"';
  const size = `width="${outputWidth}" height="${outputHeight}"`;
  const handleText = (x: number, y: number, fontSize: number) => `<text x="${xmlNumber(x)}" y="${xmlNumber(y)}" font-size="${xmlNumber(fontSize)}" font-weight="200" dominant-baseline="middle" fill="${FORMAL_INK}" text-anchor="middle" font-family="-apple-system, system-ui, Segoe UI, sans-serif">${escapeXml(displayedText)}</text>`;
  if (retainCanonicalCanvas || outputWidth * CANONICAL_HEIGHT === outputHeight * canonicalWidth) {
    return `<svg viewBox="0 0 ${canonicalWidth} ${CANONICAL_HEIGHT}" ${namespace} ${size}><rect x="0" y="0" width="${canonicalWidth}" height="${CANONICAL_HEIGHT}" fill="${FORMAL_BACKGROUND}"/>${pathElement}${handleText(canonicalWidth / 2, 399, 10)}</svg>`;
  }
  const scale = Math.min(outputWidth / canonicalWidth, outputHeight / CANONICAL_HEIGHT);
  const offsetX = (outputWidth - canonicalWidth * scale) / 2;
  const offsetY = (outputHeight - CANONICAL_HEIGHT * scale) / 2;
  const transform = `translate(${xmlNumber(offsetX)} ${xmlNumber(offsetY)}) scale(${xmlNumber(scale)})`;
  return `<svg viewBox="0 0 ${outputWidth} ${outputHeight}" ${namespace} ${size}><rect x="0" y="0" width="${outputWidth}" height="${outputHeight}" fill="${FORMAL_BACKGROUND}"/><g transform="${transform}">${pathElement}</g>${handleText(outputWidth / 2, outputHeight * 0.95, 10 * scale)}</svg>`;
}

function validateSeed(gr0kRaw: number): void {
  if (!Number.isInteger(gr0kRaw) || gr0kRaw < 1 || gr0kRaw > 100) throw new RangeError("gr0k_raw must be an integer in [1, 100]");
}

/** Formal Signature API: handle case and integer seed are artwork inputs. */
export function renderSignatureSvg(handle: string, gr0kRaw: number, options: SvgSize = {}): string {
  if (!HANDLE_PATTERN.test(handle)) throw new RangeError("handle must match ^[A-Za-z0-9_]{1,15}$ and must not include @");
  validateSeed(gr0kRaw);
  const points = centerPointsForOutline(geometryFor(handle, gr0kRaw, 420, REFERENCE_SPAN), 210);
  const path = `<path d="${bezierVariableWidthPath(points)}" fill="${FORMAL_INK}" stroke="none"/>`;
  return composeSizedSvg(path, `@${handle}`, options.width ?? DEFAULT_OUTPUT_SIZE, options.height ?? DEFAULT_OUTPUT_SIZE, 420);
}

/**
 * Non-Signature branding reuse. The release explicitly permits external text
 * curves, but requires expansion above 15 rather than squeezing more anchors.
 * This API never validates or creates a claim and labels the supplied text as-is.
 */
export function renderTextSvg(text: string, gr0kRaw: number, options: SvgSize = {}): string {
  const layout = reusableTextCurveLayout([...text].length);
  validateSeed(gr0kRaw);
  const points = centerPointsForOutline(geometryFor(text, gr0kRaw, layout.canonicalWidth, layout.curveSpan), layout.canonicalWidth / 2);
  const path = `<path d="${bezierVariableWidthPath(points)}" fill="${FORMAL_INK}" stroke="none"/>`;
  return composeSizedSvg(path, text, options.width ?? layout.proportionalOutputWidth, options.height ?? layout.proportionalOutputHeight, layout.canonicalWidth, true);
}
