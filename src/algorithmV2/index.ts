/**
 * Exact port of Signature Renderer v2.0.0, frozen upstream commit
 * 4bcc513b53edac6961e385604cd9fcc3ac913cbb. The vendored Python is the oracle.
 * MBTI selects release-defined poles; it is not hashed into the geometry.
 */
import { createHash } from "node:crypto";

export const FORMAL_ALGORITHM_VERSION = "2.0.0";
export const RENDERER_VERSION = "sg-renderer-2.0.0";
export const MBTI_TYPES = [
  "ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP",
  "ESTP", "ESFP", "ENFP", "ENTP", "ESTJ", "ESFJ", "ENFJ", "ENTJ",
] as const;
export type MBTI = (typeof MBTI_TYPES)[number];
export const DEFAULT_MBTI: MBTI = "INFP";
export const DEFAULT_OUTPUT_SIZE = 1080;
export const LIGHT_COLOR = "#f4e7c7";
export const DARK_COLOR = "#000000";
export type SvgSize = { width?: number; height?: number };

// Python fullmatch rejects the final newline tolerated by JavaScript's $.
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}(?![\s\S])/;
const MBTI_PATTERN = /^[EI][SN][TF][JP](?![\s\S])/;
const CANONICAL_SIZE = 420;
const CENTER = 210;
type Vector = [number, number];
type Scope = Record<string, unknown>;
type Profile = {
  type: MBTI;
  background: string;
  ink: string;
  handleLengthRange: Vector;
  smoothing: number;
  balance: number;
  pulseFactor: number;
  bezierOutline: boolean;
  gapRange: Vector;
  yRange: Vector;
  yContrast: number;
};
type SeededValue = { angle: number; incoming: number; outgoing: number; yShift: number };
type Point = {
  character: string;
  uppercase: boolean;
  serialTail: boolean;
  anchor: Vector;
  incoming: Vector;
  outgoing: Vector;
};

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
  return (digest.readUInt32BE(0) * 2 ** 21 + (digest.readUInt32BE(4) >>> 11)) / 2 ** 53;
}

function profileForMbti(value: string): Profile {
  const mbti = value.toUpperCase();
  if (!MBTI_PATTERN.test(mbti)) throw new RangeError("mbti must match ^[EI][SN][TF][JP]$");
  const intuitive = mbti[1] === "N";
  const perceiving = mbti[3] === "P";
  return {
    type: mbti as MBTI,
    background: mbti[0] === "E" ? LIGHT_COLOR : DARK_COLOR,
    ink: mbti[0] === "E" ? DARK_COLOR : LIGHT_COLOR,
    handleLengthRange: [10, intuitive ? 120 : 40],
    smoothing: intuitive ? 0.5 : 0.1,
    balance: intuitive ? 0.5 : 0.1,
    pulseFactor: intuitive ? 0.3 : 0.1,
    bezierOutline: mbti[2] === "F",
    gapRange: perceiving ? [0.45, 1.55] : [1, 1],
    yRange: perceiving ? [-40, 40] : [-20, 20],
    yContrast: perceiving ? 3 : 1,
  };
}

const mapRange = (unit: number, minimum: number, maximum: number) => minimum + unit * (maximum - minimum);
const characterScope = (value: string): Scope => ({ kind: "x-handle-character", value });
const underscoreScope = (): Scope => ({ kind: "x-handle-underscore", value: "_" });
const isUppercase = (value: string) => value >= "A" && value <= "Z";
const isDigit = (value: string) => value >= "0" && value <= "9";
const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0);

function mapPointY(unit: number, profile: Profile): number {
  if (profile.yContrast <= 1) return mapRange(unit, ...profile.yRange);
  const signed = unit * 2 - 1;
  const magnitude = Math.abs(signed);
  const raisedMagnitude = magnitude ** profile.yContrast;
  const raisedInverse = (1 - magnitude) ** profile.yContrast;
  const contrast = raisedMagnitude / (raisedMagnitude + raisedInverse);
  const extent = Math.max(Math.abs(profile.yRange[0]), Math.abs(profile.yRange[1]));
  const sign = signed < 0 ? -1 : signed > 0 ? 1 : 0;
  return sign * extent * contrast;
}

