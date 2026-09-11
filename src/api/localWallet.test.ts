import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { LocalMintRuntime } from "../local/mintRuntime.js";
import type { LocalTestWallet } from "../local/wallet.js";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState, type BrowserSession } from "../v1/authState.js";
import { SESSION_IDLE_TTL_MS } from "../v1/authPolicy.js";
import { fixtureIdentity, seedDevelopmentFixtures } from "../v1/fixtures.js";
import { CARD_RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { loadMintConfig, type MintConfig } from "../v2/config.js";
import { mintAuthorizationTypedData, signatureTokenId } from "../v2/core/index.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import type { WalletBindingChallenge } from "../v2/model.js";
import { V2MintService, type MintAuthorizationResponse } from "../v2/service.js";
import { createApp, type AppOptions } from "./server.js";

const ORIGIN = "http://127.0.0.1:3000";
const mnemonic = "test test test test test test test test test test test junk";
const walletAccount = mnemonicToAccount(mnemonic, { addressIndex: 6 });
const signerAccount = mnemonicToAccount(mnemonic, { addressIndex: 5 });
const OTHER_WALLET = mnemonicToAccount(mnemonic, { addressIndex: 8 }).address;
const TX_HASH = `0x${"71".repeat(32)}` as const;
const TRANSFER_HASH = `0x${"72".repeat(32)}` as const;

interface RequestOptions {
  method?: string;
  session?: BrowserSession | null;
  headers?: Record<string, string | undefined>;
}

/** Exercise the actual HTTP handler without opening ports or contacting Anvil. */
async function dispatch(handler: ReturnType<typeof createApp>, path: string, body: Record<string, unknown>, options: RequestOptions) {
  const session = options.session;
  const headers = Object.fromEntries(Object.entries({
    host: new URL(ORIGIN).host,
    origin: ORIGIN,
    accept: "application/json",
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    ...(session ? { cookie: `sg_dev_session=${session.id}`, "x-csrf-token": session.csrfToken } : {}),
    ...options.headers,
  }).filter(([, value]) => value !== undefined));
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: path, method: options.method ?? "POST", headers,
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  const responseHeaders = new Map<string, string>();
  let text = "";
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), value); },
    end(value?: string | Buffer) { text = value?.toString() ?? ""; },
  };
  await handler(req, res as unknown as ServerResponse);
  return { status: res.statusCode, json: text && responseHeaders.get("content-type")?.includes("application/json") ? JSON.parse(text) : null, text, headers: responseHeaders };
}

