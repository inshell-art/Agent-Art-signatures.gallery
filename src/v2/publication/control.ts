import type {
  ChainProjectionObservation,
  CutoverReadiness,
  ErasureCase,
  ErasureReconciliationSnapshot,
  GallerySuppression,
  GlobalSuppression,
  InMemoryErasureInventory,
  PublicationControlState,
  PublicationFence,
  PublicationLease,
  PublicationPointer,
  SignatureMintControl,
} from "./types.js";

const SAFE_KEY = /^[A-Za-z0-9._-]+$/;
const MAX_PUBLICATION_LEASE_MS = 5 * 60 * 1000;

export class PublicationControlError extends Error {}

function clone(state: PublicationControlState): PublicationControlState {
  return structuredClone(state);
}

function instant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    throw new PublicationControlError(`${field} must be an exact UTC RFC 3339 millisecond timestamp.`);
  }
  return parsed;
}

function key(value: string, field: string): string {
  if (!SAFE_KEY.test(value)) throw new PublicationControlError(`${field} must be a nonempty opaque path-safe value.`);
  return value;
}

function pair(signatureId: string, deploymentId: string): string {
  return `${signatureId}:${deploymentId}`;
}

function findControl(state: PublicationControlState, signatureId: string): SignatureMintControl {
  const control = state.controls.find((item) => item.signatureId === signatureId);
  if (!control) throw new PublicationControlError("signature mint control is missing; fail closed.");
  return control;
}

function isSuppressed(state: PublicationControlState, signatureId: string, deploymentId: string): boolean {
  return state.suppressions.some((item) => item.signatureId === signatureId && item.deploymentId === deploymentId);
}

function chainProjection(state: PublicationControlState, signatureId: string, deploymentId: string): ChainProjectionObservation | undefined {
  return state.chainProjections.find((item) => item.signatureId === signatureId && item.deploymentId === deploymentId);
}

function fence(state: PublicationControlState, signatureId: string, deploymentId: string): PublicationFence {
  let value = state.fences.find((item) => item.signatureId === signatureId && item.deploymentId === deploymentId);
  if (!value) {
    value = { signatureId, deploymentId, fencingToken: 0 };
    state.fences.push(value);
  }
  return value;
}

function advanceFence(value: PublicationFence): number {
  if (value.fencingToken >= Number.MAX_SAFE_INTEGER) throw new PublicationControlError("publication fencing token is exhausted.");
  value.fencingToken += 1;
  return value.fencingToken;
}

function upsertSuppression(
  state: PublicationControlState,
  signatureId: string,
  deploymentId: string,
  broadReasonClass: string,
  createdAt: string,
): GallerySuppression {
  const existing = state.suppressions.find((item) => item.signatureId === signatureId && item.deploymentId === deploymentId);
  if (existing) return existing;
  const suppression: GallerySuppression = { signatureId, deploymentId, status: "suppressed", broadReasonClass, createdAt };
  state.suppressions.push(suppression);
  return suppression;
}

function upsertGlobalSuppression(
  state: PublicationControlState,
  signatureId: string,
  broadReasonClass: string,
  createdAt: string,
): GlobalSuppression {
  const existing = state.globalSuppressions.find((item) => item.signatureId === signatureId);
  if (existing) return existing;
  const suppression = { signatureId, broadReasonClass, createdAt };
  state.globalSuppressions.push(suppression);
  return suppression;
}

function enqueuePurge(
  state: PublicationControlState,
  signatureId: string,
  deploymentId: string,
  reason: string,
  requestedAt: string,
): void {
  if (state.purgeRequests.some((item) => item.signatureId === signatureId && item.deploymentId === deploymentId && item.reason === reason)) return;
  state.purgeRequests.push({ signatureId, deploymentId, reason, priority: "high", requestedAt });
}

function deactivatePointer(state: PublicationControlState, signatureId: string, deploymentId: string): void {
  const pointer = state.pointers.find((item) => item.signatureId === signatureId && item.deploymentId === deploymentId);
  if (pointer) pointer.active = false;
}

