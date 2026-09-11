import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState, type BrowserSession } from "../v1/authState.js";
import { fixtureIdentity, seedDevelopmentFixtures } from "../v1/fixtures.js";
import { CARD_RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { loadMintConfig, type MintConfig } from "./config.js";
import { mintAuthorizationTypedData } from "./core/index.js";
import { MemoryMintStore, type MemoryMintStoreSnapshot } from "./memoryStore.js";
import { V2MintService, type MintServiceAdapters } from "./service.js";

const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const gallery = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const now = new Date("2026-09-04T12:00:00.000Z");

async function runtime(overrides: Partial<MintServiceAdapters> = {}) {
  const signatures = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const renderers = new RendererRegistry([formalSignatureRenderer]);
  await seedDevelopmentFixtures({ store: signatures, artifacts, renderers, cardRendererVersion: CARD_RENDERER_VERSION }, auth);
  const state = new MemoryMintStore();
  const config: MintConfig = {
    ...loadMintConfig({}, true, "http://127.0.0.1:3000"),
    fixtureMode: false,
    localChainRehearsal: true,
    chainId: 31337n,
    chainName: "Anvil 31337 local rehearsal",
    primaryRpcUrl: "http://127.0.0.1:8545",
    secondaryRpcUrl: "http://127.0.0.1:8545",
    genesisHash: `0x${"11".repeat(32)}`,
    runtimeCodeHash: `0x${"22".repeat(32)}`,
  };
  const checkpoints: MemoryMintStoreSnapshot[] = [];
  const adapters: MintServiceAdapters = {
    clock: () => now,
    latestCanonicalTimestamp: async () => 1_000n,
    eoaVerifier: { async verify(_address, chainId) {
      expect(chainId).toBe(31337n);
      return { blockNumber: 8n, blockHash: `0x${"ab".repeat(32)}` };
    } },
    signer: { address: gallery.address, async sign(_id, _digest, authorization, inputConfig) {
      return gallery.signTypedData(mintAuthorizationTypedData({ chainId: inputConfig.chainId, verifyingContract: inputConfig.contract }, authorization));
    } },
    checkpoint: async () => { checkpoints.push(state.exportSnapshot()); },
    ...overrides,
  };
  const service = new V2MintService(config, state, signatures, artifacts, adapters);
  const account = (await signatures.getAccount("1234567890123456789"))!;
  const signature = (await signatures.listSignaturesForAccount(account.xUserId))[0]!;
  const session = auth.getOrCreateSession(null, now).session;
  session.identity = fixtureIdentity("alice", now);
  const challenge = await service.createChallenge({ session, account, signature, walletAddress: wallet.address, chainId: "31337", now,
    recipientConsent: true, previousBindingId: null });
  const binding = await service.confirmChallenge({ session, challengeId: challenge.challengeId, walletProof: await wallet.signMessage({ message: challenge.message }), now });
  return { service, config, state, signatures, artifacts, session, signature, account, binding, adapters, checkpoints,
    reviewed: { walletBindingId: binding.walletBindingId, recipient: binding.address } };
}

describe("real local Anvil mint authorization", () => {
  it("requires isolated config and all authority/durability adapters", async () => {
    const app = await runtime();
    for (const key of ["signer", "eoaVerifier", "checkpoint", "latestCanonicalTimestamp"] as const) {
      expect(() => new V2MintService(app.config, app.state, app.signatures, app.artifacts, { ...app.adapters, [key]: undefined }))
        .toThrow("explicit RPC, signer, chain clock, and durable checkpoint adapters");
    }
  });

  it("uses real SIWE, chain time, and explicitly non-simulated transaction responses", async () => {
    const app = await runtime();
    expect(app.binding.verificationScheme).toBe("eip191_eoa_65byte_low_s");
    expect(app.binding.siweMessage).toContain("Chain ID: 31337");
    const response = await app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed);
    expect(response.fixture).toBeUndefined();
    expect(response.localChainRehearsal).toBe(true);
    expect(response.chainId).toBe("31337");
    expect(response.authorization.validAfter).toBe("940");
    expect(response.authorization.deadline).toBe("1840");
    const metadata = await app.service.previewMetadata(app.signature, app.account);
    expect(JSON.parse(metadata.canonicalJson)).toMatchObject({ properties: { fixture: true, local_chain_rehearsal: true, ipfs_publication: "not_published" } });
    expect(app.checkpoints.map((snapshot) => snapshot.authorizations[0]![1].status)).toEqual(["prepared", "issued"]);
  });

  it("never permits seeded binding authority or fixture advancement on the local chain", async () => {
    const app = await runtime();
    expect(() => app.service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId)).toThrow("Fixture bindings are disabled");
    expect(() => app.service.advanceFixture(app.signature.signatureId, app.account.xUserId)).toThrow("Fixture chain advancement is disabled");
    app.state.getActiveBinding(app.account.xUserId, 31337n)!.verificationScheme = "fixture_seed";
    await expect(app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed)).rejects.toMatchObject({ code: "WALLET_NOT_LINKED" });
  });

  it("requires a valid app session but does not age out minting after fifteen minutes", async () => {
    const app = await runtime();
    await expect(app.service.issueAuthorization(app.signature, app.account)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    app.session.identity!.authenticatedAt = new Date(now.getTime() - 901_000);
    await expect(app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed)).resolves.toMatchObject({ chainId: "31337" });
    app.session.identity = null;
    await expect(app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("rejects revocation without an app session outside isolated fixture mode", async () => {
    const app = await runtime();
    expect(() => app.service.revokeBinding(app.account.xUserId, now))
      .toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
    expect(app.state.getActiveBinding(app.account.xUserId, app.config.chainId)?.walletBindingId).toBe(app.binding.walletBindingId);
  });

  it.each(["before signing", "after signing"])("rechecks the app session when a chain lookup logs out %s", async (phase) => {
    let session: BrowserSession | undefined;
    let calls = 0;
    const app = await runtime({ latestCanonicalTimestamp: async () => {
      calls += 1;
      if (calls === (phase === "before signing" ? 1 : 2)) session!.identity = null;
      return 1_000n;
    } });
    session = app.session;
    await expect(app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization?.status ?? null)
      .toBe(phase === "before signing" ? null : "issued");
  });

  it("reuses the same durable authorization and signature after restart", async () => {
    const app = await runtime();
    const first = await app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed);
    const restored = MemoryMintStore.fromSnapshot(app.checkpoints.at(-1)!);
    const service = new V2MintService(app.config, restored, app.signatures, app.artifacts, {
      ...app.adapters,
      checkpoint: async () => {},
      signer: { address: gallery.address, async sign() { throw new Error("retries must not sign"); } },
    });
    expect(await service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed)).toEqual(first);
  });

  it("does not invoke the signer when the prepared checkpoint fails", async () => {
    let signed = false;
    const app = await runtime({
      checkpoint: async () => { throw new Error("disk unavailable"); },
      signer: { address: gallery.address, async sign() { signed = true; throw new Error("must not sign"); } },
    });
    await expect(app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed)).rejects.toThrow("disk unavailable");
    expect(signed).toBe(false);
    expect(app.state.exportSnapshot().authorizations[0]![1].status).toBe("prepared");
  });

  it("does not release an attestation if the issued checkpoint fails", async () => {
    let count = 0;
    const app = await runtime({ checkpoint: async () => { if (++count === 2) throw new Error("commit outcome unknown"); } });
    await expect(app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed)).rejects.toThrow("commit outcome unknown");
    expect(count).toBe(2);
  });

  it("durably records ambiguous signing and safely resumes the same intent after restart", async () => {
    const app = await runtime({ signer: { address: gallery.address, async sign() { throw new Error("signer lost reply"); } } });
    await expect(app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed)).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    const saved = app.checkpoints.at(-1)!;
    const record = saved.authorizations[0]![1];
    expect(record.status).toBe("signing_unknown");
    const restored = MemoryMintStore.fromSnapshot(saved);
    const service = new V2MintService(app.config, restored, app.signatures, app.artifacts, {
      ...app.adapters,
      checkpoint: async () => {},
      signer: { address: gallery.address, async sign(id, digest, authorization, config) {
        expect(id).toBe(record.authorizationId);
        expect(digest).toBe(record.typedDataDigest);
        return gallery.signTypedData(mintAuthorizationTypedData({ chainId: config.chainId, verifyingContract: config.contract }, authorization));
      } },
    });
    const resumed = await service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed);
    expect(resumed.authorization.authorizationId).toBe(record.authorizationId);
  });

  it("checks local expiration against chain time, without releasing the replay lock", async () => {
    let timestamp = 1_000n;
    const app = await runtime({ latestCanonicalTimestamp: async () => timestamp });
    const first = await app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed);
    timestamp = BigInt(first.authorization.deadline) + 1n;
    await expect(app.service.issueAuthorization(app.signature, app.account, undefined, app.session, app.reviewed)).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    app.session.actionApproval = {
      intent: { kind: "wallet_revoke", chainId: "31337", previousBindingId: app.binding.walletBindingId },
      sessionId: app.session.id, xUserId: app.account.xUserId,
      confirmedAt: now, expiresAt: new Date(now.getTime() + 10 * 60_000),
    };
    expect(() => app.service.revokeBinding(app.account.xUserId, now, app.session)).toThrowError(expect.objectContaining({ code: "LIVE_AUTHORIZATION_EXISTS" }));
  });
});
