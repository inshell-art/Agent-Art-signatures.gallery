import {
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { parseCanonicalCidV1 } from "../core/ipfsCid.js";

export const MINT_OPERATION_CONSTANTS = Object.freeze({
  eip712Name: "signatures.gallery",
  eip712Version: "2",
  collectionName: "Gallery of Signatures",
  collectionSymbol: "SIGN",
  authorizationTtlSeconds: 900,
  maxAuthorizationWindowSeconds: 1_800,
  nftMetadataVersion: "sg-nft-metadata-1.0.0",
  ipfsImportProfile: "sg-ipfs-unixfs-1.0.0",
  walletBindingTtlSeconds: 600,
  walletSupportMode: "eoa_only",
  finalityPolicy: "ethereum_finalized_tag_v1",
} as const);

export type MintDeploymentEnvironment = "production" | "staging";

const DEPLOYMENT_NETWORKS = Object.freeze({
  production: {
    chainId: 1n,
    chainName: "Ethereum",
    genesisHash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
  },
  staging: {
    chainId: 11_155_111n,
    chainName: "Sepolia",
    genesisHash: "0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9",
  },
} as const satisfies Record<MintDeploymentEnvironment, {
  chainId: bigint;
  chainName: string;
  genesisHash: Hex;
}>);

export interface MintOperationsConfig {
  deploymentEnvironment: MintDeploymentEnvironment;
  mintFeatureEnabled: boolean;
  chainId: bigint;
  chainName: string;
  genesisHash: Hex;
  contractAddress: Address;
  deploymentBlock: bigint;
  deploymentBlockHash: Hex;
  runtimeCodeHash: Hex;
  abiVersion: string;
  eip712Name: typeof MINT_OPERATION_CONSTANTS.eip712Name;
  eip712Version: typeof MINT_OPERATION_CONSTANTS.eip712Version;
  collectionName: typeof MINT_OPERATION_CONSTANTS.collectionName;
  collectionSymbol: typeof MINT_OPERATION_CONSTANTS.collectionSymbol;
  authorizationTtlSeconds: typeof MINT_OPERATION_CONSTANTS.authorizationTtlSeconds;
  maxAuthorizationWindowSeconds: typeof MINT_OPERATION_CONSTANTS.maxAuthorizationWindowSeconds;
  currentAuthorizerEpoch: number;
  currentAuthorizerAddress: Address;
  collectionUri: `ipfs://${string}`;
  collectionMetadataSha256: Hex;
  collectionUriHash: Hex;
  publicArtifactOrigin: string;
  primaryRpcUrl: string;
  secondaryRpcUrl: string;
  rpcHistoricalStateRequired: boolean;
  indexerPollIntervalMs: number;
  indexerReorgOverlapBlocks: number;
  indexerMaxLagBlocks: number;
  ipfsPrimaryPinConfig: string;
  ipfsSecondaryPinConfig: string;
  ipfsVerificationGateway: string;
  nftMetadataVersion: typeof MINT_OPERATION_CONSTANTS.nftMetadataVersion;
  ipfsImportProfile: typeof MINT_OPERATION_CONSTANTS.ipfsImportProfile;
  contentWriteLeaseSeconds: number;
  contentDeleteGraceSeconds: number;
  publicationLeaseSeconds: number;
  gallerySignerProvider: string;
  gallerySignerKeyId: string;
  gallerySignerAuditMode: string;
  walletBindingTtlSeconds: typeof MINT_OPERATION_CONSTANTS.walletBindingTtlSeconds;
  walletSupportMode: typeof MINT_OPERATION_CONSTANTS.walletSupportMode;
  finalityPolicy: typeof MINT_OPERATION_CONSTANTS.finalityPolicy;
}

export type MintOperationsConfigField =
  | "MINT_FEATURE_ENABLED"
  | "MINT_CHAIN_ID"
  | "MINT_CHAIN_NAME"
  | "MINT_GENESIS_HASH"
  | "MINT_CONTRACT_ADDRESS"
  | "MINT_DEPLOYMENT_BLOCK"
  | "MINT_DEPLOYMENT_BLOCK_HASH"
  | "MINT_RUNTIME_CODE_HASH"
  | "MINT_ABI_VERSION"
  | "MINT_EIP712_NAME"
  | "MINT_EIP712_VERSION"
  | "MINT_AUTHORIZATION_TTL_SECONDS"
  | "MINT_MAX_AUTH_WINDOW_SECONDS"
  | "MINT_CURRENT_AUTHORIZER_EPOCH"
  | "MINT_CURRENT_AUTHORIZER_ADDRESS"
  | "MINT_COLLECTION_URI"
  | "MINT_COLLECTION_METADATA_SHA256"
  | "MINT_COLLECTION_URI_HASH"
  | "PUBLIC_ARTIFACT_ORIGIN"
  | "PRIMARY_RPC_URL"
  | "SECONDARY_RPC_URL"
  | "RPC_HISTORICAL_STATE_REQUIRED"
  | "INDEXER_POLL_INTERVAL"
  | "INDEXER_REORG_OVERLAP"
  | "INDEXER_MAX_LAG"
  | "IPFS_PRIMARY_PIN_CONFIG"
  | "IPFS_SECONDARY_PIN_CONFIG"
  | "IPFS_VERIFICATION_GATEWAY"
  | "NFT_METADATA_VERSION"
  | "IPFS_IMPORT_PROFILE"
  | "CONTENT_WRITE_LEASE_SECONDS"
  | "CONTENT_DELETE_GRACE_SECONDS"
  | "PUBLICATION_LEASE_SECONDS"
  | "GALLERY_SIGNER_PROVIDER"
  | "GALLERY_SIGNER_KEY_ID"
  | "GALLERY_SIGNER_AUDIT_MODE"
  | "WALLET_BINDING_TTL_SECONDS"
  | "WALLET_SUPPORT_MODE";

export type MintOperationsConfigErrorCode =
  | "MISSING"
  | "INVALID_BOOLEAN"
  | "INVALID_INTEGER"
  | "OUT_OF_RANGE"
  | "WRONG_CONSTANT"
  | "INVALID_HASH"
  | "ZERO_HASH"
  | "INVALID_ADDRESS"
  | "ZERO_ADDRESS"
  | "INVALID_URI"
  | "INVALID_IDENTIFIER"
  | "DUPLICATE_PROVIDER"
  | "URI_HASH_MISMATCH"
  | "UNSAFE_RELATIONSHIP";

/** The error deliberately contains a field name and static code, never an environment value. */
export class MintOperationsConfigError extends Error {
  constructor(
    readonly field: MintOperationsConfigField,
    readonly code: MintOperationsConfigErrorCode,
  ) {
    super(`Invalid V2 mint configuration: ${field} (${code}).`);
    this.name = "MintOperationsConfigError";
  }
}

export interface SafeMintOperationsConfigSummary {
  deploymentEnvironment: MintDeploymentEnvironment;
  mintFeatureEnabled: boolean;
  chainId: string;
  chainName: string;
  contractAddress: Address;
  deploymentBlock: string;
  abiVersion: string;
  authorizerEpoch: number;
  publicArtifactOrigin: string;
  metadataVersion: string;
  ipfsImportProfile: string;
  finalityPolicy: string;
  primaryRpcConfigured: true;
  secondaryRpcConfigured: true;
  primaryPinConfigured: true;
  secondaryPinConfigured: true;
  signerProviderConfigured: true;
  signerKeyConfigured: true;
  signerAuditConfigured: true;
}

function required(env: NodeJS.ProcessEnv, field: MintOperationsConfigField): string {
  const value = env[field];
  if (value === undefined || value.length === 0) throw new MintOperationsConfigError(field, "MISSING");
  return value;
}

function exact(
  env: NodeJS.ProcessEnv,
  field: MintOperationsConfigField,
  expected: string,
): string {
  const value = required(env, field);
  if (value !== expected) throw new MintOperationsConfigError(field, "WRONG_CONSTANT");
  return value;
}

function strictBoolean(env: NodeJS.ProcessEnv, field: MintOperationsConfigField): boolean {
  const value = required(env, field);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new MintOperationsConfigError(field, "INVALID_BOOLEAN");
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  field: MintOperationsConfigField,
  maximum = 0xffff_ffff,
): number {
  const raw = required(env, field);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new MintOperationsConfigError(field, "INVALID_INTEGER");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new MintOperationsConfigError(field, "OUT_OF_RANGE");
  }
  return value;
}

