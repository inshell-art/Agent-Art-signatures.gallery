import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureDigestHex, signatureIdFromDigest, signatureTokenId } from "../core/signatureId.js";
import { galleryPage } from "./gallery.js";
import {
  applyScanBatch,
  createIndexerState,
  markFinalityRevoked,
  promoteFinalized,
  rebuildIndexerProjections,
  recordMintAttempt,
  setMintIntent,
} from "./reducer.js";
import {
  AUTHORIZATION_REVOKED_TOPIC,
  AUTHORIZER_EPOCH_ADDED_TOPIC,
  AUTHORIZER_EPOCH_REVOKED_TOPIC,
  DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC,
  DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC,
  ERC721_TRANSFER_TOPIC,
  PAUSED_TOPIC,
  ROLE_ADMIN_CHANGED_TOPIC,
  ROLE_GRANTED_TOPIC,
  SIGNATURE_MINTED_TOPIC,
  ZERO_ADDRESS,
} from "./topics.js";
import type {
  CandidateContractLog,
  ChainHeader,
  ContractControlLog,
  DeploymentIndexConfig,
  Hex,
  MintValidationEvidence,
  ScanBatch,
  SignatureMintedLog,
  TransactionReceiptInput,
  TransferLog,
} from "./types.js";

const config: DeploymentIndexConfig = {
  deploymentId: "sepolia-canonical-v2",
  chainId: "11155111",
  contract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  deploymentBlockNumber: "100",
  abiVersion: "sg-gallery-abi-1.0.0",
  mintTopic: SIGNATURE_MINTED_TOPIC,
  transferTopic: ERC721_TRANSFER_TOPIC,
};
const walletA = "0x1111111111111111111111111111111111111111" as Hex;
const walletB = "0x2222222222222222222222222222222222222222" as Hex;
const authorizer = "0x3333333333333333333333333333333333333333" as Hex;
const goldenSignatureId = "sg1_j5ii32jw5ccljacrqivzj3pmdoxp5mvka6avgv3izzfmvcunspva";

