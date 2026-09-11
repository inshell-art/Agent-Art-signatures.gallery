import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./server.js";
import { MemoryAuthState, type BrowserSession, type OAuthFlow } from "../v1/authState.js";
import { hasActionApproval, SESSION_IDLE_TTL_MS } from "../v1/authPolicy.js";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { fixtureIdentity, seedDevelopmentFixtures } from "../v1/fixtures.js";
import { CARD_RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore, type Signature } from "../v1/store.js";
import { loadMintConfig } from "../v2/config.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { V2MintService } from "../v2/service.js";

const ORIGIN = "http://127.0.0.1:3000";
const WALLET = "0x170AF4D923De5E3155067e104134C3b11d82E100";
let auth: MemoryAuthState, store: MemorySignatureStore, mint: V2MintService;
let app: ReturnType<typeof createApp>, signature: Signature, other: Signature;
let user: { id: string; username: string };
let lastFlow: OAuthFlow;
let onIdentity: () => Promise<void>;

beforeEach(async () => {
  auth = new MemoryAuthState(); store = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const renderers = new RendererRegistry([formalSignatureRenderer]);
  await seedDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: CARD_RENDERER_VERSION }, auth);
  user = { id: fixtureIdentity("alice").xUserId, username: "alice" };
  [signature, other] = await store.listSignaturesForAccount(user.id);
  mint = new V2MintService(loadMintConfig({}, true, ORIGIN), new MemoryMintStore(), store, artifacts);
  const startFlow = auth.startFlow.bind(auth);
  vi.spyOn(auth, "startFlow").mockImplementation((...args) => {
    const started = startFlow(...args); lastFlow = started.flow; return started;
  });
  onIdentity = async () => {};
  app = createApp({ auth, store, artifacts, renderers, mint }, {
    fixtureMode: true, publicOrigin: ORIGIN,
    oauthClient: {
      providerKind: "x",
      getAuthorizeUrl: (state, challenge) => `https://x.com/i/oauth2/authorize?state=${state}&code_challenge=${challenge}`,
      async exchangeCode() { return "test-only-provider-token"; },
      async getUser() { await onIdentity(); return user; },
    },
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Real request handler + OAuth state/callback; no live X, RPC, or browser account. */
async function request(path: string, session: BrowserSession | null = null, body?: URLSearchParams | Record<string, unknown>, overrides: { method?: string; headers?: Record<string, string> } = {}) {
  const form = body instanceof URLSearchParams;
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(form ? body.toString() : JSON.stringify(body))]), {
    url: path, method: overrides.method ?? (body ? "POST" : "GET"),
    headers: { host: new URL(ORIGIN).host, origin: ORIGIN, accept: "application/json",
      "sec-fetch-site": "same-origin", "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
      ...(session ? { cookie: `sg_dev_session=${session.id}`, "x-csrf-token": session.csrfToken } : {}), ...overrides.headers },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  const headers = new Map<string, string>();
  let text = "";
  const res = { statusCode: 200, setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); }, end(value?: string | Buffer) { text = value?.toString() ?? ""; } };
  await app(req, res as unknown as ServerResponse);
  return { status: res.statusCode, headers, text, json: headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
}
function login() {
  const session = auth.getOrCreateSession(null).session;
  session.identity = fixtureIdentity("alice", new Date(Date.now() - 3 * 60 * 60_000));
  return session;
}
function fields(session: BrowserSession | null, action = "wallet_link", extra: Record<string, string> = {}) {
  return new URLSearchParams({ purpose: "sensitive_action", action, ...(session?.identity ? { csrf: session.csrfToken } : {}), ...extra });
}
async function start(session: BrowserSession | null, form = fields(session)) {
  const response = await request("/auth/x/start", session, form);
  expect(response.status, response.text).toBe(302);
  const state = new URL(response.headers.get("location")!).searchParams.get("state")!;
  const sessionId = response.headers.get("set-cookie")?.split(";")[0].split("=")[1];
  return { state, session: sessionId ? auth.getSession(sessionId)! : session!, flow: lastFlow };
}
async function finish(started: Awaited<ReturnType<typeof start>>) {
  return request(`/auth/x/callback?state=${started.state}&code=test`, started.session);
}
function rotated(response: Awaited<ReturnType<typeof request>>) {
  expect(response.status, response.text).toBe(303);
  return auth.getSession(response.headers.get("set-cookie")!.split(";")[0].split("=")[1])!;
}
function withdrawFields(session: BrowserSession, target = signature) {
  return new URLSearchParams({ csrf: session.csrfToken, claim_instance: target.claimInstanceId, confirm: "withdraw" });
}

