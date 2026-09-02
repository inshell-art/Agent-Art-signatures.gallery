/**
 * Geometry construction, ported 1:1 from the prototype's `geometryFor` and
 * the outline/centerline path builders it feeds (index.html /
 * src/text-seeded-bezier-line.html in inshell-art/agent-art-Signature-prototype).
 *
 * Deliberately mirrors the original's structure and naming rather than
 * being restyled — this is a port, and staying close to the source makes
 * it possible to diff against a future prototype update.
 */

import { hashToUnitFloat, mapRange } from "./hash.js";

export function graphemes(text: string): string[] {
  if (globalThis.Intl && (Intl as { Segmenter?: unknown }).Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text.normalize("NFC")), (item) => item.segment);
  }
  return Array.from(text.normalize("NFC"));
}

function isUppercase(character: string): boolean {
  return character >= "A" && character <= "Z";
}

function isSerialDigit(character: string): boolean {
  return /^\d$/.test(character);
}

interface RawSeededValue {
  angle: number;
  incomingLength: number;
  outgoingLength: number;
  yShift: number;
}

function seededValues(
  characters: string[],
  rotationMin: number,
  rotationMax: number,
  handleLengthMin: number,
  handleLengthMax: number,
  yShiftMin: number,
  yShiftMax: number,
): RawSeededValue[] {
  return characters.map((character) => {
    const scope = { kind: "character", value: character };
    return {
      angle: (mapRange(hashToUnitFloat(scope, "handle-angle"), rotationMin, rotationMax) * Math.PI) / 180,
      incomingLength: mapRange(hashToUnitFloat(scope, "incoming-handle-length"), handleLengthMin, handleLengthMax),
      outgoingLength: mapRange(hashToUnitFloat(scope, "outgoing-handle-length"), handleLengthMin, handleLengthMax),
      yShift: mapRange(hashToUnitFloat(scope, "point-y-shift"), yShiftMin, yShiftMax),
    };
  });
}

function pairGapWeight(leftCharacter: string, rightCharacter: string): number {
  return mapRange(
    hashToUnitFloat(
      {
        kind: "ordered-character-pair",
        left: { kind: "character", value: leftCharacter },
        right: { kind: "character", value: rightCharacter },
      },
      "point-gap-weight",
    ),
    0.2,
    1.8,
  );
}

function smoothedHandleAngles(raw: RawSeededValue[]): number[] {
  const count = raw.length;
  return raw.map((value, index) => {
    const previous = raw[Math.max(0, index - 1)].angle;
    const next = raw[Math.min(count - 1, index + 1)].angle;
    return (previous + 2 * value.angle + next) / 4;
  });
}

export interface GeometryPoint {
  character: string;
  uppercase: boolean;
  serialTail: boolean;
  anchor: [number, number];
  incoming: [number, number];
  outgoing: [number, number];
}

