import { describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import {
  MINT_CRITICAL_ALERTS,
  MINT_OPERATION_METRICS,
  isMintCriticalAlertName,
  isMintOperationMetricName,
} from "./telemetry.js";
import {
  MintOperationsConfigError,
  parseMintOperationsConfig,
  safeMintOperationsConfigSummary,
  type MintOperationsConfigField,
} from "./config.js";

const collectionCid = "bafkreihnf7ql73vs7sechq6ytdexfymrh75m3d6zb4wepj4ubjqq32rr4e";
const collectionUri = `ipfs://${collectionCid}`;

function productionEnv(): NodeJS.ProcessEnv {
  return {
    MINT_FEATURE_ENABLED: "true",
    MINT_CHAIN_ID: "1",
    MINT_CHAIN_NAME: "Ethereum",
    MINT_GENESIS_HASH: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
    MINT_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
    MINT_DEPLOYMENT_BLOCK: "22345678",
    MINT_DEPLOYMENT_BLOCK_HASH: `0x${"2".repeat(64)}`,
    MINT_RUNTIME_CODE_HASH: `0x${"3".repeat(64)}`,
    MINT_ABI_VERSION: "sg-gallery-abi-1.0.0",
    MINT_EIP712_NAME: "signatures.gallery",
    MINT_EIP712_VERSION: "2",
    MINT_AUTHORIZATION_TTL_SECONDS: "900",
    MINT_MAX_AUTH_WINDOW_SECONDS: "1800",
    MINT_CURRENT_AUTHORIZER_EPOCH: "7",
    MINT_CURRENT_AUTHORIZER_ADDRESS: "0x2222222222222222222222222222222222222222",
    MINT_COLLECTION_URI: collectionUri,
    MINT_COLLECTION_METADATA_SHA256: `0x${"4".repeat(64)}`,
    MINT_COLLECTION_URI_HASH: keccak256(stringToHex(collectionUri)),
    PUBLIC_ARTIFACT_ORIGIN: "https://signatures.gallery",
    PRIMARY_RPC_URL: "https://primary-rpc.example/rpc?token=primary-secret",
    SECONDARY_RPC_URL: "https://secondary-rpc.example/rpc?token=secondary-secret",
    RPC_HISTORICAL_STATE_REQUIRED: "true",
    INDEXER_POLL_INTERVAL: "12000",
    INDEXER_REORG_OVERLAP: "24",
    INDEXER_MAX_LAG: "12",
    IPFS_PRIMARY_PIN_CONFIG: "secret://pins/primary-sensitive",
    IPFS_SECONDARY_PIN_CONFIG: "secret://pins/secondary-sensitive",
    IPFS_VERIFICATION_GATEWAY: "https://gateway.example/ipfs",
    NFT_METADATA_VERSION: "sg-nft-metadata-1.0.0",
    IPFS_IMPORT_PROFILE: "sg-ipfs-unixfs-1.0.0",
    CONTENT_WRITE_LEASE_SECONDS: "120",
    CONTENT_DELETE_GRACE_SECONDS: "86400",
    PUBLICATION_LEASE_SECONDS: "120",
    GALLERY_SIGNER_PROVIDER: "aws-kms",
    GALLERY_SIGNER_KEY_ID: "alias/gallery-production-sensitive",
    GALLERY_SIGNER_AUDIT_MODE: "cloudtrail-strict",
    WALLET_BINDING_TTL_SECONDS: "600",
    WALLET_SUPPORT_MODE: "eoa_only",
  };
}

const allFields: readonly MintOperationsConfigField[] = [
  "MINT_FEATURE_ENABLED",
  "MINT_CHAIN_ID",
  "MINT_CHAIN_NAME",
  "MINT_GENESIS_HASH",
  "MINT_CONTRACT_ADDRESS",
  "MINT_DEPLOYMENT_BLOCK",
  "MINT_DEPLOYMENT_BLOCK_HASH",
  "MINT_RUNTIME_CODE_HASH",
  "MINT_ABI_VERSION",
  "MINT_EIP712_NAME",
  "MINT_EIP712_VERSION",
  "MINT_AUTHORIZATION_TTL_SECONDS",
  "MINT_MAX_AUTH_WINDOW_SECONDS",
  "MINT_CURRENT_AUTHORIZER_EPOCH",
  "MINT_CURRENT_AUTHORIZER_ADDRESS",
  "MINT_COLLECTION_URI",
  "MINT_COLLECTION_METADATA_SHA256",
  "MINT_COLLECTION_URI_HASH",
  "PUBLIC_ARTIFACT_ORIGIN",
  "PRIMARY_RPC_URL",
  "SECONDARY_RPC_URL",
  "RPC_HISTORICAL_STATE_REQUIRED",
  "INDEXER_POLL_INTERVAL",
  "INDEXER_REORG_OVERLAP",
  "INDEXER_MAX_LAG",
  "IPFS_PRIMARY_PIN_CONFIG",
  "IPFS_SECONDARY_PIN_CONFIG",
  "IPFS_VERIFICATION_GATEWAY",
  "NFT_METADATA_VERSION",
  "IPFS_IMPORT_PROFILE",
  "CONTENT_WRITE_LEASE_SECONDS",
  "CONTENT_DELETE_GRACE_SECONDS",
  "PUBLICATION_LEASE_SECONDS",
  "GALLERY_SIGNER_PROVIDER",
  "GALLERY_SIGNER_KEY_ID",
  "GALLERY_SIGNER_AUDIT_MODE",
  "WALLET_BINDING_TTL_SECONDS",
  "WALLET_SUPPORT_MODE",
] as const;

function expectConfigFailure(env: NodeJS.ProcessEnv, field: MintOperationsConfigField, code?: string): void {
  try {
    parseMintOperationsConfig(env);
    throw new Error("Expected parsing to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(MintOperationsConfigError);
    expect((error as MintOperationsConfigError).field).toBe(field);
    if (code) expect((error as MintOperationsConfigError).code).toBe(code);
  }
}

describe("production mint operations configuration", () => {
  it("parses every listed commitment with frozen protocol constants", () => {
    const config = parseMintOperationsConfig(productionEnv());
    expect(config).toMatchObject({
      deploymentEnvironment: "production",
      mintFeatureEnabled: true,
      chainId: 1n,
      chainName: "Ethereum",
      deploymentBlock: 22_345_678n,
      eip712Name: "signatures.gallery",
      eip712Version: "2",
      collectionName: "Gallery of Signatures",
      collectionSymbol: "SIGN",
      authorizationTtlSeconds: 900,
      maxAuthorizationWindowSeconds: 1_800,
      currentAuthorizerEpoch: 7,
      indexerPollIntervalMs: 12_000,
      indexerReorgOverlapBlocks: 24,
      indexerMaxLagBlocks: 12,
      nftMetadataVersion: "sg-nft-metadata-1.0.0",
      ipfsImportProfile: "sg-ipfs-unixfs-1.0.0",
      walletBindingTtlSeconds: 600,
      walletSupportMode: "eoa_only",
      finalityPolicy: "ethereum_finalized_tag_v1",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each(allFields)("requires %s, including during a disabled rollout validation", (field) => {
    const env = productionEnv();
    env.MINT_FEATURE_ENABLED = "false";
    delete env[field];
    expectConfigFailure(env, field, "MISSING");
  });

  it.each([
    ["MINT_CHAIN_ID", "11155111"],
    ["MINT_CHAIN_NAME", "ethereum"],
    ["MINT_GENESIS_HASH", `0x${"1".repeat(64)}`],
    ["MINT_EIP712_NAME", "Signatures.gallery"],
    ["MINT_EIP712_VERSION", "3"],
    ["MINT_AUTHORIZATION_TTL_SECONDS", "899"],
    ["MINT_MAX_AUTH_WINDOW_SECONDS", "1801"],
    ["RPC_HISTORICAL_STATE_REQUIRED", "false"],
    ["NFT_METADATA_VERSION", "sg-nft-metadata-2.0.0"],
    ["IPFS_IMPORT_PROFILE", "default"],
    ["WALLET_BINDING_TTL_SECONDS", "601"],
    ["WALLET_SUPPORT_MODE", "smart_wallets"],
  ] as const)("rejects a non-frozen %s", (field, value) => {
    const env = productionEnv();
    env[field] = value;
    expectConfigFailure(env, field, "WRONG_CONSTANT");
  });

  it.each([
    "MINT_DEPLOYMENT_BLOCK",
    "MINT_CURRENT_AUTHORIZER_EPOCH",
    "INDEXER_POLL_INTERVAL",
    "INDEXER_REORG_OVERLAP",
    "INDEXER_MAX_LAG",
    "CONTENT_WRITE_LEASE_SECONDS",
    "CONTENT_DELETE_GRACE_SECONDS",
    "PUBLICATION_LEASE_SECONDS",
  ] as const)("requires a positive bounded integer for %s", (field) => {
    const env = productionEnv();
    env[field] = "0";
    expectConfigFailure(env, field, "INVALID_INTEGER");
  });

  it("requires canonical nonzero hashes and verifies the exact collection URI hash", () => {
    for (const field of [
      "MINT_GENESIS_HASH",
      "MINT_DEPLOYMENT_BLOCK_HASH",
      "MINT_RUNTIME_CODE_HASH",
      "MINT_COLLECTION_METADATA_SHA256",
      "MINT_COLLECTION_URI_HASH",
    ] as const) {
      const env = productionEnv();
      env[field] = `0x${"0".repeat(64)}`;
      expectConfigFailure(env, field, "ZERO_HASH");
    }

    const uppercase = productionEnv();
    uppercase.MINT_RUNTIME_CODE_HASH = `0x${"A".repeat(64)}`;
    expectConfigFailure(uppercase, "MINT_RUNTIME_CODE_HASH", "INVALID_HASH");

    const mismatch = productionEnv();
    mismatch.MINT_COLLECTION_URI_HASH = `0x${"5".repeat(64)}`;
    expectConfigFailure(mismatch, "MINT_COLLECTION_URI_HASH", "URI_HASH_MISMATCH");
  });

  it("rejects zero/bad addresses, noncanonical URLs, invalid CIDs, and duplicate providers", () => {
    const zeroAddress = productionEnv();
    zeroAddress.MINT_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000";
    expectConfigFailure(zeroAddress, "MINT_CONTRACT_ADDRESS", "ZERO_ADDRESS");

    const trailingOrigin = productionEnv();
    trailingOrigin.PUBLIC_ARTIFACT_ORIGIN = "https://signatures.gallery/";
    expectConfigFailure(trailingOrigin, "PUBLIC_ARTIFACT_ORIGIN", "INVALID_URI");

    const insecureGateway = productionEnv();
    insecureGateway.IPFS_VERIFICATION_GATEWAY = "http://gateway.example/ipfs";
    expectConfigFailure(insecureGateway, "IPFS_VERIFICATION_GATEWAY", "INVALID_URI");

    const invalidCid = productionEnv();
    invalidCid.MINT_COLLECTION_URI = "ipfs://QmYwAPJzv5CZsnAzt8auVZRnGmTQfL7wJtP1xFmqw3cvdL";
    expectConfigFailure(invalidCid, "MINT_COLLECTION_URI", "INVALID_URI");

    const duplicateRpc = productionEnv();
    duplicateRpc.SECONDARY_RPC_URL = duplicateRpc.PRIMARY_RPC_URL;
    expectConfigFailure(duplicateRpc, "SECONDARY_RPC_URL", "DUPLICATE_PROVIDER");

    const duplicatePin = productionEnv();
    duplicatePin.IPFS_SECONDARY_PIN_CONFIG = duplicatePin.IPFS_PRIMARY_PIN_CONFIG;
    expectConfigFailure(duplicatePin, "IPFS_SECONDARY_PIN_CONFIG", "DUPLICATE_PROVIDER");
  });

  it("requires deletion grace to outlive the maximum content writer lease", () => {
    const env = productionEnv();
    env.CONTENT_DELETE_GRACE_SECONDS = env.CONTENT_WRITE_LEASE_SECONDS;
    expectConfigFailure(env, "CONTENT_DELETE_GRACE_SECONDS", "UNSAFE_RELATIONSHIP");
  });

  it("supports the exact Sepolia staging identity without weakening production", () => {
    const env = productionEnv();
    env.MINT_CHAIN_ID = "11155111";
    env.MINT_CHAIN_NAME = "Sepolia";
    env.MINT_GENESIS_HASH = "0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9";
    env.RPC_HISTORICAL_STATE_REQUIRED = "false";
    const config = parseMintOperationsConfig(env, "staging");
    expect(config).toMatchObject({ deploymentEnvironment: "staging", chainId: 11_155_111n });
  });

  it("produces a redacted startup summary with no RPC, pin, or signer identifiers", () => {
    const env = productionEnv();
    const summary = safeMintOperationsConfigSummary(parseMintOperationsConfig(env));
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("primary-secret");
    expect(serialized).not.toContain("secondary-secret");
    expect(serialized).not.toContain("pins/primary-sensitive");
    expect(serialized).not.toContain("gallery-production-sensitive");
    expect(summary).toMatchObject({
      primaryRpcConfigured: true,
      secondaryRpcConfigured: true,
      primaryPinConfigured: true,
      secondaryPinConfigured: true,
      signerKeyConfigured: true,
    });
  });
});

describe("safe telemetry allow-lists", () => {
  it("contains only fixed Prometheus/event-safe names", () => {
    for (const name of Object.values(MINT_OPERATION_METRICS)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(isMintOperationMetricName(name)).toBe(true);
    }
    for (const name of Object.values(MINT_CRITICAL_ALERTS)) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(isMintCriticalAlertName(name)).toBe(true);
    }
    expect(isMintOperationMetricName("sg_v2_rpc?token=secret")).toBe(false);
    expect(isMintCriticalAlertName("private_key_leaked")).toBe(false);
  });
});
