import { describe, expect, it } from "vitest";
import { keccak256, stringToHex } from "viem";
import { parseMintOperationsConfig, type MintOperationsConfig } from "./config.js";
import {
  evaluateMintStartupHealth,
  type MintStartupBlockerCode,
  type MintStartupObservations,
} from "./startupHealth.js";
import { MINT_CRITICAL_ALERTS, MINT_OPERATION_METRICS } from "./telemetry.js";

const collectionCid = "bafkreihnf7ql73vs7sechq6ytdexfymrh75m3d6zb4wepj4ubjqq32rr4e";
const collectionUri = `ipfs://${collectionCid}`;
const deploymentHash = `0x${"2".repeat(64)}` as const;
const runtimeHash = `0x${"3".repeat(64)}` as const;
const metadataHash = `0x${"4".repeat(64)}` as const;
const promotionHash = `0x${"5".repeat(64)}` as const;
const checkpointHash = `0x${"6".repeat(64)}` as const;

function config(featureEnabled = true): MintOperationsConfig {
  return parseMintOperationsConfig({
    MINT_FEATURE_ENABLED: String(featureEnabled),
    MINT_CHAIN_ID: "1",
    MINT_CHAIN_NAME: "Ethereum",
    MINT_GENESIS_HASH: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
    MINT_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
    MINT_DEPLOYMENT_BLOCK: "80",
    MINT_DEPLOYMENT_BLOCK_HASH: deploymentHash,
    MINT_RUNTIME_CODE_HASH: runtimeHash,
    MINT_ABI_VERSION: "sg-gallery-abi-1.0.0",
    MINT_EIP712_NAME: "signatures.gallery",
    MINT_EIP712_VERSION: "2",
    MINT_AUTHORIZATION_TTL_SECONDS: "900",
    MINT_MAX_AUTH_WINDOW_SECONDS: "1800",
    MINT_CURRENT_AUTHORIZER_EPOCH: "7",
    MINT_CURRENT_AUTHORIZER_ADDRESS: "0x2222222222222222222222222222222222222222",
    MINT_COLLECTION_URI: collectionUri,
    MINT_COLLECTION_METADATA_SHA256: metadataHash,
    MINT_COLLECTION_URI_HASH: keccak256(stringToHex(collectionUri)),
    PUBLIC_ARTIFACT_ORIGIN: "https://signatures.gallery",
    PRIMARY_RPC_URL: "https://primary.example/rpc?credential=do-not-log-a",
    SECONDARY_RPC_URL: "https://secondary.example/rpc?credential=do-not-log-b",
    RPC_HISTORICAL_STATE_REQUIRED: "true",
    INDEXER_POLL_INTERVAL: "12000",
    INDEXER_REORG_OVERLAP: "24",
    INDEXER_MAX_LAG: "12",
    IPFS_PRIMARY_PIN_CONFIG: "secret://primary-pin",
    IPFS_SECONDARY_PIN_CONFIG: "secret://secondary-pin",
    IPFS_VERIFICATION_GATEWAY: "https://gateway.example/ipfs",
    NFT_METADATA_VERSION: "sg-nft-metadata-1.0.0",
    IPFS_IMPORT_PROFILE: "sg-ipfs-unixfs-1.0.0",
    CONTENT_WRITE_LEASE_SECONDS: "120",
    CONTENT_DELETE_GRACE_SECONDS: "86400",
    PUBLICATION_LEASE_SECONDS: "120",
    GALLERY_SIGNER_PROVIDER: "kms",
    GALLERY_SIGNER_KEY_ID: "secret-key-reference",
    GALLERY_SIGNER_AUDIT_MODE: "strict",
    WALLET_BINDING_TTL_SECONDS: "600",
    WALLET_SUPPORT_MODE: "eoa_only",
  });
}

