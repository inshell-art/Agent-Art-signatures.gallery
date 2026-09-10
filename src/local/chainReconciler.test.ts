import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, numberToHex, padHex, parseAbi, parseAbiParameters, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deterministicUnixfsCid } from "../v2/core/ipfsCid.js";
import { mintAuthorizationDigest } from "../v2/core/mintAuthorization.js";
import { SIGNATURE_ID_GOLDEN_VECTOR } from "../v2/core/signatureId.js";
import { AUTHORIZER_EPOCH_ADDED_TOPIC, createIndexerState, ERC721_TRANSFER_TOPIC, FROZEN_GALLERY_ABI_VERSION,
  PAUSED_TOPIC, SIGNATURE_MINTED_TOPIC, ZERO_ADDRESS, type ChainHeader, type RawEvmLog } from "../v2/indexer/index.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { unmintedProjection, type FrozenTokenMetadata, type MintAuthorizationRecord } from "../v2/model.js";
import { assertLocalReconcilerUrl, createLocalChainReconciler, LOCAL_AUTOMATIC_FINALITY_LABEL,
  type LocalChainReceipt, type LocalChainRpc, type LocalChainTransaction, type LocalChainTickInput } from "./chainReconciler.js";

const h = (text: string): Hex => `0x${createHash("sha256").update(text).digest("hex")}`;
const contract: Hex = "0x1111111111111111111111111111111111111111";
const wallet: Hex = "0x2222222222222222222222222222222222222222";
const buyer: Hex = "0x3333333333333333333333333333333333333333";
const signer = privateKeyToAccount(`0x${"07".repeat(32)}`);
const code: Hex = "0x60006000";
const signatureId = SIGNATURE_ID_GOLDEN_VECTOR.signatureId;
const tokenId = BigInt(SIGNATURE_ID_GOLDEN_VECTOR.tokenId);
const MINT_ABI = parseAbi(["function mintAuthorized((bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch) a,string tokenURI,bytes galleryAttestation)"]);

