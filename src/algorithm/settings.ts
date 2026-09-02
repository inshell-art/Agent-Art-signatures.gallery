/**
 * Settings shape and canonical defaults, ported from the prototype's
 * `currentSettings()` — specifically the values its sliders/toggles carry
 * out of the box (path mode "Variable outline · Bézier C", distribution
 * and point-height toggles both On). Those are the frozen, "final
 * algorithm" values the prototype's README describes; every other
 * combination in the design panel exists only to explore around them.
 */

export type PathMode = "variable_bezier_outline" | "pure_cubic_bezier_stroke" | "variable_sampled_outline";

export interface Settings {
  system: {
    id: string;
    version: string;
    randomScheme: string;
    randomNamespace: string;
  };
  input: {
    pattern: RegExp;
    displayPrefix: string;
  };
  canvas: {
    width: number;
    height: number;
    background: string;
    ink: string;
    text: {
      x: number;
      y: number;
      sizePx: number;
      weight: number;
      anchor: string;
      dominantBaseline: string;
      fontFamily: string;
    };
  };
  geometry: {
    pointDistribution: "random" | "average";
    randomPointHeight: boolean;
    lineStartX: number;
    lineEndX: number;
    shortTextSpanDenominator: number;
    gapWeightRange: [number, number];
    handleRotationDegrees: [number, number];
    handleLengthPx: [number, number];
    pointYShiftPx: [number, number];
  };
  serial: {
    maximumPulseHeightPx: number;
    baselineY: number;
    spacingPx: number;
    pulseHandleSpacingFactor: number;
    connectorGapMaxPx: number;
    connectorSpacingFactor: number;
    pointYReferenceSpanPx: number;
    pointYReferenceMidpointPx: number;
  };
  stroke: {
    baseWeightPx: number;
    uppercaseExtraWeightPx: number;
    underscoreMaxWeightPx: number;
  };
  path: {
    mode: PathMode;
  };
}

export const SPECIFICATION_VERSION = "1.0.0";

export const DEFAULT_SETTINGS: Settings = {
  system: {
    id: "personal-field",
    version: SPECIFICATION_VERSION,
    randomScheme: "sha256-labeled-u53",
    randomNamespace: "personal-field",
  },
  input: {
    pattern: /^[A-Za-z0-9_]{1,15}$/,
    displayPrefix: "@",
  },
  canvas: {
    width: 420,
    height: 420,
    background: "#f2ead6",
    ink: "#11110f",
    text: {
      x: 210,
      y: 420 * (1 - 0.05),
      sizePx: 10,
      weight: 200,
      anchor: "middle",
      dominantBaseline: "middle",
      fontFamily: "-apple-system, system-ui, Segoe UI, sans-serif",
    },
  },
  geometry: {
    pointDistribution: "random",
    randomPointHeight: true,
    lineStartX: 60,
    lineEndX: 360,
    shortTextSpanDenominator: 4,
    gapWeightRange: [0.2, 1.8],
    handleRotationDegrees: [-28, 28],
    handleLengthPx: [0, 45],
    pointYShiftPx: [-40, 10],
  },
  serial: {
    maximumPulseHeightPx: 72,
    baselineY: 250,
    spacingPx: 24,
    pulseHandleSpacingFactor: 0.28,
    connectorGapMaxPx: 24,
    connectorSpacingFactor: 0.6,
    pointYReferenceSpanPx: 50,
    pointYReferenceMidpointPx: -15,
  },
  stroke: {
    baseWeightPx: 2,
    uppercaseExtraWeightPx: 8,
    underscoreMaxWeightPx: 0.15,
  },
  path: {
    mode: "variable_bezier_outline",
  },
};
