import { describe, expect, it, vi } from "vitest";
import { assessmentDigest, AssessmentCoordinator, exactObject, isXSource, validateAssessment, validateSourceUrls, type AssessmentProvider, type AssessmentRepository, type LegacyAssessment, type NativeMbtiAssessment } from "./assessment.js";
import { MemoryAssessmentRepository } from "./assessmentStore.js";
import { DevelopmentAssessmentProvider, GROK_DEFAULT_MODEL } from "./grok.js";
import { LEGACY_MAPPING_VERSION, LEGACY_RENDERER_VERSION, POLICY_VERSION, RENDERER_VERSION } from "./identity.js";
import { type XIdentityResolver, type XIdentitySnapshot } from "./xIdentity.js";

const legacyUnsigned: Omit<LegacyAssessment, "digest"> = {
  id: "00000000-0000-4000-8000-000000000001", handle: "alice", mbti: "INTJ", seed: 1,
  rendererVersion: LEGACY_RENDERER_VERSION, mappingVersion: LEGACY_MAPPING_VERSION, policyVersion: POLICY_VERSION,
  model: "development-fixture-v1", providerResponseId: "development-fixture:legacy", sourceUrls: [],
  createdAt: "2026-09-15T00:00:00.000Z", provenance: "development-fixture",
};

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
    expect(first.rendererVersion).toBe(RENDERER_VERSION);
    expect(first).not.toHaveProperty("seed");
    expect(first).not.toHaveProperty("mappingVersion");
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

  it("preserves the legacy digest and first saved assessment without upgrading or reassessing", async () => {
    const legacy: LegacyAssessment = { ...legacyUnsigned, digest: assessmentDigest(legacyUnsigned) };
    expect(legacy.digest).toBe("0x2fcc725a73688f6e70e4c4aeddbf56f8ab618e0255f48ad48f05ac94b49a215d");
    const repository = new MemoryAssessmentRepository();
    await repository.putIfAbsent(legacy);
    const source = new DevelopmentAssessmentProvider();
    const assess = vi.spyOn(source, "assess");
    const coordinator = new AssessmentCoordinator({ provider: source, repository });
    expect(await coordinator.assess("ALICE")).toEqual(legacy);
    expect(assess).not.toHaveBeenCalled();
    expect(validateAssessment(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
    expect(JSON.stringify(await repository.get("alice"))).toBe(JSON.stringify(legacy));
  });

  it("rejects unknown versions and mixed native/legacy schemas even with recomputed digests", async () => {
    const legacy = { ...legacyUnsigned, digest: assessmentDigest(legacyUnsigned) };
    const { seed: _seed, mappingVersion: _mapping, ...nativeFields } = legacyUnsigned;
    const nativeUnsigned: Omit<NativeMbtiAssessment, "digest"> = { ...nativeFields, rendererVersion: RENDERER_VERSION };
    const native = { ...nativeUnsigned, digest: assessmentDigest(nativeUnsigned) };
    expect(native.digest).not.toBe(legacy.digest);
    expect(validateAssessment(native)).toEqual(native);
    for (const mutation of [
      { ...legacy, rendererVersion: RENDERER_VERSION },
      { ...native, rendererVersion: LEGACY_RENDERER_VERSION },
      { ...native, seed: 1 }, { ...native, mappingVersion: LEGACY_MAPPING_VERSION },
      { ...legacy, seed: 7 }, { ...legacy, mappingVersion: "mbti-seed-v2" },
      { ...native, rendererVersion: "sg-renderer-3.0.0" },
    ]) expect(() => validateAssessment(mutation)).toThrow();
    expect(() => assessmentDigest({ ...nativeUnsigned, rendererVersion: "sg-renderer-3.0.0" } as never)).toThrow();
  });

  it("rejects unsupported providers before they can spend a request", () => {
    const source = { ...provider(), provenance: "client" } as unknown as AssessmentProvider;
    expect(() => new AssessmentCoordinator({ provider: source, repository: new MemoryAssessmentRepository() })).toThrow("Unsupported assessment provider");
    expect(source.assess).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted metadata even when its digest is recomputed", () => {
    for (const mutation of [
      { id: 123 }, { id: "not-a-uuid" }, { model: "bad model" }, { model: 123 },
      { providerResponseId: 123 }, { createdAt: 123 }, { createdAt: "2026-09-15T00:00:00Z" },
      { model: "grok-4.6" }, { providerResponseId: "response-123" },
    ]) {
      const invalid = { ...legacyUnsigned, ...mutation } as unknown as Omit<LegacyAssessment, "digest">;
      // Valid ABI encodings still cannot bypass the stricter record schema.
      const digest = typeof invalid.id === "string" && typeof invalid.model === "string"
        && typeof invalid.providerResponseId === "string" && typeof invalid.createdAt === "string"
        ? assessmentDigest(invalid) : `0x${"0".repeat(64)}`;
      expect(() => validateAssessment({ ...invalid, digest })).toThrow();
    }
  });

  it("rejects noncanonical saved references rather than silently repairing their digest", () => {
    const sourceUrls = ["https://example.com/z", "https://example.com/a", "https://example.com/a"];
    const unsigned = { ...legacyUnsigned, sourceUrls };
    expect(() => validateAssessment({ ...unsigned, digest: assessmentDigest(unsigned) })).toThrow("sources are not canonical");
  });

  it.each([null, undefined, [], "assessment", 1])("rejects non-object saved records: %j", (value) => {
    expect(() => validateAssessment(value)).toThrow("Invalid assessment");
  });

  it("does not publish a persistence winner for a different handle or provider", async () => {
    const cases = [
      await new AssessmentCoordinator({ provider: provider(), repository: new MemoryAssessmentRepository() }).assess("bob"),
      await new AssessmentCoordinator({ provider: new DevelopmentAssessmentProvider(), repository: new MemoryAssessmentRepository() }).assess("alice"),
    ];
    for (const wrongWinner of cases) {
      const source = provider();
      const repository: AssessmentRepository = { get: vi.fn(async () => undefined), putIfAbsent: vi.fn(async () => wrongWinner) };
      const coordinator = new AssessmentCoordinator({ provider: source, repository });
      await expect(coordinator.assess("alice")).rejects.toThrow("storage provenance or handle mismatch");
      await expect(coordinator.assess("ALICE")).rejects.toThrow("storage provenance or handle mismatch");
      expect(await coordinator.get("alice")).toBeUndefined();
      expect(source.assess).toHaveBeenCalledTimes(1);
      expect(repository.putIfAbsent).toHaveBeenCalledTimes(2);
    }
  });

  it("clears a failed in-flight request so an explicit retry can succeed", async () => {
    const source = provider();
    const valid = await source.assess("alice");
    source.assess = vi.fn().mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValue(valid);
    const coordinator = new AssessmentCoordinator({ provider: source, repository: new MemoryAssessmentRepository() });
    const first = coordinator.assess("alice");
    expect(coordinator.assess("@ALICE")).toBe(first);
    await expect(first).rejects.toThrow("provider unavailable");
    expect(await coordinator.get("alice")).toBeUndefined();
    expect((await coordinator.assess("alice")).mbti).toBe("INTJ");
    expect(source.assess).toHaveBeenCalledTimes(2);
  });
});

