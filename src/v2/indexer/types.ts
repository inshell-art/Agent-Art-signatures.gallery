export type Hex = `0x${string}`;
export type DecimalString = string;

export type ValidationCheck =
  | { status: "valid" }
  | { status: "transient"; code: string }
  | { status: "mismatch"; code: string };

export interface DeploymentIndexConfig {
  deploymentId: string;
  chainId: DecimalString;
  contract: Hex;
  deploymentBlockNumber: DecimalString;
  abiVersion: string;
  mintTopic: Hex;
  transferTopic: Hex;
}

export interface ChainHeader {
  blockNumber: DecimalString;
  blockHash: Hex;
  parentHash: Hex;
  blockTimestamp: DecimalString;
}

export interface BlockObservation extends ChainHeader {
  canonical: boolean;
  finalized: boolean;
  orphaned: boolean;
  finalizedAt: string | null;
}

export interface DurableMintAuthorizationEvidence {
  signatureId: string;
  signatureDigest: Hex;
  walletBindingId: Hex;
  mintWallet: Hex;
  svgSha256: Hex;
  pngSha256: Hex;
  metadataSha256: Hex;
  tokenURIHash: Hex;
  authorizationId: Hex;
  authorizerEpoch: number;
  authorizer: Hex;
  typedDataDigest: Hex;
}

export type AuthorizationEvidence =
  | { status: "valid"; record: DurableMintAuthorizationEvidence }
  | { status: "transient"; code: string }
  | { status: "mismatch"; code: string };

export interface MintValidationEvidence {
  staticProvenance: ValidationCheck;
  executionControl: ValidationCheck;
  tokenURI: ValidationCheck;
  artifactIntegrity: ValidationCheck;
  authorization: AuthorizationEvidence;
}

export interface SignatureMintedFields {
  signatureId: string;
  signatureDigest: Hex;
  authorizationId: Hex;
  mintWallet: Hex;
  tokenId: DecimalString;
  walletBindingId: Hex;
  svgSha256: Hex;
  pngSha256: Hex;
  metadataSha256: Hex;
  tokenURIHash: Hex;
  authorizerEpoch: number;
  authorizationDigest: Hex;
}

export interface ContractLogBase {
  chainId: DecimalString;
  address: Hex;
  topic0: Hex;
  abiVersion: string;
  blockNumber: DecimalString;
  blockHash: Hex;
  txHash: Hex;
  transactionIndex: number;
  logIndex: number;
}

export interface SignatureMintedLog extends ContractLogBase {
  kind: "signature_minted";
  event: SignatureMintedFields;
  validation: MintValidationEvidence;
}

export interface TransferLog extends ContractLogBase {
  kind: "transfer";
  from: Hex;
  to: Hex;
  tokenId: DecimalString;
}

export interface AuthorizerEpochAddedLog extends ContractLogBase {
  kind: "authorizer_epoch_added";
  epoch: number;
  authorizer: Hex;
}

export interface AuthorizerEpochRevokedLog extends ContractLogBase {
  kind: "authorizer_epoch_revoked";
  epoch: number;
  authorizer: Hex;
}

export interface AuthorizationRevokedLog extends ContractLogBase {
  kind: "authorization_revoked";
  authorizationId: Hex;
}

export interface PausedLog extends ContractLogBase {
  kind: "paused";
  account: Hex;
}

export interface UnpausedLog extends ContractLogBase {
  kind: "unpaused";
  account: Hex;
}

export interface RoleGrantedLog extends ContractLogBase {
  kind: "role_granted";
  role: Hex;
  account: Hex;
  sender: Hex;
}

export interface RoleRevokedLog extends ContractLogBase {
  kind: "role_revoked";
  role: Hex;
  account: Hex;
  sender: Hex;
}

export interface RoleAdminChangedLog extends ContractLogBase {
  kind: "role_admin_changed";
  role: Hex;
  previousAdminRole: Hex;
  newAdminRole: Hex;
}

export interface DefaultAdminTransferScheduledLog extends ContractLogBase {
  kind: "default_admin_transfer_scheduled";
  newAdmin: Hex;
  acceptSchedule: DecimalString;
}