export function geometryFor(
  characters: string[],
  distribution: "random" | "average",
  rotationMin: number,
  rotationMax: number,
  handleLengthMin: number,
  handleLengthMax: number,
  yShiftMin: number,
  yShiftMax: number,
  useRandomHeight: boolean,
  serialMaxHeight: number,
  serialBaselineY: number,
  serialSpacing: number,
  center: number,
): GeometryPoint[] {
  const count = characters.length;
  if (count === 0) return [];
  const serialFlags = characters.map(isSerialDigit);
  const serialDigitCount = serialFlags.filter(Boolean).length;
  const hasSerialDigits = serialDigitCount > 0;
  const raw = seededValues(characters, rotationMin, rotationMax, handleLengthMin, handleLengthMax, yShiftMin, yShiftMax);
  const smoothedAngles = smoothedHandleAngles(raw);
  const lineStart = 60;
  const lineEnd = 360;
  const lineSpan = lineEnd - lineStart;
  const targetSpan = count <= 3 ? (lineSpan * count) / 4 : lineSpan;
  const targetStart = center - targetSpan / 2;
  const targetEnd = center + targetSpan / 2;

  const identityPoint = (character: string, index: number, x: number): GeometryPoint => {
    const yShift = useRandomHeight ? raw[index].yShift : 0;
    const anchor: [number, number] = [x, center + yShift];
    const angle = smoothedAngles[index];
    const direction = [Math.cos(angle), Math.sin(angle)];
    return {
      character,
      uppercase: isUppercase(character),
      serialTail: false,
      anchor,
      incoming: [anchor[0] - direction[0] * raw[index].incomingLength, anchor[1] - direction[1] * raw[index].incomingLength],
      outgoing: [anchor[0] + direction[0] * raw[index].outgoingLength, anchor[1] + direction[1] * raw[index].outgoingLength],
    };
  };

  const centerGeometry = (points: GeometryPoint[]): GeometryPoint[] => {
    const xValues = points.flatMap((point) => [point.anchor[0], point.incoming[0], point.outgoing[0]]);
    const geometryCenter = (Math.min(...xValues) + Math.max(...xValues)) / 2;
    const shiftX = center - geometryCenter;
    return points.map((point) => ({
      ...point,
      anchor: [point.anchor[0] + shiftX, point.anchor[1]],
      incoming: [point.incoming[0] + shiftX, point.incoming[1]],
      outgoing: [point.outgoing[0] + shiftX, point.outgoing[1]],
    }));
  };

  if (!hasSerialDigits) {
    if (count === 1) {
      return centerGeometry([identityPoint(characters[0], 0, targetStart), identityPoint(characters[0], 0, targetEnd)]);
    }
    const gapWeights = characters
      .slice(0, count - 1)
      .map((character, index) => (distribution === "average" ? 1 : pairGapWeight(character, characters[index + 1])));
    const gapTotal = gapWeights.reduce((total, value) => total + value, 0);
    const gaps = gapWeights.map((value) => (targetSpan * value) / gapTotal);
    const positions = [targetStart];
    gaps.forEach((gap) => positions.push(positions[positions.length - 1] + gap));
    return centerGeometry(characters.map((character, index) => identityPoint(character, index, positions[index])));
  }

  const pulseHandle = serialSpacing * 0.28;
  const pointYReferenceSpan = 50;
  const pointYReferenceMidpoint = -15;
  const pointYSpan = yShiftMax - yShiftMin;
  const pointYMidpoint = (yShiftMin + yShiftMax) / 2;
  const serialYScale = pointYSpan / pointYReferenceSpan;
  const scaledSerialBaselineY = center + pointYMidpoint + (serialBaselineY - center - pointYReferenceMidpoint) * serialYScale;
  const serialPoint = (character: string, x: number, y: number): GeometryPoint => ({
    character,
    uppercase: false,
    serialTail: true,
    anchor: [x, y],
    incoming: [x - pulseHandle, y],
    outgoing: [x + pulseHandle, y],
  });

  const connectorGap = Math.min(24, serialSpacing * 0.6);
  const flexibleBoundaries: number[] = [];
  let transitionCount = 0;
  for (let index = 0; index < count - 1; index++) {
    if (serialFlags[index] !== serialFlags[index + 1]) transitionCount++;
    if (!serialFlags[index] && !serialFlags[index + 1]) flexibleBoundaries.push(index);
  }

  const fixedWidth = serialDigitCount * serialSpacing + transitionCount * connectorGap;
  const flexibleSpan = Math.max(0, targetSpan - fixedWidth);
  const flexibleWeights = flexibleBoundaries.map((index) =>
    distribution === "average" ? 1 : pairGapWeight(characters[index], characters[index + 1]),
  );
  const flexibleTotal = flexibleWeights.reduce((total, value) => total + value, 0);
  const flexibleAdvance = new Map(
    flexibleBoundaries.map((index, weightIndex) => [
      index,
      flexibleTotal > 0 ? (flexibleSpan * flexibleWeights[weightIndex]) / flexibleTotal : 0,
    ]),
  );
  const usedWidth = fixedWidth + (flexibleBoundaries.length > 0 ? flexibleSpan : 0);
  let cursorX = center - usedWidth / 2;
  const points: GeometryPoint[] = [];

  characters.forEach((character, index) => {
    if (serialFlags[index]) {
      if (index === 0 || !serialFlags[index - 1]) {
        points.push(serialPoint(character, cursorX, scaledSerialBaselineY));
      }
      const baseHeight = (Number(character) / 9) * serialMaxHeight;
      const scaledHeight = baseHeight * serialYScale;
      points.push(serialPoint(character, cursorX + serialSpacing / 2, scaledSerialBaselineY - scaledHeight));
      cursorX += serialSpacing;
      points.push(serialPoint(character, cursorX, scaledSerialBaselineY));
      if (index < count - 1 && !serialFlags[index + 1]) cursorX += connectorGap;
    } else {
      points.push(identityPoint(character, index, cursorX));
      if (index < count - 1) {
        cursorX += serialFlags[index + 1] ? connectorGap : flexibleAdvance.get(index) || 0;
      }
    }
  });

  return centerGeometry(points);
}