async function fixture() {
  const canonicalJson = JSON.stringify({ image: "ipfs://test", properties: { signature_id: signatureId } });
  const metadataCid = await deterministicUnixfsCid(Buffer.from(canonicalJson));
  const tokenUri = `ipfs://${metadataCid}`;
  const metadata: FrozenTokenMetadata = { signatureId, metadataVersion: "sg-nft-metadata-1.0.0", importerProfile: "sg-ipfs-unixfs-1.0.0",
    svgCid: metadataCid, pngCid: metadataCid, metadataCid, svgSha256: h("svg"), pngSha256: h("png"), metadataSha256: h(canonicalJson),
    tokenUri, tokenUriHash: keccak256(Buffer.from(tokenUri)), canonicalJson, verifiedAt: new Date(1_000_000) };
  const authorization: MintAuthorizationRecord = { signatureId, signatureDigest: SIGNATURE_ID_GOLDEN_VECTOR.signatureDigest,
    authorizationId: h("authorization"), walletBindingId: h("binding"), mintWallet: wallet,
    svgSha256: metadata.svgSha256, pngSha256: metadata.pngSha256, metadataSha256: metadata.metadataSha256,
    tokenUriHash: metadata.tokenUriHash, tokenUri, authorizer: signer.address, authorizerEpoch: 1,
    validAfter: 900n, deadline: 1_800n, status: "issued", galleryAttestation: null, typedDataDigest: h("unused"), createdAt: new Date(1_000_000) };
  const signed = { ...authorization, tokenURIHash: authorization.tokenUriHash };
  authorization.typedDataDigest = mintAuthorizationDigest({ chainId: 31_337n, verifyingContract: contract }, signed);
  authorization.galleryAttestation = await signer.sign({ hash: authorization.typedDataDigest });
  const calldata = encodeFunctionData({ abi: MINT_ABI, functionName: "mintAuthorized", args: [signed, tokenUri, authorization.galleryAttestation] });
  const blocks = new Map<bigint, ChainHeader>();
  for (let n = 1n; n <= 5n; n++) blocks.set(n, { blockNumber: n.toString(), blockHash: h(`block${n}`), parentHash: h(`block${n - 1n}`), blockTimestamp: (1_000n + n).toString() });
  const raw = (number: bigint, logIndex: number, topics: Hex[], data: Hex = "0x"): RawEvmLog => ({ chainId: "31337", address: contract,
    blockNumber: number.toString(), blockHash: blocks.get(number)!.blockHash, txHash: h(`tx${number}`), transactionIndex: 0, logIndex,
    topics: topics.map((topic) => topic.toLowerCase() as Hex), data });
  const constructor = raw(1n, 0, [AUTHORIZER_EPOCH_ADDED_TOPIC, numberToHex(1, { size: 32 }), padHex(signer.address, { size: 32 })]);
  const transfer = raw(2n, 0, [ERC721_TRANSFER_TOPIC, padHex(ZERO_ADDRESS, { size: 32 }), padHex(wallet, { size: 32 }), numberToHex(tokenId, { size: 32 })]);
  const mint = raw(2n, 1, [SIGNATURE_MINTED_TOPIC, authorization.signatureDigest, authorization.authorizationId, padHex(wallet, { size: 32 })],
    encodeAbiParameters(parseAbiParameters("uint256,bytes32,bytes32,bytes32,bytes32,bytes32,uint32,bytes32"), [tokenId, authorization.walletBindingId,
      authorization.svgSha256, authorization.pngSha256, authorization.metadataSha256, authorization.tokenUriHash, 1, authorization.typedDataDigest]));
  const receipts = new Map<Hex, LocalChainReceipt>();
  const addReceipt = (number: bigint, logs: RawEvmLog[], status: "success" | "reverted" = "success") => receipts.set(h(`tx${number}`), {
    blockNumber: number.toString(), blockHash: blocks.get(number)!.blockHash, txHash: h(`tx${number}`), transactionIndex: 0, status, logs });
  addReceipt(1n, [constructor]);
  addReceipt(2n, [transfer, mint]);
  const transactions = new Map<Hex, LocalChainTransaction>([[h("tx2"), { hash: h("tx2"), from: wallet, to: contract, input: calldata, value: 0n }]]);
  const chain = { height: 2n, chainId: 31_337n, code, authorizer: signer.address, epoch: 1, paused: false, revoked: false,
    authorizationState: 1, minted: true, owner: wallet, tokenUri, allLogs: [constructor, transfer, mint] };
  const rpc: LocalChainRpc = {
    chainId: vi.fn(async () => chain.chainId), header: vi.fn(async (height) => structuredClone(blocks.get(height ?? chain.height)!)),
    code: vi.fn(async () => chain.code), logs: vi.fn(async (_contract, from, through) => structuredClone(chain.allLogs.filter((log) => BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= through))),
    receipt: vi.fn(async (hash) => structuredClone(receipts.get(hash) ?? null)), transaction: vi.fn(async (hash) => structuredClone(transactions.get(hash) ?? null)),
    read: vi.fn(async (_contract, name) => {
      switch (name) {
        case "currentAuthorizerEpoch": return chain.epoch;
        case "authorizerByEpoch": return chain.authorizer;
        case "revokedAuthorizerEpoch": return chain.revoked;
        case "paused": return chain.paused;
        case "authorizationState": return chain.authorizationState;
        case "mintedSignature": return chain.minted;
        case "tokenURI": return chain.tokenUri;
        case "ownerOf": return chain.owner;
        default: throw new Error(`Unexpected read ${name}`);
      }
    }),
  };
  const store = new MemoryMintStore();
  const mintSnapshot = store.exportSnapshot();
  mintSnapshot.authorizations.push([authorization.authorizationId, authorization]);
  mintSnapshot.authorizationBySignatureBinding.push([`${signatureId}\u0000${authorization.walletBindingId}`, authorization.authorizationId]);
  mintSnapshot.metadata.push([signatureId, metadata]);
  mintSnapshot.projections.push([signatureId, { ...unmintedProjection(signatureId), state: "authorized", authorizationId: authorization.authorizationId }]);
  const indexer = createIndexerState({ deploymentId: "local-anvil-31337", chainId: "31337", contract, deploymentBlockNumber: "1",
    abiVersion: FROZEN_GALLERY_ABI_VERSION, mintTopic: SIGNATURE_MINTED_TOPIC, transferTopic: ERC721_TRANSFER_TOPIC });
  const options = { rpcUrl: "http://127.0.0.1:18545", contract, runtimeCodeHash: keccak256(code), deploymentBlockHash: h("block1"), expectedAuthorizer: signer.address,
    verifyArtifacts: vi.fn(async () => true), rpc };
  const input: LocalChainTickInput = { mintSnapshot, indexer, now: new Date("2026-09-06T00:00:00Z") };
  return { input, options, reconciler: createLocalChainReconciler(options), chain, rpc, blocks, receipts, transactions, authorization, metadata, raw, addReceipt };
}

