import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
});
