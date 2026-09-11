import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState } from "../v1/authState.js";
import { hasMintRecipient, SESSION_IDLE_TTL_MS } from "../v1/authPolicy.js";
import { fixtureIdentity, seedDevelopmentFixtures } from "../v1/fixtures.js";
import { CARD_RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { loadMintConfig } from "./config.js";
import { mintAuthorizationTypedData } from "./core/index.js";
import { MemoryMintStore } from "./memoryStore.js";
import { unmintedProjection } from "./model.js";
import { V2MintService, type MintServiceAdapters } from "./service.js";

const now = new Date("2026-09-04T12:00:00.000Z");
const wallet = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

async function runtime(adapters: MintServiceAdapters = {}) {
  const signatures = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  await seedDevelopmentFixtures({ store: signatures, artifacts, renderers: new RendererRegistry([formalSignatureRenderer]), cardRendererVersion: CARD_RENDERER_VERSION }, auth);
  const state = new MemoryMintStore();
  const config = loadMintConfig({}, true, "http://localhost:3000");
  const service = new V2MintService(config, state, signatures, artifacts, { clock: () => now, ...adapters });
  const account = (await signatures.getAccount("1234567890123456789"))!;
  const works = await signatures.listSignaturesForAccount(account.xUserId);
  const signature = works[0];
  const session = auth.getOrCreateSession(null, now).session;
  session.identity = fixtureIdentity("alice", now);
  const consent = () => ({ recipientConsent: true as const, previousBindingId: state.getActiveBinding(account.xUserId, config.chainId)?.walletBindingId ?? null });
  const prepare = async (target = signature) => {
    return service.seedFixtureMintRecipient(session, target, account, now, consent());
  };
  const challenge = (target = signature, recipient = wallet.address) => service.createChallenge({ session, account, signature: target,
    walletAddress: recipient, chainId: config.chainId.toString(), now, ...consent() });
  const reviewed = () => {
    const binding = state.getActiveBinding(account.xUserId, config.chainId)!;
    return { walletBindingId: binding.walletBindingId, recipient: binding.address };
  };
  const issue = (target = signature, at = now) => service.issueAuthorization(target, account, at, session, reviewed());
  return { signatures, artifacts, auth, state, config, service, account, signature, works, session, consent, challenge, prepare, reviewed, issue };
}

describe("app-session mint authority and exact recipient proof", () => {
  it("does not use a historical wallet binding as authority for a new mint", async () => {
    const app = await runtime();
    app.service.seedFixtureBinding(app.account.xUserId, app.account.publicAccountId, now);
    await expect(app.issue()).rejects.toMatchObject({ code: "MINT_RECIPIENT_REQUIRED" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization).toBeNull();
  });

  it("does not turn an old generic wallet-link proof into mint consent", async () => {
    const app = await runtime();
    app.session.actionApproval = { intent: { kind: "wallet_link", chainId: app.config.chainId.toString(), previousBindingId: null },
      sessionId: app.session.id, xUserId: app.account.xUserId, confirmedAt: now, expiresAt: new Date(now.getTime() + 60_000) };
    const challenge = await app.service.createChallenge({ session: app.session, account: app.account, walletAddress: wallet.address, chainId: app.config.chainId.toString(), now });
    await app.service.confirmChallenge({ session: app.session, challengeId: challenge.challengeId, walletProof: await wallet.signMessage({ message: challenge.message }), now });
    expect(app.session.mintRecipient).toBeUndefined();
    await expect(app.issue()).rejects.toMatchObject({ code: "MINT_RECIPIENT_REQUIRED" });
  });

  it("uses a valid older app session without another OAuth grant, proving the exact work and reviewed recipient", async () => {
    const app = await runtime();
    app.session.identity!.authenticatedAt = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    expect(app.session.actionApproval).toBeUndefined();
    const challenge = await app.challenge();
    expect(challenge.message).toContain(`/signatures/${app.signature.signatureId}`);
    expect(challenge.message).toContain(`/claim-instances/${app.signature.claimInstanceId}`);
    const binding = await app.service.confirmChallenge({ session: app.session, challengeId: challenge.challengeId, walletProof: await wallet.signMessage({ message: challenge.message }), now });
    expect(hasMintRecipient(app.session, app.signature, binding, now)).toBe(true);
    const response = await app.issue();
    expect(response.authorization.mintWallet).toBe(wallet.address);
    expect(app.session.mintRecipient?.authorizationId).toBe(response.authorization.authorizationId);
    expect(hasMintRecipient(app.session, app.signature, binding, now)).toBe(false);
    expect(app.session.actionApproval).toBeUndefined();
  });

  it.each([
    ["missing consent", "REQUEST_CONFIRMATION_INVALID"],
    ["false consent", "REQUEST_CONFIRMATION_INVALID"],
    ["missing prior binding", "BINDING_TRANSITION"],
    ["prior binding", "BINDING_TRANSITION"],
    ["claim", "MINT_INELIGIBLE"],
    ["work", "MINT_INELIGIBLE"],
    ["chain", "WRONG_CHAIN"],
  ])("rejects an invalid explicit mint setup: %s", async (field, code) => {
    const app = await runtime();
    const consent: { recipientConsent?: boolean; previousBindingId?: string | null } = app.consent();
    let signature = app.signature;
    if (field === "missing consent") delete consent.recipientConsent;
    if (field === "false consent") consent.recipientConsent = false;
    if (field === "missing prior binding") delete consent.previousBindingId;
    if (field === "prior binding") consent.previousBindingId = "other-binding";
    if (field === "claim") signature = { ...signature, claimInstanceId: "another-claim" };
    if (field === "work") signature = { ...signature, signatureId: app.works[1].signatureId };
    await expect(app.service.createChallenge({ session: app.session, account: app.account, signature,
      walletAddress: wallet.address, chainId: field === "chain" ? "1" : app.config.chainId.toString(), now, ...consent })).rejects.toMatchObject({ code });
    expect(app.state.exportSnapshot().challenges).toHaveLength(0);
  });

  it.each(["signed out", "expired session", "wrong claimant"])("rejects setup with %s even with explicit consent", async reason => {
    const app = await runtime();
    if (reason === "signed out") app.session.identity = null;
    if (reason === "expired session") app.session.lastSeenAt = new Date(now.getTime() - SESSION_IDLE_TTL_MS - 1);
    if (reason === "wrong claimant") app.session.identity!.xUserId = "another-account";
    await expect(app.challenge()).rejects.toMatchObject({ code: reason === "wrong claimant" ? "NOT_CLAIMANT" : "AUTH_REQUIRED" });
    expect(app.state.exportSnapshot().challenges).toHaveLength(0);
  });

  it("does not consume an unrelated sensitive-action grant when preparing a mint", async () => {
    const app = await runtime();
    app.session.actionApproval = { intent: { kind: "claim_withdraw", signatureId: app.works[1].signatureId,
      claimInstanceId: app.works[1].claimInstanceId }, sessionId: app.session.id, xUserId: app.account.xUserId,
      confirmedAt: now, expiresAt: new Date(now.getTime() + 60_000) };
    const approval = app.session.actionApproval;
    await app.challenge();
    expect(app.session.actionApproval).toBe(approval);
  });

  it.each(["missing", "false", "stale snapshot"])("keeps explicit consent mandatory for fixture setup: %s", async reason => {
    const app = await runtime();
    const consent = reason === "missing" ? undefined : reason === "false"
      ? { recipientConsent: false, previousBindingId: null }
      : { recipientConsent: true, previousBindingId: "old-binding" };
    await expect(app.service.seedFixtureMintRecipient(app.session, app.signature, app.account, now, consent))
      .rejects.toMatchObject({ code: reason === "stale snapshot" ? "BINDING_TRANSITION" : "REQUEST_CONFIRMATION_INVALID" });
    expect(app.session.mintRecipient).toBeUndefined();
    expect(app.state.getActiveBinding(app.account.xUserId, app.config.chainId)).toBeNull();
  });

  it.each(["logout", "account switch", "expired session", "another session"])("rejects proof completion after %s", async reason => {
    const app = await runtime();
    const challenge = await app.challenge();
    let session = app.session;
    if (reason === "logout") app.auth.logout(session.id);
    if (reason === "account switch") session.identity!.xUserId = "another-account";
    if (reason === "expired session") session.lastSeenAt = new Date(now.getTime() - SESSION_IDLE_TTL_MS - 1);
    if (reason === "another session") {
      session = app.auth.getOrCreateSession(null, now).session;
      session.identity = fixtureIdentity("alice", now);
    }
    await expect(app.service.confirmChallenge({ session, challengeId: challenge.challengeId,
      walletProof: await wallet.signMessage({ message: challenge.message }), now })).rejects.toMatchObject({
      code: reason === "logout" || reason === "expired session" ? "AUTH_REQUIRED" : "WALLET_CHALLENGE_INVALID",
    });
    expect(app.state.getActiveBinding(app.account.xUserId, app.config.chainId)).toBeNull();
  });

  it.each(["logout", "account switch"])("rechecks the app identity after wallet verification: %s", async reason => {
    let app: Awaited<ReturnType<typeof runtime>>;
    app = await runtime({ eoaVerifier: { async verify() {
      if (reason === "logout") app.auth.logout(app.session.id);
      else app.session.identity!.xUserId = "another-account";
      return { blockNumber: 1n, blockHash: `0x${"ab".repeat(32)}` };
    } } });
    const challenge = await app.challenge();
    await expect(app.service.confirmChallenge({ session: app.session, challengeId: challenge.challengeId,
      walletProof: await wallet.signMessage({ message: challenge.message }), now }))
      .rejects.toMatchObject({ code: reason === "logout" ? "AUTH_REQUIRED" : "NOT_CLAIMANT" });
    expect(app.session.mintRecipient).toBeUndefined();
    expect(app.state.getActiveBinding(app.account.xUserId, app.config.chainId)).toBeNull();
  });

  it("rejects an invalid wallet signature and replay, allowing a new explicit proof attempt", async () => {
    const app = await runtime();
    const first = await app.challenge();
    const otherWallet = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    await expect(app.service.confirmChallenge({ session: app.session, challengeId: first.challengeId,
      walletProof: await otherWallet.signMessage({ message: first.message }), now })).rejects.toMatchObject({ code: "WALLET_UNSUPPORTED" });
    expect(app.session.mintRecipient).toBeUndefined();
    await expect(app.service.confirmChallenge({ session: app.session, challengeId: first.challengeId,
      walletProof: await wallet.signMessage({ message: first.message }), now })).rejects.toMatchObject({ code: "WALLET_CHALLENGE_INVALID" });
    const next = await app.challenge();
    const proof = await wallet.signMessage({ message: next.message });
    await app.service.confirmChallenge({ session: app.session, challengeId: next.challengeId, walletProof: proof, now });
    await expect(app.service.confirmChallenge({ session: app.session, challengeId: next.challengeId, walletProof: proof, now }))
      .rejects.toMatchObject({ code: "WALLET_CHALLENGE_INVALID" });
    expect(app.state.exportSnapshot().bindingsById).toHaveLength(1);
  });

  it("supersedes an earlier recipient challenge within the same app session", async () => {
    const app = await runtime();
    const first = await app.challenge();
    const otherWallet = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const next = await app.challenge(app.signature, otherWallet.address);
    await expect(app.service.confirmChallenge({ session: app.session, challengeId: first.challengeId,
      walletProof: await wallet.signMessage({ message: first.message }), now })).rejects.toMatchObject({ code: "WALLET_CHALLENGE_INVALID" });
    const binding = await app.service.confirmChallenge({ session: app.session, challengeId: next.challengeId,
      walletProof: await otherWallet.signMessage({ message: next.message }), now });
    expect(binding.address).toBe(otherWallet.address);
    expect(app.session.mintRecipient?.address).toBe(otherWallet.address);
  });

  it("does not activate an in-flight older proof after a newer recipient challenge is issued", async () => {
    let app: Awaited<ReturnType<typeof runtime>>;
    let next: Awaited<ReturnType<typeof app.challenge>> | undefined;
    const otherWallet = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    app = await runtime({ eoaVerifier: { async verify() {
      if (!next) next = await app.challenge(app.signature, otherWallet.address);
      return { blockNumber: 1n, blockHash: `0x${"ab".repeat(32)}` };
    } } });
    const first = await app.challenge();
    await expect(app.service.confirmChallenge({ session: app.session, challengeId: first.challengeId,
      walletProof: await wallet.signMessage({ message: first.message }), now })).rejects.toMatchObject({ code: "WALLET_CHALLENGE_INVALID" });
    expect(app.state.getActiveBinding(app.account.xUserId, app.config.chainId)).toBeNull();
    expect(app.session.mintRecipient).toBeUndefined();
    const binding = await app.service.confirmChallenge({ session: app.session, challengeId: next!.challengeId,
      walletProof: await otherWallet.signMessage({ message: next!.message }), now });
    expect(binding.address).toBe(otherWallet.address);
  });

  it.each(["signed out", "wrong numeric ID", "other work", "replacement claim", "expired", "other session", "changed recipient"])("rejects an invalid draft: %s", async reason => {
    const app = await runtime();
    await app.prepare();
    let target = app.signature;
    let at = now;
    if (reason === "signed out") app.session.identity = null;
    if (reason === "wrong numeric ID") app.session.identity!.xUserId = "987654321";
    if (reason === "other work") target = app.works[1];
    if (reason === "replacement claim") app.session.mintRecipient!.claimInstanceId = "old-claim";
    if (reason === "expired") at = new Date(now.getTime() + 15 * 60_000);
    if (reason === "other session") app.session.mintRecipient!.sessionId = "other-session";
    if (reason === "changed recipient") app.session.mintRecipient!.address = "0x0000000000000000000000000000000000000001";
    await expect(app.issue(target, at)).rejects.toMatchObject({ code: reason === "signed out" ? "AUTH_REQUIRED" : reason === "wrong numeric ID" ? "NOT_CLAIMANT" : "MINT_RECIPIENT_REQUIRED" });
    expect(app.state.getStatus(target.signatureId, true).authorization).toBeNull();
  });

  it("requires an explicit reviewed snapshot and rejects stale address or binding before signing", async () => {
    const app = await runtime();
    await app.prepare();
    await expect(app.service.issueAuthorization(app.signature, app.account, now, app.session)).rejects.toMatchObject({ code: "REQUEST_CONFIRMATION_INVALID" });
    for (const review of [{ ...app.reviewed(), recipient: "0x0000000000000000000000000000000000000001" }, { ...app.reviewed(), walletBindingId: "stale-binding" }]) {
      await expect(app.service.issueAuthorization(app.signature, app.account, now, app.session, review)).rejects.toMatchObject({ code: "BINDING_TRANSITION" });
    }
    expect(app.state.getStatus(app.signature.signatureId, true).authorization).toBeNull();
  });

  it("accepts a renamed handle with the same original numeric claimant", async () => {
    const app = await runtime();
    await app.prepare();
    app.session.identity!.username = "RenamedAlice";
    await expect(app.issue()).resolves.toHaveProperty("authorization");
  });

  it("blocks another preparation while the first mint is unresolved and resumes the exact issued authorization after session restart", async () => {
    const app = await runtime();
    await app.prepare();
    const first = await app.issue();
    expect(app.state.hasUnresolvedBindingAuthorization(app.account.xUserId, app.config.chainId)).toBe(true);
    await expect(app.prepare(app.works[1])).rejects.toMatchObject({ code: "LIVE_AUTHORIZATION_EXISTS" });
    delete app.session.mintRecipient;
    expect(await app.issue()).toEqual(first);
    await expect(app.issue(app.works[1])).rejects.toMatchObject({ code: "MINT_RECIPIENT_REQUIRED" });
  });

  it("rechecks pending-authority safety after looking up a second mint target", async () => {
    const app = await runtime();
    await app.prepare();
    const originalGet = app.signatures.getSignature.bind(app.signatures);
    app.signatures.getSignature = async id => {
      if (id === app.works[1].signatureId) await app.issue();
      return originalGet(id);
    };
    await expect(app.challenge(app.works[1])).rejects.toMatchObject({ code: "LIVE_AUTHORIZATION_EXISTS" });
    expect(app.state.exportSnapshot().challenges).toHaveLength(0);
    expect(app.session.mintRecipient?.signatureId).toBe(app.signature.signatureId);
  });

  it("a recipient change cancels the earlier review without deleting historical proof", async () => {
    const app = await runtime();
    const first = await app.challenge();
    const oldBinding = await app.service.confirmChallenge({ session: app.session, challengeId: first.challengeId, walletProof: await wallet.signMessage({ message: first.message }), now });
    const oldReview = app.reviewed();
    const next = await app.challenge();
    expect(app.session.mintRecipient).toBeUndefined();
    await expect(app.issue()).rejects.toMatchObject({ code: "MINT_RECIPIENT_REQUIRED" });
    await app.service.confirmChallenge({ session: app.session, challengeId: next.challengeId, walletProof: await wallet.signMessage({ message: next.message }), now });
    expect(oldBinding.status).toBe("replaced");
    expect(app.state.exportSnapshot().bindingsById).toHaveLength(2);
    await expect(app.service.issueAuthorization(app.signature, app.account, now, app.session, oldReview)).rejects.toMatchObject({ code: "BINDING_TRANSITION" });
  });

  it("never upgrades a stale proof after the claim disappears during verification", async () => {
    let app: Awaited<ReturnType<typeof runtime>>;
    app = await runtime({ eoaVerifier: { async verify() {
      await app.signatures.withdraw(app.signature.signatureId, app.account.xUserId, app.signature.claimInstanceId);
      return { blockNumber: 1n, blockHash: `0x${"ab".repeat(32)}` };
    } } });
    const challenge = await app.challenge();
    await expect(app.service.confirmChallenge({ session: app.session, challengeId: challenge.challengeId, walletProof: await wallet.signMessage({ message: challenge.message }), now })).rejects.toMatchObject({ code: "MINT_INELIGIBLE" });
    expect(app.session.mintRecipient).toBeUndefined();
    expect(app.state.getActiveBinding(app.account.xUserId, app.config.chainId)).toBeNull();
  });

  it("allows another signature after the prior mint finalizes, but needs new explicit recipient consent and proof", async () => {
    const app = await runtime();
    await app.prepare();
    await app.issue();
    app.service.advanceFixture(app.signature.signatureId, app.account.xUserId);
    app.service.advanceFixture(app.signature.signatureId, app.account.xUserId);
    app.service.advanceFixture(app.signature.signatureId, app.account.xUserId);
    expect(app.state.hasUnresolvedBindingAuthorization(app.account.xUserId, app.config.chainId)).toBe(false);
    await expect(app.issue(app.works[1])).rejects.toMatchObject({ code: "MINT_RECIPIENT_REQUIRED" });
    await app.prepare(app.works[1]);
    await expect(app.issue(app.works[1])).resolves.toHaveProperty("authorization");
  });

  it.each(["metadata", "signing"])("does not release authority when the recipient draft changes during %s", async phase => {
    let app: Awaited<ReturnType<typeof runtime>>;
    const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    app = await runtime(phase === "signing" ? { signer: { address: signer.address, async sign(_id, _digest, authorization, config) {
      delete app.session.mintRecipient;
      return signer.signTypedData(mintAuthorizationTypedData({ chainId: config.chainId, verifyingContract: config.contract }, authorization));
    } } } : {});
    await app.prepare();
    if (phase === "metadata") {
      const originalGet = app.artifacts.get.bind(app.artifacts);
      app.artifacts.get = async key => { delete app.session.mintRecipient; return originalGet(key); };
    }
    await expect(app.issue()).rejects.toMatchObject({ code: "BINDING_TRANSITION" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization?.status ?? null).toBe(phase === "signing" ? "issued" : null);
  });

  it("retains an unresolved prepared authorization but never signs it without its exact recipient draft", async () => {
    const app = await runtime({ checkpoint: async () => { throw new Error("storage temporarily unavailable"); } });
    await app.prepare();
    await expect(app.issue()).rejects.toThrow("storage temporarily unavailable");
    const authorization = app.state.getStatus(app.signature.signatureId, true).authorization!;
    expect(authorization.status).toBe("prepared");
    delete app.session.mintRecipient;
    await expect(app.issue()).rejects.toMatchObject({ code: "MINT_RECIPIENT_REQUIRED" });
    await expect(app.prepare()).rejects.toMatchObject({ code: "LIVE_AUTHORIZATION_EXISTS" });
    expect(app.state.getStatus(app.signature.signatureId, true).authorization).toBe(authorization);
  });

  it("requires a new proof after an authorization reaches a safe terminal state", async () => {
    const app = await runtime();
    await app.prepare();
    await app.issue();
    const authorization = app.state.getStatus(app.signature.signatureId, true).authorization!;
    // Emulate the trusted finalized-chain reconciliation boundary, not a browser cancellation.
    authorization.status = "expired";
    Object.assign(app.state.getProjection(app.signature.signatureId), unmintedProjection(app.signature.signatureId));
    await expect(app.issue()).rejects.toMatchObject({ code: "MINT_RECIPIENT_REQUIRED" });
    await app.prepare();
    const next = await app.issue();
    expect(next.authorization.authorizationId).not.toBe(authorization.authorizationId);
  });
});