function positiveBigInt(env: NodeJS.ProcessEnv, field: MintOperationsConfigField): bigint {
  const raw = required(env, field);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new MintOperationsConfigError(field, "INVALID_INTEGER");
  return BigInt(raw);
}

function bytes32(env: NodeJS.ProcessEnv, field: MintOperationsConfigField): Hex {
  const value = required(env, field);
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new MintOperationsConfigError(field, "INVALID_HASH");
  if (value === `0x${"0".repeat(64)}`) throw new MintOperationsConfigError(field, "ZERO_HASH");
  return value as Hex;
}

function address(env: NodeJS.ProcessEnv, field: MintOperationsConfigField): Address {
  const value = required(env, field);
  let parsed: Address;
  try {
    parsed = getAddress(value);
  } catch {
    throw new MintOperationsConfigError(field, "INVALID_ADDRESS");
  }
  if (parsed === "0x0000000000000000000000000000000000000000") {
    throw new MintOperationsConfigError(field, "ZERO_ADDRESS");
  }
  return parsed;
}

function identifier(env: NodeJS.ProcessEnv, field: MintOperationsConfigField): string {
  const value = required(env, field);
  if (value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MintOperationsConfigError(field, "INVALID_IDENTIFIER");
  }
  return value;
}

function versionIdentifier(env: NodeJS.ProcessEnv, field: MintOperationsConfigField): string {
  const value = required(env, field);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    throw new MintOperationsConfigError(field, "INVALID_IDENTIFIER");
  }
  return value;
}

