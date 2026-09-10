import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ArtifactStore } from "../v1/artifacts.js";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState } from "../v1/authState.js";
import { fixtureIdentity, seedDevelopmentFixtures } from "../v1/fixtures.js";
import { DEV_CARD_RENDERER_VERSION, developmentFixtureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { loadMintConfig } from "./config.js";
import { mintAuthorizationTypedData, type MintAuthorization } from "./core/index.js";
import { MemoryMintStore } from "./memoryStore.js";
import { V2MintService, type GallerySigner } from "./service.js";

const WALLET_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function fixture() {
  const signatures = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const renderers = new RendererRegistry([developmentFixtureRenderer]);
  await seedDevelopmentFixtures({ store: signatures, artifacts, renderers, cardRendererVersion: DEV_CARD_RENDERER_VERSION }, auth);
  const state = new MemoryMintStore();
  const config = loadMintConfig({}, true, "http://localhost:3000");
  const account = await signatures.getAccount("1234567890123456789");
  if (!account) throw new Error("Fixture account missing.");
  const signature = (await signatures.listSignaturesForAccount(account.xUserId))[0];
  const session = auth.getOrCreateSession(null, new Date("2026-09-04T12:00:00.000Z")).session;
  session.identity = fixtureIdentity("alice", new Date("2026-09-04T12:00:00.000Z"));
  return { signatures, artifacts, state, config, account, signature, session };
}

function interceptReads(inner: MemoryArtifactStore, onFirstRead: () => void): ArtifactStore {
  let intercepted = false;
  return {
    putVerified(kind, bytes, context) {
      return inner.putVerified(kind, bytes, context);
    },
    async get(key) {
      if (!intercepted) {
        intercepted = true;
        onFirstRead();
      }
      return inner.get(key);
    },
    delete(key) {
      return inner.delete(key);
    },
    releaseReference(kind, key, signatureId) {
      return inner.releaseReference(kind, key, signatureId);
    },
  };
}

function signerWithHook(hook: () => void): GallerySigner {
  const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  return {
    address: signer.address,
    async sign(_authorizationId, _digest, authorization: MintAuthorization, config) {
      hook();
      return signer.signTypedData(mintAuthorizationTypedData({
        chainId: config.chainId,
        verifyingContract: config.contract,
      }, authorization));
    },
  };
}

describe("V2 authorization race fences", () => {
  it("rejects an old-wallet authorization when the active binding changes during metadata work", async () => {
    const app = await fixture();
    const initialService = new V2MintService(app.config, app.state, app.signatures, app.artifacts);
    const oldBinding = initialService.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const racingArtifacts = interceptReads(app.artifacts, () => {
      app.state.revokeBinding(app.account.xUserId, app.config.chainId);
      app.state.seedBinding({
        ...oldBinding,
        walletBindingId: `0x${"cd".repeat(32)}`,
        address: getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
        version: oldBinding.version + 1,
        status: "active",
      });
    });
    const service = new V2MintService(app.config, app.state, app.signatures, racingArtifacts);

    await expect(service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:05:00.000Z")))
      .rejects.toMatchObject({ status: 409, code: "BINDING_TRANSITION" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization).toBeNull();
  });

  it("blocks authorization when a suppression lands during metadata work", async () => {
    const app = await fixture();
    const initialService = new V2MintService(app.config, app.state, app.signatures, app.artifacts);
    initialService.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const racingArtifacts = interceptReads(app.artifacts, () => app.state.suppress(app.signature.signatureId));
    const service = new V2MintService(app.config, app.state, app.signatures, racingArtifacts);

    await expect(service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:05:00.000Z")))
      .rejects.toMatchObject({ status: 409, code: "MINT_INELIGIBLE" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization).toBeNull();
  });

  it("fails closed instead of reauthorizing a canonical included mint", async () => {
    const app = await fixture();
    const service = new V2MintService(app.config, app.state, app.signatures, app.artifacts);
    service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    await service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:05:00.000Z"));
    service.advanceFixture(app.signature.signatureId, app.account.xUserId);
    service.advanceFixture(app.signature.signatureId, app.account.xUserId);

    await expect(service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:06:00.000Z")))
      .rejects.toMatchObject({ status: 503, code: "CHAIN_UNAVAILABLE" });
  });

  it("rechecks challenge and X freshness after the asynchronous EOA verification", async () => {
    const app = await fixture();
    let clock = new Date("2026-09-04T12:01:00.000Z");
    const service = new V2MintService(app.config, app.state, app.signatures, app.artifacts, {
      clock: () => clock,
      eoaVerifier: {
        async verify() {
          clock = new Date("2026-09-04T12:11:00.000Z");
          return { blockNumber: 6_820_000n, blockHash: `0x${"ab".repeat(32)}` };
        },
      },
    });
    const wallet = privateKeyToAccount(WALLET_KEY);
    const challenge = await service.createChallenge({
      session: app.session,
      account: app.account,
      walletAddress: wallet.address,
      chainId: app.config.chainId.toString(),
    });
    const proof = await wallet.signMessage({ message: challenge.message });

    await expect(service.confirmChallenge({ session: app.session, challengeId: challenge.challengeId, walletProof: proof }))
      .rejects.toMatchObject({ status: 409, code: "WALLET_CHALLENGE_INVALID" });
    expect(app.state.getActiveBinding(app.account.xUserId, app.config.chainId)).toBeNull();
    expect(app.state.getChallenge(challenge.challengeId)?.status).toBe("failed");
  });

  it("records but never releases an attestation when suppression lands during signing", async () => {
    const app = await fixture();
    const initialService = new V2MintService(app.config, app.state, app.signatures, app.artifacts);
    initialService.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const service = new V2MintService(app.config, app.state, app.signatures, app.artifacts, {
      signer: signerWithHook(() => app.state.suppress(app.signature.signatureId)),
    });

    await expect(service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:05:00.000Z")))
      .rejects.toMatchObject({ status: 409, code: "MINT_INELIGIBLE" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization).toMatchObject({ status: "issued" });
    expect(app.state.isSuppressed(app.signature.signatureId)).toBe(true);
  });

  it("does not return an authorization that expires while the signer is working", async () => {
    const app = await fixture();
    let clock = new Date("2026-09-04T12:01:00.000Z");
    const initialService = new V2MintService(app.config, app.state, app.signatures, app.artifacts);
    initialService.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const service = new V2MintService(app.config, app.state, app.signatures, app.artifacts, {
      clock: () => clock,
      signer: signerWithHook(() => { clock = new Date("2026-09-04T12:16:01.000Z"); }),
    });

    await expect(service.issueAuthorization(app.signature, app.account))
      .rejects.toMatchObject({ status: 410, code: "AUTHORIZATION_EXPIRED" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization).toMatchObject({ status: "issued" });
  });

  it("rechecks the boundary after reconciling an ambiguous signer outcome", async () => {
    const app = await fixture();
    const initialService = new V2MintService(app.config, app.state, app.signatures, app.artifacts);
    initialService.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId);
    const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const service = new V2MintService(app.config, app.state, app.signatures, app.artifacts, {
      signer: {
        address: signer.address,
        async sign(authorizationId, _digest, authorization, config) {
          const attestation = await signer.signTypedData(mintAuthorizationTypedData({
            chainId: config.chainId,
            verifyingContract: config.contract,
          }, authorization));
          app.state.issueAuthorization(authorizationId, attestation);
          app.state.suppress(app.signature.signatureId);
          throw new Error("simulated ambiguous transport failure");
        },
      },
    });

    await expect(service.issueAuthorization(app.signature, app.account, new Date("2026-09-04T12:05:00.000Z")))
      .rejects.toMatchObject({ status: 409, code: "MINT_INELIGIBLE" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization).toMatchObject({ status: "issued" });
  });
});