function healthyObservations(): MintStartupObservations {
  return {
    primaryRpc: {
      healthy: true,
      chainId: 1n,
      genesisHash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
      latestHeight: 105n,
      safeHeight: 102n,
      finalizedHeight: 100n,
      historicalStateAvailable: true,
    },
    secondaryRpc: {
      healthy: true,
      chainId: 1n,
      genesisHash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
      latestHeight: 103n,
      safeHeight: 101n,
      finalizedHeight: 99n,
      historicalStateAvailable: true,
    },
    sharedFinality: {
      promotionHeight: 99n,
      primaryBlockHash: promotionHash,
      secondaryBlockHash: promotionHash,
    },
    indexer: {
      scannedHeight: 105n,
      promotedFinalizedHeight: 99n,
      storedCheckpointHash: checkpointHash,
      primaryCheckpointHash: checkpointHash,
      secondaryCheckpointHash: checkpointHash,
      contiguousThroughPromotion: true,
      safetyHalted: false,
    },
    contract: {
      address: "0x1111111111111111111111111111111111111111",
      codePresent: true,
      runtimeCodeHash: runtimeHash,
      deploymentBlockHash: deploymentHash,
      abiVersion: "sg-gallery-abi-1.0.0",
      name: "Gallery of Signatures",
      symbol: "SIGN",
      eip712Domain: {
        name: "signatures.gallery",
        version: "2",
        chainId: 1n,
        verifyingContract: "0x1111111111111111111111111111111111111111",
      },
      contractUri: collectionUri,
      collectionMetadataSha256: metadataHash,
      collectionUriHash: keccak256(stringToHex(collectionUri)),
      mintPaused: false,
      currentAuthorizerEpoch: 7,
      currentAuthorizerAddress: "0x2222222222222222222222222222222222222222",
      currentAuthorizerEpochRevoked: false,
      expectedRoleAssignmentsHealthy: true,
      roleSeparationHealthy: true,
    },
    pins: {
      primaryProviderHealthy: true,
      secondaryProviderHealthy: true,
      verificationGatewayHealthy: true,
      crossProviderBytesVerified: true,
    },
    signer: {
      serviceHealthy: true,
      attestationReturned: true,
      canonicalSignatureReturned: true,
      attestationVerifiedLocally: true,
      recoveredAuthorizerAddress: "0x2222222222222222222222222222222222222222",
      digestPrehashedModeVerified: true,
      auditHealthy: true,
    },
  };
}

function codes(decision: ReturnType<typeof evaluateMintStartupHealth>): MintStartupBlockerCode[] {
  return decision.blockers.map(({ code }) => code);
}