function httpsUrl(
  env: NodeJS.ProcessEnv,
  field: MintOperationsConfigField,
  options: { originOnly?: boolean; canonicalBase?: boolean; allowCredentials?: boolean } = {},
): string {
  const value = required(env, field);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MintOperationsConfigError(field, "INVALID_URI");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hash.length > 0
    || (!options.allowCredentials && (parsed.username.length > 0 || parsed.password.length > 0))
  ) {
    throw new MintOperationsConfigError(field, "INVALID_URI");
  }
  if (options.originOnly && (parsed.origin !== value || parsed.pathname !== "/" || parsed.search.length > 0)) {
    throw new MintOperationsConfigError(field, "INVALID_URI");
  }
  if (options.canonicalBase && (value.endsWith("/") || parsed.search.length > 0)) {
    throw new MintOperationsConfigError(field, "INVALID_URI");
  }
  return value;
}

function collectionUri(env: NodeJS.ProcessEnv): `ipfs://${string}` {
  const value = required(env, "MINT_COLLECTION_URI");
  if (!value.startsWith("ipfs://")) throw new MintOperationsConfigError("MINT_COLLECTION_URI", "INVALID_URI");
  try {
    parseCanonicalCidV1(value.slice("ipfs://".length));
  } catch {
    throw new MintOperationsConfigError("MINT_COLLECTION_URI", "INVALID_URI");
  }
  return value as `ipfs://${string}`;
}

/**
 * Parses the complete deployment commitment. This is intentionally strict even
 * when the feature flag is false so operators can validate a disabled rollout
 * before enabling it. Callers must catch MintOperationsConfigError and keep V1
 * reads up while leaving issuance disabled.
 */