function h(label: string): Hex {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

function signature(label: string): string {
  return signatureIdFromDigest(createHash("sha256").update(`signature:${label}`).digest());
}

function chain(branch: string, from: number, to: number, parent = h("genesis")): ChainHeader[] {
  const headers: ChainHeader[] = [];
  let parentHash = parent;
  for (let block = from; block <= to; block += 1) {
    const blockHash = h(`${branch}:block:${block}`);
    headers.push({ blockNumber: block.toString(), blockHash, parentHash, blockTimestamp: (1_800_000_000 + block).toString() });
    parentHash = blockHash;
  }
  return headers;
}

const validCheck = { status: "valid" } as const;

function mintBundle(input: {
  signatureId?: string;
  header: ChainHeader;
  transactionIndex?: number;
  transferLogIndex?: number;
  mintLogIndex?: number;
  txHash?: Hex;
  wallet?: Hex;
  validationOverride?: Partial<MintValidationEvidence>;
  includeTransfer?: boolean;
  expectedReceipt?: boolean;
  svgSha256?: Hex;
}): { logs: CandidateContractLog[]; receipt: TransactionReceiptInput; mint: SignatureMintedLog; transfer: TransferLog } {
  const signatureId = input.signatureId ?? goldenSignatureId;
  const digest = signatureDigestHex(signatureId);
  const tokenId = signatureTokenId(signatureId).toString();
  const txHash = input.txHash ?? h(`tx:${input.header.blockHash}:${signatureId}`);
  const mintWallet = input.wallet ?? walletA;
  const authorizationId = h(`authorization:${signatureId}`);
  const transactionIndex = input.transactionIndex ?? 0;
  const common = {
    chainId: config.chainId,
    address: config.contract,
    abiVersion: config.abiVersion,
    blockNumber: input.header.blockNumber,
    blockHash: input.header.blockHash,
    txHash,
    transactionIndex,
  };
  const event = {
    signatureId,
    signatureDigest: digest,
    authorizationId,
    mintWallet,
    tokenId,
    walletBindingId: h(`binding:${signatureId}`),
    svgSha256: input.svgSha256 ?? h("shared-svg"),
    pngSha256: h(`png:${signatureId}`),
    metadataSha256: h(`metadata:${signatureId}`),
    tokenURIHash: h(`uri:${signatureId}`),
    authorizerEpoch: 1,
    authorizationDigest: h(`typed-data:${signatureId}`),
  };
  const validation: MintValidationEvidence = {
    staticProvenance: validCheck,
    executionControl: validCheck,
    tokenURI: validCheck,
    artifactIntegrity: validCheck,
    authorization: {
      status: "valid",
      record: {
        signatureId,
        signatureDigest: event.signatureDigest,
        walletBindingId: event.walletBindingId,
        mintWallet: event.mintWallet,
        svgSha256: event.svgSha256,
        pngSha256: event.pngSha256,
        metadataSha256: event.metadataSha256,
        tokenURIHash: event.tokenURIHash,
        authorizationId: event.authorizationId,
        authorizerEpoch: event.authorizerEpoch,
        authorizer,
        typedDataDigest: event.authorizationDigest,
      },
    },
    ...input.validationOverride,
  };
  const transfer: TransferLog = {
    ...common,
    kind: "transfer",
    topic0: config.transferTopic,
    logIndex: input.transferLogIndex ?? 0,
    from: ZERO_ADDRESS,
    to: mintWallet,
    tokenId,
  };
  const mint: SignatureMintedLog = {
    ...common,
    kind: "signature_minted",
    topic0: config.mintTopic,
    logIndex: input.mintLogIndex ?? 1,
    event,
    validation,
  };
  const receipt: TransactionReceiptInput = {
    blockNumber: input.header.blockNumber,
    blockHash: input.header.blockHash,
    txHash,
    transactionIndex,
    status: "success",
    expectedMint: input.expectedReceipt === false ? undefined : { signatureId, authorizationId },
  };
  return { logs: input.includeTransfer === false ? [mint] : [transfer, mint], receipt, mint, transfer };
}

function scan(headers: ChainHeader[], logs: CandidateContractLog[] = [], receipts: TransactionReceiptInput[] = [], checkpoint: Hex | null = null): ScanBatch {
  return {
    savedCheckpointFromPrimary: checkpoint,
    savedCheckpointFromSecondary: checkpoint,
    headers,
    logs,
    receipts,
  };
}

function finalize(state: ReturnType<typeof createIndexerState>, header: ChainHeader, promotedAt = "2026-09-04T12:00:00.000Z") {
  return promoteFinalized(state, {
    primaryFinalizedHeight: header.blockNumber,
    secondaryFinalizedHeight: header.blockNumber,
    promotionBlockFromPrimary: { blockNumber: header.blockNumber, blockHash: header.blockHash },
    promotionBlockFromSecondary: { blockNumber: header.blockNumber, blockHash: header.blockHash },
    savedCheckpointFromPrimary: state.checkpoint.promotedFinalizedHash,
    savedCheckpointFromSecondary: state.checkpoint.promotedFinalizedHash,
    promotedAt,
  });
}

describe("restartable V2 chain indexer reducer", () => {
  it("pins the compiled contract event topics", () => {
    expect(SIGNATURE_MINTED_TOPIC).toBe("0x292299975d9bbcb3075f9491c122ed328521a062efd3ed3eb0e8aeb71589b5ac");
    expect(ERC721_TRANSFER_TOPIC).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("moves a discovered-without-browser-report mint from provisional to finalized Gallery state", () => {
    const headers = chain("a", 100, 101);
    const bundle = mintBundle({ header: headers[1] });
    let state = applyScanBatch(createIndexerState(config), scan(headers, bundle.logs, [bundle.receipt]));

    expect(state.aggregates).toEqual([expect.objectContaining({ signatureId: goldenSignatureId, state: "included_unfinalized" })]);
    expect(state.galleryEntries).toHaveLength(0);
    expect(state.tokenHolders[0]).toMatchObject({ currentHolder: null, provisionalHolder: walletA });

    state = finalize(state, headers[1]);
    expect(state.aggregates[0].state).toBe("finalized");
    expect(state.galleryEntries).toEqual([expect.objectContaining({ signatureId: goldenSignatureId, mintWallet: walletA, chainState: "finalized" })]);
    expect(state.tokenHolders[0]).toMatchObject({ currentHolder: walletA, provisionalHolder: walletA });
  });

  it("treats client attempts as observations and keeps reverted/replaced attempts retryable", () => {
    const authorizationId = h("authorization:attempt");
    let state = setMintIntent(createIndexerState(config), { signatureId: goldenSignatureId, authorizationId, state: "authorized" });
    state = recordMintAttempt(state, { signatureId: goldenSignatureId, authorizationId, txHash: h("slow"), state: "reported" });
    state = recordMintAttempt(state, { signatureId: goldenSignatureId, authorizationId, txHash: h("speed-up"), state: "reported" });
    expect(state.aggregates[0].state).toBe("submitted");
    expect(state.galleryEntries).toHaveLength(0);

    state = recordMintAttempt(state, { signatureId: goldenSignatureId, authorizationId, txHash: h("slow"), state: "reverted" });
    state = recordMintAttempt(state, { signatureId: goldenSignatureId, authorizationId, txHash: h("speed-up"), state: "reverted" });
    expect(state.aggregates[0].state).toBe("authorized");
    expect(state.attempts).toHaveLength(2);
  });

  it("makes duplicate and overlapping scans exactly idempotent", () => {
    const headers = chain("a", 100, 102);
    const bundle = mintBundle({ header: headers[1] });
    const batch = scan(headers, [...bundle.logs, ...structuredClone(bundle.logs)], [bundle.receipt, structuredClone(bundle.receipt)]);
    const once = applyScanBatch(createIndexerState(config), batch);
    const twice = applyScanBatch(once, batch);
    expect(twice).toEqual(once);
    expect(twice.logs).toHaveLength(2);
    expect(twice.receipts).toHaveLength(1);
  });

  it("rejects conflicting duplicate identities inside one atomic batch", () => {
    const headers = chain("a", 100, 101);
    const bundle = mintBundle({ header: headers[1] });
    const conflictingLog = structuredClone(bundle.mint);
    conflictingLog.event.mintWallet = walletB;
    const initial = createIndexerState(config);

    expect(() => applyScanBatch(initial, scan(headers, [...bundle.logs, conflictingLog], [bundle.receipt])))
      .toThrow(/conflicting duplicate log identity/);
    expect(initial.logs).toHaveLength(0);

    const conflictingReceipt = structuredClone(bundle.receipt);
    conflictingReceipt.status = "reverted";
    expect(() => applyScanBatch(initial, scan(headers, bundle.logs, [bundle.receipt, conflictingReceipt])))
      .toThrow(/conflicting duplicate receipt identity/);
    expect(initial.receipts).toHaveLength(0);
  });

  it("rejects incomplete same-block rescans without mutating provisional state", () => {
    const headers = chain("a", 100, 101);
    const bundle = mintBundle({ header: headers[1] });
    const state = applyScanBatch(createIndexerState(config), scan(headers, bundle.logs, [bundle.receipt]));
    const before = structuredClone(state);

    expect(() => applyScanBatch(state, scan([headers[1]], [bundle.transfer], [bundle.receipt])))
      .toThrow(/omitted previously observed log/);
    expect(state).toEqual(before);

    expect(() => applyScanBatch(state, scan([headers[1]], bundle.logs, [])))
      .toThrow(/omitted previously observed receipt/);
    expect(state).toEqual(before);
  });

  it("enters CHAIN_SAFETY_HALT when a finalized observation is omitted", () => {
    const headers = chain("a", 100, 101);
    const bundle = mintBundle({ header: headers[1] });
    const state = finalize(applyScanBatch(createIndexerState(config), scan(headers, bundle.logs, [bundle.receipt])), headers[1]);

    const halted = applyScanBatch(state, scan([headers[1]], [bundle.transfer], [bundle.receipt], headers[1].blockHash));
    expect(halted.health).toBe("chain_safety_halt");
    expect(halted.safetyHalt).toMatchObject({
      code: "FINALIZED_OBSERVATION_DIVERGENCE",
      detail: expect.stringMatching(/omitted previously observed log/),
    });
    expect(state.health).toBe("running");
  });

  it("rolls back a shallow reorg above finality and records re-inclusion under the new block hash", () => {
    const oldHeaders = chain("old", 100, 102);
    const oldBundle = mintBundle({ header: oldHeaders[2], txHash: h("same-transaction") });
    let state = setMintIntent(createIndexerState(config), {
      signatureId: goldenSignatureId,
      authorizationId: oldBundle.mint.event.authorizationId,
      state: "authorized",
    });
    state = recordMintAttempt(state, {
      signatureId: goldenSignatureId,
      authorizationId: oldBundle.mint.event.authorizationId,
      txHash: oldBundle.mint.txHash,
      state: "reported",
    });
    state = applyScanBatch(state, scan(oldHeaders, oldBundle.logs, [oldBundle.receipt]));
    state = finalize(state, oldHeaders[0]);
    expect(state.aggregates[0].state).toBe("included_unfinalized");

    const replacement = chain("new", 101, 102, oldHeaders[0].blockHash);
    state = applyScanBatch(state, scan(replacement, [], [], oldHeaders[0].blockHash));
    expect(state.aggregates[0].state).toBe("submitted");
    expect(state.logs.filter((item) => item.orphaned)).toHaveLength(2);
    expect(state.tokenHolders).toHaveLength(0);

    const reIncluded = mintBundle({ header: replacement[1], txHash: h("same-transaction") });
    state = applyScanBatch(state, scan([replacement[1]], reIncluded.logs, [reIncluded.receipt], oldHeaders[0].blockHash));
    expect(state.aggregates[0].state).toBe("included_unfinalized");
    expect(state.logs).toHaveLength(4);
    expect(new Set(state.logs.map((item) => item.eventObservationId)).size).toBe(4);
  });

  it("enters CHAIN_SAFETY_HALT on any finalized checkpoint mismatch", () => {
    const headers = chain("a", 100, 101);
    let state = applyScanBatch(createIndexerState(config), scan(headers));
    state = finalize(state, headers[1]);
    const replacement = chain("deep", 101, 101, headers[0].blockHash);
    const halted = applyScanBatch(state, scan(replacement, [], [], headers[1].blockHash));
    expect(halted.health).toBe("chain_safety_halt");
    expect(halted.safetyHalt?.code).toBe("FINALIZED_CHECKPOINT_MISMATCH");

    const providerHalt = applyScanBatch(state, {
      ...scan([headers[1]], [], [], headers[1].blockHash),
      savedCheckpointFromSecondary: h("provider-disagrees"),
    });
    expect(providerHalt.health).toBe("chain_safety_halt");
  });

  it("uses the lower dual-provider finalized height and blocks disagreement without publishing", () => {
    const headers = chain("a", 100, 102);
    const at101 = mintBundle({ header: headers[1], signatureId: goldenSignatureId });
    const at102 = mintBundle({ header: headers[2], signatureId: signature("later") });
    let state = applyScanBatch(createIndexerState(config), scan(headers, [...at101.logs, ...at102.logs], [at101.receipt, at102.receipt]));
    state = promoteFinalized(state, {
      primaryFinalizedHeight: "102",
      secondaryFinalizedHeight: "101",
      promotionBlockFromPrimary: { blockNumber: "101", blockHash: headers[1].blockHash },
      promotionBlockFromSecondary: { blockNumber: "101", blockHash: headers[1].blockHash },
      savedCheckpointFromPrimary: null,
      savedCheckpointFromSecondary: null,
      promotedAt: "2026-09-04T12:00:00.000Z",
    });
    expect(state.galleryEntries.map((entry) => entry.signatureId)).toEqual([goldenSignatureId]);
    expect(state.aggregates.find((aggregate) => aggregate.signatureId === at102.mint.event.signatureId)?.state).toBe("included_unfinalized");

    const blocked = promoteFinalized(state, {
      primaryFinalizedHeight: "102",
      secondaryFinalizedHeight: "102",
      promotionBlockFromPrimary: { blockNumber: "102", blockHash: headers[2].blockHash },
      promotionBlockFromSecondary: { blockNumber: "102", blockHash: h("other-provider-102") },
      savedCheckpointFromPrimary: headers[1].blockHash,
      savedCheckpointFromSecondary: headers[1].blockHash,
      promotedAt: "2026-09-04T12:01:00.000Z",
    });
    expect(blocked.promotionBlockage?.code).toBe("PROVIDER_FINALITY_DISAGREEMENT");
    expect(blocked.galleryEntries).toEqual(state.galleryEntries);
  });

  it("does not advance finality past retryable validation with a missing receipt", () => {
    const headers = chain("missing-receipt", 100, 101);
    const bundle = mintBundle({ header: headers[1] });
    let state = applyScanBatch(createIndexerState(config), scan(headers, bundle.logs));
    expect(state.aggregates[0]).toMatchObject({ state: "validation_pending", failureCode: "RECEIPT_UNAVAILABLE" });

    state = finalize(state, headers[1]);
    expect(state.health).toBe("running");
    expect(state.checkpoint.promotedFinalizedHeight).toBeNull();
    expect(state.promotionBlockage).toMatchObject({ code: "VALIDATION_PENDING", promotionHeight: "101" });

    state = applyScanBatch(state, scan([headers[1]], bundle.logs, [bundle.receipt]));
    expect(state.aggregates[0].state).toBe("included_unfinalized");
    state = finalize(state, headers[1]);
    expect(state.checkpoint.promotedFinalizedHeight).toBe("101");
    expect(state.galleryEntries).toHaveLength(1);
  });

  it("distinguishes retryable validation_pending from deterministic quarantine", () => {
    const headers = chain("a", 100, 101);
    const pending = mintBundle({
      header: headers[1],
      validationOverride: { tokenURI: { status: "transient", code: "IPFS_UNAVAILABLE" } },
    });
    let state = applyScanBatch(createIndexerState(config), scan(headers, pending.logs, [pending.receipt]));
    expect(state.aggregates[0]).toMatchObject({ state: "validation_pending", failureCode: "IPFS_UNAVAILABLE" });

    state = applyScanBatch(state, scan([headers[1]], mintBundle({ header: headers[1] }).logs, [pending.receipt]));
    expect(state.aggregates[0].state).toBe("included_unfinalized");

    const badId = mintBundle({ header: headers[1] });
    badId.mint.event.walletBindingId = h("wrong binding");
    const quarantined = applyScanBatch(createIndexerState(config), scan(headers, badId.logs, [badId.receipt]));
    expect(quarantined.aggregates[0]).toMatchObject({ state: "quarantined", failureCode: "AUTHORIZATION_WALLETBINDINGID_MISMATCH" });
  });

  it("accepts authoritative validation corrections before finality and halts on finalized evidence changes", () => {
    const headers = chain("validation-correction", 100, 101);
    const valid = mintBundle({ header: headers[1] });
    const corrected = mintBundle({
      header: headers[1],
      validationOverride: { tokenURI: { status: "mismatch", code: "TOKEN_URI_RECHECK_FAILED" } },
    });
    const initial = applyScanBatch(createIndexerState(config), scan(headers, valid.logs, [valid.receipt]));

    const correctedBeforeFinality = applyScanBatch(initial, scan([headers[1]], corrected.logs, [corrected.receipt]));
    expect(correctedBeforeFinality.aggregates[0]).toMatchObject({
      state: "quarantined",
      failureCode: "TOKEN_URI_RECHECK_FAILED",
    });
    expect(correctedBeforeFinality.logs.find((item) => item.log.kind === "signature_minted")?.log)
      .toMatchObject({ validation: { tokenURI: { status: "mismatch", code: "TOKEN_URI_RECHECK_FAILED" } } });

    const finalized = finalize(initial, headers[1]);
    const halted = applyScanBatch(finalized, scan(
      [headers[1]],
      corrected.logs,
      [corrected.receipt],
      headers[1].blockHash,
    ));
    expect(halted.health).toBe("chain_safety_halt");
    expect(halted.safetyHalt).toMatchObject({
      code: "FINALIZED_OBSERVATION_DIVERGENCE",
      detail: "finalized mint validation evidence changed.",
    });
    expect(finalized.health).toBe("running");
  });

  it("quarantines mints contradicted by prior control history without applying later epoch revocation retroactively", () => {
    const headers = chain("control-history", 100, 101);
    const revokedBundle = mintBundle({ header: headers[1], transactionIndex: 1 });
    const priorRevocation: ContractControlLog = {
      chainId: config.chainId,
      address: config.contract,
      abiVersion: config.abiVersion,
      blockNumber: headers[1].blockNumber,
      blockHash: headers[1].blockHash,
      txHash: h("prior-exact-revocation"),
      transactionIndex: 0,
      logIndex: 0,
      topic0: AUTHORIZATION_REVOKED_TOPIC,
      kind: "authorization_revoked",
      authorizationId: revokedBundle.mint.event.authorizationId,
    };
    const priorRevocationReceipt: TransactionReceiptInput = {
      blockNumber: priorRevocation.blockNumber,
      blockHash: priorRevocation.blockHash,
      txHash: priorRevocation.txHash,
      transactionIndex: priorRevocation.transactionIndex,
      status: "success",
    };
    let state = applyScanBatch(createIndexerState(config), scan(
      headers,
      [priorRevocation, ...revokedBundle.logs],
      [priorRevocationReceipt, revokedBundle.receipt],
    ));
    expect(state.aggregates[0]).toMatchObject({
      state: "quarantined",
      failureCode: "EXECUTION_CONTROL_AUTHORIZATION_STATE_CONFLICT",
    });
    state = finalize(state, headers[1]);
    expect(state.galleryEntries).toHaveLength(0);

    const allowedBundle = mintBundle({ header: headers[1], transactionIndex: 0 });
    const epochAdded: ContractControlLog = {
      chainId: config.chainId,
      address: config.contract,
      abiVersion: config.abiVersion,
      blockNumber: headers[0].blockNumber,
      blockHash: headers[0].blockHash,
      txHash: h("epoch-added"),
      transactionIndex: 0,
      logIndex: 0,
      topic0: AUTHORIZER_EPOCH_ADDED_TOPIC,
      kind: "authorizer_epoch_added",
      epoch: 1,
      authorizer,
    };
    const laterEpochRevocation: ContractControlLog = {
      chainId: config.chainId,
      address: config.contract,
      abiVersion: config.abiVersion,
      blockNumber: headers[1].blockNumber,
      blockHash: headers[1].blockHash,
      txHash: h("later-epoch-revocation"),
      transactionIndex: 1,
      logIndex: 0,
      topic0: AUTHORIZER_EPOCH_REVOKED_TOPIC,
      kind: "authorizer_epoch_revoked",
      epoch: 1,
      authorizer,
    };
    const controlReceipt = (log: ContractControlLog): TransactionReceiptInput => ({
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      txHash: log.txHash,
      transactionIndex: log.transactionIndex,
      status: "success",
    });
    state = applyScanBatch(createIndexerState(config), scan(
      headers,
      [epochAdded, ...allowedBundle.logs, laterEpochRevocation],
      [controlReceipt(epochAdded), allowedBundle.receipt, controlReceipt(laterEpochRevocation)],
    ));
    expect(state.aggregates[0].state).toBe("included_unfinalized");
    expect(state.controlState.provisional.authorizationIssuanceReady).toBe(false);
    state = finalize(state, headers[1]);
    expect(state.galleryEntries).toHaveLength(1);
  });

  it("quarantines missing paired events while ignoring wrong chain/address/topic logs", () => {
    const headers = chain("a", 100, 101);
    const missingTransfer = mintBundle({ header: headers[1], includeTransfer: false });
    let state = applyScanBatch(createIndexerState(config), scan(headers, missingTransfer.logs, [missingTransfer.receipt]));
    expect(state.aggregates[0]).toMatchObject({ state: "quarantined", failureCode: "MINT_TRANSFER_MISSING" });

    const expectedOnly = mintBundle({ header: headers[1] });
    state = applyScanBatch(createIndexerState(config), scan(headers, [], [expectedOnly.receipt]));
    expect(state.aggregates[0]).toMatchObject({ state: "quarantined", failureCode: "SUCCESSFUL_MINT_RECEIPT_WITHOUT_EVENT" });

    const foreignLogs = expectedOnly.logs.map((log, index) => ({
      ...log,
      ...(index === 0 ? { chainId: "1" } : { address: walletB }),
    })) as CandidateContractLog[];
    state = applyScanBatch(createIndexerState(config), scan(headers, foreignLogs));
    expect(state.logs).toHaveLength(0);
    expect(state.aggregates).toHaveLength(0);
  });

  it("tracks provisional and finalized holder separately without rewriting mint provenance", () => {
    const headers = chain("a", 100, 102);
    const bundle = mintBundle({ header: headers[1] });
    let state = applyScanBatch(createIndexerState(config), scan(headers.slice(0, 2), bundle.logs, [bundle.receipt]));
    state = finalize(state, headers[1]);
    const transferTx = h("post-mint-transfer");
    const transfer: TransferLog = {
      ...bundle.transfer,
      blockNumber: headers[2].blockNumber,
      blockHash: headers[2].blockHash,
      txHash: transferTx,
      transactionIndex: 0,
      logIndex: 0,
      from: walletA,
      to: walletB,
    };
    const receipt: TransactionReceiptInput = {
      blockNumber: headers[2].blockNumber,
      blockHash: headers[2].blockHash,
      txHash: transferTx,
      transactionIndex: 0,
      status: "success",
    };
    state = applyScanBatch(state, scan([headers[2]], [transfer], [receipt], headers[1].blockHash));
    expect(state.tokenHolders[0]).toMatchObject({ currentHolder: walletA, provisionalHolder: walletB });
    expect(state.galleryEntries[0].mintWallet).toBe(walletA);

    const replacement = chain("holder-reorg", 102, 102, headers[1].blockHash);
    const rolledBack = applyScanBatch(state, scan(replacement, [], [], headers[1].blockHash));
    expect(rolledBack.tokenHolders[0]).toMatchObject({ currentHolder: walletA, provisionalHolder: walletA });

    state = finalize(state, headers[2], "2026-09-04T12:05:00.000Z");
    expect(state.tokenHolders[0]).toMatchObject({ currentHolder: walletB, provisionalHolder: walletB });
    expect(state.galleryEntries[0].mintWallet).toBe(walletA);
  });

  it("replays a later same-block transfer after preserving the initial recipient", () => {
    const headers = chain("a", 100, 101);
    const bundle = mintBundle({ header: headers[1], transferLogIndex: 0, mintLogIndex: 1 });
    const later: TransferLog = {
      ...bundle.transfer,
      logIndex: 2,
      from: walletA,
      to: walletB,
    };
    let state = applyScanBatch(createIndexerState(config), scan(headers, [...bundle.logs, later], [bundle.receipt]));
    state = finalize(state, headers[1]);
    expect(state.tokenHolders[0].currentHolder).toBe(walletB);
    expect(state.galleryEntries[0].mintWallet).toBe(walletA);
  });

  it("paginates finalized works by stable chain key with equal artwork remaining distinct", () => {
    const headers = chain("a", 100, 101);
    const ids = [goldenSignatureId, signature("b"), signature("c")];
    const bundles = ids.map((signatureId, transactionIndex) => mintBundle({
      header: headers[1],
      signatureId,
      transactionIndex,
      txHash: h(`page-tx:${transactionIndex}`),
      svgSha256: h("same-svg"),
    }));
    let state = applyScanBatch(createIndexerState(config), scan(headers, bundles.flatMap((bundle) => bundle.logs), bundles.map((bundle) => bundle.receipt)));
    state = finalize(state, headers[1]);
    const first = galleryPage(state, { limit: 2 });
    expect(first.entries.map((entry) => entry.transactionIndex)).toEqual([2, 1]);
    expect(first.nextCursor).not.toBeNull();
    const second = galleryPage(state, { limit: 2, after: first.nextCursor! });
    expect(second.entries.map((entry) => entry.transactionIndex)).toEqual([0]);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.signatureId)).size).toBe(3);
    expect(first.entries[0]).not.toHaveProperty("ordinal");
  });

  it("keeps the earliest canonical valid mint and quarantines a later impossible duplicate", () => {
    const headers = chain("a", 100, 101);
    const first = mintBundle({ header: headers[1], transactionIndex: 0, txHash: h("winner") });
    const later = mintBundle({ header: headers[1], transactionIndex: 1, txHash: h("impossible-replay") });
    const state = applyScanBatch(createIndexerState(config), scan(headers, [...first.logs, ...later.logs], [first.receipt, later.receipt]));
    const mintObservations = state.logs.filter((item) => item.log.kind === "signature_minted");
    expect(mintObservations.map((item) => item.validationState)).toEqual(["valid", "quarantined"]);
    expect(mintObservations[1].validationCode).toBe("EARLIER_CANONICAL_VALID_MINT");
    expect(state.aggregates[0].canonicalEventId).toBe(mintObservations[0].eventObservationId);
  });

  it("rebuilds all chain-derived projections from authoritative observations", () => {
    const headers = chain("a", 100, 101);
    const bundle = mintBundle({ header: headers[1] });
    const complete = finalize(applyScanBatch(createIndexerState(config), scan(headers, bundle.logs, [bundle.receipt])), headers[1]);
    const erasedProjections = structuredClone(complete);
    erasedProjections.aggregates = [];
    erasedProjections.galleryEntries = [];
    erasedProjections.tokenHolders = [];
    const rebuilt = rebuildIndexerProjections(erasedProjections);
    expect(rebuilt.aggregates).toEqual(complete.aggregates);
    expect(rebuilt.galleryEntries).toEqual(complete.galleryEntries);
    expect(rebuilt.tokenHolders).toEqual(complete.tokenHolders);
  });

  it("retains but removes a confirmed deep-finality incident from the normal Gallery", () => {
    const headers = chain("a", 100, 101);
    const bundle = mintBundle({ header: headers[1] });
    let state = finalize(applyScanBatch(createIndexerState(config), scan(headers, bundle.logs, [bundle.receipt])), headers[1]);
    state = applyScanBatch(state, {
      ...scan([headers[1]], [], [], headers[1].blockHash),
      savedCheckpointFromPrimary: h("deep-reorg"),
    });
    state = markFinalityRevoked(state, "incident-2026-09-04", "101");
    expect(state.aggregates[0].state).toBe("finality_revoked");
    expect(state.galleryEntries).toEqual([expect.objectContaining({ chainState: "finality_revoked" })]);
    expect(galleryPage(state, { limit: 10 }).entries).toHaveLength(0);
  });

  it("is atomic on malformed batches", () => {
    const headers = chain("a", 100, 101);
    const state = createIndexerState(config);
    const before = structuredClone(state);
    const broken = structuredClone(headers);
    broken[1].parentHash = h("not-parent");
    expect(() => applyScanBatch(state, scan(broken))).toThrow(/parent-linked/);
    expect(state).toEqual(before);
  });
});