function fenceAndAbortPair(state: PublicationControlState, signatureId: string, deploymentId: string, now: string): void {
  const active = state.leases.filter((lease) => lease.signatureId === signatureId
    && lease.deploymentId === deploymentId
    && (lease.state === "staging" || lease.state === "ready"));
  if (active.length === 0) return;
  const value = fence(state, signatureId, deploymentId);
  value.fencingToken = Math.max(value.fencingToken + 1, ...active.map((lease) => lease.fencingToken + 1));
  const nowMs = instant(now, "now");
  for (const lease of active) {
    lease.state = instant(lease.expiresAt, "lease.expiresAt") <= nowMs ? "expired" : "aborted";
    lease.cleanupRequired = true;
  }
}

export function createPublicationControlState(deploymentIds: string[] = []): PublicationControlState {
  const deployments = [...new Set(deploymentIds.map((deploymentId) => key(deploymentId, "deploymentId")))];
  return {
    schemaVersion: 1,
    deployments,
    controls: [],
    globalSuppressions: [],
    suppressions: [],
    chainProjections: [],
    fences: [],
    leases: [],
    pointers: [],
    purgeRequests: [],
    erasureCases: [],
    inventories: [],
  };
}

export function addDeployment(state: PublicationControlState, deploymentId: string, now: string): PublicationControlState {
  key(deploymentId, "deploymentId");
  instant(now, "now");
  if (state.deployments.includes(deploymentId)) return clone(state);
  const next = clone(state);
  next.deployments.push(deploymentId);
  for (const suppression of next.globalSuppressions) {
    upsertSuppression(next, suppression.signatureId, deploymentId, suppression.broadReasonClass, now);
  }
  return next;
}

function defaultInventory(signatureId: string): InMemoryErasureInventory {
  return {
    signatureId,
    transactionHintsPresent: true,
    authorizationPayloadsPresent: true,
    signerAssociationsPresent: true,
    tokenMetadataPresent: true,
    pinProviderReceiptsPresent: true,
    contentReferencesPresent: true,
    v1PersonalRecordPresent: true,
    accountIdentityPresent: true,
    tombstone: null,
  };
}

export function backfillEligibleMintControls(state: PublicationControlState, signatureIds: string[]): PublicationControlState {
  const next = clone(state);
  for (const signatureId of [...new Set(signatureIds)]) {
    key(signatureId, "signatureId");
    if (!next.controls.some((control) => control.signatureId === signatureId)) {
      next.controls.push({
        signatureId,
        issuanceState: "enabled",
        version: 1,
        broadReasonClass: null,
        originServingEnabled: true,
      });
    }
    if (!next.inventories.some((inventory) => inventory.signatureId === signatureId)) {
      next.inventories.push(defaultInventory(signatureId));
    }
  }
  return next;
}

export function observeChainProjection(
  state: PublicationControlState,
  projection: ChainProjectionObservation,
  observedAt: string,
): PublicationControlState {
  if (!state.deployments.includes(projection.deploymentId)) throw new PublicationControlError("unknown deployment.");
  instant(observedAt, "observedAt");
  const next = clone(state);
  const existing = next.chainProjections.find((item) => pair(item.signatureId, item.deploymentId) === pair(projection.signatureId, projection.deploymentId));
  if (existing) Object.assign(existing, structuredClone(projection));
  else next.chainProjections.push(structuredClone(projection));

  if (projection.state === "finality_revoked") {
    deactivatePointer(next, projection.signatureId, projection.deploymentId);
    fenceAndAbortPair(next, projection.signatureId, projection.deploymentId, observedAt);
    enqueuePurge(next, projection.signatureId, projection.deploymentId, "finality_revoked", observedAt);
  }
  return next;
}

