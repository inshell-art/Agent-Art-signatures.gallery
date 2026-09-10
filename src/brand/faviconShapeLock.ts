import type { SignatureCompositionSnapshot } from "./signatureComposition.js";

/** Exact capital S at gr0k 0.500000, captured through the composition adapter.
 * Framing belongs to favicon.ts; these renderer coordinates must not be edited. */
export const FAVICON_SHAPE_LOCK = {
  "schema": "signature-composition/2",
  "id": "agent-art-favicon-s-v1",
  "displayText": "S",
  "rendererVersion": "sg-renderer-dev-fixture",
  "rendererApproved": false,
  "gr0kRaw": 500000,
  "gr0kScale": 1000000,
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
      "svgSha256": "50fd0495f5681bbcb59018581b568da2581cbf8538dd99f70948da63133ac9d6",
      "sourcePathElementSha256": "58b443116bb57898806b9b3778fbe7417720d10573d0af84d11e98fcd9b32c9b",
      "shapeSha256": "48f8f69a1e58e4ff5fdb5247fc9d75e19ec01b8a2f43d9099699d4a2066f97e8",
      "drawing": {
        "mode": "fill",
        "d": "M173.28,196.69C188.77,194.16 237.45,198.25 248.28,196.69L246.72,186.82C238.93,188.20 189.56,184.09 171.72,186.82Z"
      }
    }
  ],
  "proposedShapeLock": {
    "S": "48f8f69a1e58e4ff5fdb5247fc9d75e19ec01b8a2f43d9099699d4a2066f97e8"
  },
  "shapeLockSchema": "signature-shape-lock/1",
  "verifiedShapeLock": {
    "S": "48f8f69a1e58e4ff5fdb5247fc9d75e19ec01b8a2f43d9099699d4a2066f97e8"
  }
} as const satisfies SignatureCompositionSnapshot;

