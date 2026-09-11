import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState, type BrowserSession } from "../v1/authState.js";
import { fixtureIdentity, seedDevelopmentFixtures } from "../v1/fixtures.js";
import { CARD_RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore, type Signature, type XAccount } from "../v1/store.js";
import { loadMintConfig, type MintConfig } from "./config.js";
import { MemoryMintStore } from "./memoryStore.js";
import { V2MintService, type EoaVerification, type EoaVerifier, type GallerySigner } from "./service.js";

const GALLERY_AUTHORIZER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const WALLET_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const now = new Date("2026-09-04T12:00:00.000Z");

const PRODUCTION_ENV = {
  MINT_FEATURE_ENABLED: "true",
  APP_ORIGIN: "https://signatures.gallery",
  MINT_CHAIN_ID: "11155111",
  MINT_CHAIN_NAME: "Sepolia",
  MINT_CONTRACT_ADDRESS: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  MINT_AUTHORIZATION_TTL_SECONDS: "900",
  MINT_MAX_AUTH_WINDOW_SECONDS: "1800",
  MINT_CURRENT_AUTHORIZER_EPOCH: "1",
  MINT_CURRENT_AUTHORIZER_ADDRESS: GALLERY_AUTHORIZER,
  MINT_GENESIS_HASH: `0x${"11".repeat(32)}`,
  MINT_RUNTIME_CODE_HASH: `0x${"22".repeat(32)}`,
  PUBLIC_ARTIFACT_ORIGIN: "https://signatures.gallery",
  PRIMARY_RPC_URL: "https://primary.example",
  SECONDARY_RPC_URL: "https://secondary.example",
};

const verifier = (): EoaVerifier => ({
  async verify(): Promise<EoaVerification> {
    return { blockNumber: 1n, blockHash: `0x${"33".repeat(32)}` as Hex };
  },
});
const signer = (address: string = GALLERY_AUTHORIZER): GallerySigner => ({
  address: getAddress(address) as Address,
  async sign() { return `0x${"44".repeat(65)}` as Hex; },
});

async function fixtures() {
  const signatures = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const renderers = new RendererRegistry([formalSignatureRenderer]);
  await seedDevelopmentFixtures({ store: signatures, artifacts, renderers, cardRendererVersion: CARD_RENDERER_VERSION }, auth);
  const account = (await signatures.getAccount("1234567890123456789"))!;
  const signature = (await signatures.listSignaturesForAccount(account.xUserId))[0]!;
  const session = auth.getOrCreateSession(null, now).session;
  session.identity = fixtureIdentity("alice", now);
  return { signatures, artifacts, auth, account, signature, session };
}

const serviceFor = (
  config: MintConfig,
  parts: Awaited<ReturnType<typeof fixtures>>,
  adapters: { eoaVerifier?: EoaVerifier; signer?: GallerySigner } = {},
) => new V2MintService(config, new MemoryMintStore(), parts.signatures, parts.artifacts, adapters);

describe("mint service adapter contract", () => {
  it("refuses to construct a production service without explicit RPC and signer adapters", async () => {
    const parts = await fixtures();
    const config = loadMintConfig(PRODUCTION_ENV, false, "https://signatures.gallery");
    expect(() => serviceFor(config, parts)).toThrow(/explicit RPC and protected signer adapters/);
    expect(() => serviceFor(config, parts, { eoaVerifier: verifier() })).toThrow(/explicit RPC and protected signer adapters/);
    expect(() => serviceFor(config, parts, { signer: signer() })).toThrow(/explicit RPC and protected signer adapters/);
    expect(() => serviceFor(config, parts, { eoaVerifier: verifier(), signer: signer() })).not.toThrow();
  });

  it("refuses a signing adapter whose address is not the configured authorizer", async () => {
    const parts = await fixtures();
    const config = loadMintConfig(PRODUCTION_ENV, false, "https://signatures.gallery");
    expect(() => serviceFor(config, parts, { eoaVerifier: verifier(), signer: signer(OTHER_ADDRESS) }))
      .toThrow(/authorizer does not match the signing adapter/);
    // Checksum spelling alone must not read as a different authorizer.
    expect(() => serviceFor(config, parts, { eoaVerifier: verifier(), signer: signer(GALLERY_AUTHORIZER.toLowerCase()) })).not.toThrow();
  });

  it("refuses a local chain rehearsal without its explicit chain adapters", async () => {
    const parts = await fixtures();
    // A rehearsal config that is otherwise valid, so the adapter check is the
    // one that has to refuse it.
    const config: MintConfig = {
      ...loadMintConfig({}, true, "http://127.0.0.1:3000"),
      fixtureMode: false,
      localChainRehearsal: true,
      chainId: 31337n,
      explorerBaseUrl: null,
      primaryRpcUrl: "http://127.0.0.1:18545",
      secondaryRpcUrl: "http://127.0.0.1:18545",
      genesisHash: `0x${"11".repeat(32)}`,
      runtimeCodeHash: `0x${"22".repeat(32)}`,
    };
    expect(() => serviceFor(config, parts, { eoaVerifier: verifier(), signer: signer() }))
      .toThrow(/explicit RPC, signer, chain clock, and durable checkpoint adapters/);
  });

  it("supplies paused adapters when minting is disabled, so nothing can verify or sign", async () => {
    const parts = await fixtures();
    const config = loadMintConfig({ MINT_FEATURE_ENABLED: "false" }, false, "https://signatures.gallery");
    const service = serviceFor(config, parts);
    // Freezing a preview reads only stored artifacts, so it stays available;
    // everything that could bind a wallet or sign must refuse.
    await expect(service.previewMetadata(parts.signature, parts.account)).resolves.toBeTruthy();
    await expect(service.createChallenge({
      session: parts.session, account: parts.account, walletAddress: OTHER_ADDRESS, chainId: "11155111", now,
    })).rejects.toMatchObject({ status: 503, code: "MINT_PAUSED" });
    expect(() => service.revokeBinding(parts.account.xUserId, now)).toThrow(/Minting is disabled/);
  });
});

