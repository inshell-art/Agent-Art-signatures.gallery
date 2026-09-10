import { describe, expect, it } from "vitest";
import { CARD_RENDERER_VERSION, RENDERER_VERSION } from "./renderer.js";
import { MemorySignatureStore, RendererIntegrityError, type ClaimRecordInput } from "./store.js";

function claim(overrides: Partial<ClaimRecordInput> = {}): ClaimRecordInput {
  return {
    xUserId: "1234567890123456789",
    handleAtClaim: "alice",
    handleNormalized: "alice",
    gr0kRaw: 22,
    rendererVersion: RENDERER_VERSION,
    svgSha256: "a".repeat(64),
    svgStorageKey: `sha256/${"a".repeat(64)}.svg`,
    cardRendererVersion: CARD_RENDERER_VERSION,
    pngSha256: "b".repeat(64),
    cardStorageKey: `sha256/${"b".repeat(64)}.png`,
    xAuthenticatedAt: new Date("2026-09-04T10:00:00Z"),
    claimedAt: new Date("2026-09-04T10:02:00Z"),
    ...overrides,
  };
}

describe("MemorySignatureStore", () => {
  it("lists claims across accounts with stable keyset ordering and no duplicates on replay", async () => {
    const store = new MemorySignatureStore();
    await store.claim(claim());
    await store.claim(claim());
    await store.claim(claim({ gr0kRaw: 50 }));
    await store.claim(claim({ xUserId: "987654321", handleAtClaim: "bob", handleNormalized: "bob", claimedAt: new Date("2026-09-05T00:00:00Z") }));
    const all = await store.listClaimedSignatures(100);
    expect(all).toHaveLength(3);
    expect(all[0].handleAtClaim).toBe("bob");
    expect(all[1].signatureId < all[2].signatureId).toBe(true);
    const first = await store.listClaimedSignatures(2);
    const last = await store.listClaimedSignatures(2, first[1]);
    expect([...first, ...last]).toEqual(all);
    expect(await store.listClaimedSignatures(2, last[0])).toEqual([]);
    await expect(store.listClaimedSignatures(0)).rejects.toBeInstanceOf(RangeError);
    await expect(store.listClaimedSignatures(101)).rejects.toBeInstanceOf(RangeError);
  });

  it("returns one row for concurrent identical claims and preserves claimed_at", async () => {
    const store = new MemorySignatureStore();
    const [first, second] = await Promise.all([store.claim(claim()), store.claim(claim({ claimedAt: new Date("2026-09-05T00:00:00Z") }))]);
    expect(first.signature.signatureId).toBe(second.signature.signatureId);
    expect([first.existing, second.existing]).toEqual([false, true]);
    expect(second.signature.claimedAt.toISOString()).toBe("2026-09-04T10:02:00.000Z");
  });

  it("allows equal-status signatures with different gr0k values", async () => {
    const store = new MemorySignatureStore();
    await store.claim(claim());
    await store.claim(claim({ gr0kRaw: 50, svgSha256: "c".repeat(64), pngSha256: "d".repeat(64) }));
    expect(await store.listSignaturesForAccount("1234567890123456789")).toHaveLength(2);
  });

  it("fails closed if the same immutable input produces new bytes", async () => {
    const store = new MemorySignatureStore();
    await store.claim(claim());
    await expect(store.claim(claim({ svgSha256: "f".repeat(64) }))).rejects.toBeInstanceOf(RendererIntegrityError);
  });

  it("keeps exact-case artwork inputs distinct without splitting the X account", async () => {
    const store = new MemorySignatureStore();
    const lower = await store.claim(claim({ currentHandle: "ALIce" }));
    const mixed = await store.claim(claim({ handleAtClaim: "Alice", currentHandle: "ALIce", svgSha256: "c".repeat(64), pngSha256: "d".repeat(64) }));
    expect(lower.signature.signatureId).not.toBe(mixed.signature.signatureId);
    expect(lower.account.publicAccountId).toBe(mixed.account.publicAccountId);
    expect(mixed.signature.handleAtClaim).toBe("Alice");
    expect(mixed.account.currentHandle).toBe("ALIce");
    expect(mixed.signature.handleNormalized).toBe("alice");
    expect(mixed.signature.gr0kScale).toBe(1);
    expect(await store.listSignaturesForAccount(lower.signature.xUserId)).toHaveLength(2);
  });

  it("does not replace the artwork spelling when an OAuth account uses different case", async () => {
    const store = new MemorySignatureStore();
    const first = await store.claim(claim({ handleAtClaim: "Alice", currentHandle: "alice" }));
    const replay = await store.claim(claim({ handleAtClaim: "Alice", currentHandle: "ALICE" }));
    expect(replay.existing).toBe(true);
    expect(replay.signature).toEqual(first.signature);
    expect(replay.account.currentHandle).toBe("ALICE");
  });

  it("rejects obsolete seeds and unrelated account handles before storage", async () => {
    const store = new MemorySignatureStore();
    await expect(store.claim(claim({ gr0kRaw: 371924 }))).rejects.toThrow(/integer/);
    await expect(store.claim(claim({ handleAtClaim: "Bob" }))).rejects.toThrow(/normalized X handle/);
    await expect(store.claim(claim({ currentHandle: "Bob" }))).rejects.toThrow(/Current OAuth handle/);
    expect(await store.listClaimedSignatures(100)).toEqual([]);
  });
});