describe("preparation-time X identity binding", () => {
  const identity: XIdentitySnapshot = { canonicalHandle: "alice", username: "ALIce", userId: "1234", verifiedAt: "2026-09-16T00:00:00.000Z", provenance: "x-api", freshness: "verified-at-preparation" };
  function boundProvider() {
    const source = provider();
    source.assess = vi.fn(async (handle, subject) => ({ handle, mbti: "INTJ" as const, model: GROK_DEFAULT_MODEL, providerResponseId: "response-bound", sourceUrls: ["https://x.com/alice/status/123"], xUserId: subject!.userId }));
    return source;
  }
  it("resolves once before Grok, binds its subject and preserves the snapshot across restart", async () => {
    const repository = new MemoryAssessmentRepository();
    const source = boundProvider();
    const resolver: XIdentityResolver = { provenance: "x-api", resolve: vi.fn(async () => identity) };
    const coordinator = new AssessmentCoordinator({ provider: source, repository, identityResolver: resolver });
    const [first, joining] = await Promise.all([coordinator.assess("@Alice"), coordinator.assess("ALICE")]);
    expect(first).toEqual(joining);
    expect(first.xIdentity).toEqual(identity);
    expect(Object.isFrozen(first.xIdentity)).toBe(true);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(source.assess).toHaveBeenCalledWith("alice", identity);
    expect(vi.mocked(resolver.resolve).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(source.assess).mock.invocationCallOrder[0]);
    const changedResolver: XIdentityResolver = { provenance: "x-api", resolve: vi.fn(async () => ({ ...identity, username: "aLICE", userId: "9876" })) };
    const restarted = new AssessmentCoordinator({ provider: boundProvider(), repository, identityResolver: changedResolver });
    expect(await restarted.assess("alice")).toEqual(first);
    expect(changedResolver.resolve).not.toHaveBeenCalled();
    expect(validateAssessment(JSON.parse(JSON.stringify(first)))).toEqual(first);
    const { xIdentity: _snapshot, digest: _digest, ...unbound } = first;
    expect(assessmentDigest(unbound)).not.toBe(first.digest);
    for (const change of [{ username: "Alice" }, { userId: "5678" }, { verifiedAt: "2026-09-17T00:00:00.000Z" }]) {
      expect(() => validateAssessment({ ...first, xIdentity: { ...identity, ...change } })).toThrow("digest");
    }
  });
  it("never spends Grok on a missing, mismatched or false-provenance X subject", async () => {
    for (const resolve of [async () => { throw new Error("X unavailable"); }, async () => ({ ...identity, username: "Bob" }), async () => ({ ...identity, provenance: "development-fixture" as const })]) {
      const source = boundProvider();
      const coordinator = new AssessmentCoordinator({ provider: source, repository: new MemoryAssessmentRepository(), identityResolver: { provenance: "x-api", resolve } });
      await expect(coordinator.assess("alice")).rejects.toThrow();
      expect(source.assess).not.toHaveBeenCalled();
    }
  });
  it("rejects provider account mismatches and fixture resolvers in real mode", async () => {
    const source = boundProvider();
    source.assess = vi.fn(async () => ({ handle: "alice", mbti: "INTJ" as const, model: GROK_DEFAULT_MODEL, providerResponseId: "response-wrong", sourceUrls: ["https://x.com/alice"], xUserId: "9999" }));
    const coordinator = new AssessmentCoordinator({ provider: source, repository: new MemoryAssessmentRepository(), identityResolver: { provenance: "x-api", resolve: async () => identity } });
    await expect(coordinator.assess("alice")).rejects.toThrow("X account mismatch");
    expect(await coordinator.get("alice")).toBeUndefined();
    expect(() => new AssessmentCoordinator({ provider: source, repository: new MemoryAssessmentRepository(), identityResolver: { provenance: "development-fixture", resolve: async () => identity } })).toThrow("provenance");
  });
  it("retries failed persistence with the same username, assessment and timestamp", async () => {
    const memory = new MemoryAssessmentRepository();
    const putIfAbsent = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockImplementation(value => memory.putIfAbsent(value));
    const source = boundProvider();
    const resolver: XIdentityResolver = { provenance: "x-api", resolve: vi.fn(async () => identity) };
    const coordinator = new AssessmentCoordinator({ provider: source, repository: { get: handle => memory.get(handle), putIfAbsent }, identityResolver: resolver });
    await expect(coordinator.assess("alice")).rejects.toThrow("disk full");
    const saved = await coordinator.assess("ALICE");
    expect(saved).toEqual(putIfAbsent.mock.calls[0][0]);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(source.assess).toHaveBeenCalledTimes(1);
  });
  it("reads old unverified assessments unchanged even when a resolver is configured", async () => {
    const repository = new MemoryAssessmentRepository();
    const old = await new AssessmentCoordinator({ provider: provider(), repository }).assess("alice");
    const resolver: XIdentityResolver = { provenance: "x-api", resolve: vi.fn(async () => identity) };
    const source = boundProvider();
    expect(await new AssessmentCoordinator({ provider: source, repository, identityResolver: resolver }).assess("ALICE")).toEqual(old);
    expect(resolver.resolve).not.toHaveBeenCalled(); expect(source.assess).not.toHaveBeenCalled();
    expect(old).not.toHaveProperty("xIdentity");
  });
});