export function parseMintOperationsConfig(
  env: NodeJS.ProcessEnv,
  deploymentEnvironment: MintDeploymentEnvironment = "production",
): MintOperationsConfig {
  const expectedNetwork = DEPLOYMENT_NETWORKS[deploymentEnvironment];
  const mintFeatureEnabled = strictBoolean(env, "MINT_FEATURE_ENABLED");
  const chainId = positiveBigInt(env, "MINT_CHAIN_ID");
  if (chainId !== expectedNetwork.chainId) throw new MintOperationsConfigError("MINT_CHAIN_ID", "WRONG_CONSTANT");
  const chainName = exact(env, "MINT_CHAIN_NAME", expectedNetwork.chainName);
  const genesisHash = bytes32(env, "MINT_GENESIS_HASH");
  if (genesisHash !== expectedNetwork.genesisHash) {
    throw new MintOperationsConfigError("MINT_GENESIS_HASH", "WRONG_CONSTANT");
  }

  const deploymentBlock = positiveBigInt(env, "MINT_DEPLOYMENT_BLOCK");
  const authorizationTtlSeconds = positiveInteger(env, "MINT_AUTHORIZATION_TTL_SECONDS");
  if (authorizationTtlSeconds !== MINT_OPERATION_CONSTANTS.authorizationTtlSeconds) {
    throw new MintOperationsConfigError("MINT_AUTHORIZATION_TTL_SECONDS", "WRONG_CONSTANT");
  }
  const maxAuthorizationWindowSeconds = positiveInteger(env, "MINT_MAX_AUTH_WINDOW_SECONDS");
  if (maxAuthorizationWindowSeconds !== MINT_OPERATION_CONSTANTS.maxAuthorizationWindowSeconds) {
    throw new MintOperationsConfigError("MINT_MAX_AUTH_WINDOW_SECONDS", "WRONG_CONSTANT");
  }

  const uri = collectionUri(env);
  const uriHash = bytes32(env, "MINT_COLLECTION_URI_HASH");
  if (keccak256(stringToHex(uri)) !== uriHash) {
    throw new MintOperationsConfigError("MINT_COLLECTION_URI_HASH", "URI_HASH_MISMATCH");
  }

  const primaryRpcUrl = httpsUrl(env, "PRIMARY_RPC_URL", { allowCredentials: true });
  const secondaryRpcUrl = httpsUrl(env, "SECONDARY_RPC_URL", { allowCredentials: true });
  if (primaryRpcUrl === secondaryRpcUrl) {
    throw new MintOperationsConfigError("SECONDARY_RPC_URL", "DUPLICATE_PROVIDER");
  }
  const ipfsPrimaryPinConfig = identifier(env, "IPFS_PRIMARY_PIN_CONFIG");
  const ipfsSecondaryPinConfig = identifier(env, "IPFS_SECONDARY_PIN_CONFIG");
  if (ipfsPrimaryPinConfig === ipfsSecondaryPinConfig) {
    throw new MintOperationsConfigError("IPFS_SECONDARY_PIN_CONFIG", "DUPLICATE_PROVIDER");
  }

  const contentWriteLeaseSeconds = positiveInteger(env, "CONTENT_WRITE_LEASE_SECONDS");
  const contentDeleteGraceSeconds = positiveInteger(env, "CONTENT_DELETE_GRACE_SECONDS");
  if (contentDeleteGraceSeconds <= contentWriteLeaseSeconds) {
    throw new MintOperationsConfigError("CONTENT_DELETE_GRACE_SECONDS", "UNSAFE_RELATIONSHIP");
  }

  const rpcHistoricalStateRequired = strictBoolean(env, "RPC_HISTORICAL_STATE_REQUIRED");
  if (deploymentEnvironment === "production" && !rpcHistoricalStateRequired) {
    throw new MintOperationsConfigError("RPC_HISTORICAL_STATE_REQUIRED", "WRONG_CONSTANT");
  }

  const walletBindingTtlSeconds = positiveInteger(env, "WALLET_BINDING_TTL_SECONDS");
  if (walletBindingTtlSeconds !== MINT_OPERATION_CONSTANTS.walletBindingTtlSeconds) {
    throw new MintOperationsConfigError("WALLET_BINDING_TTL_SECONDS", "WRONG_CONSTANT");
  }

  return Object.freeze({
    deploymentEnvironment,
    mintFeatureEnabled,
    chainId,
    chainName,
    genesisHash,
    contractAddress: address(env, "MINT_CONTRACT_ADDRESS"),
    deploymentBlock,
    deploymentBlockHash: bytes32(env, "MINT_DEPLOYMENT_BLOCK_HASH"),
    runtimeCodeHash: bytes32(env, "MINT_RUNTIME_CODE_HASH"),
    abiVersion: versionIdentifier(env, "MINT_ABI_VERSION"),
    eip712Name: exact(env, "MINT_EIP712_NAME", MINT_OPERATION_CONSTANTS.eip712Name) as typeof MINT_OPERATION_CONSTANTS.eip712Name,
    eip712Version: exact(env, "MINT_EIP712_VERSION", MINT_OPERATION_CONSTANTS.eip712Version) as typeof MINT_OPERATION_CONSTANTS.eip712Version,
    collectionName: MINT_OPERATION_CONSTANTS.collectionName,
    collectionSymbol: MINT_OPERATION_CONSTANTS.collectionSymbol,
    authorizationTtlSeconds: authorizationTtlSeconds as typeof MINT_OPERATION_CONSTANTS.authorizationTtlSeconds,
    maxAuthorizationWindowSeconds: maxAuthorizationWindowSeconds as typeof MINT_OPERATION_CONSTANTS.maxAuthorizationWindowSeconds,
    currentAuthorizerEpoch: positiveInteger(env, "MINT_CURRENT_AUTHORIZER_EPOCH"),
    currentAuthorizerAddress: address(env, "MINT_CURRENT_AUTHORIZER_ADDRESS"),
    collectionUri: uri,
    collectionMetadataSha256: bytes32(env, "MINT_COLLECTION_METADATA_SHA256"),
    collectionUriHash: uriHash,
    publicArtifactOrigin: httpsUrl(env, "PUBLIC_ARTIFACT_ORIGIN", { originOnly: true }),
    primaryRpcUrl,
    secondaryRpcUrl,
    rpcHistoricalStateRequired,
    indexerPollIntervalMs: positiveInteger(env, "INDEXER_POLL_INTERVAL", 0x7fff_ffff),
    indexerReorgOverlapBlocks: positiveInteger(env, "INDEXER_REORG_OVERLAP"),
    indexerMaxLagBlocks: positiveInteger(env, "INDEXER_MAX_LAG"),
    ipfsPrimaryPinConfig,
    ipfsSecondaryPinConfig,
    ipfsVerificationGateway: httpsUrl(env, "IPFS_VERIFICATION_GATEWAY", { canonicalBase: true }),
    nftMetadataVersion: exact(env, "NFT_METADATA_VERSION", MINT_OPERATION_CONSTANTS.nftMetadataVersion) as typeof MINT_OPERATION_CONSTANTS.nftMetadataVersion,
    ipfsImportProfile: exact(env, "IPFS_IMPORT_PROFILE", MINT_OPERATION_CONSTANTS.ipfsImportProfile) as typeof MINT_OPERATION_CONSTANTS.ipfsImportProfile,
    contentWriteLeaseSeconds,
    contentDeleteGraceSeconds,
    publicationLeaseSeconds: positiveInteger(env, "PUBLICATION_LEASE_SECONDS"),
    gallerySignerProvider: identifier(env, "GALLERY_SIGNER_PROVIDER"),
    gallerySignerKeyId: identifier(env, "GALLERY_SIGNER_KEY_ID"),
    gallerySignerAuditMode: identifier(env, "GALLERY_SIGNER_AUDIT_MODE"),
    walletBindingTtlSeconds: walletBindingTtlSeconds as typeof MINT_OPERATION_CONSTANTS.walletBindingTtlSeconds,
    walletSupportMode: exact(env, "WALLET_SUPPORT_MODE", MINT_OPERATION_CONSTANTS.walletSupportMode) as typeof MINT_OPERATION_CONSTANTS.walletSupportMode,
    finalityPolicy: MINT_OPERATION_CONSTANTS.finalityPolicy,
  });
}

/** A deliberately redacted projection suitable for structured startup logs. */
export function safeMintOperationsConfigSummary(config: MintOperationsConfig): SafeMintOperationsConfigSummary {
  return Object.freeze({
    deploymentEnvironment: config.deploymentEnvironment,
    mintFeatureEnabled: config.mintFeatureEnabled,
    chainId: config.chainId.toString(10),
    chainName: config.chainName,
    contractAddress: config.contractAddress,
    deploymentBlock: config.deploymentBlock.toString(10),
    abiVersion: config.abiVersion,
    authorizerEpoch: config.currentAuthorizerEpoch,
    publicArtifactOrigin: config.publicArtifactOrigin,
    metadataVersion: config.nftMetadataVersion,
    ipfsImportProfile: config.ipfsImportProfile,
    finalityPolicy: config.finalityPolicy,
    primaryRpcConfigured: true,
    secondaryRpcConfigured: true,
    primaryPinConfigured: true,
    secondaryPinConfigured: true,
    signerProviderConfigured: true,
    signerKeyConfigured: true,
    signerAuditConfigured: true,
  });
}
