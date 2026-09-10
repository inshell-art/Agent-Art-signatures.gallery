import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, type Hex } from "viem";

import { mintAuthorizationDigest, verifyGalleryAttestation } from "../v2/core/mintAuthorization.js";
import { deterministicUnixfsCid } from "../v2/core/ipfsCid.js";
import { signatureDigestHex } from "../v2/core/signatureId.js";
import {
  applyScanBatch, attachMintValidation, decodeRawGalleryLog, markFinalityRevoked, promoteFinalized,
  type CandidateContractLog, type ChainHeader, type DurableMintAuthorizationEvidence,
  type IndexerState, type RawEvmLog, type TransactionReceiptInput,
} from "../v2/indexer/index.js";
import type { MemoryMintStoreSnapshot } from "../v2/memoryStore.js";
import { unmintedProjection, type FrozenTokenMetadata, type GalleryEntry, type MintAuthorizationRecord, type MintProjection } from "../v2/model.js";

export const LOCAL_AUTOMATIC_FINALITY_LABEL = "Local Anvil automatic confirmation; single node";
const CHAIN_ID = 31_337n;
const READ_ABI = parseAbi([
  "function currentAuthorizerEpoch() view returns (uint32)",
  "function authorizerByEpoch(uint32) view returns (address)",
  "function revokedAuthorizerEpoch(uint32) view returns (bool)",
  "function paused() view returns (bool)",
  "function authorizationState(bytes32) view returns (uint8)",
  "function mintedSignature(bytes32) view returns (bool)",
  "function tokenURI(uint256) view returns (string)",
  "function ownerOf(uint256) view returns (address)",
]);
const MINT_ABI = parseAbi([
  "function mintAuthorized((bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch) a,string tokenURI,bytes galleryAttestation)",
]);

export interface LocalChainReceipt extends TransactionReceiptInput { logs: RawEvmLog[] }
export interface LocalChainTransaction { hash: Hex; from: Hex; to: Hex | null; input: Hex; value: bigint }
/** The production adapter below has no send, mine, reset, or wallet methods. */
export interface LocalChainRpc {
  chainId(): Promise<bigint>;
  header(height?: bigint): Promise<ChainHeader>;
  code(contract: Hex, height: bigint): Promise<Hex | undefined>;
  logs(contract: Hex, from: bigint, through: bigint): Promise<RawEvmLog[]>;
  receipt(hash: Hex): Promise<LocalChainReceipt | null>;
  transaction(hash: Hex): Promise<LocalChainTransaction | null>;
  read(contract: Hex, functionName: string, args: readonly unknown[], height: bigint): Promise<unknown>;
}

export interface LocalChainReconcilerOptions {
  rpcUrl: string;
  contract: Hex;
  runtimeCodeHash: Hex;
  deploymentBlockHash: Hex;
  expectedAuthorizer: Hex;
  expectedAuthorizerEpoch?: number;
  /** Must load the claimed signature and verify its retained SVG/PNG bytes. */
  verifyArtifacts(authorization: MintAuthorizationRecord, metadata: FrozenTokenMetadata): Promise<boolean>;
  maxBlocksPerTick?: number;
  rpc?: LocalChainRpc;
}
export interface LocalChainTickInput {
  mintSnapshot: MemoryMintStoreSnapshot;
  indexer: IndexerState;
  now?: Date;
}
export interface LocalChainTickResult {
  mintSnapshot: MemoryMintStoreSnapshot;
  indexer: IndexerState;
  health: "ready" | "blocked";
  code: string | null;
  finalityLabel: typeof LOCAL_AUTOMATIC_FINALITY_LABEL;
  scannedThrough: string | null;
}

export function assertLocalReconcilerUrl(value: string): void {
  const url = new URL(value);
  // Do not permit DNS names, credentials, redirects to another host, or a
  // remote endpoint that merely advertises Anvil's chain ID.
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Local chain reconciliation requires a literal loopback HTTP RPC origin.");
  }
}

