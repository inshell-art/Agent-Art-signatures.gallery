import { describe, expect, it, vi } from "vitest";
import { GR0K_SCALE, normalizeHandleValue } from "../v1/input.js";
import { formalSignatureRenderer } from "../v1/renderer.js";
import { renderTextSvg } from "../algorithmV1/index.js";
import { SLOGAN_SHAPE_LOCK } from "./fixtures/sloganShapeLock.v1.js";
import type { TextRenderInput, SignatureTextRenderer } from "../v1/renderer.js";
import {
  assertSignatureShapeLock,
  captureSignatureComposition,
  compileSignatureComposition,
  createSignatureCompositionSnapshot,
  describeSignatureComposition,
  renderSignatureCompositionSvg,
  restoreSignatureCompositionSnapshot,
  SignatureCompositionError,
  tokenizeSignatureWords,
  type SignatureCompositionPresentation,
  type SignatureCompositionSource,
} from "./signatureComposition.js";

function fixtureRenderer(pathOverride?: (input: TextRenderInput) => string): SignatureTextRenderer & { renderText: ReturnType<typeof vi.fn> } {
  return {
    version: "renderer-test-1",
    approved: true,
    renderText: vi.fn((input: TextRenderInput) => {
      const d = pathOverride?.(input) ?? `M ${input.text.length} 10 C 11 12 13 14 20 20`;
      const svg = `<svg viewBox="0 0 420 420" xmlns="http://www.w3.org/2000/svg"><rect width="420" height="420" fill="#fff"/><path d="${d}" fill="#111" stroke="none"/><text>@${input.text}</text></svg>`;
      return { svgUtf8: Buffer.from(svg), width: 420, height: 420 };
    }),
  };
}

const SOURCE: SignatureCompositionSource = {
  id: "brand-line-v1",
  displayText: "Read by an Agent. Claimed by YOU.",
  gr0kRaw: 22,
};

function compileFixture() {
  const renderer = fixtureRenderer();
  const captured = captureSignatureComposition(SOURCE, renderer);
  const compiled = compileSignatureComposition({ ...SOURCE, shapeLock: captured.proposedShapeLock }, renderer);
  return { renderer, captured, compiled };
}

function presentationFor(tokenCount: number): SignatureCompositionPresentation {
  return {
    viewBox: [0, 0, 1_200, 360],
    width: 1_200,
    height: 360,
    placements: Array.from({ length: tokenCount }, (_, tokenIndex) => ({
      tokenIndex,
      translateX: 20 + tokenIndex * 100,
      translateY: 80,
      scale: 0.5,
    })),
  };
}