function seededValues(characters: string[], profile: Profile): SeededValue[] {
  return characters.map((character) => {
    const scope = characterScope(character);
    const incoming = mapRange(hashToUnitFloat(scope, "incoming-handle-length"), ...profile.handleLengthRange);
    const outgoing = mapRange(hashToUnitFloat(scope, "outgoing-handle-length"), ...profile.handleLengthRange);
    const mean = (incoming + outgoing) / 2;
    return {
      angle: mapRange(hashToUnitFloat(scope, "handle-angle"), -180, 180) * (Math.PI / 180),
      incoming: incoming * (1 - profile.balance) + mean * profile.balance,
      outgoing: outgoing * (1 - profile.balance) + mean * profile.balance,
      yShift: character === "_"
        ? mapRange(hashToUnitFloat(underscoreScope(), "point-y-shift"), 0, 50)
        : mapPointY(hashToUnitFloat(scope, "point-y-shift"), profile),
    };
  });
}

function underscoreWidthWeight(): number {
  return mapRange(hashToUnitFloat(underscoreScope(), "width-weight"), 1, 2);
}

function gapWeight(left: string, right: string, profile: Profile): number {
  if (left === "_" || right === "_") return underscoreWidthWeight();
  const scope = { kind: "ordered-x-handle-character-pair", left: characterScope(left), right: characterScope(right) };
  return mapRange(hashToUnitFloat(scope, "point-gap-weight"), ...profile.gapRange);
}

function identityPoint(character: string, index: number, x: number, raw: SeededValue[], angles: number[]): Point {
  const anchor: Vector = [x, CENTER + raw[index].yShift];
  const direction: Vector = [Math.cos(angles[index]), Math.sin(angles[index])];
  return {
    character, uppercase: isUppercase(character), serialTail: false, anchor,
    incoming: [anchor[0] - direction[0] * raw[index].incoming, anchor[1] - direction[1] * raw[index].incoming],
    outgoing: [anchor[0] + direction[0] * raw[index].outgoing, anchor[1] + direction[1] * raw[index].outgoing],
  };
}

function serialPoint(character: string, x: number, y: number, incoming: number, outgoing: number): Point {
  return { character, uppercase: false, serialTail: true, anchor: [x, y], incoming: [x - incoming, y], outgoing: [x + outgoing, y] };
}

function shiftPointX(point: Point, shift: number): Point {
  return {
    ...point,
    anchor: [point.anchor[0] + shift, point.anchor[1]],
    incoming: [point.incoming[0] + shift, point.incoming[1]],
    outgoing: [point.outgoing[0] + shift, point.outgoing[1]],
  };
}

function centerGeometry(points: Point[]): Point[] {
  const values = points.flatMap((point) => [point.anchor[0], point.incoming[0], point.outgoing[0]]);
  const shift = CENTER - (Math.min(...values) + Math.max(...values)) / 2;
  return points.map((point) => shiftPointX(point, shift));
}