describe("mint challenge input boundaries", () => {
  const start = async (overrides: { walletAddress?: string; chainId?: string } = {}) => {
    const parts = await fixtures();
    const config = loadMintConfig({}, true, "http://localhost:3000");
    const service = serviceFor(config, parts);
    return service.createChallenge({
      session: parts.session, account: parts.account,
      walletAddress: overrides.walletAddress ?? privateKeyToAccount(WALLET_KEY).address,
      chainId: overrides.chainId ?? config.chainId.toString(),
      now,
    });
  };

  it("names the configured network when the wallet offers another chain", async () => {
    await expect(start({ chainId: "1" })).rejects.toMatchObject({ status: 400, code: "WRONG_CHAIN" });
    await expect(start({ chainId: "11155111 " })).rejects.toMatchObject({ code: "WRONG_CHAIN" });
  });

  it("requires one exact 20-byte address before issuing any challenge", async () => {
    for (const walletAddress of ["", "0x", "not-an-address", `0x${"ab".repeat(19)}`, `0x${"ab".repeat(21)}`]) {
      await expect(start({ walletAddress })).rejects.toMatchObject({ status: 400, code: "INVALID_WALLET_ADDRESS" });
    }
  });

  it("refuses a session whose identity is not the account being linked", async () => {
    const parts = await fixtures();
    const config = loadMintConfig({}, true, "http://localhost:3000");
    const service = serviceFor(config, parts);
    const foreign: XAccount = { ...parts.account, xUserId: "9999999999999999999" };
    await expect(service.createChallenge({
      session: parts.session, account: foreign,
      walletAddress: privateKeyToAccount(WALLET_KEY).address,
      chainId: config.chainId.toString(), now,
    })).rejects.toMatchObject({ status: 403 });
  });
});

describe("wallet revocation boundaries", () => {
  it("requires a signed-in session outside fixture mode", async () => {
    const parts = await fixtures();
    const config = loadMintConfig(PRODUCTION_ENV, false, "https://signatures.gallery");
    const service = serviceFor(config, parts, { eoaVerifier: verifier(), signer: signer() });
    expect(() => service.revokeBinding(parts.account.xUserId, now))
      .toThrow(expect.objectContaining({ status: 401, code: "AUTH_REQUIRED" }));
  });

  it("reports that there is nothing to revoke rather than consuming an approval", async () => {
    const parts = await fixtures();
    const config = loadMintConfig({}, true, "http://localhost:3000");
    const service = serviceFor(config, parts);
    expect(() => service.revokeBinding(parts.account.xUserId, now, parts.session))
      .toThrow(expect.objectContaining({ status: 403, code: "WALLET_NOT_LINKED" }));
  });
});