describe("signature composition adapter", () => {
  it("passes case through literally and deduplicates only identical spellings", () => {
    const renderer = fixtureRenderer();
    const capture = captureSignatureComposition({ ...SOURCE, displayText: "Read read READ Read" }, renderer);
    expect(capture.schema).toBe("signature-composition/2");
    expect(renderer.renderText.mock.calls.map(([input]) => input.text)).toEqual(["Read", "read", "READ"]);
    expect(capture.tokens.map((token) => token.rendererInput)).toEqual(["Read", "read", "READ", "Read"]);
    expect(Object.keys(capture.proposedShapeLock)).toEqual(["Read", "read", "READ"]);
    expect(normalizeHandleValue("READ")).toBe("read");
  });

  it.each(["What_shape_do_you_go_by?", "What_Shape_Do_You_Go_By?"])("matches the algorithm's exact path for %s", (literal) => {
    const capture = captureSignatureComposition({ ...SOURCE, displayText: literal }, formalSignatureRenderer);
    const direct = renderTextSvg(literal, 22).match(/<path d="([^"]+)"/)![1];
    expect(capture.glyphs[0].rendererInput).toBe(literal);
    expect(capture.glyphs[0].drawing.d).toBe(direct);
    expect(capture.glyphs[0].drawing.d).not.toBe(SLOGAN_SHAPE_LOCK.glyphs[0].drawing.d);
  });

  it("rejects retired scalar-based snapshots instead of relabeling their geometry as formal v1.0.0", () => {
    expect(() => restoreSignatureCompositionSnapshot(SLOGAN_SHAPE_LOCK)).toThrow("gr0kRaw");
    expect(() => captureSignatureComposition(SLOGAN_SHAPE_LOCK, formalSignatureRenderer)).toThrow("gr0kRaw");
  });

  it.each([0, 101, 0.5, 500_000, NaN, Infinity])("rejects an invalid formal seed %s", gr0kRaw => {
    expect(() => captureSignatureComposition({ ...SOURCE, gr0kRaw }, formalSignatureRenderer)).toThrow("integer from 1 through 100");
  });

  it("locks the canonical viewport rather than the 1080px export dimensions", () => {
    const capture = captureSignatureComposition({ ...SOURCE, displayText: "Alice" }, formalSignatureRenderer);
    expect(capture.glyphs[0]).toMatchObject({ width: 420, height: 420 });
    const rendered = formalSignatureRenderer.renderText({ text: "Alice", gr0kRaw: 22, gr0kScale: 1, rendererVersion: formalSignatureRenderer.version });
    expect(rendered).toMatchObject({ width: 1080, height: 1080 });
  });

  it("keeps long presentation text at the reference segment width, with a wider locked canvas", () => {
    const capture = captureSignatureComposition({ ...SOURCE, displayText: "What_shape_do_you_go_by?" }, formalSignatureRenderer);
    const glyph = capture.glyphs[0];
    expect(glyph.width).toBeCloseTo(120 + 23 * 300 / 14);
    expect(glyph.height).toBe(420);
    const snapshot = createSignatureCompositionSnapshot({ ...capture, shapeLockSchema: "signature-shape-lock/1", verifiedShapeLock: capture.proposedShapeLock });
    expect(restoreSignatureCompositionSnapshot(snapshot).glyphs[0]).toEqual(glyph);
  });

  it("tokenizes presentation copy and preserves case while tokenizing every word", () => {
    expect(tokenizeSignatureWords("  Read\tby an Agent. Claimed by YOU. ")).toEqual([
      { tokenIndex: 0, displayWord: "Read", rendererInput: "Read", start: 0, end: 4 },
      { tokenIndex: 1, displayWord: "by", rendererInput: "by", start: 5, end: 7 },
      { tokenIndex: 2, displayWord: "an", rendererInput: "an", start: 8, end: 10 },
      { tokenIndex: 3, displayWord: "Agent", rendererInput: "Agent", start: 11, end: 16 },
      { tokenIndex: 4, displayWord: "Claimed", rendererInput: "Claimed", start: 18, end: 25 },
      { tokenIndex: 5, displayWord: "by", rendererInput: "by", start: 26, end: 28 },
      { tokenIndex: 6, displayWord: "YOU", rendererInput: "YOU", start: 29, end: 32 },
    ]);
  });

  it.each([
    ["", "must not be empty"],
    ["...", "at least one renderer word"],
    ["Café", "printable ASCII"],
    ["abcdefghijklmnop", "valid X-handle-shaped"],
  ])("rejects input that cannot map exactly to canonical renderer words: %j", (text, message) => {
    expect(() => tokenizeSignatureWords(text)).toThrow(message);
  });

  it("captures an underscore-joined question as one complete presentation shape, preserving snapshot integrity", () => {
    const source = { ...SOURCE, displayText: "What_shape_is_your_name?" };
    const renderer = fixtureRenderer();
    const capture = captureSignatureComposition(source, renderer);
    const rendererInput = "What_shape_is_your_name?";

    expect(capture.tokens).toEqual([
      { tokenIndex: 0, displayWord: "What_shape_is_your_name?", rendererInput, start: 0, end: 24 },
    ]);
    expect(renderer.renderText).toHaveBeenCalledTimes(1);
    expect(renderer.renderText).toHaveBeenCalledWith({
      text: rendererInput,
      gr0kRaw: 22,
      gr0kScale: GR0K_SCALE,
      rendererVersion: renderer.version,
    });
    expect(capture.glyphs).toHaveLength(1);
    expect(capture.glyphs[0].drawing).toEqual({ mode: "fill", d: "M 24 10 C 11 12 13 14 20 20" });
    expect(() => normalizeHandleValue(rendererInput)).toThrow("1–15");

    const compiled = compileSignatureComposition({ ...source, shapeLock: capture.proposedShapeLock }, renderer);
    const snapshot = JSON.parse(JSON.stringify(createSignatureCompositionSnapshot(compiled)));
    renderer.renderText.mockClear();
    const restored = restoreSignatureCompositionSnapshot(snapshot);

    expect(renderer.renderText).not.toHaveBeenCalled();
    expect(restored).toEqual(compiled);
    expect(restored.verifiedShapeLock[rendererInput]).toBe(capture.glyphs[0].shapeSha256);
    expect(renderSignatureCompositionSvg(restored, presentationFor(1)).match(/<path\b/g)).toHaveLength(1);

    snapshot.glyphs[0].drawing.d = "M 0 0 L 99 99";
    expect(() => restoreSignatureCompositionSnapshot(snapshot)).toThrow("shape hash");
  });

  it("preserves a single question mark on a short word without relaxing X-handle validation", () => {
    expect(tokenizeSignatureWords("Why? YOU! Name.")).toEqual([
      { tokenIndex: 0, displayWord: "Why?", rendererInput: "Why?", start: 0, end: 4 },
      { tokenIndex: 1, displayWord: "YOU", rendererInput: "YOU", start: 5, end: 8 },
      { tokenIndex: 2, displayWord: "Name", rendererInput: "Name", start: 10, end: 14 },
    ]);
    expect(tokenizeSignatureWords("A".repeat(15) + "?")[0].rendererInput).toBe("A".repeat(15) + "?");
    expect(() => tokenizeSignatureWords("A".repeat(16) + "?")).toThrow("valid X-handle-shaped");
    expect(() => normalizeHandleValue("why?")).toThrow();
  });

  it("allows at most 96 characters in an extended phrase without truncating its words", () => {
    const phrase = [15, 15, 15, 15, 15, 14, 1].map((length) => "A".repeat(length)).join("_");
    expect(phrase).toHaveLength(96);
    expect(tokenizeSignatureWords(phrase)[0].rendererInput).toBe(phrase);
    const question = phrase.slice(1) + "?";
    expect(question).toHaveLength(96);
    expect(tokenizeSignatureWords(question)[0].rendererInput).toBe(question);
    expect(() => tokenizeSignatureWords(phrase + "?")).toThrow("valid X-handle-shaped");
  });

  it.each([
    "_What_shape_is_your_name",
    "What_shape_is_your_name_",
    "What__shape_is_your_name",
    "What_shape_is_your_name??",
    "Why??",
    "abcdefghijklmnop_name",
    Array.from({ length: 6 }, () => "a".repeat(15)).join("_") + "_a",
  ])("rejects a malformed or overlong extended presentation input: %j", (phrase) => {
    expect(() => tokenizeSignatureWords(phrase)).toThrowError(
      expect.objectContaining<Partial<SignatureCompositionError>>({ code: "INVALID_WORD" }),
    );
  });

  it("renders each distinct case-sensitive word once at one fixed gr0k and captures auditable hashes", () => {
    const renderer = fixtureRenderer();
    const capture = captureSignatureComposition(SOURCE, renderer);

    expect(renderer.renderText).toHaveBeenCalledTimes(6);
    expect(renderer.renderText.mock.calls.map(([input]) => input)).toEqual(
      ["Read", "by", "an", "Agent", "Claimed", "YOU"].map((text) => ({
        text,
        gr0kRaw: 22,
        gr0kScale: GR0K_SCALE,
        rendererVersion: "renderer-test-1",
      })),
    );
    expect(capture.tokens).toHaveLength(7);
    expect(capture.glyphs).toHaveLength(6);
    expect(capture.glyphs[0]).toMatchObject({
      rendererInput: "Read",
      firstDisplayWord: "Read",
      width: 420,
      height: 420,
      drawing: { mode: "fill", d: "M 4 10 C 11 12 13 14 20 20" },
    });
    expect(capture.glyphs[0].svgSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(capture.glyphs[0].sourcePathElementSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(capture.glyphs[0].shapeSha256).toBe(capture.proposedShapeLock.Read);
  });

  it("fails closed for missing, changed, malformed, and stale shape locks", () => {
    const capture = captureSignatureComposition(SOURCE, fixtureRenderer());
    const exact = { ...capture.proposedShapeLock };
    assertSignatureShapeLock(capture, exact);

    const missing = { ...exact };
    delete missing.Read;
    expect(() => assertSignatureShapeLock(capture, missing)).toThrowError(
      expect.objectContaining<Partial<SignatureCompositionError>>({ code: "SHAPE_LOCK_MISSING" }),
    );

    expect(() => assertSignatureShapeLock(capture, { ...exact, Read: "0".repeat(64) })).toThrowError(
      expect.objectContaining<Partial<SignatureCompositionError>>({ code: "SHAPE_LOCK_MISMATCH" }),
    );
    expect(() => assertSignatureShapeLock(capture, { ...exact, Read: "NOT-A-HASH" })).toThrowError(
      expect.objectContaining<Partial<SignatureCompositionError>>({ code: "SHAPE_LOCK_MISMATCH" }),
    );
    expect(() => assertSignatureShapeLock(capture, { ...exact, obsolete: "0".repeat(64) })).toThrowError(
      expect.objectContaining<Partial<SignatureCompositionError>>({ code: "SHAPE_LOCK_STALE" }),
    );
  });

  it("detects renderer shape drift even when the display copy and lock are unchanged", () => {
    const first = captureSignatureComposition(SOURCE, fixtureRenderer());
    const driftedRenderer = fixtureRenderer((input) => `M ${input.text.length} 10 L 99 99`);
    expect(() => compileSignatureComposition({ ...SOURCE, shapeLock: first.proposedShapeLock }, driftedRenderer)).toThrowError(
      expect.objectContaining<Partial<SignatureCompositionError>>({ code: "SHAPE_LOCK_MISMATCH" }),
    );
  });

  it("describes and renders translation plus one uniform scale per word occurrence", () => {
    const { compiled } = compileFixture();
    const presentation = presentationFor(compiled.tokens.length);
    const description = describeSignatureComposition(compiled, presentation);
    const svg = renderSignatureCompositionSvg(compiled, presentation);

    expect(description).toMatchObject({
      id: "brand-line-v1",
      rendererVersion: "renderer-test-1",
      gr0kRaw: 22,
      viewBox: "0 0 1200 360",
      width: 1_200,
      height: 360,
      distinctGlyphCount: 6,
    });
    expect(description.placements[0]).toMatchObject({
      tokenIndex: 0,
      displayWord: "Read",
      rendererInput: "Read",
      transform: "translate(20 80) scale(0.5)",
    });
    expect(svg).toContain('<g transform="translate(20 80) scale(0.5)">');
    expect(svg.match(/<path\b/g)).toHaveLength(compiled.tokens.length);
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toMatch(/\bmatrix\(/);
    expect(svg).not.toMatch(/scale\([^)]*[, ]+[^)]*\)/);
    expect(svg).not.toContain("<rect");
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("<script");
  });

  it("rejects any non-uniform or raw-transform presentation escape hatch", () => {
    const { compiled } = compileFixture();
    const base = presentationFor(compiled.tokens.length);
    const scaleX = {
      ...base,
      placements: base.placements.map((placement, index) =>
        index === 0 ? { ...placement, scaleX: 0.25 } : placement,
      ),
    };
    expect(() => renderSignatureCompositionSvg(compiled, scaleX)).toThrow("use one uniform scale value");

    const rawTransform = {
      ...base,
      placements: base.placements.map((placement, index) =>
        index === 0 ? { ...placement, transform: "matrix(2 0 0 .5 0 0)" } : placement,
      ),
    };
    expect(() => renderSignatureCompositionSvg(compiled, rawTransform)).toThrow("use one uniform scale value");
  });

  it("rejects malformed or unsafe renderer path output before it reaches presentation", () => {
    const renderer = fixtureRenderer(() => 'M 0 0 L 1 1" onload="alert(1)');
    expect(() => captureSignatureComposition(SOURCE, renderer)).toThrowError(
      expect.objectContaining<Partial<SignatureCompositionError>>({ code: "INVALID_RENDERER_OUTPUT" }),
    );

    const multiplePaths = fixtureRenderer(() => "M 0 0 L 1 1");
    multiplePaths.renderText.mockImplementation((input: TextRenderInput) => ({
      svgUtf8: Buffer.from(
        `<svg><path d="M 0 0 L 1 1" fill="#111"/><path d="M 1 1 L 2 2" fill="#111"/><text>${input.text}</text></svg>`,
      ),
      width: 420,
      height: 420,
    }));
    expect(() => captureSignatureComposition(SOURCE, multiplePaths)).toThrow("exactly one path");
  });

  it("preserves stroke geometry while replacing only its color with currentColor", () => {
    const renderer = fixtureRenderer();
    renderer.renderText.mockImplementation((input: TextRenderInput) => ({
      svgUtf8: Buffer.from(
        `<svg><path d="M 0 0 C 1 2 3 4 5 6" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text>${input.text}</text></svg>`,
      ),
      width: 420,
      height: 420,
    }));
    const capture = captureSignatureComposition({ id: "stroke-v1", displayText: "Line", gr0kRaw: 1 }, renderer);
    const compiled = compileSignatureComposition(
      { id: "stroke-v1", displayText: "Line", gr0kRaw: 1, shapeLock: capture.proposedShapeLock },
      renderer,
    );
    const svg = renderSignatureCompositionSvg(compiled, {
      viewBox: [0, 0, 420, 420],
      width: 420,
      height: 420,
      placements: [{ tokenIndex: 0, translateX: 0, translateY: 0, scale: 1 }],
    });
    expect(svg).toContain(
      '<path d="M 0 0 C 1 2 3 4 5 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>',
    );
  });

  it("round-trips a reviewed snapshot through JSON and restores it without invoking a renderer", () => {
    const { renderer, compiled } = compileFixture();
    const reviewed = createSignatureCompositionSnapshot(compiled);
    const serialized = JSON.stringify(reviewed);
    renderer.renderText.mockClear();

    const restored = restoreSignatureCompositionSnapshot(JSON.parse(serialized));

    expect(renderer.renderText).not.toHaveBeenCalled();
    expect(restored).toEqual(compiled);
    expect(renderSignatureCompositionSvg(restored, presentationFor(restored.tokens.length))).toBe(
      renderSignatureCompositionSvg(compiled, presentationFor(compiled.tokens.length)),
    );
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.tokens)).toBe(true);
    expect(Object.isFrozen(restored.tokens[0])).toBe(true);
    expect(Object.isFrozen(restored.glyphs)).toBe(true);
    expect(Object.isFrozen(restored.glyphs[0])).toBe(true);
    expect(Object.isFrozen(restored.glyphs[0].drawing)).toBe(true);
    expect(Object.isFrozen(restored.proposedShapeLock)).toBe(true);
    expect(Object.isFrozen(restored.verifiedShapeLock)).toBe(true);
  });

  it.each([
    ["wrong schema", (snapshot: any) => { snapshot.schema = "signature-composition/999"; }, "schema"],
    ["noncanonical display copy", (snapshot: any) => { snapshot.displayText = ` ${snapshot.displayText}`; }, "canonical whitespace"],
    ["changed token mapping", (snapshot: any) => { snapshot.tokens[0].rendererInput = "other"; }, "canonical tokenization"],
    ["duplicate glyph", (snapshot: any) => { snapshot.glyphs[1].rendererInput = snapshot.glyphs[0].rendererInput; }, "duplicate"],
    ["invalid dimensions", (snapshot: any) => { snapshot.glyphs[0].width = 0; }, "positive finite dimension"],
    ["invalid SVG hash", (snapshot: any) => { snapshot.glyphs[0].svgSha256 = "abc"; }, "lowercase SHA-256"],
    ["drawing/hash drift", (snapshot: any) => { snapshot.glyphs[0].drawing.d = "M 0 0 L 99 99"; }, "shape hash"],
    ["unsafe path data", (snapshot: any) => { snapshot.glyphs[0].drawing.d = 'M 0 0" onload="alert(1)'; }, "safe SVG path data"],
    ["unexpected drawing attribute", (snapshot: any) => { snapshot.glyphs[0].drawing.onload = "alert(1)"; }, "unexpected property"],
    ["changed proposed lock", (snapshot: any) => { snapshot.proposedShapeLock.Read = "0".repeat(64); }, "Shape lock mismatch"],
    ["changed verified lock", (snapshot: any) => { snapshot.verifiedShapeLock.Read = "0".repeat(64); }, "Shape lock mismatch"],
    ["stale lock", (snapshot: any) => { snapshot.verifiedShapeLock.stale = "0".repeat(64); }, "stale renderer input"],
    ["unexpected snapshot field", (snapshot: any) => { snapshot.renderer = "do-not-run"; }, "unexpected property"],
    ["missing snapshot field", (snapshot: any) => { delete snapshot.rendererVersion; }, "missing property"],
    ["missing token field", (snapshot: any) => { delete snapshot.tokens[0].start; }, "missing property"],
    ["missing glyph field", (snapshot: any) => { delete snapshot.glyphs[0].shapeSha256; }, "missing property"],
    ["numeric display copy", (snapshot: any) => { snapshot.displayText = 42; }, "must be a string"],
    ["numeric renderer version", (snapshot: any) => { snapshot.rendererVersion = 1; }, "must be a string"],
    ["non-integer token index", (snapshot: any) => { snapshot.tokens[0].tokenIndex = 0.5; }, "does not match canonical"],
    ["negative token offset", (snapshot: any) => { snapshot.tokens[0].start = -1; }, "does not match canonical"],
    ["fractional dimension is allowed only as a positive finite number", (snapshot: any) => { snapshot.glyphs[0].height = -1; }, "positive finite dimension"],
    ["infinite dimension", (snapshot: any) => { snapshot.glyphs[0].width = Number.POSITIVE_INFINITY; }, "positive finite dimension"],
    ["dimension as string", (snapshot: any) => { snapshot.glyphs[0].width = "420"; }, "positive finite dimension"],
    ["uppercase hash", (snapshot: any) => { snapshot.glyphs[0].shapeSha256 = "A".repeat(64); }, "lowercase SHA-256"],
    ["hash as number", (snapshot: any) => { snapshot.glyphs[0].svgSha256 = 1234; }, "lowercase SHA-256"],
    ["tokens as object", (snapshot: any) => { snapshot.tokens = { 0: snapshot.tokens[0] }; }, "must exactly reproduce"],
    ["glyph as array", (snapshot: any) => { snapshot.glyphs[0] = [snapshot.glyphs[0]]; }, "plain object"],
    ["drawing as null", (snapshot: any) => { snapshot.glyphs[0].drawing = null; }, "plain object"],
    ["unknown drawing mode", (snapshot: any) => { snapshot.glyphs[0].drawing = { mode: "raster", d: "M 0 0" }; }, "drawing.mode"],
    ["numeric drawing mode", (snapshot: any) => { snapshot.glyphs[0].drawing.mode = 7; }, "must be a string"],
    ["shape lock entry as number", (snapshot: any) => { snapshot.proposedShapeLock.Read = 1; }, "proposedShapeLock.Read"],
  ])("rejects a corrupted runtime snapshot: %s", (_label, mutate, message) => {
    const { compiled } = compileFixture();
    const serialized = JSON.parse(JSON.stringify(createSignatureCompositionSnapshot(compiled)));
    mutate(serialized);
    expect(() => restoreSignatureCompositionSnapshot(serialized)).toThrow(message);
  });

  it("revalidates stored stroke attributes at the runtime boundary", () => {
    const renderer = fixtureRenderer();
    renderer.renderText.mockImplementation(() => ({
      svgUtf8: Buffer.from(
        '<svg><path d="M 0 0 L 4 4" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      ),
      width: 420,
      height: 420,
    }));
    const source = { id: "stroke-snapshot", displayText: "Line", gr0kRaw: 22 } as const;
    const captured = captureSignatureComposition(source, renderer);
    const compiled = compileSignatureComposition({ ...source, shapeLock: captured.proposedShapeLock }, renderer);
    const snapshot: any = JSON.parse(JSON.stringify(createSignatureCompositionSnapshot(compiled)));
    snapshot.glyphs[0].drawing.strokeWidth = "2;transform:scale(4)";

    expect(() => restoreSignatureCompositionSnapshot(snapshot)).toThrow("positive finite SVG number");
  });
});

