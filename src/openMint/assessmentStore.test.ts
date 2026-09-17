import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessmentDigest, AssessmentCoordinator, type LegacyAssessment } from "./assessment.js";
import { FileAssessmentRepository, MemoryAssessmentRepository } from "./assessmentStore.js";
import { DevelopmentAssessmentProvider } from "./grok.js";
import { LEGACY_MAPPING_VERSION, LEGACY_RENDERER_VERSION, seedForMbti } from "./identity.js";

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), "sg-open-assessment-test-")); directories.push(path); return path; }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(handle = "alice") {
  return new AssessmentCoordinator({ provider: new DevelopmentAssessmentProvider(), repository: new MemoryAssessmentRepository() }).assess(handle);
}

describe("durable first-result assessment repository", () => {
  it("reloads canonical data without reevaluation after a process-style restart", async () => {
    const path = await directory();
    const first = await new AssessmentCoordinator({ provider: new DevelopmentAssessmentProvider(), repository: new FileAssessmentRepository(path) }).assess("@Alice");
    const provider = new DevelopmentAssessmentProvider();
    provider.assess = vi.fn(async () => { throw new Error("must not reassess"); });
    const reloaded = new AssessmentCoordinator({ provider, repository: new FileAssessmentRepository(path) });
    expect(await reloaded.assess("alice")).toEqual(first);
    expect(provider.assess).not.toHaveBeenCalled();
    expect(await new FileAssessmentRepository(path).list()).toEqual([first]);
  });

  it("reads pre-v2 files without rewriting their bytes or evaluating Grok again", async () => {
    const path = await directory();
    const { digest: _digest, ...native } = await fixture();
    const unsigned: Omit<LegacyAssessment, "digest"> = {
      ...native, rendererVersion: LEGACY_RENDERER_VERSION, seed: seedForMbti(native.mbti), mappingVersion: LEGACY_MAPPING_VERSION,
    };
    const legacy = { ...unsigned, digest: assessmentDigest(unsigned) };
    const originalBytes = JSON.stringify(legacy) + "\n";
    await writeFile(join(path, "alice.json"), originalBytes);
    const provider = new DevelopmentAssessmentProvider();
    const assess = vi.spyOn(provider, "assess");
    const coordinator = new AssessmentCoordinator({ provider, repository: new FileAssessmentRepository(path) });
    expect(await coordinator.assess("@ALICE")).toEqual(legacy);
    expect(assess).not.toHaveBeenCalled();
    expect(await new FileAssessmentRepository(path).putIfAbsent(await fixture())).toEqual(legacy);
    expect(await readFile(join(path, "alice.json"), "utf8")).toBe(originalBytes);
  });

  it("atomically resolves competing immutable saves to the same canonical result", async () => {
    const path = await directory();
    const a = await fixture(); const b = await fixture();
    expect(a.id).not.toBe(b.id);
    const [savedA, savedB] = await Promise.all([new FileAssessmentRepository(path).putIfAbsent(a), new FileAssessmentRepository(path).putIfAbsent(b)]);
    expect(savedA).toEqual(savedB);
    expect(await new FileAssessmentRepository(path).putIfAbsent(b)).toEqual(savedA);
    expect(JSON.parse(await readFile(join(path, "alice.json"), "utf8"))).toEqual(savedA);
  });

  it("fails closed on stored tampering and filename/handle replay", async () => {
    const path = await directory();
    const assessment = await fixture();
    await writeFile(join(path, "alice.json"), JSON.stringify({ ...assessment, seed: 99 }));
    await expect(new FileAssessmentRepository(path).get("alice")).rejects.toThrow();
    await writeFile(join(path, "bob.json"), JSON.stringify(assessment));
    await expect(new FileAssessmentRepository(path).get("bob")).rejects.toThrow("handle mismatch");
  });

  it("rejects malformed JSON and symlinked assessment records", async () => {
    const path = await directory();
    await writeFile(join(path, "alice.json"), "{");
    await expect(new FileAssessmentRepository(path).get("alice")).rejects.toThrow("JSON");
    await symlink(join(path, "alice.json"), join(path, "bob.json"));
    await expect(new FileAssessmentRepository(path).get("bob")).rejects.toThrow();
    await expect(new FileAssessmentRepository(path).get("../alice")).rejects.toThrow();
  });

  it.each(["", ".", "relative/assessments", "/", "/tmp/../"])("requires a dedicated absolute storage directory: %j", (path) => {
    expect(() => new FileAssessmentRepository(path)).toThrow("dedicated absolute directory");
  });

  it("rejects symlinked storage directories without publishing through them", async () => {
    const path = await directory();
    const target = join(path, "real");
    const linked = join(path, "linked");
    await mkdir(target);
    await symlink(target, linked);
    const repository = new FileAssessmentRepository(linked);
    await expect(repository.get("alice")).rejects.toThrow("real directory");
    await expect(repository.putIfAbsent(await fixture())).rejects.toThrow("real directory");
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects non-file and oversized records before parsing", async () => {
    const path = await directory();
    await mkdir(join(path, "alice.json"));
    await writeFile(join(path, "bob.json"), " ".repeat(512 * 1024 + 1));
    const repository = new FileAssessmentRepository(path);
    await expect(repository.get("alice")).rejects.toThrow("Invalid assessment storage file");
    await expect(repository.get("bob")).rejects.toThrow("Invalid assessment storage file");
  });

  it("lists canonical records in handle order and ignores staging/unrelated files", async () => {
    const path = await directory();
    const repository = new FileAssessmentRepository(path);
    const bob = await repository.putIfAbsent(await fixture("bob"));
    const alice = await repository.putIfAbsent(await fixture("alice"));
    for (const name of [".alice.interrupted.tmp", "README.md", "UPPER.json", "too_long_a_handle.json", "bad-name.json"]) {
      await writeFile(join(path, name), "not assessment JSON");
    }
    expect(await repository.list()).toEqual([alice, bob]);
    expect((await readdir(path)).filter((name) => name.endsWith(".tmp"))).toEqual([".alice.interrupted.tmp"]);
    expect((await stat(join(path, "alice.json"))).mode & 0o777).toBe(0o600);
  });

  it("fails closed when a canonical record in a listing is corrupt", async () => {
    const path = await directory();
    const repository = new FileAssessmentRepository(path);
    await repository.putIfAbsent(await fixture("alice"));
    await writeFile(join(path, "bob.json"), "{");
    await expect(repository.list()).rejects.toThrow("Invalid assessment storage JSON");
  });

  it("does not overwrite corrupt canonical data or leave a staging file for invalid input", async () => {
    const path = await directory();
    const repository = new FileAssessmentRepository(path);
    const assessment = await fixture();
    await writeFile(join(path, "alice.json"), "corrupt original");
    await expect(repository.putIfAbsent(assessment)).rejects.toThrow("storage JSON");
    await expect(repository.putIfAbsent({ ...assessment, digest: "0x00" } as never)).rejects.toThrow("digest");
    expect(await readFile(join(path, "alice.json"), "utf8")).toBe("corrupt original");
    expect(await readdir(path)).toEqual(["alice.json"]);
  });

  it("keeps the first in-memory result immutable and lists without exposing its container", async () => {
    const repository = new MemoryAssessmentRepository();
    expect(await repository.list()).toEqual([]);
    const first = await repository.putIfAbsent(await fixture("alice"));
    const second = await fixture("alice");
    expect(first.id).not.toBe(second.id);
    expect(await repository.putIfAbsent(second)).toBe(first);
    expect(await repository.get("@ALICE")).toBe(first);
    const listed = await repository.list();
    expect(listed).toEqual([first]);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(Object.isFrozen(listed[0].sourceUrls)).toBe(true);
    (listed as unknown[]).pop();
    expect(await repository.list()).toEqual([first]);
  });
});
