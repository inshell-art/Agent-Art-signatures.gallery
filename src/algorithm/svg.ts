/**
 * SVG serialization, ported from the prototype's `canonicalSvgForText`
 * (see geometry.ts header for provenance).
 */

import {
  bezierVariableWidthPath,
  centerPointsForCenterline,
  centerPointsForOutline,
  geometryFor,
  graphemes,
  pureBezierPath,
  sampledVariableWidthPath,
  type GeometryPoint,
} from "./geometry.js";
import type { Settings } from "./settings.js";

export function pointsForSettings(sourceText: string, settings: Settings): GeometryPoint[] {
  const { geometry, serial, canvas } = settings;
  return geometryFor(
    graphemes(sourceText),
    geometry.pointDistribution,
    geometry.handleRotationDegrees[0],
    geometry.handleRotationDegrees[1],
    geometry.handleLengthPx[0],
    geometry.handleLengthPx[1],
    geometry.pointYShiftPx[0],
    geometry.pointYShiftPx[1],
    geometry.randomPointHeight,
    serial.maximumPulseHeightPx,
    serial.baselineY,
    serial.spacingPx,
    canvas.width / 2,
  );
}

function escapeXml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function xmlNumber(value: number): string {
  return Number.isInteger(Number(value)) ? String(Math.trunc(Number(value))) : String(Number(value));
}

export interface RenderedSvg {
  svg: string;
  metadata: {
    handle: string;
    displayedHandle: string;
    characterCount: number;
    anchorCount: number;
    curveCount: number;
    pathMode: Settings["path"]["mode"];
  };
}

/** Pure function of (sourceText, settings). Faithful port of canonicalSvgForText. */
export function renderSvgForText(sourceText: string, settings: Settings): RenderedSvg {
  const points = pointsForSettings(sourceText, settings);
  const mode = settings.path.mode;
  const weight = settings.stroke.baseWeightPx;
  const uppercaseExtra = settings.stroke.uppercaseExtraWeightPx;
  const center = settings.canvas.width / 2;

  let centeredPoints: GeometryPoint[];
  let pathElement: string;

  if (mode === "pure_cubic_bezier_stroke") {
    centeredPoints = centerPointsForCenterline(points, center);
    const pathData = pureBezierPath(centeredPoints);
    pathElement = `<path d="${pathData}" fill="none" stroke="${settings.canvas.ink}" stroke-width="${xmlNumber(weight)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else {
    centeredPoints = centerPointsForOutline(points, weight, uppercaseExtra, center);
    const pathData =
      mode === "variable_bezier_outline"
        ? bezierVariableWidthPath(centeredPoints, weight, uppercaseExtra)
        : sampledVariableWidthPath(centeredPoints, weight, uppercaseExtra);
    pathElement = `<path d="${pathData}" fill="${settings.canvas.ink}" stroke="none"/>`;
  }

  const { canvas } = settings;
  const canvasText = canvas.text;
  const displayedHandle = settings.input.displayPrefix + sourceText;
  const textElement = `<text x="${xmlNumber(canvasText.x)}" y="${xmlNumber(canvasText.y)}" font-size="${xmlNumber(canvasText.sizePx)}" font-weight="${xmlNumber(canvasText.weight)}" dominant-baseline="${canvasText.dominantBaseline}" fill="${canvas.ink}" text-anchor="${canvasText.anchor}" font-family="${escapeXml(canvasText.fontFamily)}">${escapeXml(displayedHandle)}</text>`;
  const svg = `<svg viewBox="0 0 ${xmlNumber(canvas.width)} ${xmlNumber(canvas.height)}" xmlns="http://www.w3.org/2000/svg" width="${xmlNumber(canvas.width)}" height="${xmlNumber(canvas.height)}"><rect x="0" y="0" width="${xmlNumber(canvas.width)}" height="${xmlNumber(canvas.height)}" fill="${canvas.background}"/>${pathElement}${textElement}</svg>`;

  return {
    svg,
    metadata: {
      handle: sourceText,
      displayedHandle,
      characterCount: graphemes(sourceText).length,
      anchorCount: centeredPoints.length,
      curveCount: centeredPoints.length - 1,
      pathMode: mode,
    },
  };
}