export interface DefaultAdminTransferCanceledLog extends ContractLogBase {
  kind: "default_admin_transfer_canceled";
}

export interface DefaultAdminDelayChangeScheduledLog extends ContractLogBase {
  kind: "default_admin_delay_change_scheduled";
  newDelay: DecimalString;
  effectSchedule: DecimalString;
}

export interface DefaultAdminDelayChangeCanceledLog extends ContractLogBase {
  kind: "default_admin_delay_change_canceled";
}

export type ContractControlLog =
  | AuthorizerEpochAddedLog
  | AuthorizerEpochRevokedLog
  | AuthorizationRevokedLog
  | PausedLog
  | UnpausedLog
  | RoleGrantedLog
  | RoleRevokedLog
  | RoleAdminChangedLog
  | DefaultAdminTransferScheduledLog
  | DefaultAdminTransferCanceledLog
  | DefaultAdminDelayChangeScheduledLog
  | DefaultAdminDelayChangeCanceledLog;

export type CandidateContractLog = SignatureMintedLog | TransferLog | ContractControlLog;

export interface DecodedSignatureMintedLog extends ContractLogBase {
  kind: "signature_minted";
  event: SignatureMintedFields;
}

export type DecodedGalleryLog = DecodedSignatureMintedLog | TransferLog | ContractControlLog;

export interface RawEvmLog {
  chainId: DecimalString;
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: DecimalString;
  blockHash: Hex;
  txHash: Hex;
  transactionIndex: number;
  logIndex: number;
  removed?: boolean;
}
export type ObservationValidationState = "validation_pending" | "valid" | "quarantined";

export interface ContractLogObservation {
  eventObservationId: string;
  log: CandidateContractLog;
  canonical: boolean;
  orphaned: boolean;
  finalized: boolean;
  finalizedAt: string | null;
  validationState: ObservationValidationState;
  validationCode: string | null;
}

export interface ExpectedMintReceipt {
  signatureId: string;
  authorizationId: Hex;
}

export interface TransactionReceiptInput {
  blockNumber: DecimalString;
  blockHash: Hex;
  txHash: Hex;
  transactionIndex: number;
  status: "success" | "reverted";
  expectedMint?: ExpectedMintReceipt;
}

export interface TransactionReceiptObservation extends TransactionReceiptInput {
  canonical: boolean;
  orphaned: boolean;
  finalized: boolean;
  finalizedAt: string | null;
  validationState: ObservationValidationState;
  validationCode: string | null;
}

export type MintIntentState = "unminted" | "authorized";

export interface MintIntent {
  signatureId: string;
  authorizationId: Hex | null;
  state: MintIntentState;
}

export type MintAttemptState = "reported" | "observed" | "reverted" | "stale_unknown" | "included";

export interface IndexedMintAttempt {
  signatureId: string;
  authorizationId: Hex;
  txHash: Hex;
  state: MintAttemptState;
}

export type MintAggregateState =
  | "unminted"
  | "authorized"
  | "submitted"
  | "included_unfinalized"
  | "finalized"
  | "validation_pending"
  | "quarantined"
  | "finality_revoked";

export interface MintAggregate {
  signatureId: string;
  deploymentId: string;
  state: MintAggregateState;
  activeAuthorizationId: Hex | null;
  canonicalEventId: string | null;
  failureCode: string | null;
}

export interface GalleryEntryProjection {
  signatureId: string;
  deploymentId: string;
  canonicalEventId: string;
  tokenId: DecimalString;
  mintWallet: Hex;
  txHash: Hex;
  blockNumber: DecimalString;
  blockHash: Hex;
  transactionIndex: number;
  logIndex: number;
  mintedAt: DecimalString;
  finalizedAt: string;
  chainState: "finalized" | "finality_revoked";
}

export interface TokenHolderProjection {
  deploymentId: string;
  tokenId: DecimalString;
  signatureId: string;
  currentHolder: Hex | null;
  provisionalHolder: Hex | null;
  lastTransferBlockNumber: DecimalString | null;
  lastTransferBlockHash: Hex | null;
  lastTransferTxHash: Hex | null;
  lastTransferLogIndex: number | null;
}