describe("snapshot restore input boundaries", () => {
  const snapshotOf = () => JSON.parse(JSON.stringify(createSignatureCompositionSnapshot(compileFixture().compiled)));

  it("refuses anything that is not a plain JSON object at the top level", () => {
    for (const value of [null, undefined, 42, "snapshot", true, [], () => undefined]) {
      expect(() => restoreSignatureCompositionSnapshot(value)).toThrow(SignatureCompositionError);
    }
  });

  it("refuses an object carrying a prototype that JSON could not have produced", () => {
    const snapshot = snapshotOf();
    const poisoned = Object.assign(Object.create({ inherited: true }), snapshot);
    expect(() => restoreSignatureCompositionSnapshot(poisoned)).toThrow(/JSON-compatible/);
    // A null-prototype object is still JSON-shaped and must be accepted.
    expect(() => restoreSignatureCompositionSnapshot(Object.assign(Object.create(null), snapshot))).not.toThrow();
  });

  it("refuses a symbol-keyed property that an exact-key check could otherwise miss", () => {
    const snapshot = snapshotOf();
    Object.defineProperty(snapshot, Symbol("smuggled"), { value: "payload", enumerable: true });
    expect(() => restoreSignatureCompositionSnapshot(snapshot)).toThrow(/unexpected property/);
  });

  it("restores a snapshot that only differs by key order", () => {
    const snapshot = snapshotOf();
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
    expect(() => restoreSignatureCompositionSnapshot(reordered)).not.toThrow();
  });
});

