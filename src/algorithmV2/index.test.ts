import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DARK_COLOR, DEFAULT_MBTI, DEFAULT_OUTPUT_SIZE, FORMAL_ALGORITHM_VERSION,
  LIGHT_COLOR, MBTI_TYPES, RENDERER_VERSION, renderSignatureSvg,
} from "./index.js";

const goldens = JSON.parse(readFileSync(new URL("../../reference/algorithm-v2.0.0/golden-svgs.json", import.meta.url), "utf8")) as {
  handle: string; mbti: string; width: number; height: number; sha256: string;
}[];
const pathData = (svg: string) => svg.match(/<path d="([^"]+)"/)![1];

describe("frozen Signature Renderer v2.0.0", () => {
  it("identifies the release and its exact MBTI order", () => {
    expect(FORMAL_ALGORITHM_VERSION).toBe("2.0.0");
    expect(RENDERER_VERSION).toBe("sg-renderer-2.0.0");
    expect(DEFAULT_MBTI).toBe("INFP");
    expect(DEFAULT_OUTPUT_SIZE).toBe(1080);
    expect(MBTI_TYPES).toEqual([
      "ISTJ", "ISFJ", "INFJ", "INTJ", "ISTP", "ISFP", "INFP", "INTP",
      "ESTP", "ESFP", "ENFP", "ENTP", "ESTJ", "ESFJ", "ENFJ", "ENTJ",
    ]);
  });

  it.each(goldens)("matches Python SVG bytes: $handle $mbti $width × $height", (fixture) => {
    const actual = renderSignatureSvg(fixture.handle, fixture.mbti, fixture);
    expect(createHash("sha256").update(actual).digest("hex")).toBe(fixture.sha256);
  });

  it("covers every pole, short handles, digits, underscores, case, and rectangular output in the oracle", () => {
    expect(new Set(goldens.map((fixture) => fixture.mbti))).toEqual(new Set(MBTI_TYPES));
    expect(goldens.some((fixture) => fixture.handle.length === 1)).toBe(true);
    expect(goldens.some((fixture) => /^\d+$/.test(fixture.handle))).toBe(true);
    expect(goldens.some((fixture) => /^_+$/.test(fixture.handle))).toBe(true);
    expect(goldens.some((fixture) => /[a-z]/.test(fixture.handle) && /[A-Z]/.test(fixture.handle))).toBe(true);
    expect(goldens.some((fixture) => fixture.width !== fixture.height)).toBe(true);
  });

  it.each(MBTI_TYPES)("normalizes letter case like Python for %s", (mbti) => {
    expect(renderSignatureSvg("Alice_Bob_Key", mbti.toLowerCase())).toBe(renderSignatureSvg("Alice_Bob_Key", mbti));
  });

  it("uses INFP when MBTI is omitted", () => {
    expect(renderSignatureSvg("Alice_Bob_Key")).toBe(renderSignatureSvg("Alice_Bob_Key", "INFP"));
  });

  it("retains handle case in both geometry and the text label", () => {
    const mixed = renderSignatureSvg("Alice_Bob_Key", "ENFJ");
    const lowercase = renderSignatureSvg("alice_bob_key", "ENFJ");
    expect(mixed).toContain(">@Alice_Bob_Key</text>");
    expect(lowercase).toContain(">@alice_bob_key</text>");
    expect(pathData(mixed)).not.toBe(pathData(lowercase));
  });

  it("changes only the E/I palette, never the path", () => {
    const extraverted = renderSignatureSvg("Alice_Bob_Key", "ENFP");
    const introverted = renderSignatureSvg("Alice_Bob_Key", "INFP");
    expect(pathData(extraverted)).toBe(pathData(introverted));
    expect(extraverted).toContain(`height="420" fill="${LIGHT_COLOR}"/>`);
    expect(introverted).toContain(`height="420" fill="${DARK_COLOR}"/>`);
    expect(extraverted).toContain(`fill="${DARK_COLOR}" stroke="none"/>`);
    expect(introverted).toContain(`fill="${LIGHT_COLOR}" stroke="none"/>`);
  });

  it("uses sampled lines for T and Bezier outlines for F", () => {
    const thinking = pathData(renderSignatureSvg("TimD1919027", "ENTP"));
    const feeling = pathData(renderSignatureSvg("TimD1919027", "ENFP"));
    expect(thinking).toContain("L");
    expect(thinking).not.toContain("C");
    expect(feeling).toContain("C");
    expect(thinking.endsWith("Z")).toBe(true);
    expect(feeling.endsWith("Z")).toBe(true);
  });

  it("varies geometry by S/N and point rhythm by J/P", () => {
    const path = (mbti: string) => pathData(renderSignatureSvg("Alice_Bob_Key", mbti));
    expect(path("ESFJ")).not.toBe(path("ENFJ"));
    expect(path("ENFJ")).not.toBe(path("ENFP"));
  });

  it("gives underscores zero stroke width rather than visible monospaced dashes", () => {
    const path = pathData(renderSignatureSvg("___", "ENTP"));
    const coordinates = path.slice(1, -1).split("L");
    const outer = coordinates.slice(0, coordinates.length / 2);
    const inner = coordinates.slice(coordinates.length / 2).reverse();
    expect(outer).toEqual(inner);
  });

  it("keeps square SVGs on the canonical canvas and scales only rectangular output", () => {
    const square = renderSignatureSvg("Alice_Bob_Key", "INFP", { width: 420, height: 420 });
    const rectangle = renderSignatureSvg("Alice_Bob_Key", "INFP", { width: 840, height: 420 });
    expect(square).toContain('viewBox="0 0 420 420"');
    expect(square).not.toContain("<g");
    expect(rectangle).toContain('viewBox="0 0 840 420"');
    expect(rectangle).toContain('<g transform="translate(210 0) scale(1)">');
    expect(pathData(square)).toBe(pathData(rectangle));
    expect(rectangle).toContain('<text x="420" y="399" font-size="10"');
  });

  it.each(["", "@Alice", "Alice Bob", "Alice\n", "Alice\r", "alice-bob", "a".repeat(16), "署名", "Ａlice", "😀", "A\u0000"])(
    "rejects an invalid handle %j without trimming or normalizing", (handle) => {
      expect(() => renderSignatureSvg(handle, "INFP")).toThrow(/handle must match/);
    },
  );

  it.each(["", "INF", "INFPP", "ENFP\n", " ENFP", "ENFP ", "XXXX", "1", "ＥＮＦＰ", "ENFP\u0000"])(
    "rejects an invalid MBTI %j without trimming or coercing", (mbti) => {
      expect(() => renderSignatureSvg("Alice", mbti)).toThrow(/mbti must match/);
    },
  );

  it.each([0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid output dimension %s", (dimension) => {
    expect(() => renderSignatureSvg("Alice", "INFP", { width: dimension })).toThrow(/positive integers/);
    expect(() => renderSignatureSvg("Alice", "INFP", { height: dimension })).toThrow(/positive integers/);
  });

  it("rejects runtime input type coercion", () => {
    expect(() => renderSignatureSvg(123 as unknown as string, "INFP")).toThrow(/handle must match/);
    expect(() => renderSignatureSvg("Alice", 123 as unknown as string)).toThrow(/mbti must match/);
    expect(() => renderSignatureSvg("Alice", "INFP", { width: "420" as unknown as number })).toThrow(/positive integers/);
  });
});