export function beginPublicationLease(state: PublicationControlState, input: {
  publicationLeaseId: string;
  signatureId: string;
  deploymentId: string;
  expectedControlVersion: number;
  now: string;
  ttlMs?: number;
}): PublicationControlState {
  key(input.publicationLeaseId, "publicationLeaseId");
  key(input.signatureId, "signatureId");
  if (!state.deployments.includes(input.deploymentId)) throw new PublicationControlError("unknown deployment.");
  const nowMs = instant(input.now, "now");
  const ttlMs = input.ttlMs ?? 120_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_PUBLICATION_LEASE_MS) {
    throw new PublicationControlError("publication lease TTL must be between 1ms and 5 minutes.");
  }
  if (state.leases.some((lease) => lease.publicationLeaseId === input.publicationLeaseId)) {
    throw new PublicationControlError("publicationLeaseId is already in use.");
  }
  const control = findControl(state, input.signatureId);
  if (control.version !== input.expectedControlVersion) throw new PublicationControlError("stale control version; promotion must restart.");
  if (control.issuanceState !== "enabled" || !control.originServingEnabled) throw new PublicationControlError("signature publication is disabled.");
  if (isSuppressed(state, input.signatureId, input.deploymentId)) throw new PublicationControlError("signature is suppressed for this deployment.");
  if (chainProjection(state, input.signatureId, input.deploymentId)?.state !== "finalized") {
    throw new PublicationControlError("only a finalized validated chain projection can be staged.");
  }

  const next = clone(state);
  const fencingToken = advanceFence(fence(next, input.signatureId, input.deploymentId));
  const lease: PublicationLease = {
    publicationLeaseId: input.publicationLeaseId,
    signatureId: input.signatureId,
    deploymentId: input.deploymentId,
    controlVersion: control.version,
    fencingToken,
    stagedObjectKey: `staging/${input.deploymentId}/${input.signatureId}/${control.version}-${fencingToken}/${input.publicationLeaseId}`,
    state: "staging",
    createdAt: input.now,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    cleanupRequired: false,
  };
  next.leases.push(lease);
  return next;
}

export function markPublicationReady(state: PublicationControlState, publicationLeaseId: string, now: string): PublicationControlState {
  const next = clone(state);
  const lease = next.leases.find((item) => item.publicationLeaseId === publicationLeaseId);
  if (!lease) throw new PublicationControlError("publication lease does not exist.");
  if (lease.state !== "staging") throw new PublicationControlError("only a staging lease can become ready.");
  if (instant(now, "now") >= instant(lease.expiresAt, "lease.expiresAt")) {
    lease.state = "expired";
    lease.cleanupRequired = true;
  } else {
    lease.state = "ready";
  }
  return next;
}

function abortLease(lease: PublicationLease): void {
  lease.state = "aborted";
  lease.cleanupRequired = true;
}

export function activatePublicationLease(state: PublicationControlState, publicationLeaseId: string, now: string): PublicationControlState {
  const next = clone(state);
  const lease = next.leases.find((item) => item.publicationLeaseId === publicationLeaseId);
  if (!lease) throw new PublicationControlError("publication lease does not exist.");
  if (lease.state !== "ready") throw new PublicationControlError("only a ready publication lease can activate.");
  if (instant(now, "now") >= instant(lease.expiresAt, "lease.expiresAt")) {
    lease.state = "expired";
    lease.cleanupRequired = true;
    return next;
  }

  const control = next.controls.find((item) => item.signatureId === lease.signatureId);
  const currentFence = next.fences.find((item) => item.signatureId === lease.signatureId && item.deploymentId === lease.deploymentId);
  const projection = chainProjection(next, lease.signatureId, lease.deploymentId);
  const mayActivate = control?.issuanceState === "enabled"
    && control.originServingEnabled
    && control.version === lease.controlVersion
    && !isSuppressed(next, lease.signatureId, lease.deploymentId)
    && currentFence?.fencingToken === lease.fencingToken
    && projection?.state === "finalized";
  if (!mayActivate) {
    abortLease(lease);
    return next;
  }

  let pointer = next.pointers.find((item) => item.signatureId === lease.signatureId && item.deploymentId === lease.deploymentId);
  const value: PublicationPointer = {
    signatureId: lease.signatureId,
    deploymentId: lease.deploymentId,
    controlVersion: lease.controlVersion,
    fencingToken: lease.fencingToken,
    stagedObjectKey: lease.stagedObjectKey,
    active: true,
  };
  if (pointer) Object.assign(pointer, value);
  else {
    pointer = value;
    next.pointers.push(pointer);
  }
  lease.state = "activated";
  lease.cleanupRequired = false;
  return next;
}

