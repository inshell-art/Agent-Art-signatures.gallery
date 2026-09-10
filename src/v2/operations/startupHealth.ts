import { getAddress, type Address, type Hex } from "viem";
import type { MintOperationsConfig } from "./config.js";
import {
  MINT_CRITICAL_ALERTS,
  MINT_OPERATION_METRICS,
  type MintCriticalAlertName,
  type MintOperationMetricName,
} from "./telemetry.js";

export interface RpcStartupObservation {
  healthy: boolean;
  chainId: bigint;
  genesisHash: Hex | string;
  latestHeight: bigint;
  safeHeight: bigint;
  finalizedHeight: bigint;
  historicalStateAvailable: boolean;
}

/** Both providers must fetch this exact lower finalized height independently. */
export interface SharedFinalityObservation {
  promotionHeight: bigint;
  primaryBlockHash: Hex | string;
  secondaryBlockHash: Hex | string;
}

export interface IndexerStartupObservation {
  scannedHeight: bigint;
  promotedFinalizedHeight: bigint;
  storedCheckpointHash: Hex | string;
  primaryCheckpointHash: Hex | string;
  secondaryCheckpointHash: Hex | string;
  contiguousThroughPromotion: boolean;
  safetyHalted: boolean;
}

export interface ContractStartupObservation {
  address: Address | string;
  codePresent: boolean;
  runtimeCodeHash: Hex | string;
  deploymentBlockHash: Hex | string;
  abiVersion: string;
  name: string;
  symbol: string;
  eip712Domain: {
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: Address | string;
  };
  contractUri: string;
  collectionMetadataSha256: Hex | string;
  collectionUriHash: Hex | string;
  mintPaused: boolean;
  currentAuthorizerEpoch: number;
  currentAuthorizerAddress: Address | string;
  currentAuthorizerEpochRevoked: boolean;
  expectedRoleAssignmentsHealthy: boolean;
  roleSeparationHealthy: boolean;
}

export interface PinStartupObservation {
  primaryProviderHealthy: boolean;
  secondaryProviderHealthy: boolean;
  verificationGatewayHealthy: boolean;
  crossProviderBytesVerified: boolean;
}

export interface SignerStartupObservation {
  serviceHealthy: boolean;
  attestationReturned: boolean;
  canonicalSignatureReturned: boolean;
  attestationVerifiedLocally: boolean;
  recoveredAuthorizerAddress: Address | string;
  digestPrehashedModeVerified: boolean;
  auditHealthy: boolean;
}

export interface MintStartupObservations {
  primaryRpc: RpcStartupObservation;
  secondaryRpc: RpcStartupObservation;
  sharedFinality: SharedFinalityObservation;
  indexer: IndexerStartupObservation;
  contract: ContractStartupObservation;
  pins: PinStartupObservation;
  signer: SignerStartupObservation;
}