async function runtime() {
  const store = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const renderers = new RendererRegistry([formalSignatureRenderer]);
  await seedDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: CARD_RENDERER_VERSION }, auth);
  const state = new MemoryMintStore();
  const config: MintConfig = {
    ...loadMintConfig({}, true, ORIGIN),
    fixtureMode: false, localChainRehearsal: true, chainId: 31337n,
    chainName: "Local Anvil 31337", authorizer: signerAccount.address,
    primaryRpcUrl: "http://127.0.0.1:18545", secondaryRpcUrl: "http://127.0.0.1:18545",
    genesisHash: `0x${"ab".repeat(32)}`, runtimeCodeHash: `0x${"cd".repeat(32)}`,
  };
  let failPersistence: "any" | "issued" | null = null;
  const persistedStatuses: string[][] = [];
  const queue = new LocalMintRuntime({
    assertOwnership() {},
    async persist() {
      if (failPersistence === "any" || (failPersistence === "issued" && state.exportSnapshot().authorizations.some(([, record]) => record.status === "issued"))) {
        throw new Error("Database write failed");
      }
      persistedStatuses.push(state.exportSnapshot().authorizations.map(([, record]) => record.status));
    },
  });
  const signer = vi.fn(async (_id, _digest, authorization, inputConfig) => signerAccount.signTypedData(
    mintAuthorizationTypedData({ chainId: inputConfig.chainId, verifyingContract: inputConfig.contract }, authorization),
  ));
  const mint = new V2MintService(config, state, store, artifacts, {
    checkpoint: () => queue.checkpoint(),
    latestCanonicalTimestamp: async () => 1_000n,
    eoaVerifier: { async verify() { return { blockNumber: 8n, blockHash: `0x${"ab".repeat(32)}` }; } },
    signer: { address: signerAccount.address, sign: signer },
  });
  const localWalletStub = {
    address: walletAccount.address,
    info: vi.fn(async () => ({ chainId: "31337", address: walletAccount.address })),
    signChallenge: vi.fn(async (challenge: WalletBindingChallenge) => walletAccount.signMessage({ message: challenge.message })),
    submitMint: vi.fn(async (_payload: MintAuthorizationResponse) => TX_HASH),
    transferToRecipient: vi.fn(async (_tokenId: bigint) => TRANSFER_HASH),
  };
  const deps = { store, artifacts, auth, renderers, mint };
  const options: AppOptions = {
    fixtureMode: true, localChainRehearsal: true, publicOrigin: ORIGIN,
    runMintOperation: (operation) => queue.run(operation),
    localWallet: localWalletStub as unknown as LocalTestWallet,
  };
  const handler = createApp(deps, options);
  const signingIn = auth.getOrCreateSession(null).session;
  signingIn.identity = fixtureIdentity("alice");
  const signature = (await store.listSignaturesForAccount(signingIn.identity.xUserId))[0]!;
  const session = signingIn;
  const other = auth.getOrCreateSession(null).session;
  other.identity = fixtureIdentity("bob");
  const request = (path: string, body: Record<string, unknown> = {}, overrides: RequestOptions = {}) => dispatch(handler, path, body, { session, ...overrides });
  const target = { signatureId: signature.signatureId, claimInstanceId: signature.claimInstanceId, recipientConsent: true, previousBindingId: null };
  const reviewedRecipient = () => {
    const binding = state.getActiveBinding(session.identity!.xUserId, 31337n)!;
    return { walletBindingId: binding.walletBindingId, recipient: binding.address };
  };
  const challenge = async () => {
    const response = await request("/api/v2/wallet-bindings/challenge", { walletAddress: walletAccount.address, chainId: "31337", ...target });
    expect(response.status).toBe(201);
    return response.json as { challengeId: string; message: string };
  };
  const bind = async () => {
    const proofRequest = await challenge();
    const proof = await request("/api/local/wallet/sign", { challengeId: proofRequest.challengeId });
    expect(proof.status).toBe(200);
    const response = await request("/api/v2/wallet-bindings/confirm", { challengeId: proofRequest.challengeId, walletProof: proof.json.walletProof });
    expect(response.status).toBe(201);
    return response.json;
  };
  const authorize = async () => {
    const response = await request(`/api/v2/signatures/${signature.signatureId}/mint-authorizations`, reviewedRecipient(), { headers: { "x-mint-permanence-acknowledged": "1" } });
    expect(response.status).toBe(201);
    return response.json as MintAuthorizationResponse;
  };
  const finalize = async () => {
    const authorization = await authorize();
    state.observeIncluded({ signatureId: signature.signatureId, authorizationId: authorization.authorization.authorizationId,
      txHash: TX_HASH, contract: config.contract, chainId: 31337n, tokenId: signatureTokenId(signature.signatureId),
      mintWallet: walletAccount.address, blockNumber: 10n, transactionIndex: 0, logIndex: 1 });
    state.finalizeMint(signature.signatureId, new Date(), "Test local promotion");
  };
  return { deps, options, state, mint, signature, session, other, auth, request, bind, challenge, authorize, finalize, target, reviewedRecipient,
    wallet: localWalletStub, signer, queue, persistedStatuses, failPersistence: (when: "any" | "issued" = "any") => { failPersistence = when; } };
}