export function acknowledgeStagedCleanup(state: PublicationControlState, publicationLeaseId: string): PublicationControlState {
  const next = clone(state);
  const lease = next.leases.find((item) => item.publicationLeaseId === publicationLeaseId);
  if (!lease) throw new PublicationControlError("publication lease does not exist.");
  if (lease.state !== "aborted" && lease.state !== "expired") throw new PublicationControlError("only aborted or expired staging data can be cleaned.");
  lease.cleanupRequired = false;
  return next;
}

export function suppressSignatureGlobally(state: PublicationControlState, input: {
  signatureId: string;
  broadReasonClass: string;
  now: string;
}): PublicationControlState {
  instant(input.now, "now");
  const next = clone(state);
  const control = findControl(next, input.signatureId);
  if (control.issuanceState === "erased") throw new PublicationControlError("erased control tombstones are terminal.");
  control.version += 1;
  control.originServingEnabled = false;
  control.broadReasonClass = input.broadReasonClass;
  upsertGlobalSuppression(next, input.signatureId, input.broadReasonClass, input.now);
  for (const deploymentId of next.deployments) {
    upsertSuppression(next, input.signatureId, deploymentId, input.broadReasonClass, input.now);
    deactivatePointer(next, input.signatureId, deploymentId);
    fenceAndAbortPair(next, input.signatureId, deploymentId, input.now);
    enqueuePurge(next, input.signatureId, deploymentId, "gallery_suppression", input.now);
  }
  return next;
}

export function beginErasure(state: PublicationControlState, input: {
  signatureId: string;
  broadReasonClass: string;
  now: string;
}): PublicationControlState {
  instant(input.now, "now");
  const existingCase = state.erasureCases.find((item) => item.signatureId === input.signatureId);
  if (existingCase?.state === "pending" || existingCase?.state === "ready_for_controlled_delete") return clone(state);
  if (existingCase?.state === "erased") throw new PublicationControlError("erased signatures can never re-enter erasure or issuance.");
  if (existingCase?.state === "minted_suppressed") throw new PublicationControlError("a finalized/public chain record cannot enter the erasable path.");

  const next = clone(state);
  const control = findControl(next, input.signatureId);
  if (control.issuanceState === "erased") throw new PublicationControlError("erased control tombstones are terminal.");
  control.issuanceState = "erasure_pending";
  control.version += 1;
  control.broadReasonClass = input.broadReasonClass;
  control.originServingEnabled = false;
  upsertGlobalSuppression(next, input.signatureId, input.broadReasonClass, input.now);
  for (const deploymentId of next.deployments) {
    upsertSuppression(next, input.signatureId, deploymentId, input.broadReasonClass, input.now);
    deactivatePointer(next, input.signatureId, deploymentId);
    enqueuePurge(next, input.signatureId, deploymentId, "erasure_pending", input.now);
  }
  const erasureCase: ErasureCase = {
    signatureId: input.signatureId,
    state: "pending",
    broadReasonClass: input.broadReasonClass,
    startedAt: input.now,
    reconciledAt: null,
    blockers: [],
  };
  const prior = next.erasureCases.findIndex((item) => item.signatureId === input.signatureId);
  if (prior >= 0) next.erasureCases[prior] = erasureCase;
  else next.erasureCases.push(erasureCase);
  return next;
}

export function drainPublicationLeases(state: PublicationControlState, signatureId: string, now: string): PublicationControlState {
  instant(now, "now");
  const control = findControl(state, signatureId);
  if (control.issuanceState !== "erasure_pending" && !state.globalSuppressions.some((item) => item.signatureId === signatureId)) {
    throw new PublicationControlError("publication leases may be force-drained only under a durable global gate.");
  }
  const next = clone(state);
  for (const deploymentId of next.deployments) fenceAndAbortPair(next, signatureId, deploymentId, now);
  return next;
}

function actualPublicationLeasesDrained(state: PublicationControlState, signatureId: string): boolean {
  return !state.leases.some((lease) => lease.signatureId === signatureId
    && (lease.state === "staging" || lease.state === "ready" || lease.cleanupRequired));
}

