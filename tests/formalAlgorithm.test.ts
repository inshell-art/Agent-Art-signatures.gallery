import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderSignatureSvg, renderTextSvg, reusableTextCurveLayout } from "../src/algorithmV1/index.js";

const reference = fileURLToPath(new URL("../reference/algorithm-v1.0.0/", import.meta.url));
type Case = [handle: string, seed: number, width?: number, height?: number];

function oracle(cases: Case[]): string[] {
  return JSON.parse(execFileSync("python3", ["-B", "-c", [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('signature_v1', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps([module.generate_svg(*case) for case in json.load(sys.stdin)]))",
  ].join("\n"), `${reference}signature_algorithm_v1.py`], {
    input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 24 * 1024 * 1024,
  }));
}

describe("formal Signature Field v1.0.0", () => {
  it("keeps the exact independently frozen upstream source", () => {
    expect(createHash("sha256").update(readFileSync(`${reference}signature_algorithm_v1.py`)).digest("hex"))
      .toBe("dad855cd33ea59222dc129b3619744a7c33ee13a64c8c46bddefb3a200bbe175");
    expect(createHash("sha256").update(readFileSync(`${reference}signature_algorithm_v1.json`)).digest("hex"))
      .toBe("b025b7121df26d04121d4ca7791cf84fae89d57309a8085056c466cd2d6a2a4c");
  });

  it.each(["S", "s", "_", "0", "9", "inshell_art", "TimD1919027", "a0B_9c1D2345678", "012345678901234", "AaBbCcDdEeFfGgH"])(
    "matches complete Python SVG bytes for %s at every seed 1–100",
    (handle) => {
      const cases: Case[] = Array.from({ length: 100 }, (_, index) => [handle, index + 1]);
      const expected = oracle(cases);
      for (const [index, [name, seed]] of cases.entries()) {
        expect(renderSignatureSvg(name, seed), `${name}, gr0k_raw ${seed}`).toBe(expected[index]);
      }
    }, 60_000,
  );

  it("matches square, portrait, landscape, tiny and odd-sized oracle output", () => {
    const cases: Case[] = [
      ["inshell_art", 22, 1200, 800], ["TimD1919027", 100, 800, 1200],
      ["A_b09Z", 1, 420, 420], ["a9B0", 71, 2048, 2048],
      ["S", 22, 1, 1], ["z0_9Z", 99, 937, 523], ["09", 22, 333, 731],
    ];
    const expected = oracle(cases);
    cases.forEach(([handle, seed, width, height], index) => {
      expect(renderSignatureSvg(handle, seed, { width, height })).toBe(expected[index]);
    });
  });

  it("keeps canonical geometry independent of the requested output size", () => {
    const path = (svg: string) => svg.match(/<path d="([^"]+)"/)?.[1];
    expect(path(renderSignatureSvg("TimD1919027", 22, { width: 1200, height: 800 })))
      .toBe(path(renderSignatureSvg("TimD1919027", 22)));
  });

  it("preserves case as a geometry input, plus formal text, ink and background", () => {
    const upper = renderSignatureSvg("Alice", 22);
    const lower = renderSignatureSvg("alice", 22);
    expect(upper.match(/<path d="([^"]+)"/)?.[1]).not.toBe(lower.match(/<path d="([^"]+)"/)?.[1]);
    expect(upper).toContain('width="1080" height="1080"');
    expect(upper).toContain('fill="#f4e7c7"');
    expect(upper).toContain('fill="#000000" stroke="none"');
    expect(upper).toContain('>@Alice</text>');
  });

  it.each([0, 101, -1, 0.5, 22.5, NaN, Infinity])("rejects invalid raw seed %s", (seed) => {
    expect(() => renderSignatureSvg("alice", seed)).toThrow("integer in [1, 100]");
  });
  it.each(["", "@alice", "alice!", "àlice", "a b", "abcdefghijklmnop", "alice\n"])("rejects invalid handle %s", (handle) => {
    expect(() => renderSignatureSvg(handle, 22)).toThrow("handle must match");
  });
  it.each([{ width: 0 }, { height: -1 }, { width: 1.5 }, { height: NaN }, { width: Infinity }])("rejects invalid output dimensions %s", (options) => {
    expect(() => renderSignatureSvg("alice", 22, options)).toThrow("positive integers");
  });

  it("isolates expanded branding reuse from formal handle validation", () => {
    const text = "What_shape_do_you_go_by?";
    const layout = reusableTextCurveLayout([...text].length);
    expect(layout.extended).toBe(true);
    expect(layout.curveSpan).toBe(300 / 14 * (text.length - 1));
    expect(layout.canonicalWidth).toBe(layout.curveSpan + 120);
    expect(layout.proportionalOutputWidth).toBe(Math.round(1080 * layout.canonicalWidth / 420));
    const svg = renderTextSvg(text, 22);
    expect(svg).toContain(`viewBox="0 0 ${layout.canonicalWidth} 420"`);
    expect(svg).not.toContain("<g transform=");
    expect(svg).toContain(`>${text}</text>`);
    expect(() => renderSignatureSvg(text, 22)).toThrow();
    expect(() => renderTextSvg("", 22)).toThrow();
  });

  it("matches the release's reusable text layout at every boundary", () => {
    const counts = [1, 3, 14, 15, 16, 23, 40, 101];
    const expected = JSON.parse(execFileSync("python3", ["-B", "-c", [
      "import importlib.util, json, sys",
      "spec = importlib.util.spec_from_file_location('signature_v1', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "print(json.dumps([module.reusable_text_curve_layout(n) for n in json.load(sys.stdin)]))",
    ].join("\n"), `${reference}signature_algorithm_v1.py`], { input: JSON.stringify(counts), encoding: "utf8" }));
    counts.forEach((count, index) => {
      const layout = reusableTextCurveLayout(count);
      const py = expected[index];
      expect(layout).toEqual({ extended: py.extended, characterCount: py.character_count, referenceCharacterLimit: py.reference_character_limit, segmentWidth: py.segment_width, curveSpan: py.curve_span, canonicalWidth: py.canonical_width, canonicalHeight: py.canonical_height, proportionalOutputWidth: py.proportional_output_width, proportionalOutputHeight: py.proportional_output_height });
    });
  });
});