describe("scan batch input validation", () => {
  const fresh = () => createIndexerState(config);
  const headers = chain("main", 100, 102);

  it("refuses an empty batch rather than treating it as a scanned range", () => {
    expect(() => applyScanBatch(fresh(), scan([]))).toThrow(/at least one header/);
  });

  it("refuses headers that start before the configured deployment block", () => {
    expect(() => applyScanBatch(fresh(), scan(chain("early", 98, 99)))).toThrow(/before the configured deployment block/);
  });

  it("refuses headers that are not ascending and contiguous", () => {
    expect(() => applyScanBatch(fresh(), scan([headers[0]!, headers[2]!]))).toThrow(/ascending and contiguous/);
    expect(() => applyScanBatch(fresh(), scan([headers[1]!, headers[0]!]))).toThrow(/ascending and contiguous/);
    expect(() => applyScanBatch(fresh(), scan([headers[0]!, headers[0]!]))).toThrow(/ascending and contiguous/);
  });

  it("refuses headers whose parent hashes do not link them", () => {
    const orphan: ChainHeader = { ...headers[1]!, parentHash: h("some other block") };
    expect(() => applyScanBatch(fresh(), scan([headers[0]!, orphan]))).toThrow(/not parent-linked/);
  });

  it("refuses a header whose numbers or hashes are not canonical", () => {
    for (const broken of [
      { blockNumber: "0x64" }, { blockNumber: "" }, { blockNumber: "-1" }, { blockNumber: "100.0" },
      { blockTimestamp: "later" },
      { blockHash: "0x1234" }, { blockHash: h("ok").toUpperCase() as Hex },
      { parentHash: "not-a-hash" },
    ]) {
      expect(() => applyScanBatch(fresh(), scan([{ ...headers[0]!, ...broken } as ChainHeader])), JSON.stringify(broken)).toThrow();
    }
  });
});