describe("composition source and renderer-output validation", () => {
  const capture = (source: Partial<SignatureCompositionSource>, pathOverride?: (input: any) => string) =>
    () => captureSignatureComposition({ ...SOURCE, ...source } as SignatureCompositionSource, fixtureRenderer(pathOverride));

  it("requires a lowercase composition id within its length bound", () => {
    for (const id of ["", "Brand", "-leading", ".leading", "with space", "a".repeat(81), 42 as unknown as string]) {
      expect(capture({ id }), String(id)).toThrow(/Composition id must be/);
    }
    expect(capture({ id: "a" })).not.toThrow();
    expect(capture({ id: "a".repeat(80) })).not.toThrow();
    expect(capture({ id: "brand.line_v1-2" })).not.toThrow();
  });

  it("requires gr0k to be an integer inside its frozen range", () => {
    for (const gr0kRaw of [0, 101, -1, 1.5, Number.NaN, "22" as unknown as number]) {
      expect(capture({ gr0kRaw }), String(gr0kRaw)).toThrow(/Composition gr0kRaw must be an integer/);
    }
  });

  it("normalizes surrounding and repeated whitespace before validating the copy", () => {
    const spaced = captureSignatureComposition({ ...SOURCE, displayText: "  Read   by \tan Agent.  " }, fixtureRenderer());
    expect(spaced.displayText).toBe("Read by an Agent.");
  });

  it("refuses empty, oversized, and non-ASCII display copy", () => {
    for (const displayText of ["", "   ", "\t\n"]) {
      expect(capture({ displayText })).toThrow(/must not be empty/);
    }
    expect(capture({ displayText: "a ".repeat(200) })).toThrow(/must not exceed/);
    for (const displayText of ["Read by an Agent\u2014now", "Claimed\u00a0by YOU", "R\u00e9ad by an Agent"]) {
      expect(capture({ displayText }), displayText).toThrow(/printable ASCII/);
    }
    expect(capture({ displayText: 42 as unknown as string })).toThrow(/must be a string/);
  });

  it("refuses renderer path output with unsupported attributes or markup", () => {
    const withPath = (pathElement: string) => () => captureSignatureComposition(SOURCE, {
      version: "renderer-test-1",
      approved: true,
      renderText: () => ({
        svgUtf8: Buffer.from(`<svg viewBox="0 0 420 420">${pathElement}</svg>`),
        width: 420,
        height: 420,
      }),
    } as any);

    expect(withPath('<path d="M 0 0 L 4 4" fill="#111" onload="alert(1)"/>')).toThrow(/unsupported markup or attribute/);
    expect(withPath('<path d="M 0 0 L 4 4" fill="#111" class="x"/>')).toThrow(/unsupported markup or attribute/);
    expect(withPath('<path d="M 0 0 L 4 4" fill="none" stroke="#111" stroke-width="wide"/>')).toThrow(/invalid stroke-width attribute/);
    // A filled path ignores stroke geometry, so its stroke-width is not validated.
    expect(withPath('<path d="M 0 0 L 4 4" fill="#111" stroke-width="wide"/>')).not.toThrow();
    expect(withPath('<path d="M 0 0 L 4 4" fill="#111"/>')).not.toThrow();
  });

  it("refuses path data that is not a bounded move-first path", () => {
    for (const d of ["", "L 4 4", "  ", `M 0 0 ${"L 1 1 ".repeat(170_000)}`, 'M 0 0" onload="x']) {
      expect(capture({}, () => d), JSON.stringify(d.slice(0, 20))).toThrow();
    }
  });
});