export interface AuthorizerEpochProjection {
  epoch: number;
  authorizer: Hex;
  revoked: boolean;
}

export interface RoleMembershipProjection {
  role: Hex;
  account: Hex;
}

export interface RoleAdminProjection {
  role: Hex;
  adminRole: Hex;
}

export interface AuthorizationStateProjection {
  authorizationId: Hex;
  state: "redeemed" | "revoked";
}

export interface ContractControlSnapshot {
  health: "incomplete" | "ready" | "inconsistent";
  failureCode: string | null;
  paused: boolean;
  currentAuthorizerEpoch: number | null;
  authorizerEpochs: AuthorizerEpochProjection[];
  authorizationStates: AuthorizationStateProjection[];
  revokedAuthorizationIds: Hex[];
  roleMemberships: RoleMembershipProjection[];
  roleAdmins: RoleAdminProjection[];
  pendingDefaultAdmin: { account: Hex; acceptSchedule: DecimalString } | null;
  pendingDefaultAdminDelay: { delay: DecimalString; effectSchedule: DecimalString } | null;
  authorizationIssuanceReady: boolean;
}

export interface ContractControlStateProjection {
  provisional: ContractControlSnapshot;
  finalized: ContractControlSnapshot;
}

export interface FinalityRevocation {
  incidentId: string;
  signatureId: string;
  originalEntry: GalleryEntryProjection;
}

export interface IndexerCheckpoint {
  scannedHeight: DecimalString | null;
  scannedHash: Hex | null;
  promotedFinalizedHeight: DecimalString | null;
  promotedFinalizedHash: Hex | null;
}

export interface IndexerSafetyHalt {
  code: "FINALIZED_CHECKPOINT_MISMATCH" | "NO_COMMON_ANCESTOR" | "FINALIZED_OBSERVATION_DIVERGENCE";
  detail: string;
}

export interface PromotionBlockage {
  code:
    | "PROVIDER_FINALITY_DISAGREEMENT"
    | "LOCAL_CANONICAL_MISMATCH"
    | "FINALITY_COVERAGE_GAP"
    | "VALIDATION_PENDING";
  promotionHeight: DecimalString;
  detail: string;
}

export interface IndexerState {
  schemaVersion: 1;
  config: DeploymentIndexConfig;
  health: "running" | "chain_safety_halt";
  safetyHalt: IndexerSafetyHalt | null;
  promotionBlockage: PromotionBlockage | null;
  checkpoint: IndexerCheckpoint;
  blocks: BlockObservation[];
  logs: ContractLogObservation[];
  receipts: TransactionReceiptObservation[];
  intents: MintIntent[];
  attempts: IndexedMintAttempt[];
  aggregates: MintAggregate[];
  galleryEntries: GalleryEntryProjection[];
  tokenHolders: TokenHolderProjection[];
  controlState: ContractControlStateProjection;
  finalityRevocations: FinalityRevocation[];
}

export interface ScanBatch {
  savedCheckpointFromPrimary: Hex | null;
  savedCheckpointFromSecondary: Hex | null;
  /**
   * A batch is an authoritative, complete observation of every supplied block
   * hash: logs contains all in-scope contract logs and receipts contains every
   * candidate receipt the adapter previously exposed for those blocks.
   */
  headers: ChainHeader[];
  logs: CandidateContractLog[];
  receipts: TransactionReceiptInput[];
}

export interface ProviderFinalityInput {
  primaryFinalizedHeight: DecimalString;
  secondaryFinalizedHeight: DecimalString;
  promotionBlockFromPrimary: { blockNumber: DecimalString; blockHash: Hex };
  promotionBlockFromSecondary: { blockNumber: DecimalString; blockHash: Hex };
  savedCheckpointFromPrimary: Hex | null;
  savedCheckpointFromSecondary: Hex | null;
  promotedAt: string;
}

export interface GalleryCursor {
  blockNumber: DecimalString;
  transactionIndex: number;
  logIndex: number;
  signatureId: string;
}
