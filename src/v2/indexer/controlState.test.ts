import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { signatureDigestHex, signatureTokenId } from "../core/signatureId.js";
import { replayContractControlLogs } from "./controlState.js";
import { applyScanBatch, createIndexerState, promoteFinalized } from "./reducer.js";
import {
  AUTHORIZATION_REVOKED_TOPIC,
  AUTHORIZATION_REVOKER_ROLE,
  AUTHORIZER_EPOCH_ADDED_TOPIC,
  AUTHORIZER_EPOCH_REVOKED_TOPIC,
  AUTHORIZER_MANAGER_ROLE,
  DEFAULT_ADMIN_ROLE,
  DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC,
  DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC,
  DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC,
  DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC,
  ERC721_TRANSFER_TOPIC,
  FROZEN_GALLERY_ABI_VERSION,
  PAUSED_TOPIC,
  PAUSER_ROLE,
  ROLE_ADMIN_CHANGED_TOPIC,
  ROLE_GRANTED_TOPIC,
  ROLE_REVOKED_TOPIC,
  SIGNATURE_MINTED_TOPIC,
  UNPAUSED_TOPIC,
} from "./topics.js";
import type {
  CandidateContractLog,
  ChainHeader,
  ContractControlLog,
  ContractLogBase,
  DeploymentIndexConfig,
  Hex,
  SignatureMintedLog,
  TransactionReceiptInput,
} from "./types.js";

const contract = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Hex;
const admin = "0x1000000000000000000000000000000000000001" as Hex;
const manager = "0x1000000000000000000000000000000000000002" as Hex;
const pauser = "0x1000000000000000000000000000000000000003" as Hex;
const revoker = "0x1000000000000000000000000000000000000004" as Hex;
const authorizer = "0x2000000000000000000000000000000000000001" as Hex;
const secondAuthorizer = "0x2000000000000000000000000000000000000002" as Hex;
const signatureId = "sg1_j5ii32jw5ccljacrqivzj3pmdoxp5mvka6avgv3izzfmvcunspva";

