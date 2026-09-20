import { performance } from "node:perf_hooks";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { openMintDigest, openMintHandleKey, openMintTokenURIHash, openMintTypedData } from "../authorization.js";
import { syntheticPublicAssessment } from "../fixtures/publicAssessment.js";
import { preparePublicArtifact } from "../publicArtifacts.js";
import { decodeOpenSignaturesBlock, OPEN_PROJECTION_EVENTS, type MintProjectionEvidence } from "./decode.js";
import type { ProjectionDeployment } from "./model.js";

// Widely published Foundry/Anvil test account, never a user or custody secret.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const a = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const deployment: ProjectionDeployment = { id: "11111111-1111-4111-8111-111111111111", namespaceId: "22222222-2222-4222-8222-222222222222",
  chainId: "31337", contractAddress: a(10), manifestHash: h(10), deploymentBlock: "10", deploymentBlockHash: h(10),
  policy: { id: "test-only-policy", rollbackBlocks: 5, snapshotRetentionBlocks: 10 } };
type Input = Parameters<typeof decodeOpenSignaturesBlock>[0];
let evidence: MintProjectionEvidence;
beforeAll(async () => {
  const artifact = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://gallery.example" });
  const domain = { chainId: "31337", verifyingContract: a(10) }, authorization = { handleKey: openMintHandleKey(artifact.assessment.handle),
    assessmentDigest: artifact.assessment.digest, artifactDigest: artifact.digest, recipient: a(1), tokenURIHash: openMintTokenURIHash(artifact.metadata.object.uri),
    nonce: h(100), issuedAt: "1000", deadline: "1600" };
  const typedData = openMintTypedData(domain, authorization);
  evidence = { artifact, signature: await account.signTypedData(typedData), reservation: {
    version: "sg-open-authorization-1", id: "33333333-3333-4333-8333-333333333333", namespaceId: deployment.namespaceId, deploymentId: deployment.id,
    requestId: "44444444-4444-4444-8444-444444444444", sessionHash: "a".repeat(64), generation: "1", handle: artifact.assessment.handle,
    assessmentId: artifact.assessment.id, tokenURI: artifact.metadata.object.uri, authorizer: account.address, domain, authorization,
    digest: openMintDigest(domain, authorization), typedData: JSON.parse(JSON.stringify(typedData, (_key, value) => typeof value === "bigint" ? value.toString() : value)),
  } };
});
function fixture() {
  const saved = structuredClone(evidence), r = saved.reservation, auth = r.authorization;
  const common = { address: deployment.contractAddress, blockNumber: "0xa", blockHash: h(10), transactionHash: h(20), transactionIndex: "0x0", removed: false };
  const mintArgs = { handleKey: auth.handleKey, nonce: auth.nonce, recipient: a(1), tokenId: BigInt(auth.handleKey), normalizedHandle: r.handle,
    assessmentDigest: auth.assessmentDigest, artifactDigest: auth.artifactDigest, tokenURIHash: auth.tokenURIHash, authorizationDigest: r.digest };
  const logs = [
    { ...common, logIndex: "0x0", data: "0x", topics: encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "Transfer", args: { from: a(0), to: a(1), tokenId: BigInt(auth.handleKey) } }) },
    { ...common, logIndex: "0x1", topics: encodeEventTopics({ abi: OPEN_PROJECTION_EVENTS, eventName: "OpenSignatureMinted", args: mintArgs }),
      data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [mintArgs.tokenId, mintArgs.normalizedHandle, mintArgs.assessmentDigest, mintArgs.artifactDigest, mintArgs.tokenURIHash, mintArgs.authorizationDigest]) },
  ];
  return { saved, input: { deployment: structuredClone(deployment), authorizer: account.address,
    block: { number: "10", hash: h(10), parentHash: h(9), timestamp: "1200" }, logs, timeoutMs: 1000,
    signal: new AbortController().signal, resolveMint: vi.fn(async () => saved) } satisfies Input };
}
describe("strict OpenSignatures event decoding, no chain/provider network", () => {
  it("authenticates real test-key signature and saved commitments without claiming chain canonicality", async () => {
    const { input } = fixture(), result = await decodeOpenSignaturesBlock(input);
    expect(result.chainAuthenticated).toBe(false);
    expect(result.block.events).toHaveLength(2);
    expect(result.block.events[1]).toMatchObject({ kind: "OpenSignatureMinted", handle: "alice_bob_key", mbti: "INTJ", evidenceReference: "authorization:33333333-3333-4333-8333-333333333333" });
    expect(input.resolveMint).toHaveBeenCalledTimes(1);
  });
  it.each([
    { address: a(99) }, { removed: true }, { removed: undefined }, { blockHash: h(11) }, { blockNumber: "0xb" },
    { blockNumber: "0x0a" }, { transactionHash: h(0) }, { transactionIndex: "0x80000000" }, { logIndex: "0x-1" },
    { data: "0xg1" }, { data: `0x${"00".repeat(1025)}` }, { topics: [h(100)] }, { topics: [h(200), h(1), h(2), h(3)] },
  ])("rejects malformed, removed or wrongly bound raw log %j before enrichment", async change => {
    const { input } = fixture(); Object.assign(input.logs[1], change);
    await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow(); expect(input.resolveMint).not.toHaveBeenCalled();
  });
  it("rejects trailing ABI bytes instead of silently decoding a different wire payload", async () => {
    const { input } = fixture(); input.logs[1].data += "00";
    await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow(); expect(input.resolveMint).not.toHaveBeenCalled();
  });
  it("refuses duplicate or reordered log positions", async () => {
    const { input } = fixture(); input.logs[1].logIndex = "0x0";
    await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow("ordering");
  });
  it.each([
    (e: MintProjectionEvidence) => { Object.assign(e.reservation, { namespaceId: "55555555-5555-4555-8555-555555555555" }); },
    (e: MintProjectionEvidence) => { Object.assign(e.reservation, { deploymentId: "55555555-5555-4555-8555-555555555555" }); },
    (e: MintProjectionEvidence) => { Object.assign(e.reservation.domain, { chainId: "1" }); },
    (e: MintProjectionEvidence) => { Object.assign(e.reservation.domain, { verifyingContract: a(11) }); },
    (e: MintProjectionEvidence) => { Object.assign(e.reservation, { authorizer: a(11) }); },
    (e: MintProjectionEvidence) => { e.reservation.authorization.recipient = a(11); },
    (e: MintProjectionEvidence) => { e.reservation.authorization.nonce = h(11); },
    (e: MintProjectionEvidence) => { Object.assign(e.reservation, { tokenURI: "ipfs://different" }); },
    (e: MintProjectionEvidence) => { Object.assign(e.reservation, { assessmentId: "55555555-5555-4555-8555-555555555555" }); },
    (e: MintProjectionEvidence) => { Object.assign(e.reservation, { digest: h(11) }); },
    (e: MintProjectionEvidence) => { e.artifact.png.bytes[0] ^= 1; },
  ])("rejects conflicting durable mint evidence %#", async mutate => {
    const { input, saved } = fixture(); mutate(saved);
    await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow();
  });
  it("rejects an invalid signature, even when event/hash/assessment fields match", async () => {
    const { input, saved } = fixture(); Object.assign(saved, { signature: `0x${"11".repeat(65)}` });
    await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow();
  });
  it.each(["999", "1601"])("rejects mint block timestamp outside authority window: %s", async timestamp => {
    const { input } = fixture(); input.block.timestamp = timestamp; await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow();
  });
  it("accepts exactly the contract's inclusive deadline boundary", async () => {
    const { input } = fixture(); input.block.timestamp = "1600"; await expect(decodeOpenSignaturesBlock(input)).resolves.toHaveProperty("chainAuthenticated", false);
  });
  it("decodes transfers without invoking artifact or assessment enrichment", async () => {
    const { input } = fixture(); input.logs = input.logs.slice(0, 1);
    expect((await decodeOpenSignaturesBlock(input)).block.events[0].kind).toBe("Transfer"); expect(input.resolveMint).not.toHaveBeenCalled();
  });
  it.each([0, 30001, NaN])("rejects invalid timeout %s", async timeoutMs => {
    const { input } = fixture(); input.timeoutMs = timeoutMs; await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow();
  });
  it("bounds log count before invoking enrichment", async () => {
    const { input } = fixture(); input.logs = Array(129).fill(input.logs[0]); await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow(); expect(input.resolveMint).not.toHaveBeenCalled();
  });
  it("does not enrich work already aborted", async () => {
    const { input } = fixture(), controller = new AbortController(); controller.abort(); input.signal = controller.signal;
    await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow("cancelled"); expect(input.resolveMint).not.toHaveBeenCalled();
  });
  it("bounds hung enrichment and ignores its late result", async () => {
    const { input, saved } = fixture(); input.timeoutMs = 10; let release!: (value: MintProjectionEvidence) => void;
    input.resolveMint.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow("timed out"); release(saved);
    await Promise.resolve(); expect(input.resolveMint).toHaveBeenCalledTimes(1);
  });
  it("enforces elapsed time even when synchronous decoding starves timer callbacks", async () => {
    const { input } = fixture(); input.logs = input.logs.slice(0, 1); input.timeoutMs = 1;
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2);
    try { await expect(decodeOpenSignaturesBlock(input)).rejects.toThrow("timed out"); }
    finally { clock.mockRestore(); }
    expect(input.resolveMint).not.toHaveBeenCalled();
  });
  it("captures block/log inputs before asynchronous enrichment", async () => {
    const { input, saved } = fixture(); let release!: (value: MintProjectionEvidence) => void;
    input.resolveMint.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = decodeOpenSignaturesBlock(input); await vi.waitFor(() => expect(input.resolveMint).toHaveBeenCalled());
    input.block.hash = h(99); input.logs[1].transactionHash = h(99); Object.assign(input.deployment, { chainId: "1" }); release(saved);
    expect((await pending).block.hash).toBe(h(10));
  });
});
