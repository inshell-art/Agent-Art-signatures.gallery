import { createHash } from "node:crypto";
import { GR0K_SCALE } from "../v1/input.js";
import type { SignatureTextRenderer } from "../v1/renderer.js";

export const SIGNATURE_COMPOSITION_SCHEMA = "signature-composition/2" as const;
const LEGACY_COMPOSITION_SCHEMA = "signature-composition/1" as const;
type CompositionSchema = typeof SIGNATURE_COMPOSITION_SCHEMA | typeof LEGACY_COMPOSITION_SCHEMA;
export const SIGNATURE_SHAPE_LOCK_SCHEMA = "signature-shape-lock/1" as const;

const MAX_DISPLAY_CHARACTERS = 512;
const MAX_WORDS = 64;
const MAX_JOINED_PHRASE_CHARACTERS = 96;
const MAX_PATH_DATA_CHARACTERS = 1_000_000;
const SVG_PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]+$/;
const XML_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type SignatureCompositionErrorCode =
  | "INVALID_SPEC"
  | "INVALID_WORD"
  | "INVALID_GR0K"
  | "RENDER_FAILED"
  | "INVALID_RENDERER_OUTPUT"
  | "SHAPE_LOCK_MISSING"
  | "SHAPE_LOCK_MISMATCH"
  | "SHAPE_LOCK_STALE"
  | "INVALID_SNAPSHOT"
  | "INVALID_PRESENTATION";

export class SignatureCompositionError extends Error {
  constructor(
    readonly code: SignatureCompositionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SignatureCompositionError";
  }
}

export interface SignatureCompositionSource {
  /** Stable, machine-readable identity for the composition. */
  id: string;
  /** Human-readable copy. One trailing question mark enters each word's shape; other punctuation is presentation-only. */
  displayText: string;
  /** One explicit reading shared by every word in this composition. */
  gr0kRaw: number;
}

/** Exact, case-sensitive renderer input -> semantic shape hash. */
export type SignatureShapeLock = Readonly<Record<string, string>>;

export interface LockedSignatureCompositionSpec extends SignatureCompositionSource {
  /** Must contain exactly one entry for every distinct, case-sensitive word. */
  shapeLock: SignatureShapeLock;
}

export interface SignatureWordToken {
  readonly tokenIndex: number;
  readonly displayWord: string;
  readonly rendererInput: string;
  readonly start: number;
  readonly end: number;
}

export type SignaturePathDrawing =
  | {
      readonly mode: "fill";
      readonly d: string;
    }
  | {
      readonly mode: "stroke";
      readonly d: string;
      readonly strokeWidth: string;
      readonly strokeLinecap: "butt" | "round" | "square";
      readonly strokeLinejoin: "arcs" | "bevel" | "miter" | "miter-clip" | "round";
    };

export interface CapturedSignatureGlyph {
  readonly rendererInput: string;
  readonly firstDisplayWord: string;
  readonly width: number;
  readonly height: number;
  readonly svgSha256: string;
  readonly sourcePathElementSha256: string;
  /** Locks geometry, paint mode, stroke geometry, and renderer coordinate space. */
  readonly shapeSha256: string;
  readonly drawing: SignaturePathDrawing;
}

export interface CapturedSignatureComposition {
  readonly schema: CompositionSchema;
  readonly id: string;
  readonly displayText: string;
  readonly rendererVersion: string;
  readonly rendererApproved: boolean;
  readonly gr0kRaw: number;
  readonly gr0kScale: typeof GR0K_SCALE;
  readonly tokens: readonly SignatureWordToken[];
  readonly glyphs: readonly CapturedSignatureGlyph[];
  /** Candidate lock for an explicit review/update workflow; capture alone does not trust it. */
  readonly proposedShapeLock: SignatureShapeLock;
}

export interface CompiledSignatureComposition extends CapturedSignatureComposition {
  readonly shapeLockSchema: typeof SIGNATURE_SHAPE_LOCK_SCHEMA;
  readonly verifiedShapeLock: SignatureShapeLock;
}

/** JSON-safe, checked-in representation consumed by the renderer-free runtime boundary. */
export type SignatureCompositionSnapshot = CompiledSignatureComposition;

export interface UniformSignaturePlacement {
  readonly tokenIndex: number;
  readonly translateX: number;
  readonly translateY: number;
  /** A single positive value by design: non-uniform scaling has no API surface. */
  readonly scale: number;
}

export interface SignatureCompositionPresentation {
  readonly viewBox: readonly [x: number, y: number, width: number, height: number];
  readonly width: number;
  readonly height: number;
  /** Exactly one placement for every token. */
  readonly placements: readonly UniformSignaturePlacement[];
}

export interface ResolvedUniformSignaturePlacement extends UniformSignaturePlacement {
  readonly displayWord: string;
  readonly rendererInput: string;
  readonly shapeSha256: string;
  readonly transform: string;
}