// -- Path construction (outline / centerline) --------------------------

type Point2 = [number, number];

function cubicPoint(p0: Point2, p1: Point2, p2: Point2, p3: Point2, t: number): Point2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

function cubicDerivative(p0: Point2, p1: Point2, p2: Point2, p3: Point2, t: number): Point2 {
  const u = 1 - t;
  return [
    3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
    3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]),
  ];
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function weightAt(point: GeometryPoint, baseWeight: number, uppercaseExtra: number): number {
  if (point.serialTail) return baseWeight;
  if (point.character === "_") return Math.min(baseWeight, 0.15);
  return baseWeight + (point.uppercase ? uppercaseExtra : 0);
}

function pair(point: Point2): string {
  const format = (value: number) => (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);
  return `${format(point[0])},${format(point[1])}`;
}

function widthBetween(current: GeometryPoint, next: GeometryPoint, t: number, baseWeight: number, uppercaseExtra: number): number {
  const startWeight = weightAt(current, baseWeight, uppercaseExtra);
  const endWeight = weightAt(next, baseWeight, uppercaseExtra);
  return startWeight + (endWeight - startWeight) * smoothstep(t);
}

function offsetPoint(
  current: GeometryPoint,
  next: GeometryPoint,
  t: number,
  side: 1 | -1,
  baseWeight: number,
  uppercaseExtra: number,
): Point2 {
  const position = cubicPoint(current.anchor, current.outgoing, next.incoming, next.anchor, t);
  const derivative = cubicDerivative(current.anchor, current.outgoing, next.incoming, next.anchor, t);
  const length = Math.hypot(derivative[0], derivative[1]) || 1;
  const normal: Point2 = [-derivative[1] / length, derivative[0] / length];
  const halfWidth = widthBetween(current, next, t, baseWeight, uppercaseExtra) / 2;
  return [position[0] + normal[0] * halfWidth * side, position[1] + normal[1] * halfWidth * side];
}

export function centerPointsForOutline(points: GeometryPoint[], baseWeight: number, uppercaseExtra: number, center: number): GeometryPoint[] {
  if (points.length < 2) return points;
  let minimumX = Infinity;
  let maximumX = -Infinity;
  const samples = 64;

  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index];
    const next = points[index + 1];
    for (let sample = 0; sample <= samples; sample++) {
      const t = sample / samples;
      const outer = offsetPoint(current, next, t, 1, baseWeight, uppercaseExtra);
      const inner = offsetPoint(current, next, t, -1, baseWeight, uppercaseExtra);
      minimumX = Math.min(minimumX, outer[0], inner[0]);
      maximumX = Math.max(maximumX, outer[0], inner[0]);
    }
  }

  const shiftX = center - (minimumX + maximumX) / 2;
  return points.map((point) => ({
    ...point,
    anchor: [point.anchor[0] + shiftX, point.anchor[1]],
    incoming: [point.incoming[0] + shiftX, point.incoming[1]],
    outgoing: [point.outgoing[0] + shiftX, point.outgoing[1]],
  }));
}

export function centerPointsForCenterline(points: GeometryPoint[], center: number): GeometryPoint[] {
  if (points.length < 2) return points;
  let minimumX = Infinity;
  let maximumX = -Infinity;
  const samples = 64;

  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index];
    const next = points[index + 1];
    for (let sample = 0; sample <= samples; sample++) {
      const position = cubicPoint(current.anchor, current.outgoing, next.incoming, next.anchor, sample / samples);
      minimumX = Math.min(minimumX, position[0]);
      maximumX = Math.max(maximumX, position[0]);
    }
  }

  const shiftX = center - (minimumX + maximumX) / 2;
  return points.map((point) => ({
    ...point,
    anchor: [point.anchor[0] + shiftX, point.anchor[1]],
    incoming: [point.incoming[0] + shiftX, point.incoming[1]],
    outgoing: [point.outgoing[0] + shiftX, point.outgoing[1]],
  }));
}

