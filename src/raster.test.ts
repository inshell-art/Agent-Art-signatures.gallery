import { describe, expect, it } from "vitest";
import { rasterizeSvgToPng } from "./raster.js";

describe("rasterizeSvgToPng", () => {
  it("converts SVG to valid PNG bytes", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const png = await rasterizeSvgToPng(svg);
    // PNG magic bytes.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});
