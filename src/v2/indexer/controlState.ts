import { DEFAULT_ADMIN_ROLE, ZERO_ADDRESS } from "./topics.js";
import type {
  CandidateContractLog,
  ContractControlLog,
  ContractControlSnapshot,
  ContractControlStateProjection,
  ContractLogObservation,
  Hex,
  TransactionReceiptObservation,
} from "./types.js";

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function lexicalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function positionCompare(a: CandidateContractLog, b: CandidateContractLog): number {
  const block = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
  return a.logIndex - b.logIndex;
}

export function isContractControlLog(log: CandidateContractLog): log is ContractControlLog {
  return log.kind !== "signature_minted" && log.kind !== "transfer";
}

function roleKey(role: Hex, account: Hex): string {
  return `${role.toLowerCase()}:${account.toLowerCase()}`;
}

function emptySnapshot(): ContractControlSnapshot {
  return {
    health: "incomplete",
    failureCode: null,
    paused: false,
    currentAuthorizerEpoch: null,
    authorizerEpochs: [],
    authorizationStates: [],
    revokedAuthorizationIds: [],
    roleMemberships: [],
    roleAdmins: [],
    pendingDefaultAdmin: null,
    pendingDefaultAdminDelay: null,
    authorizationIssuanceReady: false,
  };
}

function failed(snapshot: ContractControlSnapshot, code: string): ContractControlSnapshot {
  return { ...snapshot, health: "inconsistent", failureCode: code, authorizationIssuanceReady: false };
}

/** Replays complete deployment-scoped control and mint logs in EVM execution order. */
export function replayContractControlLogs(logs: readonly CandidateContractLog[]): ContractControlSnapshot {
  const epochs = new Map<number, { authorizer: Hex; revoked: boolean }>();
  const authorizationStates = new Map<string, { authorizationId: Hex; state: "redeemed" | "revoked" }>();
  const roleMemberships = new Map<string, { role: Hex; account: Hex }>();
  const roleAdmins = new Map<string, { role: Hex; adminRole: Hex }>();
  let paused = false;
  let currentAuthorizerEpoch: number | null = null;
  let pendingDefaultAdmin: ContractControlSnapshot["pendingDefaultAdmin"] = null;
  let pendingDefaultAdminDelay: ContractControlSnapshot["pendingDefaultAdminDelay"] = null;
  let failureCode: string | null = null;

  for (const log of [...logs].sort(positionCompare)) {
    if (failureCode) break;
    switch (log.kind) {
      case "authorizer_epoch_added": {
        const expectedEpoch: number = currentAuthorizerEpoch === null ? 1 : currentAuthorizerEpoch + 1;
        if (log.epoch !== expectedEpoch || epochs.has(log.epoch)) {
          failureCode = "AUTHORIZER_EPOCH_SEQUENCE";
        } else if (sameHex(log.authorizer, ZERO_ADDRESS)) {
          failureCode = "ZERO_AUTHORIZER";
        } else {
          epochs.set(log.epoch, { authorizer: log.authorizer, revoked: false });
          currentAuthorizerEpoch = log.epoch;
        }
        break;
      }
      case "authorizer_epoch_revoked": {
        const epoch = epochs.get(log.epoch);
        if (!epoch || !sameHex(epoch.authorizer, log.authorizer)) {
          failureCode = "UNKNOWN_AUTHORIZER_EPOCH_REVOCATION";
        } else if (epoch.revoked) {
          failureCode = "DUPLICATE_AUTHORIZER_EPOCH_REVOCATION";
        } else {
          epoch.revoked = true;
        }
        break;
      }
      case "authorization_revoked": {
        const key = log.authorizationId.toLowerCase();
        if (sameHex(log.authorizationId, `0x${"00".repeat(32)}`)) {
          failureCode = "ZERO_AUTHORIZATION_REVOCATION";
        } else if (authorizationStates.has(key)) {
          failureCode = "AUTHORIZATION_STATE_CONFLICT";
        } else {
          authorizationStates.set(key, { authorizationId: log.authorizationId, state: "revoked" });
        }
        break;
      }
      case "signature_minted": {
        const key = log.event.authorizationId.toLowerCase();
        if (authorizationStates.has(key)) failureCode = "AUTHORIZATION_STATE_CONFLICT";
        else authorizationStates.set(key, { authorizationId: log.event.authorizationId, state: "redeemed" });
        break;
      }
      case "transfer":
        break;
      case "paused":
        if (paused) failureCode = "DUPLICATE_PAUSE";
        else paused = true;
        break;
      case "unpaused":
        if (!paused) failureCode = "UNPAUSE_WHILE_RUNNING";
        else paused = false;
        break;
      case "role_granted": {
        const key = roleKey(log.role, log.account);
        if (roleMemberships.has(key)) failureCode = "DUPLICATE_ROLE_GRANT";
        else {
          roleMemberships.set(key, { role: log.role, account: log.account });
          if (sameHex(log.role, DEFAULT_ADMIN_ROLE) && pendingDefaultAdmin && sameHex(log.account, pendingDefaultAdmin.account)) {
            pendingDefaultAdmin = null;
          }
        }
        break;
      }
      case "role_revoked": {
        const key = roleKey(log.role, log.account);
        if (!roleMemberships.delete(key)) failureCode = "UNKNOWN_ROLE_REVOCATION";
        else if (sameHex(log.role, DEFAULT_ADMIN_ROLE) && pendingDefaultAdmin && sameHex(pendingDefaultAdmin.account, ZERO_ADDRESS)) {
          pendingDefaultAdmin = null;
        }
        break;
      }
      case "role_admin_changed":
        failureCode = "IMPOSSIBLE_ROLE_ADMIN_CHANGE";
        break;
      case "default_admin_transfer_scheduled":
        pendingDefaultAdmin = { account: log.newAdmin, acceptSchedule: log.acceptSchedule };
        break;
      case "default_admin_transfer_canceled":
        if (!pendingDefaultAdmin) failureCode = "DEFAULT_ADMIN_TRANSFER_CANCEL_WITHOUT_PENDING";
        else pendingDefaultAdmin = null;
        break;
      case "default_admin_delay_change_scheduled":
        pendingDefaultAdminDelay = { delay: log.newDelay, effectSchedule: log.effectSchedule };
        break;
      case "default_admin_delay_change_canceled":
        if (!pendingDefaultAdminDelay) failureCode = "DEFAULT_ADMIN_DELAY_CANCEL_WITHOUT_PENDING";
        else pendingDefaultAdminDelay = null;
        break;
    }
  }

  const authorizerEpochs = [...epochs.entries()]
    .sort(([left], [right]) => left - right)
    .map(([epoch, value]) => ({ epoch, authorizer: value.authorizer, revoked: value.revoked }));
  const snapshot: ContractControlSnapshot = {
    health: currentAuthorizerEpoch === null ? "incomplete" : "ready",
    failureCode: null,
    paused,
    currentAuthorizerEpoch,
    authorizerEpochs,
    authorizationStates: [...authorizationStates.values()].sort((a, b) => lexicalCompare(a.authorizationId, b.authorizationId)),
    revokedAuthorizationIds: [...authorizationStates.values()]
      .filter((authorization) => authorization.state === "revoked")
      .map((authorization) => authorization.authorizationId)
      .sort(lexicalCompare),
    roleMemberships: [...roleMemberships.values()].sort((a, b) => (
      lexicalCompare(a.role, b.role) || lexicalCompare(a.account, b.account)
    )),
    roleAdmins: [...roleAdmins.values()].sort((a, b) => lexicalCompare(a.role, b.role)),
    pendingDefaultAdmin,
    pendingDefaultAdminDelay,
    authorizationIssuanceReady: false,
  };
  if (failureCode) return failed(snapshot, failureCode);

  const current = currentAuthorizerEpoch === null ? undefined : epochs.get(currentAuthorizerEpoch);
  snapshot.authorizationIssuanceReady = snapshot.health === "ready" && !paused && current !== undefined && !current.revoked;
  return snapshot;
}

