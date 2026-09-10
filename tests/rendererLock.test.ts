import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCK_PATH, verifyRendererLock } from "../scripts/verify-renderer-lock.mjs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));

describe("visually approved v1.0.0 renderer lock", () => {
  it("verifies pinned source, adapter, inputs, dependencies and complete output bytes", () => {
    expect(verifyRendererLock()).toEqual({ rendererVersion: "sg-renderer-1.0.0", sourceFiles: 6, goldenSvgs: 17 });
  });

  it.each(Object.keys(JSON.parse(read(LOCK_PATH).toString()).files))(
    "rejects drift in %s without editing any repository file", (changed) => {
      expect(() => verifyRendererLock({ read: (path: string) => path === changed
        ? Buffer.concat([read(path), Buffer.from("\nchanged")]) : read(path) }))
        .toThrow(`Locked renderer source changed: ${changed}`);
    },
  );

  it("rejects changed golden output hashes", () => {
    const lock = JSON.parse(read(LOCK_PATH).toString());
    lock.goldenSvgs[0].sha256 = "0".repeat(64);
    expect(() => verifyRendererLock({ read: (path: string) => path === LOCK_PATH
      ? Buffer.from(JSON.stringify(lock)) : read(path) })).toThrow("Locked SVG changed: S, seed 22");
  });

  it("rejects an incomplete lock", () => {
    const lock = JSON.parse(read(LOCK_PATH).toString());
    lock.goldenSvgs.pop();
    expect(() => verifyRendererLock({ read: (path: string) => path === LOCK_PATH
      ? Buffer.from(JSON.stringify(lock)) : read(path) })).toThrow("Incomplete SVG golden set");
  });

  it("rejects replacing a protected source even if the number of files stays the same", () => {
    const lock = JSON.parse(read(LOCK_PATH).toString());
    lock.files["unrelated.ts"] = lock.files["src/algorithmV1/index.ts"];
    delete lock.files["src/algorithmV1/index.ts"];
    expect(() => verifyRendererLock({ read: (path: string) => path === LOCK_PATH
      ? Buffer.from(JSON.stringify(lock)) : read(path) })).toThrow("Incomplete locked source list");
  });

  it("rejects a floating rasterizer dependency", () => {
    const pkg = JSON.parse(read("package.json").toString());
    pkg.dependencies.sharp = "^0.35.4";
    expect(() => verifyRendererLock({ read: (path: string) => path === "package.json"
      ? Buffer.from(JSON.stringify(pkg)) : read(path) })).toThrow("Sharp must stay exactly pinned");
  });

  it("keeps the fast lock gate on normal dev, test and build entrypoints", () => {
    const { scripts } = JSON.parse(read("package.json").toString());
    for (const command of ["predev", "prelocal:serve", "pretest", "prebuild"]) expect(scripts[command]).toBe("npm run renderer:verify");
    expect(scripts["renderer:verify"]).toBe("node --import tsx scripts/verify-renderer-lock.mjs");
  });
});