function geometryFor(handle: string, profile: Profile): Point[] {
  const characters = [...handle];
  const count = characters.length;
  const raw = seededValues(characters, profile);
  const angles = raw.map((value, index) => {
    const previous = raw[Math.max(0, index - 1)].angle;
    const following = raw[Math.min(count - 1, index + 1)].angle;
    return value.angle * (1 - profile.smoothing) + ((previous + following) / 2) * profile.smoothing;
  });
  const serialFlags = characters.map(isDigit);
  const targetSpan = count <= 3 ? 300 * count / 4 : 300;
  const targetStart = CENTER - targetSpan / 2;
  const targetEnd = CENTER + targetSpan / 2;
  if (!serialFlags.some(Boolean)) {
    if (count === 1) return centerGeometry([
      identityPoint(characters[0], 0, targetStart, raw, angles),
      identityPoint(characters[0], 0, targetEnd, raw, angles),
    ]);
    const weights = characters.slice(0, -1).map((character, index) => gapWeight(character, characters[index + 1], profile));
    const total = sum(weights);
    const positions = [targetStart];
    for (const weight of weights) positions.push(positions[positions.length - 1] + targetSpan * weight / total);
    return centerGeometry(characters.map((character, index) => identityPoint(character, index, positions[index], raw, angles)));
  }

  const digitsScope = { kind: "x-handle-digits", value: characters.filter(isDigit).join("") };
  const digitsYShift = mapPointY(hashToUnitFloat(digitsScope, "point-y-shift"), profile);
  const flexibleBoundaries: number[] = [];
  const transitionBoundaries: number[] = [];
  for (let index = 0; index < count - 1; index++) {
    if (serialFlags[index] !== serialFlags[index + 1]) transitionBoundaries.push(index);
    if (!serialFlags[index] && !serialFlags[index + 1]) flexibleBoundaries.push(index);
  }
  const flexibleWeights = flexibleBoundaries.map((index) => gapWeight(characters[index], characters[index + 1], profile));
  const serialWidthWeights = new Map<number, number>();
  for (let index = 0; index < count; index++) if (serialFlags[index]) serialWidthWeights.set(index, 1);
  const transitionWeights = new Map(transitionBoundaries.map((boundary) => {
    const digitIndex = serialFlags[boundary] ? boundary : boundary + 1;
    const nonDigitIndex = serialFlags[boundary] ? boundary + 1 : boundary;
    const digitWeight = serialWidthWeights.get(digitIndex)!;
    const weight = characters[nonDigitIndex] === "_" ? (digitWeight + underscoreWidthWeight()) / 2 : digitWeight;
    return [boundary, weight * 0.6];
  }));
  const total = sum(serialWidthWeights.values()) + sum(transitionWeights.values()) + sum(flexibleWeights);
  const scale = total > 0 ? targetSpan / total : 0;
  const transitionAdvance = new Map([...transitionWeights].map(([index, weight]) => [index, weight * scale]));
  const flexibleAdvance = new Map(flexibleBoundaries.map((boundary, index) => [boundary, flexibleWeights[index] * scale]));
  let cursorX = targetStart;
  const points: Point[] = [];
  for (const [index, character] of characters.entries()) {
    if (serialFlags[index]) {
      const spacing = serialWidthWeights.get(index)! * scale;
      const pulseHandle = spacing * profile.pulseFactor;
      const baselineY = CENTER + 60 * 0.5 + digitsYShift;
      if (index === 0 || !serialFlags[index - 1]) points.push(serialPoint(character, cursorX, baselineY, pulseHandle, pulseHandle));
      const pulseHeight = Number(character) / 9 * 60;
      points.push(serialPoint(character, cursorX + spacing / 2, baselineY - pulseHeight, pulseHandle, pulseHandle));
      cursorX += spacing;
      points.push(serialPoint(character, cursorX, baselineY, pulseHandle, pulseHandle));
      if (index < count - 1 && !serialFlags[index + 1]) cursorX += transitionAdvance.get(index)!;
    } else {
      points.push(identityPoint(character, index, cursorX, raw, angles));
      if (index < count - 1) cursorX += serialFlags[index + 1] ? transitionAdvance.get(index)! : (flexibleAdvance.get(index) ?? 0);
    }
  }
  return centerGeometry(points);
}

function cubicPoint(p0: Vector, p1: Vector, p2: Vector, p3: Vector, t: number): Vector {
  const u = 1 - t;
  return [
    u ** 3 * p0[0] + 3 * u ** 2 * t * p1[0] + 3 * u * t ** 2 * p2[0] + t ** 3 * p3[0],
    u ** 3 * p0[1] + 3 * u ** 2 * t * p1[1] + 3 * u * t ** 2 * p2[1] + t ** 3 * p3[1],
  ];
}

function cubicDerivative(p0: Vector, p1: Vector, p2: Vector, p3: Vector, t: number): Vector {
  const u = 1 - t;
  return [
    3 * u ** 2 * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t ** 2 * (p3[0] - p2[0]),
    3 * u ** 2 * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t ** 2 * (p3[1] - p2[1]),
  ];
}

function weightAt(point: Point): number {
  if (point.character === "_") return 0;
  if (point.serialTail || isDigit(point.character)) return 5;
  return 5 + (point.uppercase ? 10 : 0);
}

function widthBetween(current: Point, following: Point, t: number): number {
  const start = weightAt(current);
  return start + (weightAt(following) - start) * (t * t * (3 - 2 * t));
}

function offsetPoint(current: Point, following: Point, t: number, side: number): Vector {
  const position = cubicPoint(current.anchor, current.outgoing, following.incoming, following.anchor, t);
  const derivative = cubicDerivative(current.anchor, current.outgoing, following.incoming, following.anchor, t);
  const length = Math.hypot(derivative[0], derivative[1]) || 1;
  const normal: Vector = [-derivative[1] / length, derivative[0] / length];
  const halfWidth = widthBetween(current, following, t) / 2;
  return [position[0] + normal[0] * halfWidth * side, position[1] + normal[1] * halfWidth * side];
}

function centerPointsForOutline(points: Point[]): Point[] {
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
  const shift = CENTER - (minimumX + maximumX) / 2;
  return points.map((point) => shiftPointX(point, shift));
}