function receiptKey(receipt: Pick<TransactionReceiptObservation, "blockHash" | "txHash">): string {
  return `${receipt.blockHash}:${receipt.txHash}`;
}

function projectionFor(
  observations: readonly ContractLogObservation[],
  receipts: readonly TransactionReceiptObservation[],
  finalizedOnly: boolean,
): ContractControlSnapshot {
  const relevant = observations.filter((observation) => (
    observation.canonical
      && (!finalizedOnly || observation.finalized)
      && observation.log.kind !== "transfer"
  ));
  const snapshot = replayContractControlLogs(relevant.map((observation) => observation.log));
  const invalidControl = relevant.find((observation) => (
    isContractControlLog(observation.log) && observation.validationState !== "valid"
  ));
  if (invalidControl) return failed(snapshot, `CONTROL_LOG_${invalidControl.validationCode ?? invalidControl.validationState}`);

  const receiptMap = new Map(receipts
    .filter((receipt) => receipt.canonical && (!finalizedOnly || receipt.finalized))
    .map((receipt) => [receiptKey(receipt), receipt]));
  for (const observation of relevant) {
    const receipt = receiptMap.get(receiptKey(observation.log));
    if (!receipt) return failed(snapshot, "CONTROL_RECEIPT_UNAVAILABLE");
    if (receipt.status !== "success") return failed(snapshot, "CONTROL_RECEIPT_REVERTED");
    if (receipt.blockNumber !== observation.log.blockNumber || receipt.transactionIndex !== observation.log.transactionIndex) {
      return failed(snapshot, "CONTROL_RECEIPT_POSITION_MISMATCH");
    }
  }
  return snapshot;
}

export function rebuildContractControlState(
  observations: readonly ContractLogObservation[],
  receipts: readonly TransactionReceiptObservation[] = [],
): ContractControlStateProjection {
  return {
    provisional: projectionFor(observations, receipts, false),
    finalized: projectionFor(observations, receipts, true),
  };
}

export function emptyContractControlState(): ContractControlStateProjection {
  return { provisional: emptySnapshot(), finalized: emptySnapshot() };
}