describe("frozen metadata preview", () => {
  it("reports unavailable artwork rather than freezing metadata around it", async () => {
    const parts = await fixtures();
    const config = loadMintConfig({}, true, "http://localhost:3000");
    const service = serviceFor(config, parts);
    const missing: Signature = { ...parts.signature, svgStorageKey: "sha256/absent.svg" };
    await expect(service.previewMetadata(missing, parts.account))
      .rejects.toMatchObject({ status: 422, code: "ARTIFACT_INTEGRITY_ERROR" });
    const missingCard: Signature = { ...parts.signature, cardStorageKey: "sha256/absent.png" };
    await expect(service.previewMetadata(missingCard, parts.account))
      .rejects.toMatchObject({ status: 422, code: "ARTIFACT_INTEGRITY_ERROR" });
  });

  it("reports artwork that no longer matches its frozen hashes", async () => {
    const parts = await fixtures();
    const config = loadMintConfig({}, true, "http://localhost:3000");
    const service = serviceFor(config, parts);
    const tampered: Signature = { ...parts.signature, svgSha256: "f".repeat(64) };
    await expect(service.previewMetadata(tampered, parts.account))
      .rejects.toMatchObject({ status: 422, code: "ARTIFACT_INTEGRITY_ERROR" });
  });

  it("freezes production metadata through the canonical token metadata path", async () => {
    const parts = await fixtures();
    const config = loadMintConfig(PRODUCTION_ENV, false, "https://signatures.gallery");
    const service = serviceFor(config, parts, { eoaVerifier: verifier(), signer: signer() });
    const frozen = await service.previewMetadata(parts.signature, parts.account);

    expect(frozen.metadataVersion).toBe("sg-nft-metadata-1.0.0");
    expect(frozen.importerProfile).toBe("sg-ipfs-unixfs-1.0.0");
    expect(frozen.tokenUri).toBe(`ipfs://${frozen.metadataCid}`);
    expect(frozen.svgSha256).toBe(`0x${parts.signature.svgSha256}`);
    expect(frozen.pngSha256).toBe(`0x${parts.signature.pngSha256}`);
    expect(JSON.parse(frozen.canonicalJson).properties.signature_id).toBe(parts.signature.signatureId);
    // The production document must not carry any rehearsal marker.
    expect(frozen.canonicalJson).not.toContain("rehearsal");
    // Freezing is deterministic: the same claim yields the same commitment.
    const again = await service.previewMetadata(parts.signature, parts.account);
    expect(again.metadataSha256).toBe(frozen.metadataSha256);
    expect(again.canonicalJson).toBe(frozen.canonicalJson);
  });

  it("refuses to mint a claim that predates the frozen production renderer", async () => {
    const parts = await fixtures();
    const config = loadMintConfig(PRODUCTION_ENV, false, "https://signatures.gallery");
    const service = serviceFor(config, parts, { eoaVerifier: verifier(), signer: signer() });
    const legacy: Signature = { ...parts.signature, rendererVersion: "sg-renderer-0.9.0" };
    await expect(service.previewMetadata(legacy, parts.account))
      .rejects.toMatchObject({ status: 409, code: "MINT_INELIGIBLE" });
    const legacyCard: Signature = { ...parts.signature, cardRendererVersion: "sg-card-0.9.0" };
    await expect(service.previewMetadata(legacyCard, parts.account))
      .rejects.toMatchObject({ status: 409, code: "MINT_INELIGIBLE" });
  });

  it("marks local rehearsal metadata as a rehearsal document", async () => {
    const parts = await fixtures();
    const config = loadMintConfig({}, true, "http://localhost:3000");
    const service = serviceFor(config, parts);
    const frozen = await service.previewMetadata(parts.signature, parts.account);
    expect(frozen.canonicalJson).toContain("rehearsal");
  });
});

describe("store failure translation", () => {
  /** The durable store signals conflicts by message; the service must map each
   * one onto its own status rather than leaking a 500. */
  class FailingStore extends MemoryMintStore {
    constructor(private readonly failure: string) { super(); }
    putMetadata(): never { throw new Error(this.failure); }
  }

  const attempt = async (failure: string) => {
    const parts = await fixtures();
    const config = loadMintConfig({}, true, "http://localhost:3000");
    const service = new V2MintService(config, new FailingStore(failure), parts.signatures, parts.artifacts);
    service.seedFixtureBinding(parts.account.xUserId, parts.account.publicAccountId, now);
    return service.issueAuthorization(parts.signature, parts.account, new Date(now.getTime() + 60_000));
  };

  it.each([
    ["METADATA_INTEGRITY_ERROR", 422, "METADATA_INTEGRITY_ERROR"],
    ["ALREADY_MINTED", 409, "ALREADY_MINTED"],
    ["LIVE_AUTHORIZATION_EXISTS", 409, "LIVE_AUTHORIZATION_EXISTS"],
    ["AUTHORIZATION_UNAVAILABLE", 409, "AUTHORIZATION_UNAVAILABLE"],
    ["TRANSACTION_MISMATCH", 422, "TRANSACTION_MISMATCH"],
  ])("maps a %s store conflict onto its own status", async (failure, status, code) => {
    await expect(attempt(failure)).rejects.toMatchObject({ status, code });
  });

  it("re-throws an unrecognized store failure instead of inventing a conflict", async () => {
    await expect(attempt("DISK_ON_FIRE")).rejects.toThrow("DISK_ON_FIRE");
  });
});
