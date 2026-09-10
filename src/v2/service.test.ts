import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState } from "../v1/authState.js";
import { seedDevelopmentFixtures, fixtureIdentity } from "../v1/fixtures.js";
import { DEV_CARD_RENDERER_VERSION, developmentFixtureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { loadMintConfig } from "./config.js";
import { mintAuthorizationTypedData } from "./core/index.js";
import { v2Error } from "./errors.js";
import { MemoryMintStore } from "./memoryStore.js";
import { V2MintService } from "./service.js";

const FIXTURE_WALLET_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const FIXTURE_GALLERY_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const GALLERY_MINT_ABI = parseAbi([
  "function mintAuthorized((bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch) a,string tokenURI_,bytes galleryAttestation) returns (uint256 tokenId)",
]);
const GALLERY_MINT_SELECTOR = "0xf722c561";

async function runtime() {
  const signatures = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const renderers = new RendererRegistry([developmentFixtureRenderer]);
  await seedDevelopmentFixtures({ store: signatures, artifacts, renderers, cardRendererVersion: DEV_CARD_RENDERER_VERSION }, auth);
  const state = new MemoryMintStore();
  const config = loadMintConfig({}, true, "http://localhost:3000");
  const service = new V2MintService(config, state, signatures, artifacts);
  const account = await signatures.getAccount("1234567890123456789");
  if (!account) throw new Error("Fixture account is missing.");
  const signature = (await signatures.listSignaturesForAccount(account.xUserId))[0];
  const session = auth.getOrCreateSession(null, new Date("2026-09-04T12:00:00.000Z")).session;
  session.identity = fixtureIdentity("alice", new Date("2026-09-04T12:00:00.000Z"));
  return { signatures, artifacts, auth, state, config, service, account, signature, session };
}

describe("V2 mint service fixture boundary", () => {
  it("builds and verifies a one-time SIWE binding", async () => {
    const app = await runtime();
    const wallet = privateKeyToAccount(FIXTURE_WALLET_KEY);
    const challenge = await app.service.createChallenge({
      session: app.session,
      account: app.account,
      walletAddress: wallet.address,
      chainId: app.config.chainId.toString(),
      now: new Date("2026-09-04T12:01:00.000Z"),
    });
    const proof = await wallet.signMessage({ message: challenge.message });
    const linked = await app.service.confirmChallenge({
      session: app.session,
      challengeId: challenge.challengeId,
      walletProof: proof,
      now: new Date("2026-09-04T12:02:00.000Z"),
    });
    expect(linked.address).toBe(wallet.address);
    expect(linked.verificationScheme).toBe("eip191_eoa_65byte_low_s");
    await expect(app.service.confirmChallenge({
      session: app.session,
      challengeId: challenge.challengeId,
      walletProof: proof,
      now: new Date("2026-09-04T12:03:00.000Z"),
    }))
      .rejects.toMatchObject({ code: "WALLET_CHALLENGE_INVALID" });
  });

  it("freezes deterministic local metadata before issuing a 900-second authorization", async () => {
    const app = await runtime();
    app.service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId, new Date("2026-09-04T12:00:00.000Z"));
    const firstMetadata = await app.service.previewMetadata(app.signature, app.account);
    const secondMetadata = await app.service.previewMetadata(app.signature, app.account);
    expect(firstMetadata.metadataCid).toBe(secondMetadata.metadataCid);
    expect(firstMetadata.tokenUriHash).toBe(secondMetadata.tokenUriHash);

    const response = await app.service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:05:00.000Z"));
    expect(BigInt(response.authorization.deadline) - BigInt(response.authorization.validAfter)).toBe(900n);
    expect(response.authorization.mintWallet).toBe(app.state.getActiveBinding(app.account.xUserId, app.config.chainId)?.address);
    expect(response.galleryAttestation).toMatch(/^0x[0-9a-f]{130}$/);
    expect(response.fixture).toBe(true);
    expect(response.transaction.to).toBe(app.config.contract);
    expect(response.transaction.data.slice(0, 10)).toBe(GALLERY_MINT_SELECTOR);

    const decoded = decodeFunctionData({ abi: GALLERY_MINT_ABI, data: response.transaction.data });
    expect(decoded.functionName).toBe("mintAuthorized");
    expect(decoded.args).toEqual([
      {
        ...response.authorization,
        validAfter: BigInt(response.authorization.validAfter),
        deadline: BigInt(response.authorization.deadline),
      },
      response.tokenURI,
      response.galleryAttestation,
    ]);
  });

  it("surfaces conflicting frozen metadata through the V2 error envelope", async () => {
    const app = await runtime();
    app.service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const prepared = await app.service.previewMetadata(app.signature, app.account);
    app.state.putMetadata({
      ...prepared,
      metadataSha256: `0x${"ff".repeat(32)}`,
    });

    await expect(app.service.issueAuthorization(app.signature, app.account))
      .rejects.toMatchObject({ status: 422, code: "METADATA_INTEGRITY_ERROR" });
  });

  it("serializes concurrent issuance onto one live authorization", async () => {
    const app = await runtime();
    app.service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const [first, second] = await Promise.all([
      app.service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:05:00.000Z")),
      app.service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:05:00.000Z")),
    ]);
    expect(second.authorization.authorizationId).toBe(first.authorization.authorizationId);
    expect(second.galleryAttestation).toBe(first.galleryAttestation);
  });

  it("does not treat wall-clock expiry as finalized on-chain reconciliation", async () => {
    const app = await runtime();
    app.service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const issuedAt = new Date("2026-09-04T12:05:00.000Z");
    const first = await app.service.issueAuthorization(app.signature, app.account, issuedAt);
    const afterDeadline = new Date((Number(first.authorization.deadline) + 1) * 1_000);
    await expect(app.service.issueAuthorization(app.signature, app.account, afterDeadline))
      .rejects.toMatchObject({ status: 410, code: "AUTHORIZATION_EXPIRED" });
    expect(() => app.service.revokeBinding(app.account.xUserId, afterDeadline))
      .toThrowError(expect.objectContaining({ code: "LIVE_AUTHORIZATION_EXISTS" }));
  });

  it("keeps transaction reports advisory and gates Gallery publication on fixture finality", async () => {
    const app = await runtime();
    app.service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const response = await app.service.issueAuthorization(app.signature, app.account);
    app.service.reportTransaction(app.account.xUserId, response.authorization.authorizationId, `0x${"aa".repeat(32)}`);
    expect(app.state.getProjection(app.signature.signatureId).state).toBe("authorized");
    expect(app.state.listGallery()).toEqual([]);

    app.service.advanceFixture(app.signature.signatureId, app.account.xUserId);
    expect(app.state.getProjection(app.signature.signatureId).state).toBe("submitted");
    app.service.advanceFixture(app.signature.signatureId, app.account.xUserId);
    expect(app.state.getProjection(app.signature.signatureId).state).toBe("included_unfinalized");
    expect(app.state.listGallery()).toEqual([]);
    app.service.advanceFixture(app.signature.signatureId, app.account.xUserId);
    expect(app.state.getProjection(app.signature.signatureId).state).toBe("finalized");
    expect(app.state.listGallery()).toHaveLength(1);
  });

  it("preserves fail-closed RPC errors instead of misclassifying the wallet", async () => {
    const app = await runtime();
    const service = new V2MintService(app.config, app.state, app.signatures, app.artifacts, {
      eoaVerifier: {
        async verify() {
          throw v2Error(503, "WALLET_RPC_UNAVAILABLE", "Independent RPC providers did not agree.");
        },
      },
    });
    const wallet = privateKeyToAccount(FIXTURE_WALLET_KEY);
    const challenge = await service.createChallenge({
      session: app.session,
      account: app.account,
      walletAddress: wallet.address,
      chainId: app.config.chainId.toString(),
      now: new Date("2026-09-04T12:01:00.000Z"),
    });
    const proof = await wallet.signMessage({ message: challenge.message });
    await expect(service.confirmChallenge({
      session: app.session,
      challengeId: challenge.challengeId,
      walletProof: proof,
      now: new Date("2026-09-04T12:02:00.000Z"),
    })).rejects.toMatchObject({ status: 503, code: "WALLET_RPC_UNAVAILABLE" });
  });

  it("never stores an unverified signer response as issued", async () => {
    const app = await runtime();
    const service = new V2MintService(app.config, app.state, app.signatures, app.artifacts, {
      signer: {
        address: app.config.authorizer,
        async sign() {
          return `0x${"00".repeat(65)}` as Hex;
        },
      },
    });
    service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    await expect(service.issueAuthorization(app.signature, app.account))
      .rejects.toMatchObject({ status: 503, code: "SIGNER_UNAVAILABLE" });
    expect(app.state.getProjection(app.signature.signatureId).state).toBe("unminted");
    const binding = app.state.getActiveBinding(app.account.xUserId, app.config.chainId)!;
    const authorization = app.state.getLiveAuthorization(app.signature.signatureId, binding.walletBindingId);
    expect(authorization?.status).toBe("signing_unknown");
    expect(authorization?.galleryAttestation).toBeNull();
    expect(app.state.getStatus(app.signature.signatureId, true).authorization?.status).toBe("signing_unknown");
  });

  it("reconciles an ambiguous signer call with the same authorization ID and digest", async () => {
    const app = await runtime();
    const gallery = privateKeyToAccount(FIXTURE_GALLERY_KEY);
    let calls = 0;
    const service = new V2MintService(app.config, app.state, app.signatures, app.artifacts, {
      signer: {
        address: gallery.address,
        async sign(_authorizationId, _digest, authorization, config) {
          calls += 1;
          if (calls === 1) throw new Error("ambiguous transport failure");
          return gallery.signTypedData(mintAuthorizationTypedData({
            chainId: config.chainId,
            verifyingContract: config.contract,
          }, authorization));
        },
      },
    });
    service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    await expect(service.issueAuthorization(app.signature, app.account))
      .rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    const binding = app.state.getActiveBinding(app.account.xUserId, app.config.chainId)!;
    const uncertain = app.state.getLiveAuthorization(app.signature.signatureId, binding.walletBindingId)!;
    expect(uncertain.status).toBe("signing_unknown");

    const recovered = await service.issueAuthorization(app.signature, app.account);
    expect(recovered.authorization.authorizationId).toBe(uncertain.authorizationId);
    expect(app.state.getAuthorization(uncertain.authorizationId)?.status).toBe("issued");
    const repeated = await service.issueAuthorization(app.signature, app.account);
    expect(repeated.authorization.authorizationId).toBe(uncertain.authorizationId);
    expect(calls).toBe(2);
  });

  it("allows a renamed numeric X identity while rejecting a recycled handle from another identity", async () => {
    const app = await runtime();
    await app.signatures.updateExistingAccountLogin(
      app.account.xUserId,
      "alice_after_rename",
      "alice_after_rename",
      new Date("2026-09-04T12:03:00.000Z"),
    );
    const renamed = await app.signatures.getAccount(app.account.xUserId);
    if (!renamed) throw new Error("Renamed fixture account is missing.");
    app.service.seedFixtureBinding(renamed.xUserId, renamed.publicAccountId);
    const issued = await app.service.issueAuthorization(app.signature, renamed);
    expect(issued.authorization.signatureDigest).toBeDefined();
    expect(app.state.getMetadata(app.signature.signatureId)?.canonicalJson).toContain('"handle_at_claim":"alice"');
    expect(app.state.getMetadata(app.signature.signatureId)?.canonicalJson).not.toContain("alice_after_rename");

    const recycledHandleAccount = {
      ...renamed,
      xUserId: "9999999999999999999",
      publicAccountId: `xa1_${"b".repeat(26)}`,
      currentHandle: "alice",
      handleNormalized: "alice",
    };
    app.state.seedBinding({
      ...app.state.getActiveBinding(renamed.xUserId, app.config.chainId)!,
      walletBindingId: `0x${"bc".repeat(32)}`,
      xUserId: recycledHandleAccount.xUserId,
      publicAccountId: recycledHandleAccount.publicAccountId,
    });
    await expect(app.service.issueAuthorization(app.signature, recycledHandleAccount))
      .rejects.toMatchObject({ status: 403, code: "NOT_CLAIMANT" });
  });
});