export function sampledVariableWidthPath(points: GeometryPoint[], baseWeight: number, uppercaseExtra: number): string {
  if (points.length < 2) return "";
  const outer: Point2[] = [];
  const inner: Point2[] = [];
  const samplesPerSegment = Math.max(8, Math.min(32, Math.ceil(240 / points.length)));
  const segmentCount = points.length - 1;

  function sampleSegment(current: GeometryPoint, next: GeometryPoint, t: number, startWeight: number, endWeight: number) {
    const position = cubicPoint(current.anchor, current.outgoing, next.incoming, next.anchor, t);
    const derivative = cubicDerivative(current.anchor, current.outgoing, next.incoming, next.anchor, t);
    const length = Math.hypot(derivative[0], derivative[1]) || 1;
    const normal: Point2 = [-derivative[1] / length, derivative[0] / length];
    const width = startWeight + (endWeight - startWeight) * smoothstep(t);
    const half = width / 2;
    outer.push([position[0] + normal[0] * half, position[1] + normal[1] * half]);
    inner.push([position[0] - normal[0] * half, position[1] - normal[1] * half]);
  }

  for (let index = 0; index < segmentCount; index++) {
    const current = points[index];
    const next = points[index + 1];
    const startWeight = weightAt(current, baseWeight, uppercaseExtra);
    const endWeight = weightAt(next, baseWeight, uppercaseExtra);

    for (let sample = 0; sample < samplesPerSegment; sample++) {
      sampleSegment(current, next, sample / samplesPerSegment, startWeight, endWeight);
    }
  }

  const current = points[points.length - 2];
  const next = points[points.length - 1];
  sampleSegment(current, next, 1, weightAt(current, baseWeight, uppercaseExtra), weightAt(next, baseWeight, uppercaseExtra));
  return `M${outer.map(pair).join("L")}L${inner.reverse().map(pair).join("L")}Z`;
}

function cubicThroughThirds(start: Point2, oneThird: Point2, twoThirds: Point2, end: Point2) {
  const first: Point2 = [27 * oneThird[0] - 8 * start[0] - end[0], 27 * oneThird[1] - 8 * start[1] - end[1]];
  const second: Point2 = [27 * twoThirds[0] - start[0] - 8 * end[0], 27 * twoThirds[1] - start[1] - 8 * end[1]];
  return {
    control1: [(2 * first[0] - second[0]) / 18, (2 * first[1] - second[1]) / 18] as Point2,
    control2: [(2 * second[0] - first[0]) / 18, (2 * second[1] - first[1]) / 18] as Point2,
  };
}

export function bezierVariableWidthPath(points: GeometryPoint[], baseWeight: number, uppercaseExtra: number): string {
  if (points.length < 2) return "";
  const lastSegment = points.length - 2;
  const firstOuter = offsetPoint(points[0], points[1], 0, 1, baseWeight, uppercaseExtra);
  let path = `M${pair(firstOuter)}`;

  for (let index = 0; index <= lastSegment; index++) {
    const current = points[index];
    const next = points[index + 1];
    const start = offsetPoint(current, next, 0, 1, baseWeight, uppercaseExtra);
    const oneThird = offsetPoint(current, next, 1 / 3, 1, baseWeight, uppercaseExtra);
    const twoThirds = offsetPoint(current, next, 2 / 3, 1, baseWeight, uppercaseExtra);
    const end = offsetPoint(current, next, 1, 1, baseWeight, uppercaseExtra);
    const controls = cubicThroughThirds(start, oneThird, twoThirds, end);
    path += `C${pair(controls.control1)} ${pair(controls.control2)} ${pair(end)}`;
  }

  const finalInner = offsetPoint(points[lastSegment], points[lastSegment + 1], 1, -1, baseWeight, uppercaseExtra);
  path += `L${pair(finalInner)}`;

  for (let index = lastSegment; index >= 0; index--) {
    const current = points[index];
    const next = points[index + 1];
    const start = offsetPoint(current, next, 0, -1, baseWeight, uppercaseExtra);
    const oneThird = offsetPoint(current, next, 1 / 3, -1, baseWeight, uppercaseExtra);
    const twoThirds = offsetPoint(current, next, 2 / 3, -1, baseWeight, uppercaseExtra);
    const end = offsetPoint(current, next, 1, -1, baseWeight, uppercaseExtra);
    const controls = cubicThroughThirds(start, oneThird, twoThirds, end);
    path += `C${pair(controls.control2)} ${pair(controls.control1)} ${pair(start)}`;
  }

  return `${path}Z`;
}

export function pureBezierPath(points: GeometryPoint[]): string {
  if (points.length < 2) return "";
  let path = `M${pair(points[0].anchor)}`;
  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index];
    const next = points[index + 1];
    path += `C${pair(current.outgoing)} ${pair(next.incoming)} ${pair(next.anchor)}`;
  }
  return path;
}