describe("assessment trust-boundary schemas and evidence", () => {
  it.each([null, [], "json", 123, undefined])("rejects non-object provider data: %j", (value) => {
    expect(() => exactObject(value, ["handle", "mbti"], "provider assessment")).toThrow("Invalid provider assessment");
  });

  it("requires own exact fields, not inherited keys or same-size substitutes", () => {
    expect(() => exactObject({ handle: "alice", type: "INTJ" }, ["handle", "mbti"], "assessment")).toThrow("fields");
    expect(() => exactObject(Object.assign(Object.create({ mbti: "INTJ" }), { handle: "alice", type: "INTJ" }), ["handle", "mbti"], "assessment")).toThrow("fields");
  });

  it.each([
    undefined, {}, Array.from({ length: 129 }, () => "https://x.com/alice"),
    [null], [123], ["not-a-url"], ["https://x.com/alice\n"], ["https://x.com/al ice"],
    [`https://example.com/${"a".repeat(2048)}`], ["http://x.com/alice"],
    ["https://user@x.com/alice"], ["https://user:password@x.com/alice"], ["https://x.com:8443/alice"],
  ])("rejects malformed or unsafe evidence: %j", (value) => {
    expect(() => validateSourceUrls(value, "development-fixture")).toThrow("source");
  });

  it("canonicalizes, deduplicates, sorts, and freezes provider evidence", () => {
    const result = validateSourceUrls(["https://X.COM/alice", "https://example.com", "https://x.com/alice"], "grok");
    expect(result).toEqual(["https://example.com/", "https://x.com/alice"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(validateSourceUrls([], "development-fixture")).toEqual([]);
  });

  it.each([
    "https://x.com/alice", "https://www.x.com/alice/status/123/",
    "https://twitter.com/alice/status/123", "https://www.twitter.com/i/user/123",
    "https://x.com/i/status/123", "https://x.com/_/",
  ])("recognizes native X profile/post evidence: %s", (url) => {
    expect(isXSource(url)).toBe(true);
    expect(validateSourceUrls([url], "grok")).toEqual([url]);
  });

  it.each([
    "https://x.com.evil.example/alice", "https://example.com/x.com/alice", "https://x.com/",
    "https://x.com/alice/status/not-an-id", "https://x.com/alice/followers", "https://x.com/i/status/123/extra",
  ])("does not accept lookalike or unrelated URLs as X evidence: %s", (url) => {
    expect(isXSource(url)).toBe(false);
    expect(() => validateSourceUrls([url], "grok")).toThrow("X Search source evidence");
  });
});