function coordinate(value: number): string {
  return (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);
}
const pair = (point: Vector) => `${coordinate(point[0])},${coordinate(point[1])}`;

function sampledVariableWidthPath(points: Point[]): string {
  if (points.length < 2) return "";
  const outer: Vector[] = [];
  const inner: Vector[] = [];
  const samples = Math.max(8, Math.min(32, Math.ceil(240 / points.length)));
  const sampleSegment = (current: Point, following: Point, t: number) => {
    outer.push(offsetPoint(current, following, t, 1));
    inner.push(offsetPoint(current, following, t, -1));
  };
  for (let index = 0; index < points.length - 1; index++) {
    for (let sample = 0; sample < samples; sample++) sampleSegment(points[index], points[index + 1], sample / samples);
  }
  sampleSegment(points[points.length - 2], points[points.length - 1], 1);
  return `M${outer.map(pair).join("L")}L${inner.reverse().map(pair).join("L")}Z`;
}

function cubicThroughThirds(start: Vector, oneThird: Vector, twoThirds: Vector, end: Vector): [Vector, Vector] {
  const first = [27 * oneThird[0] - 8 * start[0] - end[0], 27 * oneThird[1] - 8 * start[1] - end[1]];
  const second = [27 * twoThirds[0] - start[0] - 8 * end[0], 27 * twoThirds[1] - start[1] - 8 * end[1]];
  return [
    [(2 * first[0] - second[0]) / 18, (2 * first[1] - second[1]) / 18],
    [(2 * second[0] - first[0]) / 18, (2 * second[1] - first[1]) / 18],
  ];
}

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

/** Match Python repr(float), including its zero-padded scientific exponent. */
function xmlNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const text = Math.abs(value) < 0.0001 ? value.toExponential() : String(value);
  return text.replace(/e([+-])(\d)$/, "e$10$2");
}

function composeSizedSvg(path: string, handle: string, profile: Profile, width: number, height: number): string {
  const namespace = 'xmlns="http://www.w3.org/2000/svg"';
  const size = `width="${width}" height="${height}"`;
  // Strict ASCII handle validation above guarantees this label contains no XML metacharacters.
  const label = (x: number, y: number, fontSize: number) => `<text x="${xmlNumber(x)}" y="${xmlNumber(y)}" font-size="${xmlNumber(fontSize)}" font-weight="200" dominant-baseline="middle" fill="${profile.ink}" text-anchor="middle" font-family="-apple-system, system-ui, Segoe UI, sans-serif">@${handle}</text>`;
  if (width === height) {
    return `<svg viewBox="0 0 420 420" ${namespace} ${size}><rect x="0" y="0" width="420" height="420" fill="${profile.background}"/>${path}${label(210, 399, 10)}</svg>`;
  }
  const scale = Math.min(width / CANONICAL_SIZE, height / CANONICAL_SIZE);
  const offsetX = (width - CANONICAL_SIZE * scale) / 2;
  const offsetY = (height - CANONICAL_SIZE * scale) / 2;
  const transform = `translate(${xmlNumber(offsetX)} ${xmlNumber(offsetY)}) scale(${xmlNumber(scale)})`;
  return `<svg viewBox="0 0 ${width} ${height}" ${namespace} ${size}><rect x="0" y="0" width="${width}" height="${height}" fill="${profile.background}"/><g transform="${transform}">${path}</g>${label(width / 2, height * 0.95, 10 * scale)}</svg>`;
}

/** Formal v2 API: handle case and each MBTI pole are artwork inputs. */
export function renderSignatureSvg(handle: string, mbti: string = DEFAULT_MBTI, size: SvgSize = {}): string {
  if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) {
    throw new RangeError("handle must match ^[A-Za-z0-9_]{1,15}$ and must not include @");
  }
  if (typeof mbti !== "string") throw new RangeError("mbti must match ^[EI][SN][TF][JP]$");
  const profile = profileForMbti(mbti);
  const width = size.width ?? DEFAULT_OUTPUT_SIZE;
  const height = size.height ?? DEFAULT_OUTPUT_SIZE;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("output width and height must be positive integers");
  }
  const points = centerPointsForOutline(geometryFor(handle, profile));
  const data = profile.bezierOutline ? bezierVariableWidthPath(points) : sampledVariableWidthPath(points);
  const path = `<path d="${data}" fill="${profile.ink}" stroke="none"/>`;
  return composeSizedSvg(path, handle, profile, width, height);
}