describe("action-specific X confirmation over the API", () => {
  it("keeps an older app sign-in usable without account-wide reauthentication", async () => {
    const session = login();
    const panel = await request("/api/v1/account-panel", session);
    expect(panel.status).toBe(200);
    expect(panel.json.html).toContain('<span>Log out</span></button>');
    expect(panel.json.html).not.toContain('aria-label="Wallet"');
    expect(panel.json.html).not.toMatch(/Reauthenticate|identity.*old|Refresh your X/);
    expect((await request("/me", session)).status).toBe(200);
    const binding = mint.seedFixtureBinding(user.id, (await store.getAccount(user.id))!.publicAccountId);
    const entry = await request(`/signatures/${signature.signatureId}/mint`, session);
    expect(entry.status).toBe(200);
    expect(entry.text).toContain('data-link-wallet');
    expect(entry.text).not.toContain('name="action" value="mint_recipient"');
    const authorization = await request(`/api/v2/signatures/${signature.signatureId}/mint-authorizations`, session, { walletBindingId: binding.walletBindingId, recipient: binding.address }, { headers: { "x-mint-permanence-acknowledged": "1" } });
    expect(authorization.status, authorization.text).toBe(401);
    expect(authorization.json.error.code).toBe("MINT_RECIPIENT_REQUIRED");
    expect(mint.state.getProjection(signature.signatureId).state).toBe("unminted");
    expect(mint.state.getProjection(signature.signatureId).tokenId).toBeNull();
  });

  it("counts the initial wallet-action sign-in as its X confirmation", async () => {
    const started = await start(null);
    const response = await finish(started);
    const session = rotated(response);
    expect(response.headers.get("location")).toBe("/me");
    expect(session.actionApproval?.intent).toEqual({ kind: "wallet_link", chainId: mint.config.chainId.toString(), previousBindingId: null });
    expect(started.session.identity).toBeNull();
    expect(session.actionApproval?.expiresAt).toEqual(started.flow.expiresAt);
    expect(mint.state.getActiveBinding(user.id, mint.config.chainId)).toBeNull();
    const panel = await request("/api/v1/account-panel", session);
    expect(panel.json.html).not.toContain("data-link-wallet");
    expect(panel.json.developmentHtml).not.toContain("Use simulated wallet");
    const challenge = await request("/api/v2/wallet-bindings/challenge", session, { walletAddress: WALLET, chainId: mint.config.chainId.toString() });
    expect(challenge.status, challenge.text).toBe(201);
    expect(session.actionApproval).toBeUndefined();
    expect(mint.state.getChallenge(challenge.json.challengeId)?.previousWalletBindingId).toBeNull();
    const repeat = await request("/api/v2/wallet-bindings/challenge", session, { walletAddress: WALLET, chainId: mint.config.chainId.toString() });
    expect(repeat.json.error.code).toBe("X_ACTION_CONFIRMATION_REQUIRED");
    expect(mint.state.getActiveBinding(user.id, mint.config.chainId)).toBeNull();
  });

  it("does not grant wallet or withdrawal authority from ordinary account login", async () => {
    const session = rotated(await finish(await start(null, new URLSearchParams({ purpose: "account_login" }))));
    expect(session.actionApproval).toBeUndefined();
    expect((await request("/dev/v2/wallet-bindings/seed", session, {})).json.error.code).toBe("X_ACTION_CONFIRMATION_REQUIRED");
    expect((await request(`/signatures/${signature.signatureId}/withdraw`, session, withdrawFields(session))).json.error.code).toBe("X_ACTION_CONFIRMATION_REQUIRED");
  });

  it("signs a returning wallet owner in without granting replacement consent", async () => {
    const binding = mint.seedFixtureBinding(user.id, (await store.getAccount(user.id))!.publicAccountId);
    const path = `/signatures/${signature.signatureId}/mint`;
    const session = rotated(await finish(await start(null, fields(null, "wallet_link", { return_to: path }))));
    expect(session.identity?.xUserId).toBe(user.id);
    expect(session.actionApproval).toBeUndefined();
    expect(mint.state.getActiveBinding(user.id, mint.config.chainId)?.walletBindingId).toBe(binding.walletBindingId);
    expect((await request(path, session)).status).toBe(200);
    const panel = await request("/api/v1/account-panel", session);
    expect(panel.json.html).not.toContain("Replace wallet");
    expect((await request(path, session)).text).toContain('data-link-wallet');
  });

  it("scopes developer recipient tools to an approved exact mint, never the account panel", async () => {
    const original = login();
    const path = `/signatures/${signature.signatureId}/mint`;
    const session = rotated(await finish(await start(original, fields(original, "mint_recipient", {
      signature_id: signature.signatureId, claim_instance: signature.claimInstanceId, return_to: path,
    }))));
    const panel = await request(`/api/v1/account-panel?return_to=${encodeURIComponent(path)}`, session);
    expect(panel.json.html).not.toContain("data-link-wallet");
    expect(panel.json.developmentHtml).toContain(`data-signature-id="${signature.signatureId}"`);
    for (const query of ["return_to=https://attacker.invalid", `return_to=${encodeURIComponent(path)}&return_to=/me`]) {
      expect((await request(`/api/v1/account-panel?${query}`, session)).json.developmentHtml).not.toContain("data-link-wallet");
    }
  });

  it("keeps withdrawal retry context when a grant or app session expires", async () => {
    const session = login();
    const path = `/signatures/${signature.signatureId}`;
    const unconfirmed = await request(`${path}/withdraw`, session, withdrawFields(session), { headers: { accept: "text/html" } });
    expect(unconfirmed.status).toBe(401);
    expect(unconfirmed.text).toContain(`href="${path}#withdraw"`);
    expect(unconfirmed.text).not.toContain('name="purpose" value="account_login"');
    auth.logout(session.id);
    const expired = await request(`${path}/withdraw`, session, withdrawFields(session), { headers: { accept: "text/html" } });
    expect(expired.status).toBe(401);
    expect(expired.text).toContain(`name="return_to" value="${path}"`);
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
  });

  it("binds withdrawal to the exact claim and keeps the final confirmation after OAuth", async () => {
    const original = login();
    const response = await finish(await start(original, fields(original, "claim_withdraw", { signature_id: signature.signatureId, claim_instance: signature.claimInstanceId })));
    const session = rotated(response);
    expect(response.headers.get("location")).toBe(`/signatures/${signature.signatureId}#withdraw`);
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
    const html = (await request(`/signatures/${signature.signatureId}`, session)).text;
    expect(html).toContain('id="withdraw"');
    expect(html).toContain('data-withdraw-confirmation');
    expect((await request(`/signatures/${other.signatureId}/withdraw`, session, withdrawFields(session, other))).json.error.code).toBe("X_ACTION_CONFIRMATION_REQUIRED");
    expect((await request("/dev/v2/wallet-bindings/seed", session, {})).json.error.code).toBe("X_ACTION_CONFIRMATION_REQUIRED");
    expect(session.actionApproval).toBeDefined();
    expect((await request(`/signatures/${signature.signatureId}/withdraw`, session, withdrawFields(session))).status).toBe(200);
    expect(session.actionApproval).toBeUndefined();
    expect(await store.getSignature(signature.signatureId)).toBeNull();
    expect(await store.getSignature(other.signatureId)).not.toBeNull();
  });

  it("rejects a different numeric X account without replacing the original session", async () => {
    const session = login();
    const started = await start(session);
    user = { id: fixtureIdentity("bob").xUserId, username: "alice" };
    const response = await finish(started);
    expect(response.status).toBe(403);
    expect(response.json.error.code).toBe("NOT_CLAIMANT");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(session.identity?.xUserId).toBe(signature.xUserId);
    expect(session.actionApproval).toBeUndefined();
  });

  it("accepts a renamed handle when the numeric X account is unchanged", async () => {
    const original = login();
    const started = await start(original);
    user.username = "alice_studio";
    const session = rotated(await finish(started));
    expect(session.identity?.xUserId).toBe(signature.xUserId);
    expect(session.identity?.username).toBe("alice_studio");
    expect((await store.getAccount(user.id))?.currentHandle).toBe("alice_studio");
    expect(session.actionApproval?.xUserId).toBe(signature.xUserId);
  });

  it("rejects a replaced claim instance on OAuth return", async () => {
    const session = login();
    const started = await start(session, fields(session, "claim_withdraw", { signature_id: signature.signatureId, claim_instance: signature.claimInstanceId }));
    await store.withdraw(signature.signatureId, user.id, signature.claimInstanceId);
    const replacement = await store.claim({ ...signature, claimedAt: new Date() });
    expect(replacement.signature.claimInstanceId).not.toBe(signature.claimInstanceId);
    const response = await finish(started);
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe("CLAIM_CHANGED");
    expect(session.actionApproval).toBeUndefined();
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
  });

  it("rejects a changed binding on OAuth return and grants revoke only for the current binding", async () => {
    const original = login();
    const started = await start(original);
    const binding = mint.seedFixtureBinding(user.id, (await store.getAccount(user.id))!.publicAccountId);
    expect((await finish(started)).json.error.code).toBe("BINDING_TRANSITION");
    const response = await finish(await start(original, fields(original, "wallet_revoke")));
    const session = rotated(response);
    expect(session.actionApproval?.intent).toEqual({ kind: "wallet_revoke", chainId: mint.config.chainId.toString(), previousBindingId: binding.walletBindingId });
    expect((await request("/dev/v2/wallet-bindings/seed", session, {})).json.error.code).toBe("X_ACTION_CONFIRMATION_REQUIRED");
    expect((await request("/api/v2/wallet-bindings/current", session, undefined, { method: "DELETE" })).status).toBe(200);
    expect(mint.state.getActiveBinding(user.id, mint.config.chainId)).toBeNull();
    expect(session.actionApproval).toBeUndefined();
  });

  it("starts replacement consent against the server's binding snapshot, not client values", async () => {
    const session = login();
    const binding = mint.seedFixtureBinding(user.id, (await store.getAccount(user.id))!.publicAccountId);
    const started = await start(session, fields(session, "wallet_link", { chain_id: "1", previous_binding_id: "client-forgery" }));
    expect(started.flow.actionIntent).toEqual({ kind: "wallet_link", chainId: mint.config.chainId.toString(), previousBindingId: binding.walletBindingId });
    expect(rotated(await finish(started)).actionApproval?.intent).toEqual(started.flow.actionIntent);
  });

  it("separates idle session expiry from action confirmation expiry", async () => {
    const oldSession = login();
    oldSession.lastSeenAt = new Date(Date.now() - SESSION_IDLE_TTL_MS - 1);
    expect((await request("/dev/v2/wallet-bindings/seed", oldSession, {})).json.error.code).toBe("AUTH_REQUIRED");
    const started = await start(login());
    const session = rotated(await finish(started));
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + 15 * 60_000 + 1);
    expect((await request("/me", session)).status).toBe(200);
    expect((await request("/dev/v2/wallet-bindings/seed", session, {})).json.error.code).toBe("X_ACTION_CONFIRMATION_REQUIRED");
  });

  it("retains the 15-minute OAuth deadline and one-use callback state", async () => {
    const started = await start(login());
    started.flow.expiresAt = new Date(Date.now() - 1);
    const expired = await finish(started);
    expect(expired.json.error.code).toBe("INVALID_OAUTH_STATE");
    const next = await start(login());
    const session = rotated(await finish(next));
    expect((await finish(next)).status).toBe(400);
    expect(hasActionApproval(session, session.actionApproval!.intent)).toBe(true);
  });

  it("cannot grant consent if the original browser logs out while X is responding", async () => {
    const original = login();
    const started = await start(original);
    onIdentity = async () => { auth.logout(original.id); };
    const response = await finish(started);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(original.identity).toBeNull();
    expect(original.actionApproval).toBeUndefined();
  });

  it.each([
    ["missing csrf", (s: BrowserSession) => fields(s, "wallet_link", { csrf: "" })],
    ["mixed claim intent", (s: BrowserSession) => fields(s, "wallet_link", { claim_intent: "claim-on-return-v1" })],
    ["mixed renderer intent", (s: BrowserSession) => fields(s, "wallet_link", { renderer_version: "v1.0.0" })],
    ["unknown action", (s: BrowserSession) => fields(s, "everything")],
    ["external redirect", (s: BrowserSession) => fields(s, "wallet_link", { return_to: "https://attacker.invalid/" })],
    ["duplicate action", (s: BrowserSession) => { const f = fields(s); f.append("action", "wallet_revoke"); return f; }],
    ["claim target in wallet action", (s: BrowserSession) => fields(s, "wallet_link", { signature_id: "other" })],
  ])("rejects invalid action start: %s", async (_name, form) => {
    const session = login();
    const response = await request("/auth/x/start", session, form(session));
    expect([400, 403]).toContain(response.status);
    expect(auth.startFlow).not.toHaveBeenCalled();
    expect(session.actionApproval).toBeUndefined();
  });

  it("requires same-origin action start and rejects anonymous revoke/withdraw", async () => {
    const session = login();
    expect((await request("/auth/x/start", session, fields(session), { headers: { origin: "https://attacker.invalid" } })).status).toBe(403);
    for (const action of ["wallet_revoke", "claim_withdraw"]) expect((await request("/auth/x/start", null, fields(null, action))).status).toBe(401);
  });

  it("distinguishes CSRF errors from an expired app session", async () => {
    const session = login();
    const response = await request("/dev/v2/wallet-bindings/seed", session, {}, { headers: { "x-csrf-token": "wrong" } });
    expect(response.status).toBe(403);
    expect(response.json.error.code).toBe("REQUEST_CONFIRMATION_INVALID");
    expect(auth.getSession(session.id)?.identity).not.toBeNull();
  });
});
