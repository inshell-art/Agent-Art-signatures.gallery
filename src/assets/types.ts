/**
 * Asset storage for rendered marks (handoff §9.1: "Store both: SVG as the
 * source of truth, PNG for the card."). Keyed by an opaque string the
 * caller controls — see the `instance:{id}` / `canonical:{handle}` scheme
 * in api/render.ts.
 */
export interface AssetStore {
  putSvg(key: string, svg: string): Promise<void>;
  putPng(key: string, png: Buffer): Promise<void>;
  getSvg(key: string): Promise<string | null>;
  getPng(key: string): Promise<Buffer | null>;
}