function ensureAllDeploymentsSuppressed(state: PublicationControlState, signatureId: string): boolean {
  return state.deployments.every((deploymentId) => isSuppressed(state, signatureId, deploymentId));
}

function terminalAuthorization(state: string): boolean {
  return state === "proven_never_signed" || state === "expired_unused_finalized" || state === "revoked_finalized";
}

function transitionMintedSuppressed(state: PublicationControlState, erasureCase: ErasureCase, now: string): PublicationControlState {
  const next = clone(state);
  const control = findControl(next, erasureCase.signatureId);
  if (control.issuanceState !== "blocked") control.version += 1;
  control.issuanceState = "blocked";
  control.originServingEnabled = false;
  control.broadReasonClass = "minted_record";
  const mutableCase = next.erasureCases.find((item) => item.signatureId === erasureCase.signatureId)!;
  mutableCase.state = "minted_suppressed";
  mutableCase.reconciledAt = now;
  mutableCase.blockers = ["FINALIZED_OR_PUBLIC_CHAIN_RECORD"];
  for (const deploymentId of next.deployments) {
    upsertSuppression(next, erasureCase.signatureId, deploymentId, erasureCase.broadReasonClass, now);
    deactivatePointer(next, erasureCase.signatureId, deploymentId);
    enqueuePurge(next, erasureCase.signatureId, deploymentId, "minted_suppression", now);
  }
  return next;
}

export function reconcileErasure(
  state: PublicationControlState,
  signatureId: string,
  snapshot: ErasureReconciliationSnapshot,
  now: string,
): PublicationControlState {
  instant(now, "now");
  const erasureCase = state.erasureCases.find((item) => item.signatureId === signatureId);
  if (!erasureCase || erasureCase.state !== "pending") throw new PublicationControlError("erasure case is not pending.");
  const projections = state.chainProjections.filter((projection) => projection.signatureId === signatureId);
  const hasPermanentMint = projections.some((projection) => projection.state === "finalized" || projection.state === "finality_revoked")
    || snapshot.pinnedMintedSignature === true
    || snapshot.authorizations.some((authorization) => authorization.state === "consumed_finalized")
    || snapshot.pinnedAuthorizationStates.some((authorization) => authorization.state === "redeemed");
  if (hasPermanentMint) return transitionMintedSuppressed(state, erasureCase, now);

  const blockers = new Set<string>();
  if (!ensureAllDeploymentsSuppressed(state, signatureId)) blockers.add("DEPLOYMENT_SUPPRESSION_GAP");
  if (!snapshot.publicationLeasesDrained || !actualPublicationLeasesDrained(state, signatureId)) blockers.add("PUBLICATION_LEASES_NOT_DRAINED");
  if (!snapshot.metadataPreparationsDrained) blockers.add("METADATA_PREPARATIONS_NOT_DRAINED");
  if (!snapshot.contentWriterLeasesDrained) blockers.add("CONTENT_WRITER_LEASES_NOT_DRAINED");
  if (!snapshot.reorgsResolved) blockers.add("REORG_UNRESOLVED");
  if (!snapshot.contiguousFinalizedCoveragePastAllDeadlines) blockers.add("FINALIZED_COVERAGE_INCOMPLETE");
  if (snapshot.pinnedMintedSignature === "unavailable") blockers.add("PINNED_MINT_STATE_UNAVAILABLE");
  if (projections.some((projection) => projection.state === "submitted"
    || projection.state === "included_unfinalized"
    || projection.state === "validation_pending"
    || projection.state === "quarantined")) blockers.add("POSSIBLE_MINT_UNRESOLVED");

  const pinnedById = new Map(snapshot.pinnedAuthorizationStates.map((authorization) => [authorization.authorizationId, authorization.state]));
  for (const authorization of snapshot.authorizations) {
    if (!terminalAuthorization(authorization.state)) blockers.add(`AUTHORIZATION_NOT_SAFELY_DEAD:${authorization.authorizationId}`);
    const pinned = pinnedById.get(authorization.authorizationId);
    if (pinned !== "unused" && pinned !== "revoked_finalized") blockers.add(`AUTHORIZATION_STATE_UNCONFIRMED:${authorization.authorizationId}`);
  }

  const next = clone(state);
  const mutableCase = next.erasureCases.find((item) => item.signatureId === signatureId)!;
  mutableCase.blockers = [...blockers].sort();
  mutableCase.reconciledAt = now;
  mutableCase.state = blockers.size === 0 ? "ready_for_controlled_delete" : "pending";
  return next;
}