describe("local TEST wallet API security and durable authority", () => {
  it("labels revoked local confirmation honestly in the collection", async () => {
    const app = await runtime();
    const snapshot = app.state.exportSnapshot();
    snapshot.projections.push([app.signature.signatureId, {
      ...app.state.getProjection(app.signature.signatureId), state: "finality_revoked",
    }]);
    app.state.replaceSnapshot(snapshot);
    const response = await app.request("/me", {}, { method: "GET", headers: { accept: "text/html" } });
    expect(response.status).toBe(200);
    expect(response.text).toContain("Local chain confirmation revoked");
    expect(response.text).not.toContain("Ethereum finality incident");
  });

  it("has no wallet endpoints outside the explicitly guarded local entrypoint", async () => {
    const app = await runtime();
    const handler = createApp(app.deps, { fixtureMode: true });
    for (const path of ["/api/local/wallet", "/api/local/wallet/sign", "/api/local/wallet/mint", "/api/local/wallet/transfer"]) {
      const response = await dispatch(handler, path, {}, { session: app.session, method: path === "/api/local/wallet" ? "GET" : "POST" });
      expect(response.status).toBe(404);
    }
    expect(() => createApp(app.deps, { ...app.options, localChainRehearsal: false })).toThrow("guarded durable Anvil entrypoint");
    expect(() => createApp(app.deps, { ...app.options, runMintOperation: undefined })).toThrow("guarded durable Anvil entrypoint");
    expect(app.wallet.info).not.toHaveBeenCalled();
  });

  it("requires an active app session but accepts older X identity for local wallet information", async () => {
    const app = await runtime();
    expect((await app.request("/api/local/wallet", {}, { method: "GET", session: null })).status).toBe(401);
    app.session.identity!.authenticatedAt = new Date(Date.now() - 901_000);
    expect(app.wallet.info).not.toHaveBeenCalled();
    const response = await app.request("/api/local/wallet", {}, { method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    app.session.lastSeenAt = new Date(Date.now() - SESSION_IDLE_TTL_MS - 1);
    const expired = await app.request("/api/local/wallet", {}, { method: "GET" });
    expect(expired.status).toBe(401);
    expect(expired.json.error.code).toBe("AUTH_REQUIRED");
  });

  it.each([
    ["/api/local/wallet/sign", { challengeId: "unavailable" }],
    ["/api/local/wallet/mint", { authorizationId: "unavailable" }],
    ["/api/local/wallet/transfer", { signatureId: "unavailable" }],
  ])("rejects missing identity, future-dated identity, foreign origin, and missing CSRF on %s", async (path, body) => {
    const app = await runtime();
    expect((await app.request(path, body, { session: null })).status).toBe(401);
    const invalid = await runtime();
    invalid.session.identity!.authenticatedAt = new Date(Date.now() + 60_000);
    expect((await invalid.request(path, body)).json.error.code).toBe("AUTH_REQUIRED");
    for (const headers of [{ origin: "https://evil.example" }, { origin: undefined }, { "sec-fetch-site": "cross-site" }, { "x-csrf-token": undefined }, { "x-csrf-token": "wrong" }]) {
      expect((await app.request(path, body, { headers })).status).toBe(403);
    }
    expect(app.wallet.signChallenge).not.toHaveBeenCalled();
    expect(app.wallet.submitMint).not.toHaveBeenCalled();
    expect(app.wallet.transferToRecipient).not.toHaveBeenCalled();
  });

  it("uses an older active app session and explicit mint selection without another X approval", async () => {
    const app = await runtime();
    delete app.session.actionApproval;
    app.session.identity!.authenticatedAt = new Date(Date.now() - 6 * 24 * 60 * 60_000);
    await app.bind();
    const authorization = await app.authorize();
    expect(authorization.authorization.mintWallet).toBe(walletAccount.address);
    expect(app.session.actionApproval).toBeUndefined();
  });

  it("requires explicit selection and the current claim instance for every proof", async () => {
    const app = await runtime();
    const another = (await app.deps.store.listSignaturesForAccount(app.signature.xUserId))[1]!;
    const wrongWork = await app.request("/api/v2/wallet-bindings/challenge", {
      walletAddress: walletAccount.address, chainId: "31337", signatureId: another.signatureId, claimInstanceId: another.claimInstanceId,
    });
    expect(wrongWork.status).toBe(400);
    expect(wrongWork.json.error.code).toBe("REQUEST_CONFIRMATION_INVALID");
    const replacedClaim = await app.request("/api/v2/wallet-bindings/challenge", {
      walletAddress: walletAccount.address, chainId: "31337", ...app.target, claimInstanceId: "not-the-confirmed-claim",
    });
    expect(replacedClaim.status).toBe(409);
    expect(app.state.exportSnapshot().challenges).toEqual([]);
    expect(app.wallet.signChallenge).not.toHaveBeenCalled();
  });

  it.each(["missing session", "expired session", "wrong claimant", "foreign origin", "cross-site", "missing csrf", "wrong csrf", "no consent", "stale binding"])("rejects mint proof setup with %s", async reason => {
    const app = await runtime();
    const body: Record<string, unknown> = { walletAddress: walletAccount.address, chainId: "31337", ...app.target };
    const options: RequestOptions = {};
    if (reason === "missing session") options.session = null;
    if (reason === "expired session") app.session.lastSeenAt = new Date(Date.now() - SESSION_IDLE_TTL_MS - 1);
    if (reason === "wrong claimant") options.session = app.other;
    if (reason === "foreign origin") options.headers = { origin: "https://evil.example" };
    if (reason === "cross-site") options.headers = { "sec-fetch-site": "cross-site" };
    if (reason === "missing csrf") options.headers = { "x-csrf-token": undefined };
    if (reason === "wrong csrf") options.headers = { "x-csrf-token": "wrong" };
    if (reason === "no consent") delete body.recipientConsent;
    if (reason === "stale binding") body.previousBindingId = "0x" + "ab".repeat(32);
    const response = await app.request("/api/v2/wallet-bindings/challenge", body, options);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(app.state.exportSnapshot().challenges).toHaveLength(0);
    expect(app.signer).not.toHaveBeenCalled();
  });

  it("does not sign or activate a superseded local recipient challenge", async () => {
    const app = await runtime();
    const first = await app.challenge();
    const second = await app.challenge();
    const stale = await app.request("/api/local/wallet/sign", { challengeId: first.challengeId });
    expect(stale.json.error.code).toBe("WALLET_CHALLENGE_INVALID");
    expect(app.wallet.signChallenge).not.toHaveBeenCalled();
    const proof = await app.request("/api/local/wallet/sign", { challengeId: second.challengeId });
    const confirm = { challengeId: second.challengeId, walletProof: proof.json.walletProof };
    expect((await app.request("/api/v2/wallet-bindings/confirm", confirm)).status).toBe(201);
    expect((await app.request("/api/v2/wallet-bindings/confirm", confirm)).json.error.code).toBe("WALLET_CHALLENGE_INVALID");
  });

  it("does not turn a historical wallet proof into authority for a new mint", async () => {
    const app = await runtime();
    await app.bind();
    delete app.session.mintRecipient;
    const response = await app.request(`/api/v2/signatures/${app.signature.signatureId}/mint-authorizations`, app.reviewedRecipient(), { headers: { "x-mint-permanence-acknowledged": "1" } });
    expect(response.status).toBe(401);
    expect(response.json.error.code).toBe("MINT_RECIPIENT_REQUIRED");
    expect(app.signer).not.toHaveBeenCalled();
    expect(app.state.exportSnapshot().authorizations).toEqual([]);
  });

  it("requires the exact reviewed recipient snapshot before a new mint", async () => {
    const app = await runtime();
    await app.bind();
    const path = `/api/v2/signatures/${app.signature.signatureId}/mint-authorizations`;
    const options = { headers: { "x-mint-permanence-acknowledged": "1" } };
    expect((await app.request(path, {}, options)).json.error.code).toBe("REQUEST_CONFIRMATION_INVALID");
    const changed = await app.request(path, { ...app.reviewedRecipient(), recipient: OTHER_WALLET }, options);
    expect(changed.status).toBe(409);
    expect(changed.json.error.code).toBe("BINDING_TRANSITION");
    expect(app.signer).not.toHaveBeenCalled();
    expect(app.state.exportSnapshot().authorizations).toEqual([]);
  });

  it("authorizes this mint with its current recipient proof even when the X sign-in is older", async () => {
    const app = await runtime();
    await app.bind();
    expect(app.session.actionApproval).toBeUndefined();
    expect(app.session.mintRecipient).toMatchObject({ signatureId: app.target.signatureId, claimInstanceId: app.target.claimInstanceId, sessionId: app.session.id, address: walletAccount.address });
    app.session.identity!.authenticatedAt = new Date(Date.now() - 16 * 60_000);
    const authorization = await app.authorize();
    expect(authorization.authorization.authorizationId).toBeTruthy();
    expect(app.session.identity).not.toBeNull();
    expect(app.signer).toHaveBeenCalledOnce();
  });

  it("signs only a pending challenge belonging to the exact current browser session and X identity", async () => {
    const app = await runtime();
    const challenge = await app.challenge();
    const secondSession = app.auth.getOrCreateSession(null).session;
    secondSession.identity = fixtureIdentity("alice");
    for (const session of [app.other, secondSession]) {
      const denied = await app.request("/api/local/wallet/sign", { challengeId: challenge.challengeId }, { session });
      expect(denied.status).toBe(409);
      expect(denied.json.error.code).toBe("WALLET_CHALLENGE_INVALID");
    }
    expect(app.wallet.signChallenge).not.toHaveBeenCalled();
    const signed = await app.request("/api/local/wallet/sign", { challengeId: challenge.challengeId, message: "Do not sign caller-supplied text", walletAddress: OTHER_WALLET });
    expect(signed.status).toBe(200);
    expect((await app.request("/api/v2/wallet-bindings/confirm", { challengeId: challenge.challengeId, walletProof: signed.json.walletProof })).status).toBe(201);
    expect(app.state.getActiveBinding(app.session.identity!.xUserId, 31337n)?.verificationScheme).toBe("eip191_eoa_65byte_low_s");
    expect((await app.request("/api/local/wallet/sign", { challengeId: challenge.challengeId })).status).toBe(409);
    expect(app.wallet.signChallenge).toHaveBeenCalledTimes(1);
    expect(app.wallet.signChallenge.mock.calls[0]![0].message).toBe(challenge.message);
  });

  it("does not allow seeded wallet authority or fixture chain advancement on local Anvil", async () => {
    const app = await runtime();
    for (const path of ["/dev/v2/wallet-bindings/seed", `/dev/v2/signatures/${app.signature.signatureId}/advance`]) {
      expect((await app.request(path)).status).toBe(404);
    }
    expect(app.state.getActiveBinding(app.session.identity!.xUserId, 31337n)).toBeNull();
    expect(app.state.getProjection(app.signature.signatureId).state).toBe("unminted");
  });

  it("requires claimant ownership and explicit acknowledgment before broadcasting a mint", async () => {
    const app = await runtime();
    await app.bind();
    const authorization = await app.authorize();
    const body = { authorizationId: authorization.authorization.authorizationId };
    expect((await app.request("/api/local/wallet/mint", body)).status).toBe(409);
    expect((await app.request("/api/local/wallet/mint", body, { session: app.other, headers: { "x-mint-permanence-acknowledged": "1" } })).status).toBe(403);
    expect(app.wallet.submitMint).not.toHaveBeenCalled();
  });

  it("does not release a successful authorization when the queued durable checkpoint fails", async () => {
    const app = await runtime();
    await app.bind();
    app.failPersistence();
    const response = await app.request(`/api/v2/signatures/${app.signature.signatureId}/mint-authorizations`, app.reviewedRecipient(), { headers: { "x-mint-permanence-acknowledged": "1" } });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.json.authorization).toBeUndefined();
    expect(response.json.galleryAttestation).toBeUndefined();
    expect(app.signer).not.toHaveBeenCalled();
    const retry = await app.request("/api/local/wallet/sign", { challengeId: "unused" });
    expect(retry.status).toBeGreaterThanOrEqual(500);
  });

  it("withholds the signed attestation when the issued checkpoint cannot commit", async () => {
    const app = await runtime();
    await app.bind();
    app.failPersistence("issued");
    const response = await app.request(`/api/v2/signatures/${app.signature.signatureId}/mint-authorizations`, app.reviewedRecipient(), { headers: { "x-mint-permanence-acknowledged": "1" } });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.json.authorization).toBeUndefined();
    expect(response.json.galleryAttestation).toBeUndefined();
    expect(app.signer).toHaveBeenCalledTimes(1);
    expect(app.persistedStatuses.at(-1)).toEqual(["prepared"]);
    expect(app.state.exportSnapshot().authorizations[0]![1].status).toBe("issued");
    expect(() => app.queue.assertHealthy()).toThrow("restart is required");
  });

  it("rejects the held session after logout while a local wallet action waits in the queue", async () => {
    const app = await runtime();
    const challenge = await app.challenge();
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = createApp(app.deps, { ...app.options, runMintOperation: (operation) => {
      entered();
      return app.queue.run(async () => { await gate; return operation(); });
    } });
    const pending = dispatch(handler, "/api/local/wallet/sign", { challengeId: challenge.challengeId }, { session: app.session });
    await entry;
    app.auth.logout(app.session.id);
    release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.json.error.code).toBe("AUTH_REQUIRED");
    expect(app.wallet.signChallenge).not.toHaveBeenCalled();
  });

  it("ignores forged broadcast flags on advisory reports and submits exactly one local mint", async () => {
    const app = await runtime();
    await app.bind();
    const authorization = await app.authorize();
    const authorizationId = authorization.authorization.authorizationId;
    const fakeHash = `0x${"ff".repeat(32)}`;
    const reported = await app.request(`/api/v2/mint-authorizations/${authorizationId}/transactions`, {
      txHash: fakeHash, localWalletBroadcast: true, state: "included", authorizationId,
    });
    expect(reported.status).toBe(201);
    expect(app.state.getStatus(app.signature.signatureId, true).attempts[0]).toMatchObject({ txHash: fakeHash, state: "reported" });
    expect(app.state.getStatus(app.signature.signatureId, true).attempts[0]!.localWalletBroadcast).toBeUndefined();
    expect(app.state.getProjection(app.signature.signatureId).state).toBe("authorized");
    const options = { headers: { "x-mint-permanence-acknowledged": "1" } };
    const [first, repeated] = await Promise.all([
      app.request("/api/local/wallet/mint", { authorizationId }, options),
      app.request("/api/local/wallet/mint", { authorizationId }, options),
    ]);
    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(first.json).toEqual({ txHash: TX_HASH });
    expect(repeated.json).toEqual(first.json);
    expect(app.wallet.submitMint).toHaveBeenCalledTimes(1);
    const attempts = app.state.getStatus(app.signature.signatureId, true).attempts;
    expect(attempts.find((attempt) => attempt.txHash === TX_HASH)?.localWalletBroadcast).toBe(true);
    expect(app.state.listGallery()).toHaveLength(0);
  });

  it("requires a matching real wallet binding and claimant before transferring a finalized token", async () => {
    const app = await runtime();
    await app.bind();
    await app.finalize();
    const body = { signatureId: app.signature.signatureId };
    expect((await app.request("/api/local/wallet/transfer", body, { session: app.other })).status).toBe(403);
    const binding = app.state.getActiveBinding(app.session.identity!.xUserId, 31337n)!;
    binding.verificationScheme = "fixture_seed";
    expect((await app.request("/api/local/wallet/transfer", body)).json.error.code).toBe("WALLET_NOT_LINKED");
    binding.verificationScheme = "eip191_eoa_65byte_low_s";
    binding.address = OTHER_WALLET;
    expect((await app.request("/api/local/wallet/transfer", body)).json.error.code).toBe("WALLET_NOT_LINKED");
    expect(app.wallet.transferToRecipient).not.toHaveBeenCalled();
    binding.address = walletAccount.address;
    const transferred = await app.request("/api/local/wallet/transfer", body);
    expect(transferred.status).toBe(200);
    expect(transferred.json).toEqual({ txHash: TRANSFER_HASH });
    expect(app.wallet.transferToRecipient).toHaveBeenCalledWith(signatureTokenId(app.signature.signatureId));
    // A submitted transfer is not itself a finalized holder observation.
    expect(app.state.getProjection(app.signature.signatureId).currentTokenHolder).toBe(walletAccount.address);
  });
});