export function createLocalChainRpc(rpcUrl: string): LocalChainRpc {
  assertLocalReconcilerUrl(rpcUrl);
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 5_000, fetchOptions: { redirect: "error" } }) });
  const raw = (log: {
    address: Hex; topics: Hex[]; data: Hex; blockNumber: bigint | null; blockHash: Hex | null;
    transactionHash: Hex | null; transactionIndex: number | null; logIndex: number | null; removed?: boolean;
  }): RawEvmLog => {
    if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.transactionIndex === null || log.logIndex === null) {
      throw new Error("LOCAL_PENDING_LOG");
    }
    return {
      chainId: CHAIN_ID.toString(), address: log.address, topics: log.topics, data: log.data,
      blockNumber: log.blockNumber.toString(), blockHash: log.blockHash, txHash: log.transactionHash,
      transactionIndex: log.transactionIndex, logIndex: log.logIndex, ...(log.removed ? { removed: true } : {}),
    };
  };
  const absent = (error: unknown) => error instanceof Error
    && ["TransactionReceiptNotFoundError", "TransactionNotFoundError"].includes(error.name);
  return {
    async chainId() { return BigInt(await client.getChainId()); },
    async header(height) {
      const block = await client.getBlock(height === undefined ? { blockTag: "latest" } : { blockNumber: height });
      return { blockNumber: block.number.toString(), blockHash: block.hash, parentHash: block.parentHash, blockTimestamp: block.timestamp.toString() };
    },
    code: (address, blockNumber) => client.getCode({ address, blockNumber }),
    async logs(address, fromBlock, toBlock) { return (await client.getLogs({ address, fromBlock, toBlock })).map(raw); },
    async receipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, txHash: receipt.transactionHash,
          transactionIndex: receipt.transactionIndex, status: receipt.status, logs: receipt.logs.map(raw) };
      } catch (error) { if (absent(error)) return null; throw error; }
    },
    async transaction(hash) {
      try {
        const tx = await client.getTransaction({ hash });
        return { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, value: tx.value };
      } catch (error) { if (absent(error)) return null; throw error; }
    },
    read: (address, functionName, args, blockNumber) => client.readContract({ address, abi: READ_ABI, functionName, args, blockNumber } as never),
  };
}

class ReconcileBlocked extends Error {
  constructor(readonly code: string, readonly chainIncident = false) { super(code); }
}
function requireCondition(condition: unknown, code: string, chainIncident = false): asserts condition {
  if (!condition) throw new ReconcileBlocked(code, chainIncident);
}
const sameHex = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const sha256 = (text: string) => `0x${createHash("sha256").update(text).digest("hex")}`;
function authorizationInput(record: MintAuthorizationRecord) { return { ...record, tokenURIHash: record.tokenUriHash }; }
function evidence(record: MintAuthorizationRecord): DurableMintAuthorizationEvidence {
  return { signatureId: record.signatureId, signatureDigest: record.signatureDigest, walletBindingId: record.walletBindingId,
    mintWallet: record.mintWallet, svgSha256: record.svgSha256, pngSha256: record.pngSha256, metadataSha256: record.metadataSha256,
    tokenURIHash: record.tokenUriHash, authorizationId: record.authorizationId, authorizerEpoch: record.authorizerEpoch,
    authorizer: record.authorizer, typedDataDigest: record.typedDataDigest };
}

/**
 * Pure snapshot-to-snapshot local reconciliation. The caller must serialize
 * ticks with HTTP mutations, atomically persist BOTH snapshots, then replace
 * the live store. An exception/outage never leaks a half-applied observation.
 *
 * This explicitly reuses the reducer's promotion machinery with ONE local
 * observation in both inputs. It is a rehearsal confirmation, not independent
 * provider agreement or Ethereum finalized-checkpoint evidence.
 */