export type MintStartupBlockerCode =
  | "FEATURE_DISABLED"
  | "PRIMARY_RPC_UNHEALTHY"
  | "SECONDARY_RPC_UNHEALTHY"
  | "CHAIN_ID_MISMATCH"
  | "GENESIS_HASH_MISMATCH"
  | "RPC_HEAD_ORDER_INVALID"
  | "HISTORICAL_STATE_UNAVAILABLE"
  | "FINALITY_PROMOTION_HEIGHT_INVALID"
  | "FINALITY_HASH_DISAGREEMENT"
  | "CONTRACT_ADDRESS_MISMATCH"
  | "CONTRACT_CODE_MISSING"
  | "RUNTIME_CODE_HASH_MISMATCH"
  | "DEPLOYMENT_BLOCK_HASH_MISMATCH"
  | "ABI_VERSION_MISMATCH"
  | "COLLECTION_NAME_MISMATCH"
  | "COLLECTION_SYMBOL_MISMATCH"
  | "EIP712_NAME_MISMATCH"
  | "EIP712_VERSION_MISMATCH"
  | "EIP712_CHAIN_ID_MISMATCH"
  | "EIP712_VERIFYING_CONTRACT_MISMATCH"
  | "COLLECTION_URI_MISMATCH"
  | "COLLECTION_METADATA_HASH_MISMATCH"
  | "COLLECTION_URI_HASH_MISMATCH"
  | "MINT_PAUSED"
  | "AUTHORIZER_EPOCH_MISMATCH"
  | "AUTHORIZER_ADDRESS_MISMATCH"
  | "AUTHORIZER_EPOCH_REVOKED"
  | "ROLE_ASSIGNMENT_UNSAFE"
  | "ROLE_SEPARATION_UNSAFE"
  | "INDEXER_HEIGHT_INVALID"
  | "INDEXER_NONCONTIGUOUS"
  | "INDEXER_CHECKPOINT_MISMATCH"
  | "INDEXER_SAFETY_HALTED"
  | "INDEXER_LAG_EXCEEDED"
  | "PRIMARY_PIN_UNHEALTHY"
  | "SECONDARY_PIN_UNHEALTHY"
  | "VERIFICATION_GATEWAY_UNHEALTHY"
  | "PIN_INTEGRITY_UNVERIFIED"
  | "SIGNER_UNHEALTHY"
  | "SIGNER_SELF_TEST_MISSING"
  | "SIGNER_SIGNATURE_NONCANONICAL"
  | "SIGNER_ATTESTATION_INVALID"
  | "SIGNER_ADDRESS_MISMATCH"
  | "SIGNER_DIGEST_MODE_UNVERIFIED"
  | "SIGNER_AUDIT_UNHEALTHY";

export interface MintStartupBlocker {
  code: MintStartupBlockerCode;
  /** Static, non-sensitive diagnostic safe for an operations log. */
  message: string;
}

