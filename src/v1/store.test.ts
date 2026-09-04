import { describe, expect, it } from "vitest";
import { DEV_CARD_RENDERER_VERSION, DEV_RENDERER_VERSION } from "./renderer.js";
import { MemorySignatureStore, RendererIntegrityError, type ClaimRecordInput } from "./store.js";

function claim(overrides: Partial<ClaimRecordInput> = {}): ClaimRecordInput {
  return {
    xUserId: "1234567890123456789",
    handleAtClaim: "alice",
    handleNormalized: "alice",
    gr0kRaw: 371924,
    rendererVersion: DEV_RENDERER_VERSION,
    svgSha256: "a".repeat(64),
    svgStorageKey: `sha256/${"a".repeat(64)}.svg`,
    cardRendererVersion: DEV_CARD_RENDERER_VERSION,
    pngSha256: "b".repeat(64),
    cardStorageKey: `sha256/${"b".repeat(64)}.png`,
    xAuthenticatedAt: new Date("2026-09-04T10:00:00Z"),
    claimedAt: new Date("2026-09-04T10:02:00Z"),
    ...overrides,
  };
}

describe("MemorySignatureStore", () => {
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
    await store.claim(claim({ gr0kRaw: 500000, svgSha256: "c".repeat(64), pngSha256: "d".repeat(64) }));
    expect(await store.listSignaturesForAccount("1234567890123456789")).toHaveLength(2);
  });

  it("fails closed if the same immutable input produces new bytes", async () => {
    const store = new MemorySignatureStore();
    await store.claim(claim());
    await expect(store.claim(claim({ svgSha256: "f".repeat(64) }))).rejects.toBeInstanceOf(RendererIntegrityError);
  });
});