describe("presentation validation", () => {
  it("refuses a placement set that does not cover exactly one placement per token", () => {
    const { compiled } = compileFixture();
    const good = presentationFor(compiled.tokens.length);
    expect(() => renderSignatureCompositionSvg(compiled, good)).not.toThrow();
    expect(() => renderSignatureCompositionSvg(compiled, presentationFor(compiled.tokens.length - 1))).toThrow();
    expect(() => renderSignatureCompositionSvg(compiled, presentationFor(compiled.tokens.length + 1))).toThrow();
  });

  it("refuses non-finite geometry in a placement or viewport", () => {
    const { compiled } = compileFixture();
    const base = presentationFor(compiled.tokens.length);
    const broken = (patch: Record<string, unknown>) => ({ ...base, ...patch }) as SignatureCompositionPresentation;
    for (const patch of [
      { width: 0 }, { height: -1 }, { width: Number.POSITIVE_INFINITY },
      { viewBox: [0, 0, Number.NaN, 360] }, { viewBox: [0, 0, 1_200] },
    ]) {
      expect(() => renderSignatureCompositionSvg(compiled, broken(patch)), JSON.stringify(patch)).toThrow();
    }
    for (const patch of [{ scale: 0 }, { scale: -1 }, { translateX: Number.NaN }, { tokenIndex: 99 }]) {
      const placements = base.placements.map((placement, index) => index === 0 ? { ...placement, ...patch } : placement);
      expect(() => renderSignatureCompositionSvg(compiled, { ...base, placements }), JSON.stringify(patch)).toThrow();
    }
  });
});
