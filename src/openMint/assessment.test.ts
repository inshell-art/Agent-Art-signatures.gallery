import { describe, expect, it, vi } from "vitest";
import { AssessmentCoordinator, validateAssessment, type AssessmentProvider, type AssessmentRepository } from "./assessment.js";
import { MemoryAssessmentRepository } from "./assessmentStore.js";
import { DevelopmentAssessmentProvider, GROK_DEFAULT_MODEL } from "./grok.js";

function provider(): AssessmentProvider {
  return { provenance: "grok", model: GROK_DEFAULT_MODEL, assess: vi.fn(async (handle: string) => ({ handle, mbti: "INTJ" as const, model: GROK_DEFAULT_MODEL, providerResponseId: "response-123", sourceUrls: ["https://x.com/alice/status/123"] })) };
}

describe("canonical server assessment coordinator", () => {
  it("deduplicates concurrent requests and locks the first successful MBTI forever", async () => {
    const source = provider();
    const coordinator = new AssessmentCoordinator({ provider: source, repository: new MemoryAssessmentRepository() });
    const [first, second] = await Promise.all([coordinator.assess("alice"), coordinator.assess("@ALICE")]);
    expect(second).toEqual(first);
    expect(source.assess).toHaveBeenCalledTimes(1);
    expect(await coordinator.assess("Alice")).toEqual(first);
    expect(source.assess).toHaveBeenCalledTimes(1);
    expect(first.seed).toBe(1);
    expect(first.provenance).toBe("grok");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sourceUrls)).toBe(true);
    expect("complete" in coordinator).toBe(false);
  });

  it("checks the provider echo, model, enum and rejects extra provenance claims", async () => {
    for (const alterations of [{ handle: "bob" }, { model: "wrong" }, { mbti: "bad" }, { provenance: "grok" }, { seed: 100 }]) {
      const source = provider();
      const valid = await source.assess("alice");
      source.assess = vi.fn(async () => ({ ...valid, ...alterations }) as never);
      const coordinator = new AssessmentCoordinator({ provider: source, repository: new MemoryAssessmentRepository() });
      await expect(coordinator.assess("alice")).rejects.toThrow();
      expect(await coordinator.get("alice")).toBeUndefined();
    }
  });

  it("never exposes or rerolls an unpersisted successful assessment", async () => {
    const memory = new MemoryAssessmentRepository();
    let saveCount = 0;
    const repository: AssessmentRepository = { get: (h) => memory.get(h), putIfAbsent: async (assessment) => {
      saveCount += 1;
      if (saveCount === 1) throw new Error("disk full");
      return memory.putIfAbsent(assessment);
    } };
    const source = provider();
    const coordinator = new AssessmentCoordinator({ provider: source, repository });
    await expect(coordinator.assess("alice")).rejects.toThrow("disk full");
    expect(await coordinator.get("alice")).toBeUndefined();
    const result = await coordinator.assess("alice");
    expect(source.assess).toHaveBeenCalledTimes(1);
    expect(result.mbti).toBe("INTJ");
    expect(saveCount).toBe(2);
  });

  it("rejects fixture canonical state when real Grok mode is selected", async () => {
    const repository = new MemoryAssessmentRepository();
    const fixture = new AssessmentCoordinator({ provider: new DevelopmentAssessmentProvider(), repository });
    await fixture.assess("alice");
    const source = provider();
    const real = new AssessmentCoordinator({ provider: source, repository });
    await expect(real.assess("alice")).rejects.toThrow("provenance");
    expect(source.assess).not.toHaveBeenCalled();
  });

  it("rejects corrupted assessment attributes, identity, digest, version and appended fields", async () => {
    const coordinator = new AssessmentCoordinator({ provider: provider(), repository: new MemoryAssessmentRepository() });
    const saved = await coordinator.assess("alice");
    for (const mutation of [
      { handle: "bob" }, { handle: "ALICE" }, { mbti: "ENFP" }, { seed: 2 }, { digest: `0x${"0".repeat(64)}` },
      { rendererVersion: "other" }, { mappingVersion: "other" }, { policyVersion: "other" },
      { model: "other" }, { providerResponseId: "" }, { provenance: "client" }, { createdAt: "invalid" },
      { sourceUrls: ["http://x.com/alice"] }, { sourceUrls: [] }, { callback: "evil" },
    ]) expect(() => validateAssessment({ ...saved, ...mutation })).toThrow();
    expect(validateAssessment(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
});