export interface MintStartupDecision {
  status: "ready" | "disabled" | "blocked";
  canIssueNewAuthorizations: boolean;
  v1ReadsRemainAvailable: true;
  indexerLagBlocks: bigint | null;
  blockers: readonly MintStartupBlocker[];
  criticalAlerts: readonly MintCriticalAlertName[];
  metricNames: readonly MintOperationMetricName[];
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

function lowerFinalizedHeight(observations: MintStartupObservations): bigint {
  return observations.primaryRpc.finalizedHeight < observations.secondaryRpc.finalizedHeight
    ? observations.primaryRpc.finalizedHeight
    : observations.secondaryRpc.finalizedHeight;
}

function sameAddress(first: string, second: string): boolean {
  try {
    return getAddress(first) === getAddress(second);
  } catch {
    return false;
  }
}

function exactHash(observed: string, expected: string): boolean {
  return HASH_PATTERN.test(observed) && observed === expected;
}

function validHeadOrder(rpc: RpcStartupObservation): boolean {
  return rpc.finalizedHeight >= 0n
    && rpc.safeHeight >= rpc.finalizedHeight
    && rpc.latestHeight >= rpc.safeHeight;
}

function maximum(first: bigint, second: bigint): bigint {
  return first > second ? first : second;
}

export function evaluateMintStartupHealth(
  config: MintOperationsConfig,
  observations: MintStartupObservations,
): MintStartupDecision {
  const blockers: MintStartupBlocker[] = [];
  const alerts = new Set<MintCriticalAlertName>();
  const metrics = new Set<MintOperationMetricName>([
    MINT_OPERATION_METRICS.startupIssuanceReady,
    MINT_OPERATION_METRICS.rpcLatestHeight,
    MINT_OPERATION_METRICS.rpcSafeHeight,
    MINT_OPERATION_METRICS.rpcFinalizedHeight,
    MINT_OPERATION_METRICS.indexerLagBlocks,
  ]);

  const block = (code: MintStartupBlockerCode, message: string): void => {
    if (!blockers.some((item) => item.code === code)) blockers.push(Object.freeze({ code, message }));
  };

  if (!config.mintFeatureEnabled) block("FEATURE_DISABLED", "V2 mint authorization issuance is disabled by configuration.");

  if (!observations.primaryRpc.healthy) block("PRIMARY_RPC_UNHEALTHY", "The primary RPC health check failed.");
  if (!observations.secondaryRpc.healthy) block("SECONDARY_RPC_UNHEALTHY", "The secondary RPC health check failed.");
  if (observations.primaryRpc.chainId !== config.chainId || observations.secondaryRpc.chainId !== config.chainId) {
    block("CHAIN_ID_MISMATCH", "At least one RPC reported the wrong chain ID.");
  }
  if (
    !exactHash(observations.primaryRpc.genesisHash, config.genesisHash)
    || !exactHash(observations.secondaryRpc.genesisHash, config.genesisHash)
  ) {
    block("GENESIS_HASH_MISMATCH", "At least one RPC reported the wrong genesis hash.");
  }
  if (!validHeadOrder(observations.primaryRpc) || !validHeadOrder(observations.secondaryRpc)) {
    block("RPC_HEAD_ORDER_INVALID", "An RPC reported impossible latest, safe, or finalized head ordering.");
  }
  if (
    config.rpcHistoricalStateRequired
    && (!observations.primaryRpc.historicalStateAvailable || !observations.secondaryRpc.historicalStateAvailable)
  ) {
    block("HISTORICAL_STATE_UNAVAILABLE", "Required historical state is unavailable from at least one RPC.");
  }

  const expectedPromotionHeight = lowerFinalizedHeight(observations);
  if (observations.sharedFinality.promotionHeight !== expectedPromotionHeight) {
    block("FINALITY_PROMOTION_HEIGHT_INVALID", "The shared promotion height is not the lower provider-finalized height.");
    alerts.add(MINT_CRITICAL_ALERTS.finalizedCheckpointMismatch);
  }
  if (
    !HASH_PATTERN.test(observations.sharedFinality.primaryBlockHash)
    || observations.sharedFinality.primaryBlockHash !== observations.sharedFinality.secondaryBlockHash
  ) {
    block("FINALITY_HASH_DISAGREEMENT", "The RPC providers disagree at the shared finalized height.");
    alerts.add(MINT_CRITICAL_ALERTS.finalizedCheckpointMismatch);
    metrics.add(MINT_OPERATION_METRICS.finalizedHashDisagreements);
  }

  const contract = observations.contract;
  if (!sameAddress(contract.address, config.contractAddress)) {
    block("CONTRACT_ADDRESS_MISMATCH", "The observed contract is not the canonical configured contract.");
  }
  if (!contract.codePresent) block("CONTRACT_CODE_MISSING", "The canonical contract has no runtime code.");
  if (!exactHash(contract.runtimeCodeHash, config.runtimeCodeHash)) {
    block("RUNTIME_CODE_HASH_MISMATCH", "The deployed runtime bytecode commitment does not match.");
    alerts.add(MINT_CRITICAL_ALERTS.unexpectedRuntimeCode);
    metrics.add(MINT_OPERATION_METRICS.runtimeBytecodeChanges);
  }
  if (!exactHash(contract.deploymentBlockHash, config.deploymentBlockHash)) {
    block("DEPLOYMENT_BLOCK_HASH_MISMATCH", "The canonical deployment block hash does not match.");
  }
  if (contract.abiVersion !== config.abiVersion) block("ABI_VERSION_MISMATCH", "The indexer ABI version does not match.");
  if (contract.name !== config.collectionName) block("COLLECTION_NAME_MISMATCH", "The collection name does not match.");
  if (contract.symbol !== config.collectionSymbol) block("COLLECTION_SYMBOL_MISMATCH", "The collection symbol does not match.");

  if (contract.eip712Domain.name !== config.eip712Name) {
    block("EIP712_NAME_MISMATCH", "The EIP-712 domain name does not match.");
    alerts.add(MINT_CRITICAL_ALERTS.unexpectedEip712Domain);
  }
  if (contract.eip712Domain.version !== config.eip712Version) {
    block("EIP712_VERSION_MISMATCH", "The EIP-712 domain version does not match.");
    alerts.add(MINT_CRITICAL_ALERTS.unexpectedEip712Domain);
  }
  if (contract.eip712Domain.chainId !== config.chainId) {
    block("EIP712_CHAIN_ID_MISMATCH", "The EIP-712 domain chain ID does not match.");
    alerts.add(MINT_CRITICAL_ALERTS.unexpectedEip712Domain);
  }
  if (!sameAddress(contract.eip712Domain.verifyingContract, config.contractAddress)) {
    block("EIP712_VERIFYING_CONTRACT_MISMATCH", "The EIP-712 verifying contract does not match.");
    alerts.add(MINT_CRITICAL_ALERTS.unexpectedEip712Domain);
  }

  if (contract.contractUri !== config.collectionUri) block("COLLECTION_URI_MISMATCH", "The contract URI does not match.");
  if (!exactHash(contract.collectionMetadataSha256, config.collectionMetadataSha256)) {
    block("COLLECTION_METADATA_HASH_MISMATCH", "The collection metadata SHA-256 commitment does not match.");
  }
  if (!exactHash(contract.collectionUriHash, config.collectionUriHash)) {
    block("COLLECTION_URI_HASH_MISMATCH", "The collection URI Keccak commitment does not match.");
  }
  if (contract.mintPaused) {
    block("MINT_PAUSED", "Contract minting is paused.");
    metrics.add(MINT_OPERATION_METRICS.contractPauseChanges);
  }
  if (contract.currentAuthorizerEpoch !== config.currentAuthorizerEpoch) {
    block("AUTHORIZER_EPOCH_MISMATCH", "The current authorizer epoch does not match.");
    alerts.add(MINT_CRITICAL_ALERTS.roleChangeOutsideRunbook);
    metrics.add(MINT_OPERATION_METRICS.authorizerEpochChanges);
  }
  if (!sameAddress(contract.currentAuthorizerAddress, config.currentAuthorizerAddress)) {
    block("AUTHORIZER_ADDRESS_MISMATCH", "The current authorizer address does not match.");
    alerts.add(MINT_CRITICAL_ALERTS.roleChangeOutsideRunbook);
  }
  if (contract.currentAuthorizerEpochRevoked) {
    block("AUTHORIZER_EPOCH_REVOKED", "The configured current authorizer epoch is revoked.");
    alerts.add(MINT_CRITICAL_ALERTS.roleChangeOutsideRunbook);
  }
  if (!contract.expectedRoleAssignmentsHealthy) {
    block("ROLE_ASSIGNMENT_UNSAFE", "One or more contract roles differ from the deployment runbook.");
    alerts.add(MINT_CRITICAL_ALERTS.roleChangeOutsideRunbook);
    metrics.add(MINT_OPERATION_METRICS.contractRoleChanges);
  }
  if (!contract.roleSeparationHealthy) {
    block("ROLE_SEPARATION_UNSAFE", "Contract or signer role separation is unsafe.");
    alerts.add(MINT_CRITICAL_ALERTS.roleChangeOutsideRunbook);
    metrics.add(MINT_OPERATION_METRICS.contractRoleChanges);
  }

  const indexer = observations.indexer;
  let indexerLagBlocks: bigint | null = null;
  if (
    indexer.scannedHeight < 0n
    || indexer.promotedFinalizedHeight < 0n
    || indexer.promotedFinalizedHeight > indexer.scannedHeight
    || indexer.scannedHeight > observations.primaryRpc.latestHeight
    || indexer.promotedFinalizedHeight > expectedPromotionHeight
  ) {
    block("INDEXER_HEIGHT_INVALID", "The indexer reported an impossible checkpoint or scan height.");
  } else {
    const latestLag = observations.primaryRpc.latestHeight - indexer.scannedHeight;
    const promotionLag = expectedPromotionHeight - indexer.promotedFinalizedHeight;
    indexerLagBlocks = maximum(latestLag, promotionLag);
    if (indexerLagBlocks >= BigInt(config.indexerMaxLagBlocks)) {
      block("INDEXER_LAG_EXCEEDED", "Indexer lag is not below the configured threshold.");
    }
  }
  if (!indexer.contiguousThroughPromotion) {
    block("INDEXER_NONCONTIGUOUS", "Indexer coverage is not contiguous through the promotion height.");
  }
  if (
    indexer.promotedFinalizedHeight < config.deploymentBlock
    || !HASH_PATTERN.test(indexer.storedCheckpointHash)
    || indexer.storedCheckpointHash !== indexer.primaryCheckpointHash
    || indexer.storedCheckpointHash !== indexer.secondaryCheckpointHash
  ) {
    block("INDEXER_CHECKPOINT_MISMATCH", "The stored finalized checkpoint is not confirmed by both RPC providers.");
    alerts.add(MINT_CRITICAL_ALERTS.finalizedCheckpointMismatch);
  }
  if (indexer.safetyHalted) {
    block("INDEXER_SAFETY_HALTED", "The chain indexer safety halt is active.");
    alerts.add(MINT_CRITICAL_ALERTS.finalizedCheckpointMismatch);
    metrics.add(MINT_OPERATION_METRICS.chainSafetyHalts);
  }

  if (!observations.pins.primaryProviderHealthy) block("PRIMARY_PIN_UNHEALTHY", "The primary pin service is unhealthy.");
  if (!observations.pins.secondaryProviderHealthy) block("SECONDARY_PIN_UNHEALTHY", "The secondary pin service is unhealthy.");
  if (!observations.pins.verificationGatewayHealthy) {
    block("VERIFICATION_GATEWAY_UNHEALTHY", "The independent IPFS verification gateway is unhealthy.");
  }
  if (!observations.pins.crossProviderBytesVerified) {
    block("PIN_INTEGRITY_UNVERIFIED", "Pinned metadata bytes were not verified across independent providers.");
  }
  if (
    !observations.pins.primaryProviderHealthy
    || !observations.pins.secondaryProviderHealthy
    || !observations.pins.verificationGatewayHealthy
    || !observations.pins.crossProviderBytesVerified
  ) {
    alerts.add(MINT_CRITICAL_ALERTS.ipfsPinLossAcrossProviders);
  }

  const signer = observations.signer;
  if (!signer.serviceHealthy) block("SIGNER_UNHEALTHY", "The signing service health check failed.");
  if (!signer.attestationReturned) block("SIGNER_SELF_TEST_MISSING", "The signing service returned no self-test attestation.");
  if (!signer.canonicalSignatureReturned) {
    block("SIGNER_SIGNATURE_NONCANONICAL", "The signing service self-test returned a noncanonical signature.");
  }
  if (!signer.attestationVerifiedLocally) {
    block("SIGNER_ATTESTATION_INVALID", "The signing service self-test attestation failed local verification.");
  }
  if (!sameAddress(signer.recoveredAuthorizerAddress, config.currentAuthorizerAddress)) {
    block("SIGNER_ADDRESS_MISMATCH", "The signing service self-test recovered the wrong authorizer.");
    alerts.add(MINT_CRITICAL_ALERTS.roleChangeOutsideRunbook);
  }
  if (!signer.digestPrehashedModeVerified) {
    block("SIGNER_DIGEST_MODE_UNVERIFIED", "The signing service digest/prehashed mode is not verified.");
  }
  if (!signer.auditHealthy) block("SIGNER_AUDIT_UNHEALTHY", "The signing service audit path is unhealthy.");

  const enabled = config.mintFeatureEnabled;
  const canIssueNewAuthorizations = enabled && blockers.length === 0;
  const status = canIssueNewAuthorizations ? "ready" : enabled ? "blocked" : "disabled";

  return Object.freeze({
    status,
    canIssueNewAuthorizations,
    v1ReadsRemainAvailable: true,
    indexerLagBlocks,
    blockers: Object.freeze([...blockers]),
    criticalAlerts: Object.freeze([...alerts]),
    metricNames: Object.freeze([...metrics]),
  });
}