export function createLocalChainReconciler(options: LocalChainReconcilerOptions) {
  assertLocalReconcilerUrl(options.rpcUrl);
  getAddress(options.contract);
  getAddress(options.expectedAuthorizer);
  const maxBlocks = options.maxBlocksPerTick ?? 128;
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 1_024) throw new Error("maxBlocksPerTick must be 1–1024.");
  const rpc = options.rpc ?? createLocalChainRpc(options.rpcUrl);
  const expectedEpoch = options.expectedAuthorizerEpoch ?? 1;

  return { async tick(input: LocalChainTickInput): Promise<LocalChainTickResult> {
    const snapshot = structuredClone(input.mintSnapshot);
    let state = structuredClone(input.indexer);
    const output = (health: "ready" | "blocked", code: string | null): LocalChainTickResult => ({
      mintSnapshot: snapshot, indexer: state, health, code, finalityLabel: LOCAL_AUTOMATIC_FINALITY_LABEL,
      scannedThrough: state.checkpoint.scannedHeight,
    });
    try {
      requireCondition(state.health === "running", "LOCAL_CHAIN_SAFETY_HALT");
      requireCondition(state.config.chainId === CHAIN_ID.toString() && sameHex(state.config.contract, options.contract), "LOCAL_DEPLOYMENT_CONFIG_MISMATCH");
      requireCondition(await rpc.chainId() === CHAIN_ID, "LOCAL_CHAIN_ID_MISMATCH", true);
      const head = await rpc.header();
      const height = BigInt(head.blockNumber);
      const deploymentHeight = BigInt(state.config.deploymentBlockNumber);
      requireCondition(height >= deploymentHeight, "LOCAL_CHAIN_REWOUND", true);
      const deployment = await rpc.header(deploymentHeight);
      requireCondition(deployment.blockHash === options.deploymentBlockHash, "LOCAL_DEPLOYMENT_BLOCK_MISMATCH", true);
      const code = await rpc.code(options.contract, height);
      requireCondition(code && code !== "0x" && keccak256(code) === options.runtimeCodeHash, "LOCAL_RUNTIME_CODE_MISMATCH", true);
      const read = (name: string, args: readonly unknown[] = []) => rpc.read(options.contract, name, args, height);
      const [epoch, authorizer, revoked, paused] = await Promise.all([
        read("currentAuthorizerEpoch"), read("authorizerByEpoch", [expectedEpoch]),
        read("revokedAuthorizerEpoch", [expectedEpoch]), read("paused"),
      ]);
      requireCondition(Number(epoch) === expectedEpoch && typeof authorizer === "string" && sameHex(authorizer, options.expectedAuthorizer)
        && revoked === false && paused === false, "LOCAL_CONTROL_CHANGED");

      const savedHeight = state.checkpoint.promotedFinalizedHeight;
      let savedHash: Hex | null = null;
      if (savedHeight !== null) {
        requireCondition(height >= BigInt(savedHeight), "LOCAL_CHAIN_REWOUND", true);
        savedHash = (await rpc.header(BigInt(savedHeight))).blockHash;
        requireCondition(savedHash === state.checkpoint.promotedFinalizedHash, "LOCAL_CONFIRMED_BLOCK_REORG", true);
      }
      const from = savedHeight === null ? deploymentHeight : BigInt(savedHeight) + 1n;
      const through = from + BigInt(maxBlocks) - 1n < height ? from + BigInt(maxBlocks) - 1n : height;
      const authorizations = new Map(snapshot.authorizations);
      const metadata = new Map(snapshot.metadata);
      const receiptsByHash = new Map<Hex, LocalChainReceipt>();
      const transactions = new Map<Hex, LocalChainTransaction>();
      const loadReceipt = async (hash: Hex) => {
        const previous = receiptsByHash.get(hash);
        if (previous) return previous;
        const receipt = await rpc.receipt(hash);
        if (receipt) receiptsByHash.set(hash, receipt);
        return receipt;
      };
      const transactionMatches = async (hash: Hex, record: MintAuthorizationRecord) => {
        let tx = transactions.get(hash);
        if (!tx) { tx = await rpc.transaction(hash) ?? undefined; if (tx) transactions.set(hash, tx); }
        if (!tx || !record.galleryAttestation) return false;
        const data = encodeFunctionData({ abi: MINT_ABI, functionName: "mintAuthorized", args: [authorizationInput(record), record.tokenUri, record.galleryAttestation] });
        return tx.hash === hash && tx.to !== null && sameHex(tx.to, options.contract) && sameHex(tx.from, record.mintWallet) && tx.value === 0n && tx.input === data;
      };

      if (from <= through) {
        const headers: ChainHeader[] = [];
        for (let number = from; number <= through; number += 1n) headers.push(await rpc.header(number));
        const rawLogs = await rpc.logs(options.contract, from, through);
        const logs: CandidateContractLog[] = [];
        const receipts: TransactionReceiptInput[] = [];
        const decodeScoped = (raw: RawEvmLog) => sameHex(raw.address, options.contract) ? decodeRawGalleryLog(state.config, raw) : null;
        for (const raw of rawLogs) {
          requireCondition(!raw.removed, "LOCAL_REMOVED_LOG", true);
          const decoded = decodeRawGalleryLog(state.config, raw);
          if (!decoded) continue;
          const receipt = await loadReceipt(raw.txHash);
          requireCondition(receipt && receipt.status === "success" && receipt.blockHash === raw.blockHash
            && receipt.blockNumber === raw.blockNumber && receipt.transactionIndex === raw.transactionIndex
            && receipt.logs.some((item) => isDeepStrictEqual(decodeScoped(item), decoded)), "LOCAL_RECEIPT_LOG_MISMATCH");
          if (decoded.kind !== "signature_minted") {
            requireCondition(decoded.kind === "transfer" || BigInt(decoded.blockNumber) === deploymentHeight, "LOCAL_CONTROL_CHANGED");
            logs.push(decoded);
            continue;
          }
          const record = authorizations.get(decoded.event.authorizationId);
          const frozen = record ? metadata.get(record.signatureId) : undefined;
          requireCondition(record && frozen, "LOCAL_DURABLE_MINT_EVIDENCE_MISSING");
          requireCondition(record.galleryAttestation && ["issued", "signing_unknown", "consumed"].includes(record.status), "LOCAL_AUTHORIZATION_NOT_ISSUED");
          const digest = mintAuthorizationDigest({ chainId: CHAIN_ID, verifyingContract: options.contract }, authorizationInput(record));
          requireCondition(digest === record.typedDataDigest && signatureDigestHex(record.signatureId) === record.signatureDigest
            && record.authorizerEpoch === expectedEpoch && sameHex(record.authorizer, options.expectedAuthorizer), "LOCAL_AUTHORIZATION_INTEGRITY_MISMATCH");
          await verifyGalleryAttestation({ chainId: CHAIN_ID, verifyingContract: options.contract }, authorizationInput(record), record.galleryAttestation, options.expectedAuthorizer);
          requireCondition(await transactionMatches(raw.txHash, record), "LOCAL_MINT_TRANSACTION_MISMATCH");
          requireCondition(frozen.signatureId === record.signatureId && frozen.svgSha256 === record.svgSha256 && frozen.pngSha256 === record.pngSha256
            && frozen.metadataSha256 === record.metadataSha256 && frozen.tokenUriHash === record.tokenUriHash && frozen.tokenUri === record.tokenUri
            && sha256(frozen.canonicalJson) === frozen.metadataSha256
            && `ipfs://${await deterministicUnixfsCid(Buffer.from(frozen.canonicalJson))}` === frozen.tokenUri
            && frozen.tokenUri === `ipfs://${frozen.metadataCid}`
            && keccak256(Buffer.from(frozen.tokenUri)) === frozen.tokenUriHash, "LOCAL_METADATA_INTEGRITY_MISMATCH");
          requireCondition(await options.verifyArtifacts(record, frozen), "LOCAL_ARTIFACT_INTEGRITY_MISMATCH");
          requireCondition(await rpc.read(options.contract, "tokenURI", [BigInt(decoded.event.tokenId)], BigInt(decoded.blockNumber)) === record.tokenUri, "LOCAL_TOKEN_URI_MISMATCH");
          const block = headers.find((candidate) => candidate.blockHash === raw.blockHash);
          requireCondition(block && BigInt(block.blockTimestamp) >= record.validAfter && BigInt(block.blockTimestamp) <= record.deadline, "LOCAL_MINT_WINDOW_MISMATCH");
          logs.push(attachMintValidation(decoded, { staticProvenance: { status: "valid" }, executionControl: { status: "valid" },
            tokenURI: { status: "valid" }, artifactIntegrity: { status: "valid" }, authorization: { status: "valid", record: evidence(record) } }));
        }
        for (const receipt of receiptsByHash.values()) {
          const known = receipt.logs.map(decodeScoped).filter((log) => log !== null);
          requireCondition(known.every((event) => rawLogs.some((raw) => isDeepStrictEqual(decodeScoped(raw), event))), "LOCAL_LOG_SCAN_INCOMPLETE");
          const mint = known.find((log) => log.kind === "signature_minted");
          receipts.push({ blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, txHash: receipt.txHash,
            transactionIndex: receipt.transactionIndex, status: receipt.status,
            ...(mint?.kind === "signature_minted" ? { expectedMint: { signatureId: mint.event.signatureId, authorizationId: mint.event.authorizationId } } : {}) });
        }
        state = applyScanBatch(state, { savedCheckpointFromPrimary: savedHash, savedCheckpointFromSecondary: savedHash, headers, logs, receipts });
        requireCondition(state.health === "running", "LOCAL_CHAIN_SAFETY_HALT", true);
        requireCondition(state.logs.every((log) => !log.canonical || log.validationState === "valid"), "LOCAL_CHAIN_VALIDATION_FAILED");
        requireCondition(state.controlState.provisional.authorizationIssuanceReady
          && state.controlState.provisional.currentAuthorizerEpoch === expectedEpoch, "LOCAL_CONTROL_HISTORY_INCOMPLETE");
        const boundary = headers.at(-1)!;
        requireCondition((await rpc.header(through)).blockHash === boundary.blockHash, "LOCAL_SCAN_BOUNDARY_CHANGED", true);
        state = promoteFinalized(state, { primaryFinalizedHeight: boundary.blockNumber, secondaryFinalizedHeight: boundary.blockNumber,
          promotionBlockFromPrimary: { blockNumber: boundary.blockNumber, blockHash: boundary.blockHash },
          promotionBlockFromSecondary: { blockNumber: boundary.blockNumber, blockHash: boundary.blockHash },
          savedCheckpointFromPrimary: savedHash, savedCheckpointFromSecondary: savedHash, promotedAt: (input.now ?? new Date()).toISOString() });
        requireCondition(state.health === "running" && !state.promotionBlockage, "LOCAL_CONFIRMATION_BLOCKED");
      }

      // Receipt reports are hints only. Dropping a report cannot hide a mint;
      // inventing one cannot consume an authorization or advance a projection.
      for (const [authorizationId, attempts] of snapshot.attempts) {
        const record = authorizations.get(authorizationId);
        if (!record) continue;
        for (const attempt of attempts) {
          if (attempt.state === "included" || attempt.state === "reverted") continue;
          const receipt = await loadReceipt(attempt.txHash);
          if (!receipt || BigInt(receipt.blockNumber) > through || !(await transactionMatches(attempt.txHash, record))) continue;
          requireCondition((await rpc.header(BigInt(receipt.blockNumber))).blockHash === receipt.blockHash, "LOCAL_RECEIPT_REORG", true);
          if (receipt.status === "reverted") attempt.state = "reverted";
        }
      }

      projectConfirmedMints(snapshot, state);
      const caughtUp = state.checkpoint.promotedFinalizedHeight === head.blockNumber;
      if (caughtUp) {
        for (const [, record] of snapshot.authorizations) {
          const onChain = Number(await read("authorizationState", [record.authorizationId]));
          const minted = await read("mintedSignature", [record.signatureDigest]);
          const known = state.galleryEntries.find((entry) => entry.signatureId === record.signatureId && entry.chainState === "finalized");
          if (onChain === 1 || minted === true) requireCondition(known, "LOCAL_REDEEMED_MINT_NOT_OBSERVED");
          if (["issued", "prepared", "signing_unknown"].includes(record.status) && onChain === 0 && minted === false
            && BigInt(head.blockTimestamp) > record.deadline) {
            record.status = "expired";
            snapshot.projections = snapshot.projections.map(([key, projection]) => [key,
              projection.authorizationId === record.authorizationId && ["authorized", "submitted"].includes(projection.state)
                ? unmintedProjection(key) : projection]);
          }
          requireCondition(onChain === 0 || onChain === 1, "LOCAL_CONTROL_CHANGED");
        }
        for (const entry of state.galleryEntries.filter((entry) => entry.chainState === "finalized")) {
          const owner = await read("ownerOf", [BigInt(entry.tokenId)]);
          const projected = state.tokenHolders.find((holder) => holder.tokenId === entry.tokenId)?.currentHolder;
          requireCondition(typeof owner === "string" && projected && sameHex(owner, projected), "LOCAL_HOLDER_SCAN_MISMATCH");
        }
      }
      requireCondition((await rpc.header(height)).blockHash === head.blockHash, "LOCAL_HEAD_CHANGED", true);
      return output(caughtUp ? "ready" : "blocked", caughtUp ? null : "LOCAL_CHAIN_CATCHING_UP");
    } catch (error) {
      // Never publish a partly scanned batch, half-promoted mint, or expiry
      // derived from an RPC call sequence whose pinned boundary changed.
      state = structuredClone(input.indexer);
      const original = structuredClone(input.mintSnapshot);
      const failure = error instanceof ReconcileBlocked ? error : new ReconcileBlocked("LOCAL_RPC_OR_VALIDATION_UNAVAILABLE");
      if (failure.chainIncident) {
        state.health = "chain_safety_halt";
        state.safetyHalt = { code: "FINALIZED_CHECKPOINT_MISMATCH", detail: failure.code };
        state = markFinalityRevoked(state, failure.code, state.config.deploymentBlockNumber);
        for (const [, projection] of original.projections) {
          if (projection.state === "finalized") { projection.state = "finality_revoked"; projection.finalityLabel = "Local Anvil chain history changed; confirmation revoked"; }
        }
        original.gallery = [];
      }
      return { ...output("blocked", failure.code), mintSnapshot: original, indexer: state };
    }
  } };
}

