import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCK_PATH, verifyRendererV2Lock } from "../scripts/verify-renderer-v2-lock.mjs";

const read = (path: string): Buffer => readFileSync(new URL(`../${path}`, import.meta.url));
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

describe("native MBTI v2.0.0 renderer pin", () => {
  it("verifies the tagged upstream source and complete Python-oracle SVGs", () => {
    expect(verifyRendererV2Lock()).toEqual({ rendererVersion: "sg-renderer-2.0.0", sourceFiles: 5, goldenSvgs: 384 });
  });

  it.each(Object.keys(JSON.parse(read(LOCK_PATH).toString()).files))("rejects source drift in %s", (changed) => {
    expect(() => verifyRendererV2Lock({ read: (path: string) => path === changed ? Buffer.concat([read(path), Buffer.from("\nchanged")]) : read(path) }))
      .toThrow(`Pinned v2 renderer source changed: ${changed}`);
  });

  it("rejects an incomplete protected source list", () => {
    const lock = JSON.parse(read(LOCK_PATH).toString());
    delete lock.files["src/algorithmV2/index.ts"];
    expect(() => verifyRendererV2Lock({ read: (path: string) => path === LOCK_PATH ? Buffer.from(JSON.stringify(lock)) : read(path) })).toThrow("Incomplete v2 protected source list");
  });

  it.each([
    ["schema", "signatures-gallery-renderer-lock/1"],
    ["status", "candidate"],
    ["upstream.tag", "v2.0.1"],
    ["upstream.commit", "0".repeat(40)],
    ["upstream.tagObject", "0".repeat(40)],
    ["algorithmVersion", "1.0.0"],
    ["rendererVersion", "sg-renderer-1.0.0"],
    ["goldenSvgs", 383],
  ])("rejects altered release identity: %s", (field, value) => {
    const lock = JSON.parse(read(LOCK_PATH).toString());
    const parts = String(field).split(".");
    const parent = parts.length === 2 ? lock[parts[0]] : lock;
    parent[parts.at(-1)!] = value;
    expect(() => verifyRendererV2Lock({ read: (path: string) => path === LOCK_PATH ? Buffer.from(JSON.stringify(lock)) : read(path) })).toThrow();
  });

  it.each([
    "reference/algorithm-v2.0.0/signature_renderer_v2.0.0.py",
    "reference/algorithm-v2.0.0/signature_renderer_v2.0.0.json",
  ])("rejects rehashed upstream drift in %s", path => {
    // Updating the lock's file hash cannot silently bless a replacement release.
    const bytes = Buffer.concat([read(path), Buffer.from("\n")]);
    const lock = JSON.parse(read(LOCK_PATH).toString());
    lock.files[path] = hash(bytes);
    expect(() => verifyRendererV2Lock({ read: (name: string) => name === path ? bytes : name === LOCK_PATH ? Buffer.from(JSON.stringify(lock)) : read(name) })).toThrow();
  });

  it("rejects an oracle mismatch even if its file hash is changed", () => {
    const path = "reference/algorithm-v2.0.0/golden-svgs.json";
    const goldens = JSON.parse(read(path).toString());
    goldens[0].sha256 = "0".repeat(64);
    const bytes = Buffer.from(JSON.stringify(goldens));
    const lock = JSON.parse(read(LOCK_PATH).toString());
    lock.files[path] = hash(bytes);
    expect(() => verifyRendererV2Lock({ read: (name: string) => name === path ? bytes : name === LOCK_PATH ? Buffer.from(JSON.stringify(lock)) : read(name) }))
      .toThrow("V2 SVG differs from upstream");
  });

  it("rejects an incomplete oracle set even if its file hash is changed", () => {
    const path = "reference/algorithm-v2.0.0/golden-svgs.json";
    const goldens = JSON.parse(read(path).toString());
    goldens.pop();
    const bytes = Buffer.from(JSON.stringify(goldens));
    const lock = JSON.parse(read(LOCK_PATH).toString());
    lock.files[path] = hash(bytes);
    expect(() => verifyRendererV2Lock({ read: (name: string) => name === path ? bytes : name === LOCK_PATH ? Buffer.from(JSON.stringify(lock)) : read(name) }))
      .toThrow("Incomplete v2 SVG oracle set");
  });
});
