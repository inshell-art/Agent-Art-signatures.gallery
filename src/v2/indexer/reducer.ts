import { isDeepStrictEqual } from "node:util";

import { signatureDigestHex } from "../core/signatureId.js";
import { emptyContractControlState, isContractControlLog, rebuildContractControlState } from "./controlState.js";
import {
  AUTHORIZATION_REVOKED_TOPIC,
  AUTHORIZER_EPOCH_ADDED_TOPIC,
  AUTHORIZER_EPOCH_REVOKED_TOPIC,
  DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC,
  DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC,
  DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC,
  DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC,
  ERC721_TRANSFER_TOPIC,
  PAUSED_TOPIC,
  ROLE_ADMIN_CHANGED_TOPIC,
  ROLE_GRANTED_TOPIC,
  ROLE_REVOKED_TOPIC,
  SIGNATURE_MINTED_TOPIC,
  UNPAUSED_TOPIC,
  ZERO_ADDRESS,
} from "./topics.js";
import type {
  BlockObservation,
  CandidateContractLog,
  ChainHeader,
  ContractLogObservation,
  DeploymentIndexConfig,
  DurableMintAuthorizationEvidence,
  FinalityRevocation,
  GalleryEntryProjection,
  Hex,
  IndexedMintAttempt,
  IndexerSafetyHalt,
  IndexerState,
  MintAggregate,
  MintIntent,
  ObservationValidationState,
  ProviderFinalityInput,
  ScanBatch,
  SignatureMintedLog,
  TokenHolderProjection,
  TransactionReceiptInput,
  TransactionReceiptObservation,
  TransferLog,
  ValidationCheck,
} from "./types.js";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;

export class IndexerInputError extends Error {}

function integer(value: string, field: string): bigint {
  if (!DECIMAL.test(value)) throw new IndexerInputError(`${field} must be a canonical unsigned decimal string.`);
  return BigInt(value);
}

function hash(value: string, field: string): asserts value is Hex {
  if (!HASH.test(value)) throw new IndexerInputError(`${field} must be an exact lowercase 32-byte hash.`);
}

function address(value: string, field: string): asserts value is Hex {
  if (!ADDRESS.test(value)) throw new IndexerInputError(`${field} must be an exact 20-byte address.`);
}