describe("local Anvil snapshot reconciler", () => {
  it("discovers an unreported signed mint, checks exact chain evidence, and projects explicit local confirmation", async () => {
    const f = await fixture();
    const original = structuredClone(f.input);
    const result = await f.reconciler.tick(f.input);
    expect(result.code).toBeNull();
    expect(result.health).toBe("ready");
    expect(result.indexer.galleryEntries).toHaveLength(1);
    expect(result.mintSnapshot.gallery[0][1]).toMatchObject({ signatureId, mintWallet: wallet, currentTokenHolder: wallet, state: "finalized", tokenId,
      finalityLabel: LOCAL_AUTOMATIC_FINALITY_LABEL });
    expect(result.mintSnapshot.authorizations[0][1].status).toBe("consumed");
    expect(result.mintSnapshot.attempts[0][1][0].state).toBe("included");
    expect(f.options.verifyArtifacts).toHaveBeenCalledOnce();
    expect(f.input).toEqual(original);
    expect(f.rpc.read).toHaveBeenCalledWith(contract, "tokenURI", [tokenId], 2n);
  });

  it("is idempotent across fresh-process replay and catches a transfer while preserving the original mint wallet", async () => {
    const f = await fixture();
    const first = await f.reconciler.tick(f.input);
    const restarted = createLocalChainReconciler(f.options);
    const replay = await restarted.tick(first);
    expect(replay).toEqual(first);
    const transferred = f.raw(3n, 0, [ERC721_TRANSFER_TOPIC, padHex(wallet, { size: 32 }), padHex(buyer, { size: 32 }), numberToHex(tokenId, { size: 32 })]);
    f.chain.height = 3n; f.chain.owner = buyer;
    f.chain.allLogs.push(transferred); f.addReceipt(3n, [transferred]);
    const result = await restarted.tick(replay);
    expect(result.health).toBe("ready");
    expect(result.mintSnapshot.gallery[0][1]).toMatchObject({ mintWallet: wallet, currentTokenHolder: getAddress(buyer) });
    expect(result.indexer.logs).toHaveLength(4);
    expect(result.mintSnapshot.attempts[0][1]).toHaveLength(1);
  });

  it.each(["svg", "metadata", "uri", "calldata", "sender", "attestation", "authorization", "artifact"])("fails closed on changed %s evidence", async (kind) => {
    const f = await fixture();
    switch (kind) {
      case "svg": f.metadata.svgSha256 = h("tampered"); break;
      case "metadata": f.metadata.canonicalJson = "{}"; break;
      case "uri": f.chain.tokenUri = "ipfs://different"; break;
      case "calldata": f.transactions.get(h("tx2"))!.input = "0x12"; break;
      case "sender": f.transactions.get(h("tx2"))!.from = buyer; break;
      case "attestation": f.authorization.galleryAttestation = `0x${"00".repeat(65)}`; break;
      case "authorization": f.input.mintSnapshot.authorizations = []; break;
      case "artifact": f.options.verifyArtifacts.mockResolvedValue(false); break;
    }
    const result = await f.reconciler.tick(f.input);
    expect(result.health).toBe("blocked");
    expect(result.mintSnapshot).toEqual(f.input.mintSnapshot);
    expect(result.indexer).toEqual(f.input.indexer);
    expect(result.mintSnapshot.gallery).toEqual([]);
  });

  it("rejects missing receipt logs and incomplete scans rather than manufacturing validity", async () => {
    const f = await fixture();
    f.receipts.get(h("tx2"))!.logs.pop();
    expect((await f.reconciler.tick(f.input)).code).toBe("LOCAL_RECEIPT_LOG_MISMATCH");
    const omitted = await fixture();
    omitted.chain.allLogs.pop();
    expect((await omitted.reconciler.tick(omitted.input)).code).toBe("LOCAL_LOG_SCAN_INCOMPLETE");
    const missingAllMint = await fixture();
    missingAllMint.chain.allLogs = missingAllMint.chain.allLogs.slice(0, 1);
    expect((await missingAllMint.reconciler.tick(missingAllMint.input)).code).toBe("LOCAL_REDEEMED_MINT_NOT_OBSERVED");
  });

  it("blocks an omitted transfer even when no advisory transaction was reported", async () => {
    const f = await fixture();
    const first = await f.reconciler.tick(f.input);
    f.chain.height = 3n; f.chain.owner = buyer;
    const result = await f.reconciler.tick(first);
    expect(result.code).toBe("LOCAL_HOLDER_SCAN_MISMATCH");
    expect(result.mintSnapshot).toEqual(first.mintSnapshot);
    expect(result.indexer).toEqual(first.indexer);
  });

  it("requires constructor control history even when pinned control getters look ready", async () => {
    const f = await fixture();
    f.chain.allLogs = f.chain.allLogs.filter((log) => log.blockNumber !== "1");
    const result = await f.reconciler.tick(f.input);
    expect(result.code).toBe("LOCAL_CONTROL_HISTORY_INCOMPLETE");
    expect(result.mintSnapshot).toEqual(f.input.mintSnapshot);
  });

  it("fails closed on outage without publishing partial changes, then resumes safely", async () => {
    const f = await fixture();
    vi.mocked(f.rpc.read).mockRejectedValueOnce(new Error("RPC offline"));
    const failed = await f.reconciler.tick(f.input);
    expect(failed.health).toBe("blocked");
    expect(failed.mintSnapshot).toEqual(f.input.mintSnapshot);
    expect(failed.indexer).toEqual(f.input.indexer);
    const recovered = await f.reconciler.tick(failed);
    expect(recovered.health).toBe("ready");
    expect(recovered.mintSnapshot.gallery).toHaveLength(1);
  });

  it.each(["rollback", "reorg", "code", "network"])("revokes local confirmation and halts on %s", async (kind) => {
    const f = await fixture();
    const first = await f.reconciler.tick(f.input);
    if (kind === "rollback") f.chain.height = 1n;
    if (kind === "reorg") f.blocks.get(2n)!.blockHash = h("replacement");
    if (kind === "code") f.chain.code = "0x6001";
    if (kind === "network") f.chain.chainId = 1n;
    const result = await f.reconciler.tick(first);
    expect(result.health).toBe("blocked");
    expect(result.indexer.health).toBe("chain_safety_halt");
    expect(result.mintSnapshot.gallery).toHaveLength(0);
    expect(result.mintSnapshot.projections[0][1].state).toBe("finality_revoked");
    expect((await f.reconciler.tick(result)).code).toBe("LOCAL_CHAIN_SAFETY_HALT");
  });

  it.each(["pause", "epoch", "authorizer", "revoke", "control-log"])("blocks changed local controls: %s", async (kind) => {
    const f = await fixture();
    if (kind === "pause") f.chain.paused = true;
    if (kind === "epoch") f.chain.epoch = 2;
    if (kind === "authorizer") f.chain.authorizer = getAddress(buyer);
    if (kind === "revoke") f.chain.revoked = true;
    if (kind === "control-log") {
      const paused = f.raw(3n, 0, [PAUSED_TOPIC], encodeAbiParameters(parseAbiParameters("address"), [wallet]));
      f.chain.height = 3n; f.chain.allLogs.push(paused); f.addReceipt(3n, [paused]);
    }
    const result = await f.reconciler.tick(f.input);
    expect(result.code).toBe("LOCAL_CONTROL_CHANGED");
    expect(result.mintSnapshot).toEqual(f.input.mintSnapshot);
  });

  it("bounds catch-up work and refuses authorization readiness until it has scanned the pinned head", async () => {
    const f = await fixture();
    f.chain.height = 5n;
    const reconciler = createLocalChainReconciler({ ...f.options, maxBlocksPerTick: 1 });
    let result = await reconciler.tick(f.input);
    expect(result.code).toBe("LOCAL_CHAIN_CATCHING_UP");
    expect(result.scannedThrough).toBe("1");
    for (let n = 2; n <= 5; n++) result = await reconciler.tick(result);
    expect(result.health).toBe("ready");
    expect(result.scannedThrough).toBe("5");
    expect(result.mintSnapshot.gallery).toHaveLength(1);
  });

  it("expires an unused authorization only after complete chain-time coverage, not wall-clock passage", async () => {
    const f = await fixture();
    f.chain.allLogs = f.chain.allLogs.slice(0, 1); f.chain.authorizationState = 0; f.chain.minted = false;
    const notExpired = await f.reconciler.tick({ ...f.input, now: new Date("2099-01-01") });
    expect(notExpired.health).toBe("ready");
    expect(notExpired.mintSnapshot.authorizations[0][1].status).toBe("issued");
    f.chain.height = 3n; f.blocks.get(3n)!.blockTimestamp = "1801";
    const expired = await f.reconciler.tick(notExpired);
    expect(expired.health).toBe("ready");
    expect(expired.mintSnapshot.authorizations[0][1].status).toBe("expired");
    expect(expired.mintSnapshot.projections[0][1].state).toBe("unminted");
    expect(MemoryMintStore.fromSnapshot(expired.mintSnapshot).getLiveAuthorization(signatureId, f.authorization.walletBindingId)).toBeNull();
  });

  it("marks a verified reverted attempt but keeps its still-live authorization reusable", async () => {
    const f = await fixture();
    f.chain.allLogs = f.chain.allLogs.slice(0, 1); f.chain.authorizationState = 0; f.chain.minted = false;
    f.addReceipt(2n, [], "reverted");
    f.input.mintSnapshot.attempts.push([f.authorization.authorizationId, [{ authorizationId: f.authorization.authorizationId,
      txHash: h("tx2"), state: "reported", reportedAt: new Date() }]]);
    const result = await f.reconciler.tick(f.input);
    expect(result.health).toBe("ready");
    expect(result.mintSnapshot.attempts[0][1][0].state).toBe("reverted");
    expect(result.mintSnapshot.authorizations[0][1].status).toBe("issued");
    expect(result.mintSnapshot.gallery).toEqual([]);
  });

  it("does not credit a fabricated/reported unrelated reverted transaction", async () => {
    const f = await fixture();
    f.chain.allLogs = f.chain.allLogs.slice(0, 1); f.chain.authorizationState = 0; f.chain.minted = false;
    f.addReceipt(2n, [], "reverted");
    f.transactions.get(h("tx2"))!.to = buyer;
    f.input.mintSnapshot.attempts.push([f.authorization.authorizationId, [{ authorizationId: f.authorization.authorizationId,
      txHash: h("tx2"), state: "reported", reportedAt: new Date() }]]);
    const result = await f.reconciler.tick(f.input);
    expect(result.health).toBe("ready");
    expect(result.mintSnapshot.attempts[0][1][0].state).toBe("reported");
  });

  it.each(["https://example.com", "http://localhost:8545", "http://127.0.0.1:8545/path", "http://user@127.0.0.1:8545", "http://127.0.0.1:8545?x=1"])("rejects non-local or ambiguous RPC origins %s", (url) => {
    expect(() => assertLocalReconcilerUrl(url)).toThrow(/loopback/);
  });
});