describe("control log envelope validation", () => {
  const headers = chain("main", 100, 100);
  const block = headers[0]!;
  const account = "0x4444444444444444444444444444444444444444" as Hex;
  const role = h("PAUSER_ROLE");

  const envelope = (topic0: Hex) => ({
    chainId: config.chainId,
    address: config.contract,
    abiVersion: config.abiVersion,
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    txHash: h("control tx"),
    transactionIndex: 0,
    logIndex: 0,
    topic0,
  });
  const apply = (log: unknown) => applyScanBatch(createIndexerState(config), scan(headers, [log as CandidateContractLog]));

  it("accepts every well-formed governance log this contract can emit", () => {
    const logs: ContractControlLog[] = [
      { ...envelope(ROLE_GRANTED_TOPIC), kind: "role_granted", role, account, sender: account } as ContractControlLog,
      { ...envelope(ROLE_ADMIN_CHANGED_TOPIC), kind: "role_admin_changed", role, previousAdminRole: h("a"), newAdminRole: h("b") } as ContractControlLog,
      { ...envelope(PAUSED_TOPIC), kind: "paused", account } as ContractControlLog,
      { ...envelope(DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC), kind: "default_admin_transfer_scheduled", newAdmin: account, acceptSchedule: "1800000900" } as ContractControlLog,
      { ...envelope(DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC), kind: "default_admin_delay_change_scheduled", newDelay: "86400", effectSchedule: "1800086400" } as ContractControlLog,
    ];
    for (const [index, log] of logs.entries()) {
      expect(() => apply({ ...log, logIndex: index }), log.kind).not.toThrow();
    }
  });

  it("refuses an authorizer epoch outside uint32 or a zero-address authorizer field", () => {
    const added = { ...envelope(AUTHORIZER_EPOCH_ADDED_TOPIC), kind: "authorizer_epoch_added", authorizer };
    expect(() => apply({ ...added, epoch: 0x1_0000_0000 })).toThrow(/uint32/);
    expect(() => apply({ ...added, epoch: -1 })).toThrow();
    expect(() => apply({ ...added, epoch: 1.5 })).toThrow();
    expect(() => apply({ ...added, epoch: 1, authorizer: "0xnope" })).toThrow();
    expect(() => apply({ ...envelope(AUTHORIZER_EPOCH_REVOKED_TOPIC), kind: "authorizer_epoch_revoked", epoch: 0x1_0000_0000, authorizer })).toThrow(/uint32/);
  });

  it("refuses governance logs whose role, account, or schedule fields are malformed", () => {
    expect(() => apply({ ...envelope(ROLE_GRANTED_TOPIC), kind: "role_granted", role: "0x12", account, sender: account })).toThrow();
    expect(() => apply({ ...envelope(ROLE_GRANTED_TOPIC), kind: "role_granted", role, account: "0x12", sender: account })).toThrow();
    expect(() => apply({ ...envelope(ROLE_GRANTED_TOPIC), kind: "role_granted", role, account, sender: "not-an-address" })).toThrow();
    expect(() => apply({ ...envelope(ROLE_ADMIN_CHANGED_TOPIC), kind: "role_admin_changed", role, previousAdminRole: "0x1", newAdminRole: h("b") })).toThrow();
    expect(() => apply({ ...envelope(PAUSED_TOPIC), kind: "paused", account: "0x" })).toThrow();
    expect(() => apply({ ...envelope(AUTHORIZATION_REVOKED_TOPIC), kind: "authorization_revoked", authorizationId: "0xabc" })).toThrow();
    expect(() => apply({ ...envelope(DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC), kind: "default_admin_transfer_scheduled", newAdmin: account, acceptSchedule: "soon" })).toThrow();
    expect(() => apply({ ...envelope(DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC), kind: "default_admin_delay_change_scheduled", newDelay: "86400", effectSchedule: "-1" })).toThrow();
  });

  it("refuses unsafe transaction and log positions", () => {
    const paused = { ...envelope(PAUSED_TOPIC), kind: "paused", account };
    for (const position of [{ transactionIndex: -1 }, { transactionIndex: 1.5 }, { logIndex: -1 }, { logIndex: Number.MAX_SAFE_INTEGER + 2 }]) {
      expect(() => apply({ ...paused, ...position }), JSON.stringify(position)).toThrow();
    }
  });

  it("ignores logs from another chain, contract, or topic instead of validating them", () => {
    const paused = { ...envelope(PAUSED_TOPIC), kind: "paused", account: "0x" };
    // Out-of-scope logs are filtered before validation, so a malformed field
    // in one cannot fail the batch.
    expect(() => apply({ ...paused, chainId: "1" })).not.toThrow();
    expect(() => apply({ ...paused, address: "0x9999999999999999999999999999999999999999" })).not.toThrow();
    expect(() => apply({ ...paused, topic0: h("some other event") })).not.toThrow();
  });
});
