import { describe, expect, it } from "vitest";
import { MemoryMintStore } from "./memoryStore.js";
import type { MintAuthorizationRecord, WalletBinding } from "./model.js";

const wallet = "0x1111111111111111111111111111111111111111" as const;
const bindingId = `0x${"22".repeat(32)}` as const;
const authorizationId = `0x${"33".repeat(32)}` as const;
const digest = `0x${"44".repeat(32)}` as const;
const txHash = `0x${"55".repeat(32)}` as const;

function binding(): WalletBinding {
  return {
    walletBindingId: bindingId,
    xUserId: "1234567890123456789",
    publicAccountId: "xa1_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    chainId: 11155111n,
    address: wallet,
    siweMessage: "fixture",
    walletProof: `0x${"66".repeat(65)}`,
    verificationScheme: "fixture_seed",
    verificationBlockNumber: 1n,
    verificationBlockHash: `0x${"77".repeat(32)}`,
    provedAt: new Date("2026-09-04T10:00:00.000Z"),
    status: "active",
    version: 1,
  };
}

function authorization(signatureId = "sg1_fixture"): MintAuthorizationRecord {
  return {
    authorizationId,
    signatureId,
    signatureDigest: digest,
    walletBindingId: bindingId,
    mintWallet: wallet,
    svgSha256: digest,
    pngSha256: digest,
    metadataSha256: digest,
    tokenUriHash: digest,
    validAfter: 1_788_516_000n,
    deadline: 1_788_516_900n,
    authorizerEpoch: 1,
    tokenUri: "ipfs://bafymetadata",
    authorizer: wallet,
    galleryAttestation: null,
    typedDataDigest: digest,
    status: "prepared",
    createdAt: new Date("2026-09-04T10:00:00.000Z"),
  };
}

describe("MemoryMintStore authority boundaries", () => {
  it("replaces the local snapshot without aliasing state or retaining stale entries", () => {
    const store = new MemoryMintStore();
    store.seedBinding(binding());
    store.suppress("stale");
    const next = new MemoryMintStore();
    next.suppress("current");
    const snapshot = next.exportSnapshot();
    store.replaceSnapshot(snapshot);
    snapshot.suppressions.push("later");
    expect(store.getActiveBinding(binding().xUserId, 11155111n)).toBeNull();
    expect(store.isSuppressed("stale")).toBe(false);
    expect(store.isSuppressed("current")).toBe(true);
    expect(store.isSuppressed("later")).toBe(false);
  });
  it("does not create submitted or Gallery state from a browser transaction hint", () => {
    const store = new MemoryMintStore();
    store.seedBinding(binding());
    store.putPreparedAuthorization(authorization(), new Date("2026-09-04T10:00:00.000Z"));
    store.issueAuthorization(authorizationId, `0x${"88".repeat(65)}`);
    store.reportAttempt({ authorizationId, txHash, state: "reported", reportedAt: new Date() });

    expect(store.getProjection("sg1_fixture").state).toBe("authorized");
    expect(store.listGallery()).toEqual([]);
  });

  it("publishes only after an included observation is explicitly finalized", () => {
    const store = new MemoryMintStore();
    store.seedBinding(binding());
    store.putPreparedAuthorization(authorization(), new Date("2026-09-04T10:00:00.000Z"));
    store.issueAuthorization(authorizationId, `0x${"88".repeat(65)}`);
    store.observeIncluded({
      signatureId: "sg1_fixture",
      authorizationId,
      txHash,
      contract: "0x9999999999999999999999999999999999999999",
      chainId: 11155111n,
      tokenId: 1n,
      mintWallet: wallet,
      blockNumber: 100n,
      transactionIndex: 2,
      logIndex: 3,
    });
    expect(store.listGallery()).toEqual([]);

    store.finalizeMint("sg1_fixture", new Date("2026-09-04T10:15:00.000Z"), "Fixture finalized checkpoint");
    expect(store.listGallery()).toHaveLength(1);
    expect(store.getProjection("sg1_fixture").state).toBe("finalized");
  });

  it("never regresses a chain observation when signing completes late", () => {
    const store = new MemoryMintStore();
    store.seedBinding(binding());
    store.putPreparedAuthorization(authorization(), new Date("2026-09-04T10:00:00.000Z"));
    store.observeIncluded({
      signatureId: "sg1_fixture",
      authorizationId,
      txHash,
      contract: "0x9999999999999999999999999999999999999999",
      chainId: 11155111n,
      tokenId: 1n,
      mintWallet: wallet,
      blockNumber: 100n,
      transactionIndex: 2,
      logIndex: 3,
    });

    store.issueAuthorization(authorizationId, `0x${"88".repeat(65)}`);

    expect(store.getProjection("sg1_fixture")).toMatchObject({
      state: "included_unfinalized",
      blockNumber: 100n,
      txHash,
    });
    expect(store.getAuthorization(authorizationId)).toMatchObject({ status: "issued" });
  });

  it("keeps claimant-era mint wallet separate from the transferable holder projection", () => {
    const store = new MemoryMintStore();
    store.seedBinding(binding());
    store.putPreparedAuthorization(authorization(), new Date("2026-09-04T10:00:00.000Z"));
    store.issueAuthorization(authorizationId, `0x${"88".repeat(65)}`);
    store.observeIncluded({
      signatureId: "sg1_fixture",
      authorizationId,
      txHash,
      contract: "0x9999999999999999999999999999999999999999",
      chainId: 11155111n,
      tokenId: 1n,
      mintWallet: wallet,
      blockNumber: 100n,
      transactionIndex: 2,
      logIndex: 3,
    });
    store.finalizeMint("sg1_fixture", new Date(), "Fixture finalized checkpoint");
    store.updateFinalizedHolder("sg1_fixture", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const entry = store.listGallery()[0];
    expect(entry.mintWallet).toBe(wallet);
    expect(entry.currentTokenHolder).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