function projectConfirmedMints(snapshot: MemoryMintStoreSnapshot, state: IndexerState): void {
  const projections = new Map(snapshot.projections);
  const gallery = new Map(snapshot.gallery);
  for (const entry of state.galleryEntries.filter((candidate) => candidate.chainState === "finalized")) {
    const event = state.logs.find((log) => log.eventObservationId === entry.canonicalEventId)?.log;
    requireCondition(event?.kind === "signature_minted", "LOCAL_CONFIRMED_EVENT_MISSING");
    const authorization = snapshot.authorizations.find(([id]) => id === event.event.authorizationId)?.[1];
    const holder = state.tokenHolders.find((candidate) => candidate.tokenId === entry.tokenId)?.currentHolder;
    requireCondition(authorization && holder, "LOCAL_CONFIRMED_EVIDENCE_MISSING");
    authorization.status = "consumed";
    const projection: GalleryEntry = { ...unmintedProjection(entry.signatureId), state: "finalized", authorizationId: authorization.authorizationId,
      txHash: entry.txHash, contract: state.config.contract, chainId: CHAIN_ID, tokenId: BigInt(entry.tokenId), mintWallet: getAddress(entry.mintWallet),
      currentTokenHolder: getAddress(holder), blockNumber: BigInt(entry.blockNumber), transactionIndex: entry.transactionIndex, logIndex: entry.logIndex,
      finalizedAt: new Date(entry.finalizedAt), finalityLabel: LOCAL_AUTOMATIC_FINALITY_LABEL };
    projections.set(entry.signatureId, projection);
    gallery.set(entry.signatureId, projection);
    const attempts = snapshot.attempts.find(([id]) => id === authorization.authorizationId)?.[1];
    const attempt = attempts?.find((candidate) => candidate.txHash === entry.txHash);
    if (attempt) attempt.state = "included";
    else if (attempts) attempts.push({ authorizationId: authorization.authorizationId, txHash: entry.txHash, state: "included", reportedAt: new Date(entry.finalizedAt) });
    else snapshot.attempts.push([authorization.authorizationId, [{ authorizationId: authorization.authorizationId, txHash: entry.txHash, state: "included", reportedAt: new Date(entry.finalizedAt) }]]);
  }
  snapshot.projections = [...projections] as Array<[string, MintProjection]>;
  snapshot.gallery = [...gallery];
}