export interface SignatureCompositionDescription {
  readonly schema: CompositionSchema;
  readonly id: string;
  readonly displayText: string;
  readonly rendererVersion: string;
  readonly gr0kRaw: number;
  readonly gr0kScale: typeof GR0K_SCALE;
  readonly viewBox: string;
  readonly width: number;
  readonly height: number;
  readonly distinctGlyphCount: number;
  readonly placements: readonly ResolvedUniformSignaturePlacement[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedDisplayText(value: string): string {
  if (typeof value !== "string") {
    throw new SignatureCompositionError("INVALID_SPEC", "Composition displayText must be a string.");
  }
  const normalized = value.normalize("NFC").trim().replace(/[\t\n\f\r ]+/g, " ");
  if (normalized.length === 0) {
    throw new SignatureCompositionError("INVALID_SPEC", "Composition displayText must not be empty.");
  }
  if (normalized.length > MAX_DISPLAY_CHARACTERS) {
    throw new SignatureCompositionError(
      "INVALID_SPEC",
      `Composition displayText must not exceed ${MAX_DISPLAY_CHARACTERS} characters.`,
    );
  }
  // Only printable ASCII separators are accepted. This prevents a Unicode word
  // from being silently reduced to an unrelated ASCII renderer input.
  if (!/^[\x20-\x7e]+$/.test(normalized)) {
    throw new SignatureCompositionError(
      "INVALID_WORD",
      "Composition words and separators must use printable ASCII characters.",
    );
  }
  return normalized;
}

function validateCompositionRendererInput(value: string): string {
  const questionMark = value.endsWith("?") ? "?" : "";
  const word = questionMark ? value.slice(0, -1) : value;
  if (value.length > MAX_JOINED_PHRASE_CHARACTERS) {
    throw new Error("Composition input, including a trailing question mark, must not exceed 96 characters.");
  }
  if (/^[A-Za-z0-9_]{1,15}$/.test(word)) return value;

  // Longer underscore-joined phrases belong only to presentation composition.
  // These are validation bounds only: never alter the spelling. The phrase (and its
  // optional question mark) is not an X handle and must never relax artifact,
  // route, or claim validation.
  if (!/^[A-Za-z0-9]{1,15}(?:_[A-Za-z0-9]{1,15})+$/.test(word)) {
    throw new Error("Extended composition input must be an underscore-joined phrase of at most 96 characters.");
  }
  return value;
}

/**
 * Splits presentation copy into word occurrences. Underscore-joined phrases
 * remain one renderer input. One trailing question mark enters the shape;
 * other punctuation remains outside it. Repeated question marks are rejected.
 */
export function tokenizeSignatureWords(displayText: string): readonly SignatureWordToken[] {
  const normalized = normalizedDisplayText(displayText);
  const matches = normalized.matchAll(/[A-Za-z0-9_]+\?*/g);
  const tokens: SignatureWordToken[] = [];

  for (const match of matches) {
    const displayWord = match[0];
    const start = match.index;
    let rendererInput: string;
    try {
      rendererInput = validateCompositionRendererInput(displayWord);
    } catch (error) {
      throw new SignatureCompositionError(
        "INVALID_WORD",
        `Composition word ${JSON.stringify(displayWord)} is not a valid X-handle-shaped word or presentation-only underscore-joined phrase.`,
        { cause: error },
      );
    }
    tokens.push(
      Object.freeze({
        tokenIndex: tokens.length,
        displayWord,
        rendererInput,
        start,
        end: start + displayWord.length,
      }),
    );
  }

  if (tokens.length === 0) {
    throw new SignatureCompositionError("INVALID_WORD", "Composition must contain at least one renderer word.");
  }
  if (tokens.length > MAX_WORDS) {
    throw new SignatureCompositionError("INVALID_WORD", `Composition must not exceed ${MAX_WORDS} words.`);
  }
  return Object.freeze(tokens);
}

function assertSource(source: SignatureCompositionSource): { id: string; displayText: string; gr0kRaw: number } {
  if (typeof source.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(source.id)) {
    throw new SignatureCompositionError(
      "INVALID_SPEC",
      "Composition id must be 1-80 lowercase letters, numbers, dots, underscores, or hyphens.",
    );
  }
  if (!Number.isInteger(source.gr0kRaw) || source.gr0kRaw < 0 || source.gr0kRaw > GR0K_SCALE) {
    throw new SignatureCompositionError(
      "INVALID_GR0K",
      `Composition gr0kRaw must be an integer from 0 through ${GR0K_SCALE}.`,
    );
  }
  return { id: source.id, displayText: normalizedDisplayText(source.displayText), gr0kRaw: source.gr0kRaw };
}

function attribute(pathElement: string, name: string): string | undefined {
  const match = pathElement.match(new RegExp(`(?:\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "s"));
  return match?.[2];
}

function numericAttribute(pathElement: string, name: string): string | undefined {
  const value = attribute(pathElement, name);
  if (value === undefined) return undefined;
  if (!XML_NUMBER.test(value) || !Number.isFinite(Number(value))) {
    throw new SignatureCompositionError(
      "INVALID_RENDERER_OUTPUT",
      `Renderer path has an invalid ${name} attribute.`,
    );
  }
  return value;
}

function assertSupportedPathAttributes(pathElement: string): void {
  const allowed = new Set(["d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]);
  const body = pathElement.slice("<path".length, -1).replace(/\/\s*$/, "");
  const attributes = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/gs;
  let cursor = 0;
  for (const match of body.matchAll(attributes)) {
    const start = match.index;
    if (body.slice(cursor, start).trim().length > 0 || !allowed.has(match[1])) {
      throw new SignatureCompositionError(
        "INVALID_RENDERER_OUTPUT",
        `Renderer path contains unsupported markup or attribute ${JSON.stringify(match[1])}.`,
      );
    }
    cursor = start + match[0].length;
  }
  if (body.slice(cursor).trim().length > 0) {
    throw new SignatureCompositionError("INVALID_RENDERER_OUTPUT", "Renderer path contains malformed markup.");
  }
}

function isSafePathData(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_DATA_CHARACTERS &&
    /^\s*[Mm]/.test(value) &&
    SVG_PATH_DATA.test(value)
  );
}

function extractPathDrawing(svg: string): { pathElement: string; drawing: SignaturePathDrawing } {
  const paths = svg.match(/<path\b[^>]*>/g) ?? [];
  if (paths.length !== 1) {
    throw new SignatureCompositionError(
      "INVALID_RENDERER_OUTPUT",
      `Renderer output must contain exactly one path; received ${paths.length}.`,
    );
  }

  const pathElement = paths[0];
  assertSupportedPathAttributes(pathElement);
  const d = attribute(pathElement, "d");
  if (!isSafePathData(d)) {
    throw new SignatureCompositionError(
      "INVALID_RENDERER_OUTPUT",
      "Renderer path must contain safe SVG path data.",
    );
  }

  const fill = attribute(pathElement, "fill");
  const stroke = attribute(pathElement, "stroke");
  if (fill === "none") {
    if (!stroke || stroke === "none") {
      throw new SignatureCompositionError(
        "INVALID_RENDERER_OUTPUT",
        "A non-filled renderer path must declare a visible stroke.",
      );
    }
    const strokeWidth = numericAttribute(pathElement, "stroke-width");
    if (!strokeWidth || Number(strokeWidth) <= 0) {
      throw new SignatureCompositionError(
        "INVALID_RENDERER_OUTPUT",
        "A stroked renderer path must declare a positive stroke-width.",
      );
    }
    const strokeLinecap = attribute(pathElement, "stroke-linecap") ?? "butt";
    const strokeLinejoin = attribute(pathElement, "stroke-linejoin") ?? "miter";
    if (!(["butt", "round", "square"] as const).includes(strokeLinecap as "butt")) {
      throw new SignatureCompositionError("INVALID_RENDERER_OUTPUT", "Renderer path has an invalid stroke-linecap.");
    }
    if (!(["arcs", "bevel", "miter", "miter-clip", "round"] as const).includes(strokeLinejoin as "arcs")) {
      throw new SignatureCompositionError("INVALID_RENDERER_OUTPUT", "Renderer path has an invalid stroke-linejoin.");
    }
    return {
      pathElement,
      drawing: Object.freeze({
        mode: "stroke" as const,
        d,
        strokeWidth,
        strokeLinecap: strokeLinecap as "butt" | "round" | "square",
        strokeLinejoin: strokeLinejoin as "arcs" | "bevel" | "miter" | "miter-clip" | "round",
      }),
    };
  }

  if (stroke && stroke !== "none") {
    throw new SignatureCompositionError(
      "INVALID_RENDERER_OUTPUT",
      "Renderer paths that combine fill and stroke are not supported by the composition adapter.",
    );
  }
  return { pathElement, drawing: Object.freeze({ mode: "fill" as const, d }) };
}

function shapeDescriptor(width: number, height: number, drawing: SignaturePathDrawing): string {
  if (drawing.mode === "fill") return `shape-v1\ncanvas=${width}x${height}\nmode=fill\nd=${drawing.d}`;
  return [
    "shape-v1",
    `canvas=${width}x${height}`,
    "mode=stroke",
    `stroke-width=${drawing.strokeWidth}`,
    `stroke-linecap=${drawing.strokeLinecap}`,
    `stroke-linejoin=${drawing.strokeLinejoin}`,
    `d=${drawing.d}`,
  ].join("\n");
}

function cloneShapeLock(shapeLock: SignatureShapeLock): SignatureShapeLock {
  const clone: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rendererInput, hash] of Object.entries(shapeLock)) clone[rendererInput] = hash;
  return Object.freeze(clone);
}

function snapshotRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label} must be JSON-compatible.`);
  }
  return value as Record<string, unknown>;
}

function assertExactSnapshotKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedKeys = new Set(expected);
  const actualKeys = Reflect.ownKeys(value);
  for (const key of actualKeys) {
    if (typeof key !== "string" || !expectedKeys.has(key)) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `${label} contains unexpected property ${typeof key === "string" ? JSON.stringify(key) : String(key)}.`,
      );
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label} is missing property ${JSON.stringify(key)}.`);
    }
  }
}

function snapshotString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label} must be a string.`);
  }
  return value;
}

function snapshotInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new SignatureCompositionError(
      "INVALID_SNAPSHOT",
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value as number;
}

function snapshotHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label} must be a lowercase SHA-256 hash.`);
  }
  return value;
}

function restoreDrawing(value: unknown, label: string): SignaturePathDrawing {
  const drawing = snapshotRecord(value, label);
  const mode = snapshotString(drawing.mode, `${label}.mode`);
  if (mode === "fill") {
    assertExactSnapshotKeys(drawing, ["mode", "d"], label);
    const d = drawing.d;
    if (!isSafePathData(d)) {
      throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label}.d must be safe SVG path data.`);
    }
    return Object.freeze({ mode, d });
  }
  if (mode === "stroke") {
    assertExactSnapshotKeys(
      drawing,
      ["mode", "d", "strokeWidth", "strokeLinecap", "strokeLinejoin"],
      label,
    );
    const d = drawing.d;
    if (!isSafePathData(d)) {
      throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label}.d must be safe SVG path data.`);
    }
    const strokeWidth = snapshotString(drawing.strokeWidth, `${label}.strokeWidth`);
    if (!XML_NUMBER.test(strokeWidth) || !Number.isFinite(Number(strokeWidth)) || Number(strokeWidth) <= 0) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `${label}.strokeWidth must be a positive finite SVG number.`,
      );
    }
    const strokeLinecap = snapshotString(drawing.strokeLinecap, `${label}.strokeLinecap`);
    if (!( ["butt", "round", "square"] as readonly string[]).includes(strokeLinecap)) {
      throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label}.strokeLinecap is not supported.`);
    }
    const strokeLinejoin = snapshotString(drawing.strokeLinejoin, `${label}.strokeLinejoin`);
    if (!( ["arcs", "bevel", "miter", "miter-clip", "round"] as readonly string[]).includes(strokeLinejoin)) {
      throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label}.strokeLinejoin is not supported.`);
    }
    return Object.freeze({
      mode,
      d,
      strokeWidth,
      strokeLinecap: strokeLinecap as "butt" | "round" | "square",
      strokeLinejoin: strokeLinejoin as "arcs" | "bevel" | "miter" | "miter-clip" | "round",
    });
  }
  throw new SignatureCompositionError("INVALID_SNAPSHOT", `${label}.mode must be "fill" or "stroke".`);
}

function restoreSnapshotLock(value: unknown, label: string): SignatureShapeLock {
  const lock = snapshotRecord(value, label);
  const restored: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rendererInput, hash] of Object.entries(lock)) {
    let canonical: string;
    try {
      canonical = validateCompositionRendererInput(rendererInput);
    } catch (error) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `${label} key ${JSON.stringify(rendererInput)} is not a canonical renderer input.`,
        { cause: error },
      );
    }
    if (canonical !== rendererInput) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `${label} key ${JSON.stringify(rendererInput)} is not a literal renderer input.`,
      );
    }
    restored[rendererInput] = snapshotHash(hash, `${label}.${rendererInput}`);
  }
  return Object.freeze(restored);
}

/**
 * Renders every distinct case-sensitive word once and returns hashes suitable for
 * explicit lock review. This function captures candidates; it does not verify
 * or silently approve them.
 */
export function captureSignatureComposition(
  source: SignatureCompositionSource,
  renderer: SignatureTextRenderer,
): CapturedSignatureComposition {
  const checked = assertSource(source);
  if (!renderer || typeof renderer.version !== "string" || renderer.version.length === 0 || typeof renderer.renderText !== "function") {
    throw new SignatureCompositionError("INVALID_SPEC", "A versioned SignatureTextRenderer is required.");
  }
  const tokens = tokenizeSignatureWords(checked.displayText);
  const firstTokenForWord = new Map<string, SignatureWordToken>();
  for (const token of tokens) {
    if (!firstTokenForWord.has(token.rendererInput)) firstTokenForWord.set(token.rendererInput, token);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const glyphs: CapturedSignatureGlyph[] = [];
  for (const [rendererInput, token] of firstTokenForWord) {
    let output;
    try {
      output = renderer.renderText({
        text: rendererInput,
        gr0kRaw: checked.gr0kRaw,
        gr0kScale: GR0K_SCALE,
        rendererVersion: renderer.version,
      });
    } catch (error) {
      throw new SignatureCompositionError(
        "RENDER_FAILED",
        `Renderer failed while capturing ${JSON.stringify(rendererInput)}.`,
        { cause: error },
      );
    }
    if (
      !output ||
      !(output.svgUtf8 instanceof Uint8Array) ||
      !Number.isInteger(output.width) ||
      output.width <= 0 ||
      !Number.isInteger(output.height) ||
      output.height <= 0
    ) {
      throw new SignatureCompositionError(
        "INVALID_RENDERER_OUTPUT",
        `Renderer returned invalid dimensions or bytes for ${JSON.stringify(rendererInput)}.`,
      );
    }

    let svg: string;
    try {
      svg = decoder.decode(output.svgUtf8);
    } catch (error) {
      throw new SignatureCompositionError(
        "INVALID_RENDERER_OUTPUT",
        `Renderer returned non-UTF-8 SVG for ${JSON.stringify(rendererInput)}.`,
        { cause: error },
      );
    }
    const { pathElement, drawing } = extractPathDrawing(svg);
    glyphs.push(
      Object.freeze({
        rendererInput,
        firstDisplayWord: token.displayWord,
        width: output.width,
        height: output.height,
        svgSha256: sha256(output.svgUtf8),
        sourcePathElementSha256: sha256(pathElement),
        shapeSha256: sha256(shapeDescriptor(output.width, output.height, drawing)),
        drawing,
      }),
    );
  }

  const proposedShapeLock: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const glyph of glyphs) proposedShapeLock[glyph.rendererInput] = glyph.shapeSha256;

  return Object.freeze({
    schema: SIGNATURE_COMPOSITION_SCHEMA,
    id: checked.id,
    displayText: checked.displayText,
    rendererVersion: renderer.version,
    rendererApproved: renderer.approved,
    gr0kRaw: checked.gr0kRaw,
    gr0kScale: GR0K_SCALE,
    tokens,
    glyphs: Object.freeze(glyphs),
    proposedShapeLock: Object.freeze(proposedShapeLock),
  });
}

/** Enforces exact lock coverage and hash equality; extra stale entries also fail. */
export function assertSignatureShapeLock(
  capture: CapturedSignatureComposition,
  shapeLock: SignatureShapeLock,
): void {
  if (!shapeLock || typeof shapeLock !== "object" || Array.isArray(shapeLock)) {
    throw new SignatureCompositionError("INVALID_SPEC", "shapeLock must be a renderer-input-to-hash record.");
  }
  const expectedWords = new Set(capture.glyphs.map((glyph) => glyph.rendererInput));
  for (const glyph of capture.glyphs) {
    if (!Object.hasOwn(shapeLock, glyph.rendererInput)) {
      throw new SignatureCompositionError(
        "SHAPE_LOCK_MISSING",
        `Shape lock is missing ${JSON.stringify(glyph.rendererInput)} (${glyph.shapeSha256}).`,
      );
    }
    const lockedHash = shapeLock[glyph.rendererInput];
    if (!/^[a-f0-9]{64}$/.test(lockedHash)) {
      throw new SignatureCompositionError(
        "SHAPE_LOCK_MISMATCH",
        `Shape lock for ${JSON.stringify(glyph.rendererInput)} is not a lowercase SHA-256 hash.`,
      );
    }
    if (lockedHash !== glyph.shapeSha256) {
      throw new SignatureCompositionError(
        "SHAPE_LOCK_MISMATCH",
        `Shape lock mismatch for ${JSON.stringify(glyph.rendererInput)}: locked ${lockedHash}, rendered ${glyph.shapeSha256}.`,
      );
    }
  }
  for (const lockedWord of Object.keys(shapeLock)) {
    if (!expectedWords.has(lockedWord)) {
      throw new SignatureCompositionError(
        "SHAPE_LOCK_STALE",
        `Shape lock contains stale renderer input ${JSON.stringify(lockedWord)}.`,
      );
    }
  }
}

/** Captures through the renderer, then fails closed unless the checked lock is exact. */
export function compileSignatureComposition(
  spec: LockedSignatureCompositionSpec,
  renderer: SignatureTextRenderer,
): CompiledSignatureComposition {
  const capture = captureSignatureComposition(spec, renderer);
  assertSignatureShapeLock(capture, spec.shapeLock);
  return Object.freeze({
    ...capture,
    shapeLockSchema: SIGNATURE_SHAPE_LOCK_SCHEMA,
    verifiedShapeLock: cloneShapeLock(spec.shapeLock),
  });
}

/**
 * Restores a checked-in JSON/TypeScript snapshot without touching a renderer.
 * Every derived relationship is rebuilt or rechecked before path data becomes
 * available to presentation code.
 */
export function restoreSignatureCompositionSnapshot(value: unknown): CompiledSignatureComposition {
  const snapshot = snapshotRecord(value, "Signature composition snapshot");
  assertExactSnapshotKeys(
    snapshot,
    [
      "schema",
      "id",
      "displayText",
      "rendererVersion",
      "rendererApproved",
      "gr0kRaw",
      "gr0kScale",
      "tokens",
      "glyphs",
      "proposedShapeLock",
      "shapeLockSchema",
      "verifiedShapeLock",
    ],
    "Signature composition snapshot",
  );
  if (snapshot.schema !== SIGNATURE_COMPOSITION_SCHEMA && snapshot.schema !== LEGACY_COMPOSITION_SCHEMA) {
    throw new SignatureCompositionError(
      "INVALID_SNAPSHOT",
      `Signature composition snapshot schema must be ${JSON.stringify(SIGNATURE_COMPOSITION_SCHEMA)}.`,
    );
  }
  if (snapshot.shapeLockSchema !== SIGNATURE_SHAPE_LOCK_SCHEMA) {
    throw new SignatureCompositionError(
      "INVALID_SNAPSHOT",
      `Signature composition shape-lock schema must be ${JSON.stringify(SIGNATURE_SHAPE_LOCK_SCHEMA)}.`,
    );
  }

  const id = snapshotString(snapshot.id, "Snapshot id");
  const displayText = snapshotString(snapshot.displayText, "Snapshot displayText");
  const gr0kRaw = snapshotInteger(snapshot.gr0kRaw, "Snapshot gr0kRaw", 0, GR0K_SCALE);
  const checkedSource = assertSource({ id, displayText, gr0kRaw });
  if (checkedSource.displayText !== displayText) {
    throw new SignatureCompositionError(
      "INVALID_SNAPSHOT",
      "Snapshot displayText must already be NFC-normalized with canonical whitespace.",
    );
  }
  if (snapshot.gr0kScale !== GR0K_SCALE) {
    throw new SignatureCompositionError(
      "INVALID_SNAPSHOT",
      `Snapshot gr0kScale must be the canonical ${GR0K_SCALE}.`,
    );
  }
  const rendererVersion = snapshotString(snapshot.rendererVersion, "Snapshot rendererVersion");
  if (!/^[\x21-\x7e]{1,128}$/.test(rendererVersion)) {
    throw new SignatureCompositionError(
      "INVALID_SNAPSHOT",
      "Snapshot rendererVersion must be 1-128 non-whitespace printable ASCII characters.",
    );
  }
  if (typeof snapshot.rendererApproved !== "boolean") {
    throw new SignatureCompositionError("INVALID_SNAPSHOT", "Snapshot rendererApproved must be boolean.");
  }

  const literalTokens = tokenizeSignatureWords(displayText);
  // Read-only compatibility for previously reviewed v1 bytes. This never
  // participates in capture, and a v1 lock cannot be relabelled as a v2 lock.
  const expectedTokens = snapshot.schema === LEGACY_COMPOSITION_SCHEMA
    ? literalTokens.map((token) => ({ ...token, rendererInput: token.rendererInput.toLowerCase() }))
    : literalTokens;
  if (!Array.isArray(snapshot.tokens) || snapshot.tokens.length !== expectedTokens.length) {
    throw new SignatureCompositionError(
      "INVALID_SNAPSHOT",
      `Snapshot tokens must exactly reproduce all ${expectedTokens.length} display-word occurrences.`,
    );
  }
  const tokens = snapshot.tokens.map((value, tokenIndex) => {
    const token = snapshotRecord(value, `Snapshot token ${tokenIndex}`);
    assertExactSnapshotKeys(
      token,
      ["tokenIndex", "displayWord", "rendererInput", "start", "end"],
      `Snapshot token ${tokenIndex}`,
    );
    const expected = expectedTokens[tokenIndex];
    if (
      token.tokenIndex !== expected.tokenIndex ||
      token.displayWord !== expected.displayWord ||
      token.rendererInput !== expected.rendererInput ||
      token.start !== expected.start ||
      token.end !== expected.end
    ) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `Snapshot token ${tokenIndex} does not match canonical tokenization of displayText.`,
      );
    }
    return Object.freeze({ ...expected });
  });

  const firstTokenByRendererInput = new Map<string, SignatureWordToken>();
  for (const token of expectedTokens) {
    if (!firstTokenByRendererInput.has(token.rendererInput)) {
      firstTokenByRendererInput.set(token.rendererInput, token);
    }
  }
  if (!Array.isArray(snapshot.glyphs) || snapshot.glyphs.length !== firstTokenByRendererInput.size) {
    throw new SignatureCompositionError(
      "INVALID_SNAPSHOT",
      `Snapshot glyphs must cover exactly ${firstTokenByRendererInput.size} distinct canonical words.`,
    );
  }
  const seenGlyphs = new Set<string>();
  const glyphs = snapshot.glyphs.map((value, glyphIndex) => {
    const glyph = snapshotRecord(value, `Snapshot glyph ${glyphIndex}`);
    assertExactSnapshotKeys(
      glyph,
      [
        "rendererInput",
        "firstDisplayWord",
        "width",
        "height",
        "svgSha256",
        "sourcePathElementSha256",
        "shapeSha256",
        "drawing",
      ],
      `Snapshot glyph ${glyphIndex}`,
    );
    const rendererInput = snapshotString(glyph.rendererInput, `Snapshot glyph ${glyphIndex}.rendererInput`);
    const expectedFirstToken = firstTokenByRendererInput.get(rendererInput);
    if (!expectedFirstToken || seenGlyphs.has(rendererInput)) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `Snapshot glyph ${glyphIndex} is duplicate or does not belong to displayText.`,
      );
    }
    seenGlyphs.add(rendererInput);
    if (glyph.firstDisplayWord !== expectedFirstToken.displayWord) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `Snapshot glyph ${glyphIndex}.firstDisplayWord does not match its first token occurrence.`,
      );
    }
    const width = snapshotInteger(glyph.width, `Snapshot glyph ${glyphIndex}.width`, 1, Number.MAX_SAFE_INTEGER);
    const height = snapshotInteger(glyph.height, `Snapshot glyph ${glyphIndex}.height`, 1, Number.MAX_SAFE_INTEGER);
    const drawing = restoreDrawing(glyph.drawing, `Snapshot glyph ${glyphIndex}.drawing`);
    const shapeSha256 = snapshotHash(glyph.shapeSha256, `Snapshot glyph ${glyphIndex}.shapeSha256`);
    const recomputedShapeHash = sha256(shapeDescriptor(width, height, drawing));
    if (shapeSha256 !== recomputedShapeHash) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `Snapshot glyph ${JSON.stringify(rendererInput)} shape hash does not match its stored drawing and coordinate space.`,
      );
    }
    return Object.freeze({
      rendererInput,
      firstDisplayWord: expectedFirstToken.displayWord,
      width,
      height,
      svgSha256: snapshotHash(glyph.svgSha256, `Snapshot glyph ${glyphIndex}.svgSha256`),
      sourcePathElementSha256: snapshotHash(
        glyph.sourcePathElementSha256,
        `Snapshot glyph ${glyphIndex}.sourcePathElementSha256`,
      ),
      shapeSha256,
      drawing,
    });
  });
  for (const rendererInput of firstTokenByRendererInput.keys()) {
    if (!seenGlyphs.has(rendererInput)) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `Snapshot glyphs are missing canonical word ${JSON.stringify(rendererInput)}.`,
      );
    }
  }

  const proposedShapeLock = restoreSnapshotLock(snapshot.proposedShapeLock, "Snapshot proposedShapeLock");
  const verifiedShapeLock = restoreSnapshotLock(snapshot.verifiedShapeLock, "Snapshot verifiedShapeLock");
  const capture: CapturedSignatureComposition = Object.freeze({
    schema: snapshot.schema,
    id,
    displayText,
    rendererVersion,
    rendererApproved: snapshot.rendererApproved,
    gr0kRaw,
    gr0kScale: GR0K_SCALE,
    tokens: Object.freeze(tokens),
    glyphs: Object.freeze(glyphs),
    proposedShapeLock,
  });
  assertSignatureShapeLock(capture, proposedShapeLock);
  assertSignatureShapeLock(capture, verifiedShapeLock);
  for (const rendererInput of Object.keys(proposedShapeLock)) {
    if (proposedShapeLock[rendererInput] !== verifiedShapeLock[rendererInput]) {
      throw new SignatureCompositionError(
        "INVALID_SNAPSHOT",
        `Snapshot proposed and verified locks differ for ${JSON.stringify(rendererInput)}.`,
      );
    }
  }
  return Object.freeze({
    ...capture,
    shapeLockSchema: SIGNATURE_SHAPE_LOCK_SCHEMA,
    verifiedShapeLock,
  });
}

/** Produces a deeply frozen, JSON-safe copy for review and check-in. */
export function createSignatureCompositionSnapshot(
  composition: CompiledSignatureComposition,
): SignatureCompositionSnapshot {
  return restoreSignatureCompositionSnapshot(composition);
}

function svgNumber(value: number, label: string): string {
  if (!Number.isFinite(value)) {
    throw new SignatureCompositionError("INVALID_PRESENTATION", `${label} must be finite.`);
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function resolvePresentation(
  composition: CompiledSignatureComposition,
  presentation: SignatureCompositionPresentation,
): { viewBox: string; placements: readonly ResolvedUniformSignaturePlacement[] } {
  if (!presentation || !Array.isArray(presentation.viewBox) || presentation.viewBox.length !== 4) {
    throw new SignatureCompositionError("INVALID_PRESENTATION", "Presentation viewBox must contain four numbers.");
  }
  const [viewX, viewY, viewWidth, viewHeight] = presentation.viewBox;
  const viewBox = [
    svgNumber(viewX, "viewBox x"),
    svgNumber(viewY, "viewBox y"),
    svgNumber(viewWidth, "viewBox width"),
    svgNumber(viewHeight, "viewBox height"),
  ].join(" ");
  if (viewWidth <= 0 || viewHeight <= 0) {
    throw new SignatureCompositionError("INVALID_PRESENTATION", "Presentation viewBox dimensions must be positive.");
  }
  if (!Number.isFinite(presentation.width) || presentation.width <= 0 || !Number.isFinite(presentation.height) || presentation.height <= 0) {
    throw new SignatureCompositionError("INVALID_PRESENTATION", "Presentation output dimensions must be positive.");
  }
  if (!Array.isArray(presentation.placements) || presentation.placements.length !== composition.tokens.length) {
    throw new SignatureCompositionError(
      "INVALID_PRESENTATION",
      `Presentation must contain exactly ${composition.tokens.length} placements.`,
    );
  }

  const allowedKeys = new Set(["tokenIndex", "translateX", "translateY", "scale"]);
  const byTokenIndex = new Map<number, UniformSignaturePlacement>();
  for (const placement of presentation.placements) {
    if (!placement || typeof placement !== "object") {
      throw new SignatureCompositionError("INVALID_PRESENTATION", "Every placement must be an object.");
    }
    for (const key of Object.keys(placement)) {
      if (!allowedKeys.has(key)) {
        throw new SignatureCompositionError(
          "INVALID_PRESENTATION",
          `Placement property ${JSON.stringify(key)} is not allowed; use one uniform scale value.`,
        );
      }
    }
    if (!Number.isInteger(placement.tokenIndex) || placement.tokenIndex < 0 || placement.tokenIndex >= composition.tokens.length) {
      throw new SignatureCompositionError("INVALID_PRESENTATION", "Placement tokenIndex is out of range.");
    }
    if (byTokenIndex.has(placement.tokenIndex)) {
      throw new SignatureCompositionError(
        "INVALID_PRESENTATION",
        `Token ${placement.tokenIndex} has more than one placement.`,
      );
    }
    if (!Number.isFinite(placement.scale) || placement.scale <= 0) {
      throw new SignatureCompositionError("INVALID_PRESENTATION", "Placement scale must be one positive finite number.");
    }
    svgNumber(placement.translateX, "placement translateX");
    svgNumber(placement.translateY, "placement translateY");
    byTokenIndex.set(placement.tokenIndex, placement);
  }

  const glyphByInput = new Map(composition.glyphs.map((glyph) => [glyph.rendererInput, glyph]));
  const resolved = composition.tokens.map((token) => {
    const placement = byTokenIndex.get(token.tokenIndex);
    const glyph = glyphByInput.get(token.rendererInput);
    if (!placement || !glyph) {
      throw new SignatureCompositionError(
        "INVALID_PRESENTATION",
        `Token ${token.tokenIndex} cannot be resolved to a placement and locked glyph.`,
      );
    }
    const transform = `translate(${svgNumber(placement.translateX, "placement translateX")} ${svgNumber(placement.translateY, "placement translateY")}) scale(${svgNumber(placement.scale, "placement scale")})`;
    return Object.freeze({
      ...placement,
      displayWord: token.displayWord,
      rendererInput: token.rendererInput,
      shapeSha256: glyph.shapeSha256,
      transform,
    });
  });
  return { viewBox, placements: Object.freeze(resolved) };
}

/** Returns a serializable provenance/layout description without SVG markup. */
export function describeSignatureComposition(
  composition: CompiledSignatureComposition,
  presentation: SignatureCompositionPresentation,
): SignatureCompositionDescription {
  const resolved = resolvePresentation(composition, presentation);
  return Object.freeze({
    schema: composition.schema,
    id: composition.id,
    displayText: composition.displayText,
    rendererVersion: composition.rendererVersion,
    gr0kRaw: composition.gr0kRaw,
    gr0kScale: composition.gr0kScale,
    viewBox: resolved.viewBox,
    width: presentation.width,
    height: presentation.height,
    distinctGlyphCount: composition.glyphs.length,
    placements: resolved.placements,
  });
}

function drawingElement(drawing: SignaturePathDrawing): string {
  if (drawing.mode === "fill") return `<path d="${drawing.d}" fill="currentColor" stroke="none"/>`;
  return `<path d="${drawing.d}" fill="none" stroke="currentColor" stroke-width="${drawing.strokeWidth}" stroke-linecap="${drawing.strokeLinecap}" stroke-linejoin="${drawing.strokeLinejoin}"/>`;
}

/**
 * Renders only trusted locked paths. Every placement is translation plus one
 * scale value, so presentation cannot stretch renderer geometry on one axis.
 */
export function renderSignatureCompositionSvg(
  composition: CompiledSignatureComposition,
  presentation: SignatureCompositionPresentation,
): string {
  const description = describeSignatureComposition(composition, presentation);
  const glyphByInput = new Map(composition.glyphs.map((glyph) => [glyph.rendererInput, glyph]));
  const paths = description.placements.map((placement) => {
    const glyph = glyphByInput.get(placement.rendererInput);
    if (!glyph) {
      throw new SignatureCompositionError("INVALID_PRESENTATION", "A placement references a missing locked glyph.");
    }
    return `<g transform="${placement.transform}">${drawingElement(glyph.drawing)}</g>`;
  });
  return `<svg viewBox="${description.viewBox}" xmlns="http://www.w3.org/2000/svg" width="${description.width}" height="${description.height}" fill="none" aria-hidden="true" focusable="false">${paths.join("")}</svg>`;
}
