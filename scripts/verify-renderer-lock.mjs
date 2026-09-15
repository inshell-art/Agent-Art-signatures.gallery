import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { verifyRendererV2Lock } from "./verify-renderer-v2-lock.mjs";
import {
  DEFAULT_GR0K_RAW, DEFAULT_OUTPUT_SIZE, FORMAL_ALGORITHM_VERSION,
  FORMAL_BACKGROUND, FORMAL_INK, renderSignatureSvg,
} from "../src/algorithmV1/index.ts";
import { GR0K_DEFAULT, GR0K_MAX, GR0K_MIN, GR0K_SCALE } from "../src/v1/input.ts";
import { CARD_RENDERER_VERSION, RENDERER_VERSION, formalSignatureRenderer } from "../src/v1/renderer.ts";

export const LOCK_PATH = "reference/algorithm-v1.0.0/renderer-lock.json";
const readRepositoryFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lockedSourcePaths = [
  "reference/algorithm-v1.0.0/signature_algorithm_v1.py",
  "reference/algorithm-v1.0.0/signature_algorithm_v1.json",
  "reference/algorithm-v1.0.0/SHA256SUMS",
  "src/algorithmV1/index.ts",
  "src/v1/renderer.ts",
  "src/v1/input.ts",
];

/** Verification only: never rewrite the approved lock or regenerate goldens. */
export function verifyRendererLock({ read = readRepositoryFile } = {}) {
  const lock = JSON.parse(read(LOCK_PATH).toString());
  assert.equal(lock.schema, "signatures-gallery-renderer-lock/1", "Unknown renderer lock schema.");
  assert.equal(lock.status, "locked", "Renderer must remain locked.");
  assert.equal(lock.upstream.tag, "v1.0.0");
  assert.equal(lock.upstream.commit, "1e1dab4ec093261006feb7879c109413c0b3ac6d");
  assert.deepEqual(Object.keys(lock.files).sort(), [...lockedSourcePaths].sort(), "Incomplete locked source list.");
  assert.equal(lock.goldenSvgs.length, 17, "Incomplete SVG golden set.");
  for (const [path, expected] of Object.entries(lock.files)) {
    assert.equal(hash(read(path)), expected, `Locked renderer source changed: ${path}. Adopt a new version; do not re-bless v1.0.0.`);
  }

  assert.equal(FORMAL_ALGORITHM_VERSION, lock.algorithmVersion);
  assert.equal(RENDERER_VERSION, lock.rendererVersion);
  assert.equal(CARD_RENDERER_VERSION, lock.cardRendererVersion);
  assert.equal(formalSignatureRenderer.version, lock.rendererVersion);
  assert.equal(formalSignatureRenderer.approved, true);
  assert.deepEqual(lock.contract, {
    handlePattern: "^[A-Za-z0-9_]{1,15}$", caseSensitive: true,
    gr0kMin: GR0K_MIN, gr0kMax: GR0K_MAX, gr0kDefault: GR0K_DEFAULT, gr0kScale: GR0K_SCALE,
    outputSize: DEFAULT_OUTPUT_SIZE, canonicalSize: 420,
    background: FORMAL_BACKGROUND, ink: FORMAL_INK, handleLabel: true,
  }, "Formal renderer contract changed.");
  assert.equal(DEFAULT_GR0K_RAW, GR0K_DEFAULT);

  const pkg = JSON.parse(read("package.json").toString());
  const dependencies = JSON.parse(read("package-lock.json").toString()).packages;
  assert.equal(pkg.dependencies.sharp, lock.rasterizer.sharp, "Sharp must stay exactly pinned.");
  assert.equal(dependencies[""].dependencies.sharp, lock.rasterizer.sharp);
  assert.equal(dependencies["node_modules/sharp"].version, lock.rasterizer.sharp);
  assert.equal(sharp.versions.sharp, lock.rasterizer.sharp, "Installed Sharp differs from the approved version; use npm ci.");

  for (const golden of lock.goldenSvgs) {
    const input = { gr0kRaw: golden.gr0kRaw, gr0kScale: GR0K_SCALE, rendererVersion: RENDERER_VERSION };
    let bytes;
    if (golden.kind === "signature") {
      bytes = golden.width !== undefined || golden.height !== undefined
        ? renderSignatureSvg(golden.handle, golden.gr0kRaw, { width: golden.width, height: golden.height })
        : formalSignatureRenderer.render({ ...input, handle: golden.handle }).svgUtf8;
    } else {
      assert.equal(golden.kind, "text", "Unknown SVG golden kind.");
      bytes = formalSignatureRenderer.renderText({ ...input, text: golden.text }).svgUtf8;
    }
    assert.equal(hash(bytes), golden.sha256, `Locked SVG changed: ${golden.handle ?? golden.text}, seed ${golden.gr0kRaw}.`);
  }
  return { rendererVersion: lock.rendererVersion, sourceFiles: Object.keys(lock.files).length, goldenSvgs: lock.goldenSvgs.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyRendererLock();
    console.log(`Renderer lock verified: ${result.rendererVersion}; ${result.sourceFiles} source files; ${result.goldenSvgs} complete SVG goldens.`);
    const v2 = verifyRendererV2Lock();
    console.log(`Renderer lock verified: ${v2.rendererVersion}; ${v2.sourceFiles} source files; ${v2.goldenSvgs} Python-oracle SVG goldens.`);
  } catch (error) {
    console.error(`Renderer lock FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