function h(label: string): Hex {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

const config: DeploymentIndexConfig = {
  deploymentId: "sepolia-canonical-v2",
  chainId: "11155111",
  contract,
  deploymentBlockNumber: "100",
  abiVersion: FROZEN_GALLERY_ABI_VERSION,
  mintTopic: SIGNATURE_MINTED_TOPIC,
  transferTopic: ERC721_TRANSFER_TOPIC,
};

function header(branch: string, blockNumber: number, parentHash: Hex): ChainHeader {
  return {
    blockNumber: blockNumber.toString(),
    blockHash: h(`${branch}:${blockNumber}`),
    parentHash,
    blockTimestamp: (1_800_000_000 + blockNumber).toString(),
  };
}

function base(input: { header: ChainHeader; tx?: string; transactionIndex?: number; logIndex: number; topic0: Hex }): ContractLogBase {
  return {
    chainId: config.chainId,
    address: config.contract,
    abiVersion: config.abiVersion,
    blockNumber: input.header.blockNumber,
    blockHash: input.header.blockHash,
    txHash: h(input.tx ?? `tx:${input.header.blockHash}`),
    transactionIndex: input.transactionIndex ?? 0,
    logIndex: input.logIndex,
    topic0: input.topic0,
  };
}

function epochAdded(header: ChainHeader, epoch: number, signer: Hex, logIndex: number): ContractControlLog {
  return { ...base({ header, logIndex, topic0: AUTHORIZER_EPOCH_ADDED_TOPIC }), kind: "authorizer_epoch_added", epoch, authorizer: signer };
}

function roleGranted(header: ChainHeader, role: Hex, account: Hex, logIndex: number): ContractControlLog {
  return { ...base({ header, logIndex, topic0: ROLE_GRANTED_TOPIC }), kind: "role_granted", role, account, sender: admin };
}

function receipt(log: CandidateContractLog): TransactionReceiptInput {
  return {
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.txHash,
    transactionIndex: log.transactionIndex,
    status: "success",
  };
}

function constructorLogs(header: ChainHeader): ContractControlLog[] {
  return [
    roleGranted(header, DEFAULT_ADMIN_ROLE, admin, 0),
    epochAdded(header, 1, authorizer, 1),
    roleGranted(header, AUTHORIZER_MANAGER_ROLE, manager, 2),
    roleGranted(header, PAUSER_ROLE, pauser, 3),
    roleGranted(header, AUTHORIZATION_REVOKER_ROLE, revoker, 4),
  ];
}

function mintLog(header: ChainHeader, authorizationId = h("mint authorization"), logIndex = 9): SignatureMintedLog {
  const digest = signatureDigestHex(signatureId);
  return {
    ...base({ header, logIndex, topic0: SIGNATURE_MINTED_TOPIC, tx: `mint:${authorizationId}` }),
    kind: "signature_minted",
    event: {
      signatureId,
      signatureDigest: digest,
      authorizationId,
      mintWallet: admin,
      tokenId: signatureTokenId(signatureId).toString(),
      walletBindingId: h("binding"),
      svgSha256: h("svg"),
      pngSha256: h("png"),
      metadataSha256: h("metadata"),
      tokenURIHash: h("uri"),
      authorizerEpoch: 1,
      authorizationDigest: h("typed data"),
    },
    validation: {
      staticProvenance: { status: "mismatch", code: "UNKNOWN_V1" },
      executionControl: { status: "valid" },
      tokenURI: { status: "valid" },
      artifactIntegrity: { status: "valid" },
      authorization: { status: "mismatch", code: "UNKNOWN_AUTHORIZATION" },
    },
  };
}

describe("rebuildable Gallery contract control projection", () => {
  it("replays constructor controls deterministically from deployment logs", () => {
    const genesis = header("canonical", 100, h("genesis"));
    const snapshot = replayContractControlLogs([...constructorLogs(genesis)].reverse());
    expect(snapshot).toMatchObject({
      health: "ready",
      paused: false,
      currentAuthorizerEpoch: 1,
      authorizerEpochs: [{ epoch: 1, authorizer, revoked: false }],
      authorizationIssuanceReady: true,
    });
    expect(snapshot.roleMemberships).toHaveLength(4);
  });

  it("keeps a revoked current epoch current and fails issuance closed", () => {
    const genesis = header("canonical", 100, h("genesis"));
    const rotate: ContractControlLog = epochAdded(genesis, 2, secondAuthorizer, 5);
    const revoke: ContractControlLog = {
      ...base({ header: genesis, logIndex: 6, topic0: AUTHORIZER_EPOCH_REVOKED_TOPIC }),
      kind: "authorizer_epoch_revoked",
      epoch: 2,
      authorizer: secondAuthorizer,
    };
    const snapshot = replayContractControlLogs([...constructorLogs(genesis), rotate, revoke]);
    expect(snapshot).toMatchObject({ currentAuthorizerEpoch: 2, authorizationIssuanceReady: false });
    expect(snapshot.authorizerEpochs[1]).toEqual({ epoch: 2, authorizer: secondAuthorizer, revoked: true });
  });

  it("replays pause state and treats impossible sequences as inconsistent", () => {
    const genesis = header("canonical", 100, h("genesis"));
    const paused: ContractControlLog = { ...base({ header: genesis, logIndex: 5, topic0: PAUSED_TOPIC }), kind: "paused", account: pauser };
    const unpaused: ContractControlLog = { ...base({ header: genesis, logIndex: 6, topic0: UNPAUSED_TOPIC }), kind: "unpaused", account: admin };
    expect(replayContractControlLogs([...constructorLogs(genesis), paused])).toMatchObject({ paused: true, authorizationIssuanceReady: false });
    expect(replayContractControlLogs([...constructorLogs(genesis), paused, unpaused])).toMatchObject({ paused: false, authorizationIssuanceReady: true });
    expect(replayContractControlLogs([...constructorLogs(genesis), unpaused])).toMatchObject({
      health: "inconsistent",
      failureCode: "UNPAUSE_WHILE_RUNNING",
      authorizationIssuanceReady: false,
    });
  });

  it("tracks revoked and redeemed authorizations even when a mint fails off-chain provenance", () => {
    const genesis = header("canonical", 100, h("genesis"));
    const revokedId = h("revoked authorization");
    const revocation: ContractControlLog = {
      ...base({ header: genesis, logIndex: 5, topic0: AUTHORIZATION_REVOKED_TOPIC }),
      kind: "authorization_revoked",
      authorizationId: revokedId,
    };
    const mint = mintLog(genesis);
    const snapshot = replayContractControlLogs([...constructorLogs(genesis), revocation, mint]);
    expect(snapshot.authorizationStates).toEqual([
      { authorizationId: mint.event.authorizationId, state: "redeemed" },
      { authorizationId: revokedId, state: "revoked" },
    ].sort((a, b) => a.authorizationId.localeCompare(b.authorizationId)));

    expect(replayContractControlLogs([...constructorLogs(genesis), revocation, mintLog(genesis, revokedId, 6)])).toMatchObject({
      health: "inconsistent",
      failureCode: "AUTHORIZATION_STATE_CONFLICT",
      authorizationIssuanceReady: false,
    });
  });

  it("tracks delayed-admin acceptance and flags an unreachable RoleAdminChanged event", () => {
    const genesis = header("canonical", 100, h("genesis"));
    const nextAdmin = "0x3000000000000000000000000000000000000001" as Hex;
    const scheduled: ContractControlLog = {
      ...base({ header: genesis, logIndex: 5, topic0: DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC }),
      kind: "default_admin_transfer_scheduled",
      newAdmin: nextAdmin,
      acceptSchedule: "1800001000",
    };
    const revokeOld: ContractControlLog = {
      ...base({ header: genesis, logIndex: 6, topic0: ROLE_REVOKED_TOPIC }),
      kind: "role_revoked",
      role: DEFAULT_ADMIN_ROLE,
      account: admin,
      sender: nextAdmin,
    };
    const grantNew: ContractControlLog = {
      ...base({ header: genesis, logIndex: 7, topic0: ROLE_GRANTED_TOPIC }),
      kind: "role_granted",
      role: DEFAULT_ADMIN_ROLE,
      account: nextAdmin,
      sender: nextAdmin,
    };
    const accepted = replayContractControlLogs([...constructorLogs(genesis), scheduled, revokeOld, grantNew]);
    expect(accepted.pendingDefaultAdmin).toBeNull();
    expect(accepted.roleMemberships).toContainEqual({ role: DEFAULT_ADMIN_ROLE, account: nextAdmin });
    expect(accepted.roleMemberships).not.toContainEqual({ role: DEFAULT_ADMIN_ROLE, account: admin });

    const impossible: ContractControlLog = {
      ...base({ header: genesis, logIndex: 5, topic0: ROLE_ADMIN_CHANGED_TOPIC }),
      kind: "role_admin_changed",
      role: PAUSER_ROLE,
      previousAdminRole: DEFAULT_ADMIN_ROLE,
      newAdminRole: AUTHORIZER_MANAGER_ROLE,
    };
    expect(replayContractControlLogs([...constructorLogs(genesis), impossible])).toMatchObject({
      health: "inconsistent",
      failureCode: "IMPOSSIBLE_ROLE_ADMIN_CHANGE",
    });
  });

  it("maintains provisional/finalized controls and rebuilds after a shallow reorg", () => {
    const block100 = header("canonical", 100, h("genesis"));
    const block101 = header("canonical", 101, block100.blockHash);
    const block102 = header("canonical", 102, block101.blockHash);
    const controls = constructorLogs(block100);
    const pause: ContractControlLog = { ...base({ header: block102, logIndex: 0, topic0: PAUSED_TOPIC }), kind: "paused", account: pauser };
    const receipts = [receipt(controls[0]), receipt(pause)];
    let state = applyScanBatch(createIndexerState(config), {
      savedCheckpointFromPrimary: null,
      savedCheckpointFromSecondary: null,
      headers: [block100, block101, block102],
      logs: [...controls, pause],
      receipts,
    });
    expect(state.controlState.provisional).toMatchObject({ health: "ready", paused: true, authorizationIssuanceReady: false });
    expect(state.controlState.finalized.health).toBe("incomplete");

    state = promoteFinalized(state, {
      primaryFinalizedHeight: "101",
      secondaryFinalizedHeight: "101",
      promotionBlockFromPrimary: { blockNumber: "101", blockHash: block101.blockHash },
      promotionBlockFromSecondary: { blockNumber: "101", blockHash: block101.blockHash },
      savedCheckpointFromPrimary: null,
      savedCheckpointFromSecondary: null,
      promotedAt: "2026-09-04T12:00:00.000Z",
    });
    expect(state.controlState.finalized).toMatchObject({ health: "ready", paused: false, authorizationIssuanceReady: true });

    const replacement102 = header("replacement", 102, block101.blockHash);
    state = applyScanBatch(state, {
      savedCheckpointFromPrimary: block101.blockHash,
      savedCheckpointFromSecondary: block101.blockHash,
      headers: [replacement102],
      logs: [],
      receipts: [],
    });
    expect(state.controlState.provisional).toMatchObject({ health: "ready", paused: false, authorizationIssuanceReady: true });
    expect(state.logs.find((observation) => observation.log.kind === "paused")).toMatchObject({ orphaned: true });
  });
});

describe("control log sequences that cannot have happened on chain", () => {
  const ZERO = `0x${"00".repeat(20)}` as Hex;
  const block = header("control", 100, h("control:99"));
  let index = 0;
  const next = () => (index += 1);
  const control = (topic0: Hex, rest: Record<string, unknown>): ContractControlLog =>
    ({ ...base({ header: block, logIndex: next(), topic0 }), ...rest } as ContractControlLog);

  const epochRevoked = (epoch: number, signer: Hex) =>
    control(AUTHORIZER_EPOCH_REVOKED_TOPIC, { kind: "authorizer_epoch_revoked", epoch, authorizer: signer });
  const authorizationRevoked = (authorizationId: Hex) =>
    control(AUTHORIZATION_REVOKED_TOPIC, { kind: "authorization_revoked", authorizationId });
  const pausedLog = () => control(PAUSED_TOPIC, { kind: "paused", account: pauser });
  const unpausedLog = () => control(UNPAUSED_TOPIC, { kind: "unpaused", account: pauser });
  const roleRevoked = (role: Hex, account: Hex) =>
    control(ROLE_REVOKED_TOPIC, { kind: "role_revoked", role, account, sender: admin });
  const adminScheduled = (newAdmin: Hex) =>
    control(DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC, { kind: "default_admin_transfer_scheduled", newAdmin, acceptSchedule: "1800000900" });
  const adminCanceled = () => control(DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC, { kind: "default_admin_transfer_canceled" });
  const delayScheduled = () =>
    control(DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC, { kind: "default_admin_delay_change_scheduled", newDelay: "86400", effectSchedule: "1800086400" });
  const delayCanceled = () => control(DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC, { kind: "default_admin_delay_change_canceled" });

  const replay = (logs: ContractControlLog[]) => replayContractControlLogs(logs);
  const failsWith = (code: string, logs: ContractControlLog[]) => {
    const snapshot = replay(logs);
    expect(snapshot.health).toBe("inconsistent");
    expect(snapshot.failureCode).toBe(code);
    // An inconsistent contract view must never authorize a new mint.
    expect(snapshot.authorizationIssuanceReady).toBe(false);
  };

  it("refuses an authorizer epoch that is not the next one in sequence", () => {
    failsWith("AUTHORIZER_EPOCH_SEQUENCE", [roleGranted(block, DEFAULT_ADMIN_ROLE, admin, next()), epochAdded(block, 2, authorizer, next())]);
    failsWith("AUTHORIZER_EPOCH_SEQUENCE", [epochAdded(block, 1, authorizer, next()), epochAdded(block, 1, secondAuthorizer, next())]);
    failsWith("AUTHORIZER_EPOCH_SEQUENCE", [epochAdded(block, 1, authorizer, next()), epochAdded(block, 3, secondAuthorizer, next())]);
  });

  it("refuses the zero address as an authorizer", () => {
    failsWith("ZERO_AUTHORIZER", [epochAdded(block, 1, ZERO, next())]);
  });

  it("refuses a revocation of an epoch that was never added or was signed by another authorizer", () => {
    failsWith("UNKNOWN_AUTHORIZER_EPOCH_REVOCATION", [epochRevoked(1, authorizer)]);
    failsWith("UNKNOWN_AUTHORIZER_EPOCH_REVOCATION", [epochAdded(block, 1, authorizer, next()), epochRevoked(1, secondAuthorizer)]);
  });

  it("refuses a second revocation of the same authorizer epoch", () => {
    failsWith("DUPLICATE_AUTHORIZER_EPOCH_REVOCATION", [
      epochAdded(block, 1, authorizer, next()), epochRevoked(1, authorizer), epochRevoked(1, authorizer),
    ]);
  });

  it("refuses a zero or repeated authorization revocation", () => {
    failsWith("ZERO_AUTHORIZATION_REVOCATION", [authorizationRevoked(`0x${"00".repeat(32)}` as Hex)]);
    const id = h("authorization");
    failsWith("AUTHORIZATION_STATE_CONFLICT", [authorizationRevoked(id), authorizationRevoked(id)]);
  });

  it("refuses a pause sequence that could not have been produced by the contract", () => {
    failsWith("DUPLICATE_PAUSE", [pausedLog(), pausedLog()]);
    failsWith("UNPAUSE_WHILE_RUNNING", [unpausedLog()]);
    failsWith("UNPAUSE_WHILE_RUNNING", [pausedLog(), unpausedLog(), unpausedLog()]);
  });

  it("refuses revoking a role that was never granted", () => {
    failsWith("UNKNOWN_ROLE_REVOCATION", [roleRevoked(PAUSER_ROLE, pauser)]);
    failsWith("UNKNOWN_ROLE_REVOCATION", [roleGranted(block, PAUSER_ROLE, pauser, next()), roleRevoked(PAUSER_ROLE, manager)]);
  });

  it("refuses a duplicate role grant", () => {
    failsWith("DUPLICATE_ROLE_GRANT", [roleGranted(block, PAUSER_ROLE, pauser, next()), roleGranted(block, PAUSER_ROLE, pauser, next())]);
  });

  it("treats any role admin change as impossible for this contract", () => {
    failsWith("IMPOSSIBLE_ROLE_ADMIN_CHANGE", [control(ROLE_ADMIN_CHANGED_TOPIC, {
      kind: "role_admin_changed", role: PAUSER_ROLE, previousAdminRole: DEFAULT_ADMIN_ROLE, newAdminRole: AUTHORIZER_MANAGER_ROLE,
    })]);
  });

  it("tracks a scheduled default-admin transfer and clears it on acceptance or cancellation", () => {
    const scheduled = replay([adminScheduled(manager)]);
    expect(scheduled.pendingDefaultAdmin).toMatchObject({ account: manager, acceptSchedule: "1800000900" });

    const accepted = replay([adminScheduled(manager), roleGranted(block, DEFAULT_ADMIN_ROLE, manager, next())]);
    expect(accepted.pendingDefaultAdmin).toBeNull();

    const canceled = replay([adminScheduled(manager), adminCanceled()]);
    expect(canceled.pendingDefaultAdmin).toBeNull();
    expect(canceled.failureCode).toBeNull();
  });

  it("clears a pending renunciation when the zero-address transfer completes as a revocation", () => {
    const renounced = replay([
      roleGranted(block, DEFAULT_ADMIN_ROLE, admin, next()),
      adminScheduled(ZERO),
      roleRevoked(DEFAULT_ADMIN_ROLE, admin),
    ]);
    expect(renounced.pendingDefaultAdmin).toBeNull();
    expect(renounced.failureCode).toBeNull();
  });

  it("refuses cancelling a default-admin transfer or delay change that was never scheduled", () => {
    failsWith("DEFAULT_ADMIN_TRANSFER_CANCEL_WITHOUT_PENDING", [adminCanceled()]);
    failsWith("DEFAULT_ADMIN_TRANSFER_CANCEL_WITHOUT_PENDING", [adminScheduled(manager), adminCanceled(), adminCanceled()]);
    failsWith("DEFAULT_ADMIN_DELAY_CANCEL_WITHOUT_PENDING", [delayCanceled()]);
  });

  it("tracks a scheduled default-admin delay change and clears it on cancellation", () => {
    const scheduled = replay([delayScheduled()]);
    expect(scheduled.pendingDefaultAdminDelay).toMatchObject({ delay: "86400", effectSchedule: "1800086400" });
    const canceled = replay([delayScheduled(), delayCanceled()]);
    expect(canceled.pendingDefaultAdminDelay).toBeNull();
    expect(canceled.failureCode).toBeNull();
  });

  it("stops replaying at the first impossible event rather than compounding the damage", () => {
    const snapshot = replay([unpausedLog(), epochAdded(block, 1, authorizer, next()), pausedLog()]);
    expect(snapshot.failureCode).toBe("UNPAUSE_WHILE_RUNNING");
    expect(snapshot.currentAuthorizerEpoch).toBeNull();
    expect(snapshot.paused).toBe(false);
  });
});
