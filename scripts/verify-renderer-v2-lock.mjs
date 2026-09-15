import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORMAL_ALGORITHM_VERSION, RENDERER_VERSION, MBTI_TYPES, renderSignatureSvg } from "../src/algorithmV2/index.ts";

export const LOCK_PATH = "reference/algorithm-v2.0.0/renderer-lock.json";
const GOLDENS_PATH = "reference/algorithm-v2.0.0/golden-svgs.json";
const readRepositoryFile = path => readFileSync(new URL(`../${path}`, import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const protectedPaths = [
  "reference/algorithm-v2.0.0/signature_renderer_v2.0.0.py",
  "reference/algorithm-v2.0.0/signature_renderer_v2.0.0.json",
  "reference/algorithm-v2.0.0/SHA256SUMS",
  GOLDENS_PATH,
  "src/algorithmV2/index.ts",
];

/** Verification only. Never rewrite the upstream source or bless new output hashes. */
export function verifyRendererV2Lock({ read = readRepositoryFile } = {}) {
  const lock = JSON.parse(read(LOCK_PATH).toString());
  assert.equal(lock.schema, "signatures-gallery-renderer-lock/2");
  assert.equal(lock.status, "pinned");
  assert.equal(lock.upstream.tag, "v2.0.0");
  assert.equal(lock.upstream.commit, "4bcc513b53edac6961e385604cd9fcc3ac913cbb");
  assert.equal(lock.upstream.tagObject, "84992e64634ab8d35461122776b53d8da9bd1ccf");
  assert.equal(lock.algorithmVersion, FORMAL_ALGORITHM_VERSION);
  assert.equal(lock.rendererVersion, RENDERER_VERSION);
  assert.deepEqual(Object.keys(lock.files).sort(), [...protectedPaths].sort(), "Incomplete v2 protected source list.");
  for (const [path, expected] of Object.entries(lock.files)) {
    assert.equal(hash(read(path)), expected, `Pinned v2 renderer source changed: ${path}. Adopt a new version.`);
  }
  const spec = JSON.parse(read(protectedPaths[1]).toString());
  assert.deepEqual([...MBTI_TYPES], spec.algorithm.input.mbti_type.values, "MBTI order differs from upstream.");
  assert.equal(spec.algorithm.version, FORMAL_ALGORITHM_VERSION);
  assert.equal(spec.random.mbti_is_hashed, false);
  assert.equal(lock.files[protectedPaths[0]], "c589f8ac607104f77a26347e39d19ba684ef5ee92baa3e3093c62a8df6618f26");
  assert.equal(lock.files[protectedPaths[1]], "cea650e1b84486f5313760cf82a886036d448085b3bc5e70f643161ad406b507");
  const goldens = JSON.parse(read(GOLDENS_PATH).toString());
  assert.equal(goldens.length, 384, "Incomplete v2 SVG oracle set.");
  assert.equal(lock.goldenSvgs, goldens.length);
  for (const golden of goldens) {
    const svg = renderSignatureSvg(golden.handle, golden.mbti, { width: golden.width, height: golden.height });
    assert.equal(hash(svg), golden.sha256, `V2 SVG differs from upstream: ${golden.handle}/${golden.mbti}/${golden.width}x${golden.height}.`);
  }
  return { rendererVersion: RENDERER_VERSION, sourceFiles: protectedPaths.length, goldenSvgs: goldens.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyRendererV2Lock();
    console.log(`Renderer lock verified: ${result.rendererVersion}; ${result.sourceFiles} source files; ${result.goldenSvgs} Python-oracle SVG goldens.`);
  } catch (error) {
    console.error(`Renderer v2 lock FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