describe("fail-closed mint startup health", () => {
  it("allows issuance only after every exact commitment and health check passes", () => {
    const decision = evaluateMintStartupHealth(config(), healthyObservations());
    expect(decision).toEqual({
      status: "ready",
      canIssueNewAuthorizations: true,
      v1ReadsRemainAvailable: true,
      indexerLagBlocks: 0n,
      blockers: [],
      criticalAlerts: [],
      metricNames: [
        MINT_OPERATION_METRICS.startupIssuanceReady,
        MINT_OPERATION_METRICS.rpcLatestHeight,
        MINT_OPERATION_METRICS.rpcSafeHeight,
        MINT_OPERATION_METRICS.rpcFinalizedHeight,
        MINT_OPERATION_METRICS.indexerLagBlocks,
      ],
    });
  });

  it("uses the lower provider-finalized head and does not mistake provider lag for disagreement", () => {
    const observations = healthyObservations();
    observations.primaryRpc.finalizedHeight = 104n;
    observations.primaryRpc.safeHeight = 104n;
    observations.sharedFinality.promotionHeight = 99n;
    expect(evaluateMintStartupHealth(config(), observations).status).toBe("ready");
  });

  it("keeps V1 reads available when the feature flag is disabled", () => {
    const decision = evaluateMintStartupHealth(config(false), healthyObservations());
    expect(decision.status).toBe("disabled");
    expect(decision.canIssueNewAuthorizations).toBe(false);
    expect(decision.v1ReadsRemainAvailable).toBe(true);
    expect(codes(decision)).toEqual(["FEATURE_DISABLED"]);
  });

  it("treats the configured lag as a strict upper threshold", () => {
    const observations = healthyObservations();
    observations.indexer.scannedHeight = 93n;
    observations.indexer.promotedFinalizedHeight = 90n;
    const decision = evaluateMintStartupHealth(config(), observations);
    expect(decision.indexerLagBlocks).toBe(12n);
    expect(codes(decision)).toContain("INDEXER_LAG_EXCEEDED");
    expect(decision.canIssueNewAuthorizations).toBe(false);
  });

  it.each([
    ["PRIMARY_RPC_UNHEALTHY", (o: MintStartupObservations) => { o.primaryRpc.healthy = false; }],
    ["SECONDARY_RPC_UNHEALTHY", (o: MintStartupObservations) => { o.secondaryRpc.healthy = false; }],
    ["CHAIN_ID_MISMATCH", (o: MintStartupObservations) => { o.secondaryRpc.chainId = 11_155_111n; }],
    ["GENESIS_HASH_MISMATCH", (o: MintStartupObservations) => { o.primaryRpc.genesisHash = `0x${"9".repeat(64)}`; }],
    ["RPC_HEAD_ORDER_INVALID", (o: MintStartupObservations) => { o.primaryRpc.safeHeight = 99n; }],
    ["HISTORICAL_STATE_UNAVAILABLE", (o: MintStartupObservations) => { o.secondaryRpc.historicalStateAvailable = false; }],
    ["CONTRACT_ADDRESS_MISMATCH", (o: MintStartupObservations) => { o.contract.address = "0x3333333333333333333333333333333333333333"; }],
    ["CONTRACT_CODE_MISSING", (o: MintStartupObservations) => { o.contract.codePresent = false; }],
    ["DEPLOYMENT_BLOCK_HASH_MISMATCH", (o: MintStartupObservations) => { o.contract.deploymentBlockHash = `0x${"9".repeat(64)}`; }],
    ["ABI_VERSION_MISMATCH", (o: MintStartupObservations) => { o.contract.abiVersion = "wrong"; }],
    ["COLLECTION_NAME_MISMATCH", (o: MintStartupObservations) => { o.contract.name = "Wrong"; }],
    ["COLLECTION_SYMBOL_MISMATCH", (o: MintStartupObservations) => { o.contract.symbol = "NO"; }],
    ["COLLECTION_URI_MISMATCH", (o: MintStartupObservations) => { o.contract.contractUri = `${collectionUri}x`; }],
    ["COLLECTION_METADATA_HASH_MISMATCH", (o: MintStartupObservations) => { o.contract.collectionMetadataSha256 = `0x${"9".repeat(64)}`; }],
    ["COLLECTION_URI_HASH_MISMATCH", (o: MintStartupObservations) => { o.contract.collectionUriHash = `0x${"9".repeat(64)}`; }],
    ["MINT_PAUSED", (o: MintStartupObservations) => { o.contract.mintPaused = true; }],
    ["AUTHORIZER_EPOCH_MISMATCH", (o: MintStartupObservations) => { o.contract.currentAuthorizerEpoch = 8; }],
    ["AUTHORIZER_ADDRESS_MISMATCH", (o: MintStartupObservations) => { o.contract.currentAuthorizerAddress = "0x3333333333333333333333333333333333333333"; }],
    ["AUTHORIZER_EPOCH_REVOKED", (o: MintStartupObservations) => { o.contract.currentAuthorizerEpochRevoked = true; }],
    ["ROLE_ASSIGNMENT_UNSAFE", (o: MintStartupObservations) => { o.contract.expectedRoleAssignmentsHealthy = false; }],
    ["ROLE_SEPARATION_UNSAFE", (o: MintStartupObservations) => { o.contract.roleSeparationHealthy = false; }],
    ["INDEXER_NONCONTIGUOUS", (o: MintStartupObservations) => { o.indexer.contiguousThroughPromotion = false; }],
    ["INDEXER_SAFETY_HALTED", (o: MintStartupObservations) => { o.indexer.safetyHalted = true; }],
    ["PRIMARY_PIN_UNHEALTHY", (o: MintStartupObservations) => { o.pins.primaryProviderHealthy = false; }],
    ["SECONDARY_PIN_UNHEALTHY", (o: MintStartupObservations) => { o.pins.secondaryProviderHealthy = false; }],
    ["VERIFICATION_GATEWAY_UNHEALTHY", (o: MintStartupObservations) => { o.pins.verificationGatewayHealthy = false; }],
    ["PIN_INTEGRITY_UNVERIFIED", (o: MintStartupObservations) => { o.pins.crossProviderBytesVerified = false; }],
    ["SIGNER_UNHEALTHY", (o: MintStartupObservations) => { o.signer.serviceHealthy = false; }],
    ["SIGNER_SELF_TEST_MISSING", (o: MintStartupObservations) => { o.signer.attestationReturned = false; }],
    ["SIGNER_SIGNATURE_NONCANONICAL", (o: MintStartupObservations) => { o.signer.canonicalSignatureReturned = false; }],
    ["SIGNER_ATTESTATION_INVALID", (o: MintStartupObservations) => { o.signer.attestationVerifiedLocally = false; }],
    ["SIGNER_ADDRESS_MISMATCH", (o: MintStartupObservations) => { o.signer.recoveredAuthorizerAddress = "not-an-address-secret"; }],
    ["SIGNER_DIGEST_MODE_UNVERIFIED", (o: MintStartupObservations) => { o.signer.digestPrehashedModeVerified = false; }],
    ["SIGNER_AUDIT_UNHEALTHY", (o: MintStartupObservations) => { o.signer.auditHealthy = false; }],
  ] satisfies ReadonlyArray<readonly [MintStartupBlockerCode, (observations: MintStartupObservations) => void]>)
  ("blocks issuance on %s", (expectedCode, mutate) => {
    const observations = healthyObservations();
    mutate(observations);
    const decision = evaluateMintStartupHealth(config(), observations);
    expect(decision.status).toBe("blocked");
    expect(decision.canIssueNewAuthorizations).toBe(false);
    expect(decision.v1ReadsRemainAvailable).toBe(true);
    expect(codes(decision)).toContain(expectedCode);
  });

  it("raises the exact critical event names for bytecode, domain, role, finality, and pin failures", () => {
    const observations = healthyObservations();
    observations.contract.runtimeCodeHash = `0x${"9".repeat(64)}`;
    observations.contract.eip712Domain.version = "unexpected-domain-secret";
    observations.contract.currentAuthorizerEpoch = 8;
    observations.sharedFinality.secondaryBlockHash = `0x${"8".repeat(64)}`;
    observations.pins.secondaryProviderHealthy = false;
    const decision = evaluateMintStartupHealth(config(), observations);
    expect(decision.criticalAlerts).toEqual(expect.arrayContaining([
      MINT_CRITICAL_ALERTS.unexpectedRuntimeCode,
      MINT_CRITICAL_ALERTS.unexpectedEip712Domain,
      MINT_CRITICAL_ALERTS.roleChangeOutsideRunbook,
      MINT_CRITICAL_ALERTS.finalizedCheckpointMismatch,
      MINT_CRITICAL_ALERTS.ipfsPinLossAcrossProviders,
    ]));
    expect(decision.metricNames).toContain(MINT_OPERATION_METRICS.finalizedHashDisagreements);
    expect(JSON.stringify(decision, (_key, value) => typeof value === "bigint" ? value.toString(10) : value))
      .not.toContain("unexpected-domain-secret");
  });

  it("validates the stored finalized checkpoint independently through both RPCs", () => {
    const observations = healthyObservations();
    observations.indexer.secondaryCheckpointHash = `0x${"7".repeat(64)}`;
    const decision = evaluateMintStartupHealth(config(), observations);
    expect(codes(decision)).toContain("INDEXER_CHECKPOINT_MISMATCH");
    expect(decision.criticalAlerts).toContain(MINT_CRITICAL_ALERTS.finalizedCheckpointMismatch);
  });
});
