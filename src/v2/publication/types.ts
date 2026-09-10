export type IssuanceState = "enabled" | "blocked" | "erasure_pending" | "erased";
export type PublicationLeaseState = "staging" | "ready" | "activated" | "aborted" | "expired";
export type ChainPublicationState =
  | "unminted"
  | "authorized"
  | "submitted"
  | "included_unfinalized"
  | "finalized"
  | "validation_pending"
  | "quarantined"
  | "finality_revoked";

export interface SignatureMintControl {
  signatureId: string;
  issuanceState: IssuanceState;
  version: number;
  broadReasonClass: string | null;
  originServingEnabled: boolean;
}

export interface GlobalSuppression {
  signatureId: string;
  broadReasonClass: string;
  createdAt: string;
}

export interface GallerySuppression {
  signatureId: string;
  deploymentId: string;
  status: "suppressed";
  broadReasonClass: string;
  createdAt: string;
}

export interface ChainProjectionObservation {
  signatureId: string;
  deploymentId: string;
  state: ChainPublicationState;
  canonicalEventId: string | null;
}

export interface PublicationFence {
  signatureId: string;
  deploymentId: string;
  fencingToken: number;
}

export interface PublicationLease {
  publicationLeaseId: string;
  signatureId: string;
  deploymentId: string;
  controlVersion: number;
  fencingToken: number;
  stagedObjectKey: string;
  state: PublicationLeaseState;
  createdAt: string;
  expiresAt: string;
  cleanupRequired: boolean;
}

export interface PublicationPointer {
  signatureId: string;
  deploymentId: string;
  controlVersion: number;
  fencingToken: number;
  stagedObjectKey: string;
  active: boolean;
}

export interface PurgeRequest {
  signatureId: string;
  deploymentId: string;
  reason: string;
  priority: "high";
  requestedAt: string;
}

export type AuthorizationErasureState =
  | "prepared"
  | "signing_unknown"
  | "issued"
  | "submitted"
  | "proven_never_signed"
  | "expired_unused_finalized"
  | "revoked_finalized"
  | "consumed_finalized";

export interface AuthorizationErasureEvidence {
  authorizationId: string;
  state: AuthorizationErasureState;
}

export interface ErasureReconciliationSnapshot {
  publicationLeasesDrained: boolean;
  metadataPreparationsDrained: boolean;
  contentWriterLeasesDrained: boolean;
  reorgsResolved: boolean;
  contiguousFinalizedCoveragePastAllDeadlines: boolean;
  pinnedMintedSignature: false | true | "unavailable";
  pinnedAuthorizationStates: Array<{
    authorizationId: string;
    state: "unused" | "revoked_finalized" | "redeemed" | "unavailable";
  }>;
  authorizations: AuthorizationErasureEvidence[];
}

export type ErasureCaseState = "pending" | "ready_for_controlled_delete" | "minted_suppressed" | "erased";

export interface ErasureCase {
  signatureId: string;
  state: ErasureCaseState;
  broadReasonClass: string;
  startedAt: string;
  reconciledAt: string | null;
  blockers: string[];
}

export interface InMemoryErasureInventory {
  signatureId: string;
  transactionHintsPresent: boolean;
  authorizationPayloadsPresent: boolean;
  signerAssociationsPresent: boolean;
  tokenMetadataPresent: boolean;
  pinProviderReceiptsPresent: boolean;
  contentReferencesPresent: boolean;
  v1PersonalRecordPresent: boolean;
  accountIdentityPresent: boolean;
  tombstone: { signatureId: string; erasedAt: string; broadReasonClass: string } | null;
}

export interface PublicationControlState {
  schemaVersion: 1;
  deployments: string[];
  controls: SignatureMintControl[];
  globalSuppressions: GlobalSuppression[];
  suppressions: GallerySuppression[];
  chainProjections: ChainProjectionObservation[];
  fences: PublicationFence[];
  leases: PublicationLease[];
  pointers: PublicationPointer[];
  purgeRequests: PurgeRequest[];
  erasureCases: ErasureCase[];
  inventories: InMemoryErasureInventory[];
}

export interface CutoverReadiness {
  v1BackupComplete: boolean;
  additiveSchemaApplied: boolean;
  mintControlsBackfilled: boolean;
  contentReferencesBackfilled: boolean;
  v1WritersUseSharedFencing: boolean;
  localContractTestsPassed: boolean;
  sepoliaDeploymentVerified: boolean;
  indexerFullRebuildVerified: boolean;
  endpointsBehindDisabledFlag: boolean;
  sepoliaRehearsalPassed: boolean;
  securityReviewPassed: boolean;
  productionRunbookCreatedNotExecuted: boolean;
  explicitMainnetDeploymentApproval: boolean;
  mainnetDeploymentVerified: boolean;
  roleTransferVerified: boolean;
  sourceAndBytecodeVerified: boolean;
  rpcAgreementHealthy: boolean;
  signerHealthy: boolean;
  redundantPinHealthVerified: boolean;
  publicationFencingVerified: boolean;
}
