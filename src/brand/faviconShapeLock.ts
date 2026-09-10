import type { SignatureCompositionSnapshot } from "./signatureComposition.js";

/** Exact authored text at integer seed 22, captured from the frozen formal
 * Signature Algorithm v1.0.0. Framing is presentation only; geometry is locked. */
export const FAVICON_SHAPE_LOCK = {
  "schema": "signature-composition/2",
  "id": "agent-art-favicon-s-v2",
  "displayText": "S",
  "rendererVersion": "sg-renderer-1.0.0",
  "rendererApproved": true,
  "gr0kRaw": 22,
  "gr0kScale": 1,
  "tokens": [
    {
      "tokenIndex": 0,
      "displayWord": "S",
      "rendererInput": "S",
      "start": 0,
      "end": 1
    }
  ],
  "glyphs": [
    {
      "rendererInput": "S",
      "firstDisplayWord": "S",
      "width": 420,
      "height": 420,
      "svgSha256": "5daae273071ae1d618996145623a2cff5c3a4087737857e2c95550b5c78a19de",
      "sourcePathElementSha256": "195f44304f7b58a0e053efefa98baad171ad0ffef12f6ade00a2b7b15c9d022b",
      "shapeSha256": "44ae39147977c824a69d4600fe44e25387372f7706034054d82928afc02c37ed",
      "drawing": {
        "mode": "fill",
        "d": "M170.97,196.61C261.36,216.29 184.12,174.02 245.97,196.61L249.03,182.95C161.50,171.98 252.96,201.30 174.03,182.95Z"
      }
    }
  ],
  "proposedShapeLock": {
    "S": "44ae39147977c824a69d4600fe44e25387372f7706034054d82928afc02c37ed"
  },
  "shapeLockSchema": "signature-shape-lock/1",
  "verifiedShapeLock": {
    "S": "44ae39147977c824a69d4600fe44e25387372f7706034054d82928afc02c37ed"
  }
} as const satisfies SignatureCompositionSnapshot;
