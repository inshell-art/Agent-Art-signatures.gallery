import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { projectionRpcFixture, testHash } from "../fixtures/projectionRpc.js";
import { createVerifiedArtworkReads, type ArtworkKind } from "./artwork.js";
import type { ProjectionReads } from "./http.js";

let saved: Awaited<ReturnType<typeof projectionRpcFixture>>;
beforeAll(async () => { saved = await projectionRpcFixture(); });
function fixture() {
  const artifact = structuredClone(saved.evidence.artifact), handle = artifact.assessment.handle;
  const mint = { tokenId: BigInt(saved.evidence.reservation.authorization.handleKey).toString(), handle, mbti: artifact.assessment.mbti,
    availability: "unavailable" as const, artifactDigest: artifact.digest, assessmentDigest: artifact.assessment.digest,
    tokenURIHash: artifact.commitment.tokenURIHash, transactionHash: testHash(200), originalRecipient: saved.evidence.reservation.authorization.recipient };
  const lookup = vi.fn<ProjectionReads["lookup"]>().mockResolvedValue({ state: "confirming", item: mint });
  const journal = { namespaceId: saved.options.deployment.namespaceId, origin: artifact.origin, load: vi.fn().mockResolvedValue(artifact) };
  const options = { projection: { lookup }, journal, namespaceId: journal.namespaceId, origin: artifact.origin, timeoutMs: 1000 };
  return { artifact, handle, mint, lookup, journal, options, reads: createVerifiedArtworkReads(options) };
}
const signal = () => new AbortController().signal;
describe("verified immutable artwork reveal reads", () => {
  it.each(["confirming", "confirmed"] as const)("builds a public detail model only after %s with preserved rendering and no private authority fields", async state => {
    const f = fixture(); f.lookup.mockResolvedValue({ state, item: f.mint }); const before = structuredClone(f.artifact);
    const page = await f.reads.detail(f.handle, signal());
    expect(page).toMatchObject({ renderHandle: "Alice_Bob_Key", mbti: "INTJ", code: "", status: "ready", canMint: false,
      mint: { state: state === "confirmed" ? "minted" : "confirming" }, artifactDigest: f.artifact.digest });
    expect(page.imageUrl).toBe(`/api/signatures/${f.handle}/artwork/${f.artifact.digest}/png`);
    expect(f.journal.load).toHaveBeenCalledWith(f.handle, true); expect(f.lookup).toHaveBeenCalledTimes(2);
    for (const key of ["responseId", "authorization", "signature", "sessionHash", "requestId", "attemptId", "receipt"]) expect(page).not.toHaveProperty(key);
    expect(f.artifact).toEqual(before);
  });
  it.each(["svg", "png", "metadata"] as const)("returns exactly the saved %s bytes, never a rerender or external fetch", async kind => {
    const f = fixture(), result = await f.reads.media(f.handle, f.artifact.digest, kind, signal());
    expect(result.bytes).toEqual(f.artifact[kind].bytes); expect(result.bytes).not.toBe(f.artifact[kind].bytes);
    expect(result.mediaType).toBe(f.artifact[kind].object.mediaType);
  });
  it.each(["unknown", "pending", "safety-halted"] as const)("does not load private artifacts for %s state", async state => {
    const f = fixture(); f.lookup.mockResolvedValue({ state, item: f.mint });
    await expect(f.reads.detail(f.handle, signal())).rejects.toThrow("unavailable"); expect(f.journal.load).not.toHaveBeenCalled();
  });
  it.each([
    { handle: "other" }, { mbti: "ENFP" }, { tokenId: "1" }, { availability: "quarantined" as const }, { transactionHash: undefined },
    { artifactDigest: testHash(50) }, { assessmentDigest: testHash(51) }, { tokenURIHash: testHash(52) },
  ])("refuses on-chain binding mismatch %#", async change => {
    const f = fixture(); f.lookup.mockResolvedValue({ state: "confirming", item: { ...f.mint, ...change } });
    await expect(f.reads.detail(f.handle, signal())).rejects.toThrow("unavailable");
  });
  it.each(["unknown", "confirmed"] as const)("withdraws read if confidence changes to %s while loading", async state => {
    const f = fixture(); f.lookup.mockResolvedValueOnce({ state: "confirming", item: f.mint }).mockResolvedValue({ state, item: f.mint });
    await expect(f.reads.detail(f.handle, signal())).rejects.toThrow();
  });
  it.each(["absent", "corrupt svg", "corrupt png", "corrupt metadata", "oversized", "wrong origin"])("refuses %s saved artifact", async mode => {
    const f = fixture();
    if (mode === "absent") f.journal.load.mockResolvedValue(undefined);
    else if (mode === "corrupt svg") f.artifact.svg.bytes[0] ^= 1;
    else if (mode === "corrupt png") f.artifact.png.bytes[0] ^= 1;
    else if (mode === "corrupt metadata") f.artifact.metadata.bytes[0] ^= 1;
    else if (mode === "oversized") Object.assign(f.artifact.svg, { bytes: new Uint8Array(8 * 1024 * 1024 + 1) });
    else Object.assign(f.artifact, { origin: "https://other.example" });
    await expect(f.reads.detail(f.handle, signal())).rejects.toThrow("unavailable");
  });
  it.each(["hung lookup", "hung load", "cancel", "pre-cancel", "microtasks"])("bounds %s without returning late bytes", async mode => {
    const f = fixture(), parent = new AbortController(); f.options.timeoutMs = 10;
    if (mode === "hung lookup") f.lookup.mockImplementation(() => new Promise(() => {}));
    if (mode === "hung load" || mode === "cancel") f.journal.load.mockImplementation(() => new Promise(() => {}));
    if (mode === "microtasks") f.journal.load.mockImplementation(async () => { const end = performance.now() + 15; while (performance.now() < end) await Promise.resolve(); return f.artifact; });
    if (mode === "cancel") setTimeout(() => parent.abort(), 2);
    if (mode === "pre-cancel") parent.abort();
    await expect(createVerifiedArtworkReads(f.options).detail(f.handle, parent.signal)).rejects.toThrow("unavailable");
  });
  it("refuses digest substitution, unknown kinds, malformed handles and cross-namespace configuration", async () => {
    const f = fixture();
    await expect(f.reads.media(f.handle, testHash(50), "svg", signal())).rejects.toThrow();
    await expect(f.reads.media(f.handle, "invalid", "svg", signal())).rejects.toThrow();
    await expect(f.reads.media(f.handle, f.artifact.digest, "secret" as ArtworkKind, signal())).rejects.toThrow();
    await expect(f.reads.detail("@Alice", signal())).rejects.toThrow();
    expect(() => createVerifiedArtworkReads({ ...f.options, namespaceId: "different" })).toThrow();
    for (const timeoutMs of [0, 10001, NaN]) expect(() => createVerifiedArtworkReads({ ...f.options, timeoutMs })).toThrow();
  });
});
