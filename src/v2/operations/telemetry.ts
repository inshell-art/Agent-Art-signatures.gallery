/**
 * Fixed telemetry names are an allow-list: callers add numeric values and
 * low-cardinality labels, never credentials, request payloads, wallet-provider
 * payloads, cookies, PKCE/CSRF values, OAuth material, or attestations.
 */
export const MINT_OPERATION_METRICS = Object.freeze({
  xReauthRequired: "sg_v2_x_reauth_required_total",
  xReauthSucceeded: "sg_v2_x_reauth_succeeded_total",
  xReauthFailed: "sg_v2_x_reauth_failed_total",
  walletChallengeIssued: "sg_v2_wallet_challenge_issued_total",
  walletChallengeExpired: "sg_v2_wallet_challenge_expired_total",
  walletChallengeReplay: "sg_v2_wallet_challenge_replay_total",
  walletChallengeVerificationFailed: "sg_v2_wallet_challenge_verification_failed_total",
  eoaBindingCreated: "sg_v2_eoa_binding_created_total",
  nonEoaBindingRejected: "sg_v2_non_eoa_binding_rejected_total",
  activeBindings: "sg_v2_active_bindings",
  walletRebindings: "sg_v2_wallet_rebindings_total",
  walletBindingRevocations: "sg_v2_wallet_binding_revocations_total",
  metadataBuilds: "sg_v2_metadata_build_total",
  metadataHashFailures: "sg_v2_metadata_hash_failure_total",
  metadataPinResults: "sg_v2_metadata_pin_result_total",
  metadataRetrievalIntegrityFailures: "sg_v2_metadata_retrieval_integrity_failure_total",
  authorizationsPrepared: "sg_v2_authorizations_prepared_total",
  authorizationsIssued: "sg_v2_authorizations_issued_total",
  authorizationsExpired: "sg_v2_authorizations_expired_total",
  authorizationsRevoked: "sg_v2_authorizations_revoked_total",
  authorizationsConsumed: "sg_v2_authorizations_consumed_total",
  signerLatencySeconds: "sg_v2_signer_latency_seconds",
  signerFailures: "sg_v2_signer_failures_total",
  signerIssuanceVolume: "sg_v2_signer_issuance_volume_total",
  transactionAttempts: "sg_v2_transaction_attempts_total",
  rpcLatestHeight: "sg_v2_rpc_latest_height",
  rpcSafeHeight: "sg_v2_rpc_safe_height",
  rpcFinalizedHeight: "sg_v2_rpc_finalized_height",
  indexerLagBlocks: "sg_v2_indexer_lag_blocks",
  finalizedHashDisagreements: "sg_v2_finalized_hash_disagreement_total",
  reorgDepthBlocks: "sg_v2_reorg_depth_blocks",
  orphanedLogs: "sg_v2_orphaned_logs_total",
  quarantineEvents: "sg_v2_quarantine_events_total",
  chainSafetyHalts: "sg_v2_chain_safety_halts_total",
  finalizedGalleryInsertions: "sg_v2_finalized_gallery_insertions_total",
  transferOwnerUpdates: "sg_v2_transfer_owner_updates_total",
  contractPauseChanges: "sg_v2_contract_pause_changes_total",
  authorizerEpochChanges: "sg_v2_authorizer_epoch_changes_total",
  contractRoleChanges: "sg_v2_contract_role_changes_total",
  runtimeBytecodeChanges: "sg_v2_runtime_bytecode_changes_total",
  startupIssuanceReady: "sg_v2_startup_issuance_ready",
} as const);

export type MintOperationMetricName = typeof MINT_OPERATION_METRICS[keyof typeof MINT_OPERATION_METRICS];

export const MINT_CRITICAL_ALERTS = Object.freeze({
  mintWithoutAuthorizationOrClaim: "sg_v2_mint_without_authorization_or_claim",
  mintCommitmentMismatch: "sg_v2_mint_commitment_mismatch",
  unexpectedRuntimeCode: "sg_v2_unexpected_runtime_code",
  unexpectedEip712Domain: "sg_v2_unexpected_eip712_domain",
  roleChangeOutsideRunbook: "sg_v2_role_change_outside_runbook",
  mintWhileIssuanceDisabled: "sg_v2_mint_while_issuance_disabled",
  finalizedCheckpointMismatch: "sg_v2_finalized_checkpoint_mismatch",
  signerVolumeAboveBudget: "sg_v2_signer_volume_above_budget",
  ipfsPinLossAcrossProviders: "sg_v2_ipfs_pin_loss_across_providers",
} as const);

export type MintCriticalAlertName = typeof MINT_CRITICAL_ALERTS[keyof typeof MINT_CRITICAL_ALERTS];

const METRIC_ALLOW_LIST = new Set<string>(Object.values(MINT_OPERATION_METRICS));
const ALERT_ALLOW_LIST = new Set<string>(Object.values(MINT_CRITICAL_ALERTS));

export function isMintOperationMetricName(value: string): value is MintOperationMetricName {
  return METRIC_ALLOW_LIST.has(value);
}

export function isMintCriticalAlertName(value: string): value is MintCriticalAlertName {
  return ALERT_ALLOW_LIST.has(value);
}
