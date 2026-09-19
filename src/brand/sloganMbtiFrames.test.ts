import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { SLOGAN_MBTI_FRAMES, SLOGAN_MBTI_LAYOUT, SLOGAN_MBTI_SOURCE } from "./sloganMbtiFrames.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const captureScript = "scripts/capture-slogan-v2.py";
const oraclePath = "reference/algorithm-v2.0.1/signature_renderer_v2.0.1.py";
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const python = (args: string[]): string => execFileSync("python3", ["-B", ...args], {
  cwd: root,
  encoding: "utf8",
  timeout: 20_000,
});

describe("pinned v2 brand-only slogan frames", () => {
  it("preserves the exact slogan, case, underscores, and no punctuation without inventing a handle", () => {
    expect(SLOGAN_MBTI_SOURCE).toEqual({
      displayText: "The_First_Agent_Artwork",
      rendererVersion: "sg-renderer-2.0.1",
      upstreamCommit: "d00c018d1a740a5807480126d1f1bd0c620fb96d",
      pythonSha256: "bfa7ebdfb6e5ced7ddc0b92c3facb3709863ee6c6d10cf9a2f1596c018ecb896",
      adapter: "brand-only-whole-phrase-v2",
    });
    expect(SLOGAN_MBTI_SOURCE.displayText).toHaveLength(23);
    expect(SLOGAN_MBTI_SOURCE.displayText.match(/_/g)).toHaveLength(3);
    expect(Object.isFrozen(SLOGAN_MBTI_SOURCE)).toBe(true);
    expect(hash(readFileSync(new URL(`../../${oraclePath}`, import.meta.url))))
      .toBe(SLOGAN_MBTI_SOURCE.pythonSha256);
  });

  it("expands the 23-character phrase at the 15-character reference spacing and keeps its height", () => {
    const segmentWidth = 300 / 14;
    const curveSpan = segmentWidth * 22;
    const canonicalWidth = curveSpan + 120;
    expect(Object.isFrozen(SLOGAN_MBTI_LAYOUT)).toBe(true);
    expect(SLOGAN_MBTI_LAYOUT).toEqual({
      extended: true,
      character_count: 23,
      reference_character_limit: 15,
      segment_width: segmentWidth,
      curve_span: curveSpan,
      canonical_width: canonicalWidth,
      canonical_height: 420,
      proportional_output_width: Math.round(1080 * canonicalWidth / 420),
      proportional_output_height: 1080,
    });
    expect(SLOGAN_MBTI_LAYOUT.curve_span).toBeGreaterThan(300);
    expect(SLOGAN_MBTI_LAYOUT.canonical_width).toBeGreaterThan(420);
  });

  it("uses the upstream policy whose canvas expansion starts after 15 characters", () => {
    const counts = [1, 3, 14, 15, 16, 22, 23];
    const layouts = JSON.parse(python(["-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("oracle", ${JSON.stringify(oraclePath)})
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
print(json.dumps([renderer.reusable_text_curve_layout(count) for count in ${JSON.stringify(counts)}]))
`])) as Array<typeof SLOGAN_MBTI_LAYOUT>;
    for (const [index, count] of counts.entries()) {
      const layout = layouts[index]!;
      const extended = count > 15;
      const span = extended ? 300 / 14 * (count - 1) : 300;
      expect(layout.character_count).toBe(count);
      expect(layout.extended).toBe(extended);
      expect(layout.segment_width).toBe(300 / 14);
      expect(layout.curve_span).toBe(span);
      expect(layout.canonical_width).toBe(extended ? span + 120 : 420);
      expect(layout.canonical_height).toBe(420);
    }
    expect(layouts.at(-1)).toEqual(SLOGAN_MBTI_LAYOUT);
  });

  it("contains eight immutable, unique shapes in the intended order, with explicit E twins", () => {
    expect(SLOGAN_MBTI_FRAMES.map(frame => frame.mbti)).toEqual([
      "ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP",
    ]);
    expect(new Set(SLOGAN_MBTI_FRAMES.map(frame => frame.d)).size).toBe(8);
    expect(Object.isFrozen(SLOGAN_MBTI_FRAMES)).toBe(true);
    for (const frame of SLOGAN_MBTI_FRAMES) {
      expect(Object.isFrozen(frame)).toBe(true);
      expect(frame.pairedMbti).toBe(`E${frame.mbti.slice(1)}`);
      expect(hash(frame.d)).toBe(frame.sha256);
      expect(frame.d).toMatch(/^M[-\d., LCM]+Z$/);
      expect(frame.d).not.toContain("NaN");
      expect(frame.d.includes("C")).toBe(frame.mbti[2] === "F");
    }
  });

  it("pins every approved Signature phrase frame to its independently computed upstream path", () => {
    expect(SLOGAN_MBTI_FRAMES.map(frame => ({ mbti: frame.mbti, sha256: hash(frame.d) }))).toEqual([
      { mbti: "ISTJ", sha256: "7c1a268bb2667b2be8c3494c89a86370fc275eddfeb0aed44a7a2a842fbc1626" },
      { mbti: "ISFJ", sha256: "0459d310b30ab34b65854f98e5cda7d6de8c0dc9177c0a866ebc218c7c269623" },
      { mbti: "INFJ", sha256: "92b5a310c694b4d1a5f064db765cc6ec21bb8ae9ab6611c624ca784fcf211c4a" },
      { mbti: "INTJ", sha256: "ffe31feb3c325919cd78aadded10184c32f2a65fc822b2eee6bfe5d378b3038c" },
      { mbti: "ISTP", sha256: "33a1049a5f149b4d62e5afe6227648e84d1d60adff16106fbd757464c2eb0a7c" },
      { mbti: "ISFP", sha256: "b0029cec5dba26b986c0795bc8aa66f171ad1d7cf6a97a83ca4cfc1e7b38cbe9" },
      { mbti: "INFP", sha256: "7032525eafe9c48392d31a43dee40e0d63f83c68b33cb609a004b497e7c775b4" },
      { mbti: "INTP", sha256: "0f9195aeebfcf0c63db364efe14b87dbf14d61cfb8b2c14db06044f589f8d0f2" },
    ]);
  });

  it.each(SLOGAN_MBTI_FRAMES)("keeps public account rendering strict for $mbti", frame => {
    for (const handle of ["", "a".repeat(16), "Alice\n", "Alice?", SLOGAN_MBTI_SOURCE.displayText]) {
      expect(() => renderSignatureSvg(handle, frame.mbti)).toThrow(/handle must match/);
    }
    for (const handle of ["A", "Alice_Bob_Key", "a".repeat(15)]) {
      expect(renderSignatureSvg(handle, frame.mbti)).toContain("<svg");
    }
  });

  it("retains upstream account validation and byte-for-byte rendering for valid handles", () => {
    const handles = ["A", "Alice_Bob_Key", "a".repeat(15)];
    const invalidHandles = ["", "a".repeat(16), "Alice\n", "Alice?", SLOGAN_MBTI_SOURCE.displayText];
    const result = JSON.parse(python(["-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("oracle", ${JSON.stringify(oraclePath)})
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
valid = []
for handle in ${JSON.stringify(handles)}:
    for mbti in ${JSON.stringify(SLOGAN_MBTI_FRAMES.flatMap(frame => [frame.mbti, frame.pairedMbti]))}:
        valid.append({"handle": handle, "mbti": mbti, "svg": renderer.generate_svg(handle, mbti)})
invalid = []
for handle in ${JSON.stringify(invalidHandles)}:
    try:
        renderer.generate_svg(handle, "INFP")
        invalid.append("accepted")
    except ValueError as error:
        invalid.append(str(error))
print(json.dumps({"valid": valid, "invalid": invalid}))
`])) as { valid: Array<{ handle: string; mbti: string; svg: string }>; invalid: string[] };
    expect(result.valid).toHaveLength(handles.length * 16);
    for (const { handle, mbti, svg } of result.valid) {
      expect(renderSignatureSvg(handle, mbti)).toBe(svg);
    }
    expect(result.invalid).toHaveLength(invalidHandles.length);
    expect(result.invalid.every(message => message.startsWith("handle must match"))).toBe(true);
  });

  it("reproduces the entire checked-in module through the pinned offline capture", () => {
    expect(python([captureScript, "--check"]))
      .toBe("Verified 8 pinned v2 slogan shapes and all I/E geometry pairs.\n");
    expect(python([captureScript, "--emit"]))
      .toBe(readFileSync(new URL("./sloganMbtiFrames.ts", import.meta.url), "utf8"));
    expect(JSON.parse(python([captureScript, "--json"]))).toEqual({
      source: SLOGAN_MBTI_SOURCE,
      layout: SLOGAN_MBTI_LAYOUT,
      frames: SLOGAN_MBTI_FRAMES,
    });
  });

  it("independently reproduces all 16 direct Python paths and their I/E palette distinction", () => {
    const results = JSON.parse(python(["-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("oracle", ${JSON.stringify(oraclePath)})
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
layout = renderer.reusable_text_curve_layout(len(${JSON.stringify(SLOGAN_MBTI_SOURCE.displayText)}))
results = []
for mbti in ${JSON.stringify(SLOGAN_MBTI_FRAMES.flatMap(frame => [frame.mbti, frame.pairedMbti]))}:
    profile = renderer.profile_for_mbti(mbti)
    profile["curve_span"] = layout["curve_span"]
    points = renderer.center_points_for_outline(renderer.geometry_for(${JSON.stringify(SLOGAN_MBTI_SOURCE.displayText)}, profile), profile)
    points = [renderer.shift_point_x(point, layout["canonical_width"] / 2 - renderer.CANONICAL_CENTER) for point in points]
    draw = renderer.bezier_variable_width_path if mbti[2] == "F" else renderer.sampled_variable_width_path
    anchors = [point["anchor"][0] for point in points]
    results.append({"mbti": mbti, "d": draw(points, profile), "anchorSpan": max(anchors) - min(anchors), "ink": profile["ink"], "background": profile["background"]})
print(json.dumps(results))
`])) as Array<{ mbti: string; d: string; anchorSpan: number; ink: string; background: string }>;
    for (const frame of SLOGAN_MBTI_FRAMES) {
      const introvert = results.find(result => result.mbti === frame.mbti)!;
      const extrovert = results.find(result => result.mbti === frame.pairedMbti)!;
      expect(introvert.d).toBe(frame.d);
      expect(extrovert.d).toBe(frame.d);
      expect(introvert.anchorSpan).toBeCloseTo(300 / 14 * 22, 10);
      expect(extrovert.anchorSpan).toBeCloseTo(300 / 14 * 22, 10);
      expect(introvert.ink).toBe(extrovert.background);
      expect(introvert.background).toBe(extrovert.ink);
      expect(introvert.ink).not.toBe(extrovert.ink);
    }
  });

  it("does not turn the phrase adapter into a general long-text rendering endpoint", () => {
    const results = JSON.parse(python(["-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("capture", ${JSON.stringify(captureScript)})
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
renderer = capture.load_renderer()
results = []
for text in ["whose_signature_will_you_reveal?", "Whose_signature_will_you_reveal?", "Whose_Signature_Will_You_Reveal", "Whose Signature Will You Reveal?", "A_different_long_phrase?", "Whose_Signature_Will_You_Reveal?\\n", "What_shape_do_you_go_by?", "Whose_Shape_Will_You_Reveal?", "Alice_Bob_Key"]:
    try:
        capture.brand_path(renderer, text, "INFP")
        results.append("accepted")
    except ValueError as error:
        results.append(str(error))
print(json.dumps(results))
`])) as string[];
    expect(results).toHaveLength(9);
    expect(results.every(result => result === "Brand adapter accepts only the exact slogan literal")).toBe(true);
  });
});