export function completeControlledErasure(state: PublicationControlState, input: {
  signatureId: string;
  now: string;
  deletingLastRetainedSignature: boolean;
  noMintLegalOrSecurityObligation: boolean;
}): PublicationControlState {
  instant(input.now, "now");
  const erasureCase = state.erasureCases.find((item) => item.signatureId === input.signatureId);
  if (!erasureCase || erasureCase.state !== "ready_for_controlled_delete") {
    throw new PublicationControlError("erasure has not been conclusively reconciled.");
  }
  if (!actualPublicationLeasesDrained(state, input.signatureId)) throw new PublicationControlError("publication staging cleanup is incomplete.");
  const next = clone(state);
  const control = findControl(next, input.signatureId);
  if (control.issuanceState !== "erasure_pending") throw new PublicationControlError("control is not erasure_pending.");
  const inventory = next.inventories.find((item) => item.signatureId === input.signatureId);
  if (!inventory) throw new PublicationControlError("erasure inventory is missing.");
  inventory.transactionHintsPresent = false;
  inventory.authorizationPayloadsPresent = false;
  inventory.signerAssociationsPresent = false;
  inventory.tokenMetadataPresent = false;
  inventory.pinProviderReceiptsPresent = false;
  inventory.contentReferencesPresent = false;
  inventory.v1PersonalRecordPresent = false;
  if (input.deletingLastRetainedSignature && input.noMintLegalOrSecurityObligation) inventory.accountIdentityPresent = false;
  inventory.tombstone = { signatureId: input.signatureId, erasedAt: input.now, broadReasonClass: erasureCase.broadReasonClass };
  control.issuanceState = "erased";
  control.version += 1;
  control.originServingEnabled = false;
  const mutableCase = next.erasureCases.find((item) => item.signatureId === input.signatureId)!;
  mutableCase.state = "erased";
  mutableCase.reconciledAt = input.now;
  mutableCase.blockers = [];
  return next;
}

export function isPubliclyVisible(state: PublicationControlState, signatureId: string, deploymentId: string): boolean {
  const control = state.controls.find((item) => item.signatureId === signatureId);
  const pointer = state.pointers.find((item) => item.signatureId === signatureId && item.deploymentId === deploymentId);
  const projection = chainProjection(state, signatureId, deploymentId);
  const currentFence = state.fences.find((item) => item.signatureId === signatureId && item.deploymentId === deploymentId);
  return control?.issuanceState === "enabled"
    && control.originServingEnabled
    && !isSuppressed(state, signatureId, deploymentId)
    && projection?.state === "finalized"
    && pointer?.active === true
    && pointer.controlVersion === control.version
    && pointer.fencingToken === currentFence?.fencingToken;
}

const STAGING_CUTOVER_KEYS: Array<keyof CutoverReadiness> = [
  "v1BackupComplete",
  "additiveSchemaApplied",
  "mintControlsBackfilled",
  "contentReferencesBackfilled",
  "v1WritersUseSharedFencing",
  "localContractTestsPassed",
  "sepoliaDeploymentVerified",
  "roleTransferVerified",
  "sourceAndBytecodeVerified",
  "rpcAgreementHealthy",
  "signerHealthy",
  "redundantPinHealthVerified",
  "indexerFullRebuildVerified",
  "endpointsBehindDisabledFlag",
  "publicationFencingVerified",
];

export function cutoverBlockers(readiness: CutoverReadiness, environment: "sepolia" | "mainnet"): string[] {
  const required = environment === "sepolia" ? STAGING_CUTOVER_KEYS : Object.keys(readiness) as Array<keyof CutoverReadiness>;
  return required.filter((item) => !readiness[item]);
}

export function authorizationIssuanceMayBeEnabled(readiness: CutoverReadiness, environment: "sepolia" | "mainnet"): boolean {
  return cutoverBlockers(readiness, environment).length === 0;
}