function safeIndex(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new IndexerInputError(`${field} must be a nonnegative safe integer.`);
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function clone(state: IndexerState): IndexerState {
  return structuredClone(state);
}

function positionCompare(
  a: { blockNumber: string; transactionIndex: number; logIndex: number },
  b: { blockNumber: string; transactionIndex: number; logIndex: number },
): number {
  const block = integer(a.blockNumber, "blockNumber") - integer(b.blockNumber, "blockNumber");
  if (block !== 0n) return block < 0n ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
  return a.logIndex - b.logIndex;
}

function canonicalBlockByHeight(state: IndexerState): Map<string, BlockObservation> {
  return new Map(state.blocks.filter((block) => block.canonical).map((block) => [block.blockNumber, block]));
}

function blockByHash(state: IndexerState): Map<string, BlockObservation> {
  return new Map(state.blocks.map((block) => [block.blockHash, block]));
}

function receiptKey(receipt: Pick<TransactionReceiptInput, "blockHash" | "txHash">): string {
  return `${receipt.blockHash}:${receipt.txHash}`;
}

export function eventObservationId(config: DeploymentIndexConfig, log: CandidateContractLog): string {
  return `${config.deploymentId}:${log.blockHash}:${log.txHash}:${log.logIndex}`;
}

function haltState(state: IndexerState, halt: IndexerSafetyHalt): IndexerState {
  const halted = clone(state);
  halted.health = "chain_safety_halt";
  halted.safetyHalt = halt;
  halted.promotionBlockage = null;
  return halted;
}

function requireRunning(state: IndexerState): void {
  if (state.health !== "running") throw new IndexerInputError("indexer is in CHAIN_SAFETY_HALT.");
}

function validateConfig(config: DeploymentIndexConfig): void {
  if (config.deploymentId.length === 0) throw new IndexerInputError("deploymentId is required.");
  integer(config.chainId, "chainId");
  integer(config.deploymentBlockNumber, "deploymentBlockNumber");
  address(config.contract, "contract");
  hash(config.mintTopic, "mintTopic");
  hash(config.transferTopic, "transferTopic");
  if (config.abiVersion.length === 0) throw new IndexerInputError("abiVersion is required.");
}

export function createIndexerState(config: DeploymentIndexConfig): IndexerState {
  validateConfig(config);
  return {
    schemaVersion: 1,
    config: structuredClone(config),
    health: "running",
    safetyHalt: null,
    promotionBlockage: null,
    checkpoint: {
      scannedHeight: null,
      scannedHash: null,
      promotedFinalizedHeight: null,
      promotedFinalizedHash: null,
    },
    blocks: [],
    logs: [],
    receipts: [],
    intents: [],
    attempts: [],
    aggregates: [],
    galleryEntries: [],
    tokenHolders: [],
    controlState: emptyContractControlState(),
    finalityRevocations: [],
  };
}

function validateHeader(header: ChainHeader): void {
  integer(header.blockNumber, "blockNumber");
  integer(header.blockTimestamp, "blockTimestamp");
  hash(header.blockHash, "blockHash");
  hash(header.parentHash, "parentHash");
}

function validateHeaders(headers: ChainHeader[], deploymentBlockNumber: bigint): void {
  if (headers.length === 0) throw new IndexerInputError("scan batch must contain at least one header.");
  let previous: ChainHeader | null = null;
  for (const header of headers) {
    validateHeader(header);
    if (integer(header.blockNumber, "blockNumber") < deploymentBlockNumber) {
      throw new IndexerInputError("scan batch starts before the configured deployment block.");
    }
    if (previous !== null) {
      if (integer(header.blockNumber, "blockNumber") !== integer(previous.blockNumber, "blockNumber") + 1n) {
        throw new IndexerInputError("scan headers must be ascending and contiguous.");
      }
      if (header.parentHash !== previous.blockHash) throw new IndexerInputError("scan headers are not parent-linked.");
    }
    previous = header;
  }
}

function inScope(log: CandidateContractLog, config: DeploymentIndexConfig): boolean {
  if (log.chainId !== config.chainId || !sameHex(log.address, config.contract)) return false;
  let expectedTopic: Hex;
  switch (log.kind) {
    case "signature_minted": expectedTopic = config.mintTopic; break;
    case "transfer": expectedTopic = config.transferTopic; break;
    case "authorizer_epoch_added": expectedTopic = AUTHORIZER_EPOCH_ADDED_TOPIC; break;
    case "authorizer_epoch_revoked": expectedTopic = AUTHORIZER_EPOCH_REVOKED_TOPIC; break;
    case "authorization_revoked": expectedTopic = AUTHORIZATION_REVOKED_TOPIC; break;
    case "paused": expectedTopic = PAUSED_TOPIC; break;
    case "unpaused": expectedTopic = UNPAUSED_TOPIC; break;
    case "role_granted": expectedTopic = ROLE_GRANTED_TOPIC; break;
    case "role_revoked": expectedTopic = ROLE_REVOKED_TOPIC; break;
    case "role_admin_changed": expectedTopic = ROLE_ADMIN_CHANGED_TOPIC; break;
    case "default_admin_transfer_scheduled": expectedTopic = DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC; break;
    case "default_admin_transfer_canceled": expectedTopic = DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC; break;
    case "default_admin_delay_change_scheduled": expectedTopic = DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC; break;
    case "default_admin_delay_change_canceled": expectedTopic = DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC; break;
  }
  return log.topic0 === expectedTopic;
}

function validateLogEnvelope(log: CandidateContractLog): void {
  integer(log.blockNumber, "log.blockNumber");
  hash(log.blockHash, "log.blockHash");
  hash(log.txHash, "log.txHash");
  hash(log.topic0, "log.topic0");
  address(log.address, "log.address");
  safeIndex(log.transactionIndex, "transactionIndex");
  safeIndex(log.logIndex, "logIndex");
  switch (log.kind) {
    case "authorizer_epoch_added":
    case "authorizer_epoch_revoked":
      safeIndex(log.epoch, "epoch");
      if (log.epoch > 0xffff_ffff) throw new IndexerInputError("epoch must fit uint32.");
      address(log.authorizer, "authorizer");
      break;
    case "authorization_revoked":
      hash(log.authorizationId, "authorizationId");
      break;
    case "paused":
    case "unpaused":
      address(log.account, "account");
      break;
    case "role_granted":
    case "role_revoked":
      hash(log.role, "role");
      address(log.account, "account");
      address(log.sender, "sender");
      break;
    case "role_admin_changed":
      hash(log.role, "role");
      hash(log.previousAdminRole, "previousAdminRole");
      hash(log.newAdminRole, "newAdminRole");
      break;
    case "default_admin_transfer_scheduled":
      address(log.newAdmin, "newAdmin");
      integer(log.acceptSchedule, "acceptSchedule");
      break;
    case "default_admin_delay_change_scheduled":
      integer(log.newDelay, "newDelay");
      integer(log.effectSchedule, "effectSchedule");
      break;
    case "default_admin_transfer_canceled":
    case "default_admin_delay_change_canceled":
    case "signature_minted":
    case "transfer":
      break;
  }
}

function immutableLog(log: CandidateContractLog): unknown {
  if (log.kind === "signature_minted") {
    const { validation: _validation, ...immutable } = log;
    return immutable;
  }
  return log;
}

function immutableEqual(a: CandidateContractLog, b: CandidateContractLog): boolean {
  return isDeepStrictEqual(immutableLog(a), immutableLog(b));
}

function validationEqual(a: CandidateContractLog, b: CandidateContractLog): boolean {
  if (a.kind !== "signature_minted" || b.kind !== "signature_minted") return true;
  return isDeepStrictEqual(a.validation, b.validation);
}

function validateReceipt(receipt: TransactionReceiptInput): void {
  integer(receipt.blockNumber, "receipt.blockNumber");
  hash(receipt.blockHash, "receipt.blockHash");
  hash(receipt.txHash, "receipt.txHash");
  safeIndex(receipt.transactionIndex, "receipt.transactionIndex");
  if (receipt.expectedMint) {
    if (receipt.expectedMint.signatureId.length === 0) throw new IndexerInputError("expected mint signatureId is required.");
    hash(receipt.expectedMint.authorizationId, "expected mint authorizationId");
  }
}

function receiptImmutableEqual(a: TransactionReceiptInput, b: TransactionReceiptInput): boolean {
  return a.blockNumber === b.blockNumber
    && a.blockHash === b.blockHash
    && a.txHash === b.txHash
    && a.transactionIndex === b.transactionIndex
    && a.status === b.status
    && isDeepStrictEqual(a.expectedMint ?? null, b.expectedMint ?? null);
}

function deduplicateBatchLogs(config: DeploymentIndexConfig, logs: CandidateContractLog[]): CandidateContractLog[] {
  const unique = new Map<string, CandidateContractLog>();
  for (const log of logs) {
    const id = eventObservationId(config, log);
    const existing = unique.get(id);
    if (existing && !isDeepStrictEqual(existing, log)) {
      throw new IndexerInputError("scan batch contains conflicting duplicate log identity.");
    }
    if (!existing) unique.set(id, log);
  }
  return [...unique.values()];
}

function deduplicateBatchReceipts(receipts: TransactionReceiptInput[]): TransactionReceiptInput[] {
  const unique = new Map<string, TransactionReceiptInput>();
  for (const receipt of receipts) {
    const id = receiptKey(receipt);
    const existing = unique.get(id);
    if (existing && !receiptImmutableEqual(existing, receipt)) {
      throw new IndexerInputError("scan batch contains conflicting duplicate receipt identity.");
    }
    if (!existing) unique.set(id, receipt);
  }
  return [...unique.values()];
}

interface OmittedObservation {
  kind: "log" | "receipt";
  identity: string;
  blockNumber: string;
}

function omittedObservation(
  state: IndexerState,
  headers: ChainHeader[],
  logs: CandidateContractLog[],
  receipts: TransactionReceiptInput[],
): OmittedObservation | null {
  const coveredBlockHashes = new Set(headers.map((header) => header.blockHash));
  const incomingLogIds = new Set(logs.map((log) => eventObservationId(state.config, log)));
  const missingLog = state.logs.find((observation) => (
    coveredBlockHashes.has(observation.log.blockHash) && !incomingLogIds.has(observation.eventObservationId)
  ));
  if (missingLog) {
    return {
      kind: "log",
      identity: missingLog.eventObservationId,
      blockNumber: missingLog.log.blockNumber,
    };
  }

  const incomingReceiptIds = new Set(receipts.map(receiptKey));
  const missingReceipt = state.receipts.find((receipt) => (
    coveredBlockHashes.has(receipt.blockHash) && !incomingReceiptIds.has(receiptKey(receipt))
  ));
  return missingReceipt
    ? { kind: "receipt", identity: receiptKey(missingReceipt), blockNumber: missingReceipt.blockNumber }
    : null;
}

function checkpointMismatch(state: IndexerState, primary: Hex | null, secondary: Hex | null): IndexerState | null {
  const expected = state.checkpoint.promotedFinalizedHash;
  if (expected === null) {
    if (primary !== null || secondary !== null) throw new IndexerInputError("no finalized checkpoint exists to re-fetch.");
    return null;
  }
  if (primary !== expected || secondary !== expected) {
    return haltState(state, {
      code: "FINALIZED_CHECKPOINT_MISMATCH",
      detail: `saved finalized checkpoint ${expected} was observed as ${primary ?? "null"} / ${secondary ?? "null"}.`,
    });
  }
  return null;
}

function storedContinuityFailure(state: IndexerState): IndexerState | null {
  if (state.checkpoint.scannedHeight === null) return null;
  const canonical = canonicalBlockByHeight(state);
  const start = state.checkpoint.promotedFinalizedHeight ?? state.config.deploymentBlockNumber;
  const end = integer(state.checkpoint.scannedHeight, "scannedHeight");
  let parent: BlockObservation | null = null;
  for (let height = integer(start, "continuity start"); height <= end; height += 1n) {
    const block = canonical.get(height.toString());
    if (!block || (parent !== null && block.parentHash !== parent.blockHash)) {
      return haltState(state, { code: "NO_COMMON_ANCESTOR", detail: "stored canonical history is not contiguous and parent-linked." });
    }
    parent = block;
  }
  if (state.checkpoint.promotedFinalizedHash !== null && canonical.get(start)?.blockHash !== state.checkpoint.promotedFinalizedHash) {
    return haltState(state, { code: "FINALIZED_CHECKPOINT_MISMATCH", detail: "stored finalized checkpoint is not canonical." });
  }
  return null;
}

function findReorgAncestor(
  state: IndexerState,
  headers: ChainHeader[],
  mismatchIndex: number,
): BlockObservation | null {
  const canonical = canonicalBlockByHeight(state);
  for (let index = mismatchIndex - 1; index >= 0; index -= 1) {
    const candidate = canonical.get(headers[index].blockNumber);
    if (candidate?.blockHash === headers[index].blockHash) return candidate;
  }
  const firstMismatch = headers[mismatchIndex];
  const priorHeight = integer(firstMismatch.blockNumber, "blockNumber") - 1n;
  if (priorHeight < 0n) return null;
  const implicit = canonical.get(priorHeight.toString());
  return implicit?.blockHash === firstMismatch.parentHash ? implicit : null;
}

function syncObservationFinality(state: IndexerState): void {
  const blocks = blockByHash(state);
  for (const observation of state.logs) {
    const block = blocks.get(observation.log.blockHash);
    observation.canonical = block?.canonical === true;
    observation.orphaned = !observation.canonical;
    observation.finalized = observation.canonical && block?.finalized === true;
    observation.finalizedAt = observation.finalized ? block?.finalizedAt ?? null : null;
  }
  for (const receipt of state.receipts) {
    const block = blocks.get(receipt.blockHash);
    receipt.canonical = block?.canonical === true;
    receipt.orphaned = !receipt.canonical;
    receipt.finalized = receipt.canonical && block?.finalized === true;
    receipt.finalizedAt = receipt.finalized ? block?.finalizedAt ?? null : null;
  }
}

export function applyScanBatch(state: IndexerState, batch: ScanBatch): IndexerState {
  requireRunning(state);
  const mismatch = checkpointMismatch(state, batch.savedCheckpointFromPrimary, batch.savedCheckpointFromSecondary);
  if (mismatch) return mismatch;
  const continuityFailure = storedContinuityFailure(state);
  if (continuityFailure) return continuityFailure;

  const deploymentBlock = integer(state.config.deploymentBlockNumber, "deploymentBlockNumber");
  validateHeaders(batch.headers, deploymentBlock);
  const candidateLogs = batch.logs.filter((log) => inScope(log, state.config));
  candidateLogs.forEach(validateLogEnvelope);
  batch.receipts.forEach(validateReceipt);
  const scopedLogs = deduplicateBatchLogs(state.config, candidateLogs);
  const receipts = deduplicateBatchReceipts(batch.receipts);

  const headerByHash = new Map(batch.headers.map((header) => [header.blockHash, header]));
  for (const log of scopedLogs) {
    const header = headerByHash.get(log.blockHash);
    if (!header || header.blockNumber !== log.blockNumber) throw new IndexerInputError("every scanned log must match a header in the same atomic batch.");
  }
  for (const receipt of receipts) {
    const header = headerByHash.get(receipt.blockHash);
    if (!header || header.blockNumber !== receipt.blockNumber) throw new IndexerInputError("every scanned receipt must match a header in the same atomic batch.");
  }

  const oldCanonical = canonicalBlockByHeight(state);
  const finalizedHeight = state.checkpoint.promotedFinalizedHeight === null
    ? null
    : integer(state.checkpoint.promotedFinalizedHeight, "promotedFinalizedHeight");

  for (const log of scopedLogs) {
    const existing = state.logs.find((item) => item.eventObservationId === eventObservationId(state.config, log));
    if (existing && !immutableEqual(existing.log, log)) {
      if (finalizedHeight !== null && integer(log.blockNumber, "log.blockNumber") <= finalizedHeight) {
        return haltState(state, { code: "FINALIZED_OBSERVATION_DIVERGENCE", detail: "a finalized log identity changed." });
      }
      throw new IndexerInputError("one log observation identity has conflicting immutable data.");
    }
    if (
      existing
      && !validationEqual(existing.log, log)
      && (existing.finalized || (finalizedHeight !== null && integer(log.blockNumber, "log.blockNumber") <= finalizedHeight))
    ) {
      return haltState(state, {
        code: "FINALIZED_OBSERVATION_DIVERGENCE",
        detail: "finalized mint validation evidence changed.",
      });
    }
    if (!existing && finalizedHeight !== null && integer(log.blockNumber, "log.blockNumber") <= finalizedHeight) {
      return haltState(state, { code: "FINALIZED_OBSERVATION_DIVERGENCE", detail: "a new log appeared below the finalized checkpoint." });
    }
  }
  for (const receipt of receipts) {
    const existing = state.receipts.find((item) => receiptKey(item) === receiptKey(receipt));
    if (existing && !receiptImmutableEqual(existing, receipt)) {
      if (finalizedHeight !== null && integer(receipt.blockNumber, "receipt.blockNumber") <= finalizedHeight) {
        return haltState(state, { code: "FINALIZED_OBSERVATION_DIVERGENCE", detail: "a finalized receipt identity changed." });
      }
      throw new IndexerInputError("one receipt observation identity has conflicting immutable data.");
    }
    if (!existing && finalizedHeight !== null && integer(receipt.blockNumber, "receipt.blockNumber") <= finalizedHeight) {
      return haltState(state, { code: "FINALIZED_OBSERVATION_DIVERGENCE", detail: "a new receipt appeared below the finalized checkpoint." });
    }
  }

  const omission = omittedObservation(state, batch.headers, scopedLogs, receipts);
  if (omission) {
    const detail = `authoritative rescan omitted previously observed ${omission.kind} ${omission.identity}.`;
    if (finalizedHeight !== null && integer(omission.blockNumber, `${omission.kind}.blockNumber`) <= finalizedHeight) {
      return haltState(state, { code: "FINALIZED_OBSERVATION_DIVERGENCE", detail });
    }
    throw new IndexerInputError(detail);
  }

  const mismatchIndex = batch.headers.findIndex((header) => {
    const existing = oldCanonical.get(header.blockNumber);
    return existing !== undefined && existing.blockHash !== header.blockHash;
  });
  let ancestor: BlockObservation | null = null;
  if (mismatchIndex >= 0) {
    const mismatchHeight = integer(batch.headers[mismatchIndex].blockNumber, "blockNumber");
    if (finalizedHeight !== null && mismatchHeight <= finalizedHeight) {
      return haltState(state, { code: "FINALIZED_CHECKPOINT_MISMATCH", detail: "incoming canonical headers replace a finalized block." });
    }
    ancestor = findReorgAncestor(state, batch.headers, mismatchIndex);
    if (ancestor === null || (finalizedHeight !== null && integer(ancestor.blockNumber, "blockNumber") < finalizedHeight)) {
      return haltState(state, { code: "NO_COMMON_ANCESTOR", detail: "no common ancestor exists at or above the finalized checkpoint." });
    }
  }

  const first = batch.headers[0];
  const firstHeight = integer(first.blockNumber, "blockNumber");
  if (firstHeight > deploymentBlock) {
    const prior = oldCanonical.get((firstHeight - 1n).toString());
    const internalPrevious = batch.headers.find((header) => integer(header.blockNumber, "blockNumber") === firstHeight - 1n);
    const linked = internalPrevious?.blockHash === first.parentHash || prior?.blockHash === first.parentHash;
    if (!linked) {
      return haltState(state, { code: "NO_COMMON_ANCESTOR", detail: "scan start is not linked to stored canonical history." });
    }
  } else if (state.checkpoint.scannedHeight !== null && oldCanonical.get(first.blockNumber)?.blockHash !== first.blockHash) {
    return haltState(state, { code: "NO_COMMON_ANCESTOR", detail: "deployment block changed without a common ancestor." });
  }

  const next = clone(state);
  next.promotionBlockage = null;
  if (ancestor !== null) {
    const ancestorHeight = integer(ancestor.blockNumber, "ancestor.blockNumber");
    for (const block of next.blocks) {
      if (block.canonical && integer(block.blockNumber, "blockNumber") > ancestorHeight) {
        block.canonical = false;
        block.orphaned = true;
        block.finalized = false;
        block.finalizedAt = null;
      }
    }
  }

  const byHash = blockByHash(next);
  for (const header of batch.headers) {
    const existing = byHash.get(header.blockHash);
    if (existing) {
      if (existing.blockNumber !== header.blockNumber || existing.parentHash !== header.parentHash || existing.blockTimestamp !== header.blockTimestamp) {
        throw new IndexerInputError("one block hash has conflicting header data.");
      }
      existing.canonical = true;
      existing.orphaned = false;
    } else {
      const observation: BlockObservation = {
        ...structuredClone(header),
        canonical: true,
        finalized: false,
        orphaned: false,
        finalizedAt: null,
      };
      next.blocks.push(observation);
      byHash.set(observation.blockHash, observation);
    }
  }

  for (const log of scopedLogs) {
    const id = eventObservationId(state.config, log);
    const existing = next.logs.find((item) => item.eventObservationId === id);
    if (existing) {
      if (log.kind === "signature_minted" && !existing.finalized) existing.log = structuredClone(log);
      existing.canonical = true;
      existing.orphaned = false;
    } else {
      next.logs.push({
        eventObservationId: id,
        log: structuredClone(log),
        canonical: true,
        orphaned: false,
        finalized: false,
        finalizedAt: null,
        validationState: "validation_pending",
        validationCode: null,
      });
    }
  }

  for (const receipt of receipts) {
    const existing = next.receipts.find((item) => receiptKey(item) === receiptKey(receipt));
    if (existing) {
      existing.canonical = true;
      existing.orphaned = false;
    } else {
      next.receipts.push({
        ...structuredClone(receipt),
        canonical: true,
        orphaned: false,
        finalized: false,
        finalizedAt: null,
        validationState: "valid",
        validationCode: null,
      });
    }
  }

  syncObservationFinality(next);
  const last = batch.headers.at(-1)!;
  if (ancestor !== null || next.checkpoint.scannedHeight === null || integer(last.blockNumber, "blockNumber") > integer(next.checkpoint.scannedHeight, "scannedHeight")) {
    next.checkpoint.scannedHeight = last.blockNumber;
    next.checkpoint.scannedHash = last.blockHash;
  }
  return rebuildIndexerProjections(next);
}

function validationResult(checks: ValidationCheck[]): { state: ObservationValidationState; code: string | null } | null {
  const mismatch = checks.find((check) => check.status === "mismatch");
  if (mismatch?.status === "mismatch") return { state: "quarantined", code: mismatch.code };
  const transient = checks.find((check) => check.status === "transient");
  if (transient?.status === "transient") return { state: "validation_pending", code: transient.code };
  return null;
}

function authorizationMismatch(event: SignatureMintedLog["event"], record: DurableMintAuthorizationEvidence): string | null {
  const byteFields: Array<keyof Pick<DurableMintAuthorizationEvidence,
    "signatureDigest" | "walletBindingId" | "svgSha256" | "pngSha256" | "metadataSha256" | "tokenURIHash" | "authorizationId" | "typedDataDigest">> = [
    "signatureDigest", "walletBindingId", "svgSha256", "pngSha256", "metadataSha256", "tokenURIHash", "authorizationId", "typedDataDigest",
  ];
  const eventValues: Record<string, string> = {
    signatureDigest: event.signatureDigest,
    walletBindingId: event.walletBindingId,
    svgSha256: event.svgSha256,
    pngSha256: event.pngSha256,
    metadataSha256: event.metadataSha256,
    tokenURIHash: event.tokenURIHash,
    authorizationId: event.authorizationId,
    typedDataDigest: event.authorizationDigest,
  };
  for (const field of byteFields) {
    if (!sameHex(eventValues[field], record[field])) return `AUTHORIZATION_${field.toUpperCase()}_MISMATCH`;
  }
  if (event.signatureId !== record.signatureId) return "AUTHORIZATION_SIGNATURE_ID_MISMATCH";
  if (!sameHex(event.mintWallet, record.mintWallet)) return "AUTHORIZATION_MINT_WALLET_MISMATCH";
  if (event.authorizerEpoch !== record.authorizerEpoch) return "AUTHORIZATION_EPOCH_MISMATCH";
  return null;
}

function controlLogValidation(
  observation: ContractLogObservation,
  state: IndexerState,
  receipts: Map<string, TransactionReceiptObservation>,
): { state: ObservationValidationState; code: string | null } {
  if (!isContractControlLog(observation.log)) return { state: "quarantined", code: "NOT_CONTROL_EVENT" };
  if (observation.log.abiVersion !== state.config.abiVersion) {
    return { state: "quarantined", code: "ABI_VERSION_MISMATCH" };
  }
  const receipt = receipts.get(receiptKey(observation.log));
  if (!receipt) return { state: "validation_pending", code: "CONTROL_RECEIPT_UNAVAILABLE" };
  if (receipt.status !== "success") return { state: "quarantined", code: "CONTROL_RECEIPT_REVERTED" };
  if (
    receipt.blockNumber !== observation.log.blockNumber
    || receipt.transactionIndex !== observation.log.transactionIndex
  ) {
    return { state: "quarantined", code: "CONTROL_RECEIPT_POSITION_MISMATCH" };
  }
  return { state: "valid", code: null };
}

function positionAwareExecutionControl(
  observation: ContractLogObservation,
  state: IndexerState,
): { state: ObservationValidationState; code: string | null } {
  if (observation.log.kind !== "signature_minted") {
    return { state: "quarantined", code: "NOT_MINT_EVENT" };
  }
  const mint = observation.log;
  const prior = state.logs.filter((candidate) => (
    candidate.canonical
    && candidate.log.kind !== "transfer"
    && positionCompare(candidate.log, mint) < 0
  ));
  const control = rebuildContractControlState(prior, state.receipts).provisional;
  if (control.health === "inconsistent") {
    if (control.failureCode?.includes("RECEIPT_UNAVAILABLE")) {
      return { state: "validation_pending", code: control.failureCode };
    }
    return {
      state: "quarantined",
      code: `EXECUTION_CONTROL_${control.failureCode ?? "INCONSISTENT"}`,
    };
  }
  if (control.paused) return { state: "quarantined", code: "EXECUTION_CONTROL_PAUSED" };

  const priorAuthorization = control.authorizationStates.find((authorization) => (
    sameHex(authorization.authorizationId, mint.event.authorizationId)
  ));
  if (priorAuthorization) {
    const earlierAcceptedSameSignature = prior.some((candidate) => (
      candidate.validationState === "valid"
      && candidate.log.kind === "signature_minted"
      && candidate.log.event.signatureId === mint.event.signatureId
    ));
    // The later duplicate-signature pass reports its established, more precise
    // code; all other pre-mint redeemed/revoked states are impossible.
    if (priorAuthorization.state !== "redeemed" || !earlierAcceptedSameSignature) {
      return { state: "quarantined", code: "EXECUTION_CONTROL_AUTHORIZATION_STATE_CONFLICT" };
    }
  }

  // Some reducer fixtures intentionally omit the deployment's constructor
  // history. Once any epoch history is present, however, it is authoritative
  // for the exact mint position and must agree with the durable authorization.
  if (control.currentAuthorizerEpoch !== null) {
    const epoch = control.authorizerEpochs.find((item) => item.epoch === mint.event.authorizerEpoch);
    if (!epoch) return { state: "quarantined", code: "EXECUTION_CONTROL_UNKNOWN_AUTHORIZER_EPOCH" };
    if (epoch.revoked) return { state: "quarantined", code: "EXECUTION_CONTROL_REVOKED_AUTHORIZER_EPOCH" };
    const authorization = mint.validation.authorization;
    if (authorization.status !== "valid" || !sameHex(epoch.authorizer, authorization.record.authorizer)) {
      return { state: "quarantined", code: "EXECUTION_CONTROL_AUTHORIZER_MISMATCH" };
    }
  }
  return { state: "valid", code: null };
}

function baseMintValidation(
  observation: ContractLogObservation,
  state: IndexerState,
  receipts: Map<string, TransactionReceiptObservation>,
): { state: ObservationValidationState; code: string | null } {
  const log = observation.log;
  if (log.kind !== "signature_minted") return { state: "quarantined", code: "NOT_MINT_EVENT" };
  if (log.abiVersion !== state.config.abiVersion) return { state: "quarantined", code: "ABI_VERSION_MISMATCH" };
  const receipt = receipts.get(receiptKey(log));
  if (!receipt) return { state: "validation_pending", code: "RECEIPT_UNAVAILABLE" };
  if (receipt.blockNumber !== log.blockNumber || receipt.transactionIndex !== log.transactionIndex) {
    return { state: "quarantined", code: "RECEIPT_POSITION_MISMATCH" };
  }
  if (receipt.status !== "success") return { state: "quarantined", code: "REVERTED_TRANSACTION_EMITTED_LOG" };

  const evidence = log.validation;
  const external = validationResult([
    evidence.staticProvenance,
    evidence.executionControl,
    evidence.tokenURI,
    evidence.artifactIntegrity,
    evidence.authorization.status === "valid" ? { status: "valid" } : evidence.authorization,
  ]);
  if (external) return external;
  if (evidence.authorization.status !== "valid") return { state: "quarantined", code: "AUTHORIZATION_UNKNOWN" };

  let expectedDigest: Hex;
  try {
    expectedDigest = signatureDigestHex(log.event.signatureId);
  } catch {
    return { state: "quarantined", code: "UNKNOWN_SIGNATURE_ID" };
  }
  if (!sameHex(expectedDigest, log.event.signatureDigest)) return { state: "quarantined", code: "SIGNATURE_DIGEST_MISMATCH" };
  if (!DECIMAL.test(log.event.tokenId) || BigInt(log.event.tokenId) !== BigInt(expectedDigest)) {
    return { state: "quarantined", code: "TOKEN_ID_MISMATCH" };
  }
  const mismatch = authorizationMismatch(log.event, evidence.authorization.record);
  if (mismatch) return { state: "quarantined", code: mismatch };

  const paired = state.logs.filter((candidate) => {
    if (!candidate.canonical || candidate.log.kind !== "transfer") return false;
    const transfer = candidate.log;
    return transfer.blockHash === log.blockHash
      && transfer.txHash === log.txHash
      && transfer.transactionIndex === log.transactionIndex
      && transfer.abiVersion === state.config.abiVersion
      && sameHex(transfer.from, ZERO_ADDRESS)
      && sameHex(transfer.to, log.event.mintWallet)
      && transfer.tokenId === log.event.tokenId;
  });
  if (paired.length !== 1) return { state: "quarantined", code: paired.length === 0 ? "MINT_TRANSFER_MISSING" : "MINT_TRANSFER_NOT_UNIQUE" };
  return { state: "valid", code: null };
}

function sortedCanonicalLogs<T extends CandidateContractLog["kind"]>(state: IndexerState, kind: T): ContractLogObservation[] {
  return state.logs
    .filter((observation) => observation.canonical && observation.log.kind === kind)
    .sort((a, b) => positionCompare(a.log, b.log));
}

function rebuildLogValidation(state: IndexerState): void {
  const receipts = new Map(state.receipts.filter((receipt) => receipt.canonical).map((receipt) => [receiptKey(receipt), receipt]));
  for (const observation of state.logs) {
    if (!isContractControlLog(observation.log)) continue;
    const result = controlLogValidation(observation, state, receipts);
    observation.validationState = result.state;
    observation.validationCode = result.code;
  }

  const mints = sortedCanonicalLogs(state, "signature_minted");
  for (const mint of mints) {
    let result = baseMintValidation(mint, state, receipts);
    if (result.state === "valid") result = positionAwareExecutionControl(mint, state);
    mint.validationState = result.state;
    mint.validationCode = result.code;
  }

  const firstValidBySignature = new Map<string, ContractLogObservation>();
  for (const mint of mints) {
    if (mint.validationState !== "valid" || mint.log.kind !== "signature_minted") continue;
    const previous = firstValidBySignature.get(mint.log.event.signatureId);
    if (previous) {
      mint.validationState = "quarantined";
      mint.validationCode = "EARLIER_CANONICAL_VALID_MINT";
    } else {
      firstValidBySignature.set(mint.log.event.signatureId, mint);
    }
  }

  const validMintByToken = new Map<string, ContractLogObservation>();
  for (const mint of firstValidBySignature.values()) {
    if (mint.log.kind === "signature_minted") validMintByToken.set(mint.log.event.tokenId, mint);
  }
  const ownerByToken = new Map<string, Hex>();
  for (const transferObservation of sortedCanonicalLogs(state, "transfer")) {
    if (transferObservation.log.kind !== "transfer") continue;
    const transfer = transferObservation.log;
    if (transfer.abiVersion !== state.config.abiVersion) {
      transferObservation.validationState = "quarantined";
      transferObservation.validationCode = "ABI_VERSION_MISMATCH";
      continue;
    }
    const receipt = receipts.get(receiptKey(transfer));
    if (!receipt) {
      transferObservation.validationState = "validation_pending";
      transferObservation.validationCode = "RECEIPT_UNAVAILABLE";
      continue;
    }
    if (receipt.status !== "success") {
      transferObservation.validationState = "quarantined";
      transferObservation.validationCode = "REVERTED_TRANSACTION_EMITTED_LOG";
      continue;
    }
    if (receipt.blockNumber !== transfer.blockNumber || receipt.transactionIndex !== transfer.transactionIndex) {
      transferObservation.validationState = "quarantined";
      transferObservation.validationCode = "RECEIPT_POSITION_MISMATCH";
      continue;
    }
    if (!ADDRESS.test(transfer.from) || !ADDRESS.test(transfer.to) || !DECIMAL.test(transfer.tokenId)) {
      transferObservation.validationState = "quarantined";
      transferObservation.validationCode = "TRANSFER_DECODE_MISMATCH";
      continue;
    }
    if (sameHex(transfer.to, ZERO_ADDRESS)) {
      transferObservation.validationState = "quarantined";
      transferObservation.validationCode = "UNEXPECTED_BURN";
      continue;
    }
    const mint = validMintByToken.get(transfer.tokenId);
    if (!mint || mint.log.kind !== "signature_minted") {
      transferObservation.validationState = "quarantined";
      transferObservation.validationCode = "UNKNOWN_TOKEN";
      continue;
    }
    if (sameHex(transfer.from, ZERO_ADDRESS)) {
      const isPair = transfer.blockHash === mint.log.blockHash
        && transfer.txHash === mint.log.txHash
        && sameHex(transfer.to, mint.log.event.mintWallet);
      if (!isPair || ownerByToken.has(transfer.tokenId)) {
        transferObservation.validationState = "quarantined";
        transferObservation.validationCode = "INVALID_MINT_TRANSFER";
        continue;
      }
    } else {
      const current = ownerByToken.get(transfer.tokenId);
      if (!current || !sameHex(current, transfer.from)) {
        transferObservation.validationState = "quarantined";
        transferObservation.validationCode = "TRANSFER_FROM_MISMATCH";
        continue;
      }
    }
    ownerByToken.set(transfer.tokenId, transfer.to);
    transferObservation.validationState = "valid";
    transferObservation.validationCode = null;
  }

  for (const receipt of state.receipts.filter((item) => item.canonical)) {
    receipt.validationState = "valid";
    receipt.validationCode = null;
    if (receipt.status === "success" && receipt.expectedMint) {
      const matching = mints.some((mint) => mint.log.kind === "signature_minted"
        && mint.log.blockHash === receipt.blockHash
        && mint.log.txHash === receipt.txHash
        && sameHex(mint.log.event.authorizationId, receipt.expectedMint!.authorizationId));
      if (!matching) {
        receipt.validationState = "quarantined";
        receipt.validationCode = "SUCCESSFUL_MINT_RECEIPT_WITHOUT_EVENT";
      }
    }
  }
}

function replayHolder(
  transfers: ContractLogObservation[],
  tokenId: string,
): { holder: Hex | null; last: TransferLog | null } {
  let holder: Hex | null = null;
  let last: TransferLog | null = null;
  for (const observation of transfers) {
    if (observation.validationState !== "valid" || observation.log.kind !== "transfer" || observation.log.tokenId !== tokenId) continue;
    holder = observation.log.to;
    last = observation.log;
  }
  return { holder, last };
}

function buildTokenHolders(state: IndexerState): TokenHolderProjection[] {
  const validMints = sortedCanonicalLogs(state, "signature_minted")
    .filter((observation) => observation.validationState === "valid" && observation.log.kind === "signature_minted");
  const transfers = sortedCanonicalLogs(state, "transfer");
  return validMints.map((mint) => {
    if (mint.log.kind !== "signature_minted") throw new IndexerInputError("invalid mint projection.");
    const provisional = replayHolder(transfers, mint.log.event.tokenId);
    const current = replayHolder(transfers.filter((transfer) => transfer.finalized), mint.log.event.tokenId);
    return {
      deploymentId: state.config.deploymentId,
      tokenId: mint.log.event.tokenId,
      signatureId: mint.log.event.signatureId,
      currentHolder: current.holder,
      provisionalHolder: provisional.holder,
      lastTransferBlockNumber: provisional.last?.blockNumber ?? null,
      lastTransferBlockHash: provisional.last?.blockHash ?? null,
      lastTransferTxHash: provisional.last?.txHash ?? null,
      lastTransferLogIndex: provisional.last?.logIndex ?? null,
    };
  });
}

function revokedBySignature(state: IndexerState): Map<string, FinalityRevocation> {
  return new Map(state.finalityRevocations.map((revocation) => [revocation.signatureId, revocation]));
}

function buildAggregates(state: IndexerState): MintAggregate[] {
  const signatures = new Set<string>();
  state.intents.forEach((intent) => signatures.add(intent.signatureId));
  state.attempts.forEach((attempt) => signatures.add(attempt.signatureId));
  state.logs.forEach((observation) => {
    if (observation.log.kind === "signature_minted") signatures.add(observation.log.event.signatureId);
  });
  state.receipts.forEach((receipt) => {
    if (receipt.expectedMint) signatures.add(receipt.expectedMint.signatureId);
  });
  state.finalityRevocations.forEach((revocation) => signatures.add(revocation.signatureId));

  const revoked = revokedBySignature(state);
  return [...signatures].sort().map((signatureId) => {
    const intent = state.intents.find((item) => item.signatureId === signatureId);
    const attempts = state.attempts.filter((attempt) => attempt.signatureId === signatureId);
    const mints = sortedCanonicalLogs(state, "signature_minted")
      .filter((observation) => observation.log.kind === "signature_minted" && observation.log.event.signatureId === signatureId);
    const valid = mints.find((observation) => observation.validationState === "valid");
    let aggregate: MintAggregate;
    if (revoked.has(signatureId)) {
      aggregate = { signatureId, deploymentId: state.config.deploymentId, state: "finality_revoked", activeAuthorizationId: null, canonicalEventId: revoked.get(signatureId)!.originalEntry.canonicalEventId, failureCode: "FINALITY_REVOKED" };
    } else if (valid && valid.log.kind === "signature_minted") {
      aggregate = {
        signatureId,
        deploymentId: state.config.deploymentId,
        state: valid.finalized ? "finalized" : "included_unfinalized",
        activeAuthorizationId: valid.log.event.authorizationId,
        canonicalEventId: valid.eventObservationId,
        failureCode: null,
      };
    } else {
      const receiptQuarantine = state.receipts.find((receipt) => receipt.canonical
        && receipt.validationState === "quarantined"
        && receipt.expectedMint?.signatureId === signatureId);
      const quarantined = mints.find((observation) => observation.validationState === "quarantined");
      const pending = mints.find((observation) => observation.validationState === "validation_pending");
      if (quarantined || receiptQuarantine) {
        aggregate = {
          signatureId,
          deploymentId: state.config.deploymentId,
          state: "quarantined",
          activeAuthorizationId: intent?.authorizationId ?? attempts.at(-1)?.authorizationId ?? null,
          canonicalEventId: quarantined?.eventObservationId ?? null,
          failureCode: quarantined?.validationCode ?? receiptQuarantine?.validationCode ?? "QUARANTINED",
        };
      } else if (pending) {
        aggregate = {
          signatureId,
          deploymentId: state.config.deploymentId,
          state: "validation_pending",
          activeAuthorizationId: intent?.authorizationId ?? attempts.at(-1)?.authorizationId ?? null,
          canonicalEventId: pending.eventObservationId,
          failureCode: pending.validationCode,
        };
      } else {
        const liveAttempt = attempts.some((attempt) => attempt.state === "reported" || attempt.state === "observed" || attempt.state === "stale_unknown" || attempt.state === "included");
        aggregate = {
          signatureId,
          deploymentId: state.config.deploymentId,
          state: liveAttempt ? "submitted" : intent?.state ?? "unminted",
          activeAuthorizationId: intent?.authorizationId ?? attempts.at(-1)?.authorizationId ?? null,
          canonicalEventId: null,
          failureCode: null,
        };
      }
    }
    return aggregate;
  });
}

function buildGallery(state: IndexerState): GalleryEntryProjection[] {
  const blockMap = blockByHash(state);
  const revokedSignatures = new Set(state.finalityRevocations.map((revocation) => revocation.signatureId));
  const entries: GalleryEntryProjection[] = [];
  for (const observation of sortedCanonicalLogs(state, "signature_minted")) {
    if (!observation.finalized || observation.validationState !== "valid" || observation.log.kind !== "signature_minted") continue;
    if (revokedSignatures.has(observation.log.event.signatureId)) continue;
    const block = blockMap.get(observation.log.blockHash);
    if (!block || !observation.finalizedAt) continue;
    entries.push({
      signatureId: observation.log.event.signatureId,
      deploymentId: state.config.deploymentId,
      canonicalEventId: observation.eventObservationId,
      tokenId: observation.log.event.tokenId,
      mintWallet: observation.log.event.mintWallet,
      txHash: observation.log.txHash,
      blockNumber: observation.log.blockNumber,
      blockHash: observation.log.blockHash,
      transactionIndex: observation.log.transactionIndex,
      logIndex: observation.log.logIndex,
      mintedAt: block.blockTimestamp,
      finalizedAt: observation.finalizedAt,
      chainState: "finalized",
    });
  }
  for (const revoked of state.finalityRevocations) {
    entries.push({ ...structuredClone(revoked.originalEntry), chainState: "finality_revoked" });
  }
  return entries;
}

export function rebuildIndexerProjections(state: IndexerState): IndexerState {
  const next = clone(state);
  syncObservationFinality(next);
  rebuildLogValidation(next);
  next.tokenHolders = buildTokenHolders(next);
  next.aggregates = buildAggregates(next);
  next.galleryEntries = buildGallery(next);
  next.controlState = rebuildContractControlState(next.logs, next.receipts);
  return next;
}

function contiguousCoverage(state: IndexerState, through: bigint): BlockObservation[] | null {
  const canonical = canonicalBlockByHeight(state);
  const start = state.checkpoint.promotedFinalizedHeight === null
    ? integer(state.config.deploymentBlockNumber, "deploymentBlockNumber")
    : integer(state.checkpoint.promotedFinalizedHeight, "promotedFinalizedHeight") + 1n;
  const result: BlockObservation[] = [];
  let parentHash = state.checkpoint.promotedFinalizedHash;
  for (let height = start; height <= through; height += 1n) {
    const block = canonical.get(height.toString());
    if (!block || (parentHash !== null && block.parentHash !== parentHash)) return null;
    result.push(block);
    parentHash = block.blockHash;
  }
  return result;
}

export function promoteFinalized(state: IndexerState, input: ProviderFinalityInput): IndexerState {
  requireRunning(state);
  const mismatch = checkpointMismatch(state, input.savedCheckpointFromPrimary, input.savedCheckpointFromSecondary);
  if (mismatch) return mismatch;
  const primaryHeight = integer(input.primaryFinalizedHeight, "primaryFinalizedHeight");
  const secondaryHeight = integer(input.secondaryFinalizedHeight, "secondaryFinalizedHeight");
  const promotionHeight = primaryHeight < secondaryHeight ? primaryHeight : secondaryHeight;
  if (integer(input.promotionBlockFromPrimary.blockNumber, "primary promotion block") !== promotionHeight
    || integer(input.promotionBlockFromSecondary.blockNumber, "secondary promotion block") !== promotionHeight) {
    throw new IndexerInputError("provider promotion blocks must be fetched at the lower finalized height.");
  }
  hash(input.promotionBlockFromPrimary.blockHash, "primary promotion hash");
  hash(input.promotionBlockFromSecondary.blockHash, "secondary promotion hash");
  if (input.promotionBlockFromPrimary.blockHash !== input.promotionBlockFromSecondary.blockHash) {
    const blocked = clone(state);
    blocked.promotionBlockage = {
      code: "PROVIDER_FINALITY_DISAGREEMENT",
      promotionHeight: promotionHeight.toString(),
      detail: "independent providers disagree at the shared promotion boundary.",
    };
    return blocked;
  }
  const canonical = canonicalBlockByHeight(state).get(promotionHeight.toString());
  if (!canonical || canonical.blockHash !== input.promotionBlockFromPrimary.blockHash) {
    const blocked = clone(state);
    blocked.promotionBlockage = {
      code: "LOCAL_CANONICAL_MISMATCH",
      promotionHeight: promotionHeight.toString(),
      detail: "local canonical history does not match the provider-agreed promotion block.",
    };
    return blocked;
  }
  const previousHeight = state.checkpoint.promotedFinalizedHeight === null
    ? null
    : integer(state.checkpoint.promotedFinalizedHeight, "promotedFinalizedHeight");
  if (previousHeight !== null && promotionHeight <= previousHeight) {
    const unchanged = clone(state);
    unchanged.promotionBlockage = null;
    return unchanged;
  }
  const covered = contiguousCoverage(state, promotionHeight);
  if (covered === null) {
    const blocked = clone(state);
    blocked.promotionBlockage = {
      code: "FINALITY_COVERAGE_GAP",
      promotionHeight: promotionHeight.toString(),
      detail: "contiguous canonical header/log coverage is incomplete through the promotion boundary.",
    };
    return blocked;
  }
  const pendingValidation = state.logs
    .filter((observation) => (
      observation.canonical
      && observation.validationState === "validation_pending"
      && integer(observation.log.blockNumber, "log.blockNumber") <= promotionHeight
    ))
    .sort((a, b) => positionCompare(a.log, b.log))[0];
  if (pendingValidation) {
    const blocked = clone(state);
    blocked.promotionBlockage = {
      code: "VALIDATION_PENDING",
      promotionHeight: promotionHeight.toString(),
      detail: `validation is pending for ${pendingValidation.eventObservationId}: ${pendingValidation.validationCode ?? "UNKNOWN"}.`,
    };
    return blocked;
  }
  if (input.promotedAt.length === 0 || Number.isNaN(Date.parse(input.promotedAt))) {
    throw new IndexerInputError("promotedAt must be a valid timestamp.");
  }

  const next = clone(state);
  next.promotionBlockage = null;
  const coveredHashes = new Set(covered.map((block) => block.blockHash));
  for (const block of next.blocks) {
    if (block.canonical && (coveredHashes.has(block.blockHash) || integer(block.blockNumber, "blockNumber") <= promotionHeight)) {
      block.finalized = true;
      block.finalizedAt ??= input.promotedAt;
    }
  }
  next.checkpoint.promotedFinalizedHeight = promotionHeight.toString();
  next.checkpoint.promotedFinalizedHash = canonical.blockHash;
  return rebuildIndexerProjections(next);
}

export function setMintIntent(state: IndexerState, intent: MintIntent): IndexerState {
  const next = clone(state);
  const existing = next.intents.find((item) => item.signatureId === intent.signatureId);
  if (existing) Object.assign(existing, structuredClone(intent));
  else next.intents.push(structuredClone(intent));
  return rebuildIndexerProjections(next);
}

export function recordMintAttempt(state: IndexerState, attempt: IndexedMintAttempt): IndexerState {
  hash(attempt.authorizationId, "attempt.authorizationId");
  hash(attempt.txHash, "attempt.txHash");
  const next = clone(state);
  const existing = next.attempts.find((item) => item.authorizationId === attempt.authorizationId && item.txHash === attempt.txHash);
  if (existing) existing.state = attempt.state;
  else next.attempts.push(structuredClone(attempt));
  return rebuildIndexerProjections(next);
}

export function markFinalityRevoked(state: IndexerState, incidentId: string, affectedFromHeight: string): IndexerState {
  if (state.health !== "chain_safety_halt") throw new IndexerInputError("finality can be revoked only after CHAIN_SAFETY_HALT.");
  if (incidentId.length === 0) throw new IndexerInputError("incidentId is required.");
  const from = integer(affectedFromHeight, "affectedFromHeight");
  const next = clone(state);
  for (const entry of state.galleryEntries.filter((item) => item.chainState === "finalized" && integer(item.blockNumber, "blockNumber") >= from)) {
    if (!next.finalityRevocations.some((item) => item.signatureId === entry.signatureId)) {
      next.finalityRevocations.push({ incidentId, signatureId: entry.signatureId, originalEntry: structuredClone(entry) });
    }
  }
  return rebuildIndexerProjections(next);
}
