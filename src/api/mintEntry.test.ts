import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "./server.js";
import { MemoryAuthState } from "../v1/authState.js";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemorySignatureStore } from "../v1/store.js";
import { seedDevelopmentFixtures } from "../v1/fixtures.js";
import { CARD_RENDERER_VERSION, RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { loadMintConfig } from "../v2/config.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { V2MintService } from "../v2/service.js";
import { seedV2DevelopmentFixtures } from "../v2/fixtures.js";
import { SESSION_IDLE_TTL_MS } from "../v1/authPolicy.js";

const claimant = "1234567890123456789";
let server: ReturnType<typeof startServer>;
let base: string;
let auth: MemoryAuthState;
let store: MemorySignatureStore;
let mint: V2MintService;
let signatureId: string;
let mintPath: string;

beforeEach(async () => {
  store = new MemorySignatureStore();
  auth = new MemoryAuthState();
  const artifacts = new MemoryArtifactStore();
  const renderers = new RendererRegistry([formalSignatureRenderer]);
  await seedDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: CARD_RENDERER_VERSION }, auth);
  mint = new V2MintService(loadMintConfig({}, true, "http://localhost:3000"), new MemoryMintStore(), store, artifacts);
  signatureId = (await store.listSignaturesForAccount(claimant))[0].signatureId;
  mintPath = `/signatures/${signatureId}/mint`;
  server = startServer({ store, auth, artifacts, renderers, mint }, 0, { fixtureMode: true, activeRendererVersion: RENDERER_VERSION });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
});

function identity(xUserId = claimant, olderIdentity = false) {
  const { session } = auth.getOrCreateSession(null);
  session.identity = { xUserId, username: xUserId === claimant ? "alice" : "bob", handleNormalized: xUserId === claimant ? "alice" : "bob", authenticatedAt: new Date(Date.now() - (olderIdentity ? 16 * 60_000 : 0)) };
  return { session, cookie: `sg_dev_session=${session.id}`, csrf: session.csrfToken };
}
function form(path: string, body: URLSearchParams, cookie?: string) {
  return fetch(base + path, { method: "POST", redirect: "manual", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body });
}
async function writeAuthorization(who?: ReturnType<typeof identity>) {
  const binding = mint.state.getActiveBinding(claimant, mint.config.chainId);
  return fetch(`${base}/api/v2/signatures/${signatureId}/mint-authorizations`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Mint-Permanence-Acknowledged": "1", ...(who ? { Cookie: who.cookie, "X-CSRF-Token": who.csrf } : {}) }, body: JSON.stringify({ walletBindingId: binding?.walletBindingId ?? "0x" + "00".repeat(32), recipient: binding?.address ?? "0x" + "00".repeat(20) }) });
}

async function proveRecipient(who: ReturnType<typeof identity>) {
  const signature = (await store.getSignature(signatureId))!;
  const account = (await store.getAccount(claimant))!;
  return mint.seedFixtureMintRecipient(who.session, signature, account, new Date(), {
    recipientConsent: true, previousBindingId: mint.state.getActiveBinding(claimant, mint.config.chainId)?.walletBindingId ?? null,
  });
}

describe("guided mint entry", () => {
  it("hides owner-only minting on an unminted public signature", async () => {
    const response = await fetch(`${base}/signatures/${signatureId}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(html).not.toContain(`href="${mintPath}"`);
    expect(html).not.toContain("Only the original claimant can mint");
    expect(html).not.toContain('name="csrf"');
  });

  it.each(["sign-in", "wrong-account", "wallet", "paused"] as const)("guides %s without preparing metadata or authorizing", async stage => {
    const who = stage === "sign-in" ? undefined : identity(stage === "wrong-account" ? "999" : claimant);
    if (stage === "paused") mint.config.enabled = false;
    const snapshot = mint.state.exportSnapshot();
    const metadata = vi.spyOn(mint, "previewMetadata");
    const issue = vi.spyOn(mint, "issueAuthorization");
    const response = await fetch(base + mintPath, { headers: who ? { Cookie: who.cookie } : {} });
    const html = await response.text();
    expect(response.status).toBe(stage === "sign-in" ? 401 : stage === "wrong-account" ? 403 : stage === "paused" ? 503 : 200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain(`data-mint-entry="${stage}"`);
    expect(html).toContain("Minting is optional");
    expect(html).not.toContain('class="mint-authorization-form"');
    const entry = html.match(/<div data-mint-entry=[\s\S]*?<\/main>/)![0];
    if (stage === "wallet") {
      expect(entry).toContain("data-link-wallet");
      expect(entry).toContain('<span>Connect wallet</span></button>');
      expect(entry).not.toContain('action="/auth/x/start"');
    } else expect(entry).not.toContain("data-link-wallet");
    if (["sign-in", "wrong-account"].includes(stage)) {
      expect(entry).toContain(`name="return_to" value="${mintPath}"`);
      expect(entry).toContain('name="purpose" value="account_login"');
      expect(entry).not.toContain('name="action" value="mint_recipient"');
    }
    expect(mint.state.exportSnapshot()).toEqual(snapshot);
    expect(metadata).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    const denied = await writeAuthorization(who);
    expect(denied.status).toBe(stage === "paused" ? 503 : stage === "sign-in" ? 401 : 403);
    expect(mint.state.exportSnapshot()).toEqual(snapshot);
  });

  it("keeps older identities signed in and asks only for the specific missing wallet action", async () => {
    const who = identity(claimant, true);
    const response = await fetch(base + mintPath, { headers: { Cookie: who.cookie } });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-mint-entry="wallet"');
    expect(html).toContain('<span>Connect wallet</span></button>');
    expect(html).not.toContain("Reauthenticate with X");
    expect(html).not.toContain('data-mint-entry="reauthenticate"');
    expect(auth.getSession(who.session.id)?.identity?.xUserId).toBe(claimant);
  });

  it("treats an existing proven wallet as convenience, not authority for a new mint", async () => {
    const who = identity(claimant, true);
    const account = (await store.getAccount(claimant))!;
    mint.seedFixtureBinding(claimant, account.publicAccountId);
    expect(who.session.actionApproval).toBeUndefined();
    const review = await fetch(base + mintPath, { headers: { Cookie: who.cookie } });
    expect(review.status).toBe(200);
    expect(await review.text()).toContain('data-mint-entry="wallet"');
    const denied = await writeAuthorization(who);
    expect(denied.status).toBe(401);
    expect((await denied.json()).error.code).toBe("MINT_RECIPIENT_REQUIRED");
    await proveRecipient(who);
    expect(await (await fetch(base + mintPath, { headers: { Cookie: who.cookie } })).text()).toContain('class="mint-authorization-form"');
    const authorization = await writeAuthorization(who);
    expect(authorization.status).toBe(201);
    expect((await authorization.json()).authorization.authorizationId).toBeTruthy();
  });

  it("shows sign-in, not action confirmation, when the app session has expired", async () => {
    const who = identity();
    who.session.lastSeenAt = new Date(Date.now() - SESSION_IDLE_TTL_MS - 1);
    const response = await fetch(base + mintPath, { headers: { Cookie: who.cookie } });
    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain('data-mint-entry="sign-in"');
    expect(html).not.toContain('data-mint-entry="reauthenticate"');
    const authorization = await writeAuthorization(who);
    expect(authorization.status).toBe(401);
    expect((await authorization.json()).error.code).toBe("AUTH_REQUIRED");
  });

  it("offers recipient change without X OAuth but never changes or reuses authority on GET", async () => {
    const who = identity(claimant, true);
    await proveRecipient(who);
    const before = mint.state.exportSnapshot();
    const draft = { ...who.session.mintRecipient! };
    const entry = await (await fetch(base + mintPath + "?recipient=change", { headers: { Cookie: who.cookie } })).text();
    expect(entry).toContain('data-mint-entry="wallet"');
    expect(entry).toContain('data-link-wallet');
    expect(entry).not.toContain('name="action" value="mint_recipient"');
    expect(who.session.mintRecipient).toEqual(draft);
    expect(mint.state.exportSnapshot()).toEqual(before);
    await writeAuthorization(who);
    const resume = await (await fetch(base + mintPath + "?recipient=change", { headers: { Cookie: who.cookie } })).text();
    expect(resume).not.toContain('data-mint-entry="wallet"');
    expect(resume).not.toContain('data-link-wallet');
    expect(resume).toContain("Confirm in wallet");
  });

  it("keeps the exact mint through signed-out OAuth, recipient proof, and review", async () => {
    const count = (await store.listSignaturesForAccount(claimant)).length;
    const signature = (await store.getSignature(signatureId))!;
    const start = await form("/auth/x/start", new URLSearchParams({ purpose: "account_login", return_to: mintPath }));
    expect(start.status).toBe(302);
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const request = new URL(start.headers.get("location")!, base).searchParams.get("request")!;
    const decision = await form("/dev/oauth/x/authorize", new URLSearchParams({ request, decision: "approve", account: "alice" }));
    const callback = await fetch(base + decision.headers.get("location"), { redirect: "manual", headers: { Cookie: cookie } });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(mintPath);
    const rotatedCookie = callback.headers.get("set-cookie")!.split(";")[0];
    expect(rotatedCookie).not.toBe(cookie);
    const entry = await (await fetch(base + mintPath, { headers: { Cookie: rotatedCookie } })).text();
    expect(entry).toContain('data-mint-entry="wallet"');
    expect(entry).toContain("data-link-wallet");
    expect(entry).toContain("Connect wallet");
    expect(entry).toContain(`data-signature-id="${signatureId}"`);
    expect(entry).not.toContain("X confirmed.");
    const csrf = entry.match(/name="csrf" value="([^"]+)"/)![1];
    const linked = await fetch(base + "/dev/v2/wallet-bindings/seed", { method: "POST", headers: { Origin: base, Cookie: rotatedCookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ chainId: mint.config.chainId.toString(), signatureId, claimInstanceId: signature.claimInstanceId, recipientConsent: true, previousBindingId: null }) });
    expect(linked.status).toBe(201);
    const review = await (await fetch(base + mintPath, { headers: { Cookie: rotatedCookie } })).text();
    expect(review).toContain("Authorize this exact work.");
    expect(review).toContain('name="permanence_acknowledged"');
    expect(review).not.toContain("data-mint-entry");
    expect(mint.state.getProjection(signatureId).state).toBe("unminted");
    expect((await store.listSignaturesForAccount(claimant)).length).toBe(count);
  });

  it("permits the explicit My Collection return destination without granting action consent", async () => {
    const response = await form("/auth/x/start", new URLSearchParams({ purpose: "account_login", return_to: "/me" }));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).not.toBeNull();
  });

  it.each(["https://evil.example", "//evil.example", "/signatures/invalid/mint", "/signatures/sg1_" + "a".repeat(52) + "/mint?next=https://evil.example", "/signatures/sg1_" + "a".repeat(52) + "/mint#x"])("rejects an unapproved OAuth return destination: %s", async return_to => {
    const response = await form("/auth/x/start", new URLSearchParams({ purpose: "account_login", return_to }));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects duplicate return targets and claim-flow return overrides", async () => {
    const duplicate = new URLSearchParams({ purpose: "account_login", return_to: mintPath });
    duplicate.append("return_to", mintPath);
    expect((await form("/auth/x/start", duplicate)).status).toBe(400);
    expect((await form("/auth/x/start", new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "50", return_to: mintPath }))).status).toBe(400);
  });

  it("shows pending confirmation instead of soliciting another wallet or authorization", async () => {
    await seedV2DevelopmentFixtures(mint, store);
    const included = (await store.listSignaturesForAccount(claimant))[1];
    const who = identity();
    const metadata = vi.spyOn(mint, "previewMetadata");
    const response = await fetch(`${base}/signatures/${included.signatureId}/mint`, { headers: { Cookie: who.cookie } });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-mint-entry="pending"');
    expect(html).not.toContain('class="mint-authorization-form"');
    expect(metadata).not.toHaveBeenCalled();
  });

  it("supports HEAD without a body or session and redirects finalized works to provenance", async () => {
    const head = await fetch(base + mintPath, { method: "HEAD" });
    expect(head.status).toBe(401);
    expect(await head.text()).toBe("");
    expect(head.headers.get("set-cookie")).toBeNull();
    await seedV2DevelopmentFixtures(mint, store);
    const finalized = (await store.listSignaturesForAccount(claimant))[2];
    const response = await fetch(`${base}/signatures/${finalized.signatureId}/mint`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/signatures/${finalized.signatureId}`);
  });

  it("rejects a wrong X account on a signed-out mint-specific OAuth callback", async () => {
    const signature = (await store.getSignature(signatureId))!;
    const before = mint.state.exportSnapshot();
    const start = await form("/auth/x/start", new URLSearchParams({ purpose: "sensitive_action", action: "mint_recipient", signature_id: signatureId, claim_instance: signature.claimInstanceId, return_to: mintPath }));
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const request = new URL(start.headers.get("location")!, base).searchParams.get("request")!;
    const decision = await form("/dev/oauth/x/authorize", new URLSearchParams({ request, decision: "approve", account: "bob" }));
    const callback = await fetch(base + decision.headers.get("location"), { redirect: "manual", headers: { Cookie: cookie } });
    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain("NOT_CLAIMANT");
    expect(mint.state.exportSnapshot()).toEqual(before);
  });

  it.each(["deny", "provider_error"])("does not change bindings or authorize when X returns %s", async decision => {
    const signature = (await store.getSignature(signatureId))!;
    const before = mint.state.exportSnapshot();
    const start = await form("/auth/x/start", new URLSearchParams({ purpose: "sensitive_action", action: "mint_recipient", signature_id: signatureId, claim_instance: signature.claimInstanceId, return_to: mintPath }));
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const request = new URL(start.headers.get("location")!, base).searchParams.get("request")!;
    const provider = await form("/dev/oauth/x/authorize", new URLSearchParams({ request, decision, account: "alice" }));
    const callback = await fetch(base + provider.headers.get("location"), { redirect: "manual", headers: { Cookie: cookie } });
    expect(callback.status).toBeGreaterThanOrEqual(400);
    expect(mint.state.exportSnapshot()).toEqual(before);
  });

  it.each(["csrf", "duplicate", "claim", "return"])("rejects a tampered mint OAuth %s before creating a grant", async variant => {
    const who = identity();
    const signature = (await store.getSignature(signatureId))!;
    const body = new URLSearchParams({ purpose: "sensitive_action", action: "mint_recipient", signature_id: signatureId,
      claim_instance: signature.claimInstanceId, return_to: mintPath, csrf: who.csrf });
    if (variant === "csrf") body.set("csrf", "wrong");
    if (variant === "duplicate") body.append("signature_id", signatureId);
    if (variant === "claim") body.set("claim_instance", "00000000-0000-0000-0000-000000000000");
    if (variant === "return") body.set("return_to", "/me");
    const response = await form("/auth/x/start", body, who.cookie);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("location")).toBeNull();
    expect(who.session.actionApproval).toBeUndefined();
    expect(who.session.mintRecipient).toBeUndefined();
  });

  it("requires the exact reviewed recipient snapshot before creating an authorization", async () => {
    const who = identity();
    const binding = await proveRecipient(who);
    const before = mint.state.exportSnapshot();
    for (const body of [{}, { walletBindingId: binding.walletBindingId, recipient: "0x" + "12".repeat(20) },
      { walletBindingId: "0x" + "ab".repeat(32), recipient: binding.address }]) {
      const response = await fetch(`${base}/api/v2/signatures/${signatureId}/mint-authorizations`, { method: "POST",
        headers: { Origin: base, Cookie: who.cookie, "X-CSRF-Token": who.csrf, "X-Mint-Permanence-Acknowledged": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect([400, 409]).toContain(response.status);
      expect(mint.state.exportSnapshot()).toEqual(before);
    }
  });

  it("resumes the same issued mint after sign-in without exposing recipient changes", async () => {
    const who = identity();
    await proveRecipient(who);
    const issued = await (await writeAuthorization(who)).json();
    auth.logout(who.session.id);
    const returned = identity();
    const html = await (await fetch(base + mintPath, { headers: { Cookie: returned.cookie } })).text();
    expect(html).toContain("Confirm in wallet");
    expect(html).not.toContain("Change recipient");
    expect(returned.session.mintRecipient).toBeUndefined();
    const retried = await writeAuthorization(returned);
    expect(retried.status).toBe(201);
    expect((await retried.json()).authorization.authorizationId).toBe(issued.authorization.authorizationId);
    const signature = (await store.getSignature(signatureId))!;
    const change = await form("/auth/x/start", new URLSearchParams({ purpose: "sensitive_action", action: "mint_recipient", signature_id: signatureId,
      claim_instance: signature.claimInstanceId, return_to: mintPath, csrf: returned.csrf }), returned.cookie);
    expect(change.status).toBe(409);
  });

  it("does not reuse a proof for another signature and allows a later mint after the first finalizes", async () => {
    const who = identity();
    const first = signatureId;
    const second = (await store.listSignaturesForAccount(claimant))[1];
    await proveRecipient(who);
    const secondPage = () => fetch(`${base}/signatures/${second.signatureId}/mint`, { headers: { Cookie: who.cookie } });
    expect(await (await secondPage()).text()).toContain('data-mint-entry="wallet"');
    expect((await writeAuthorization(who)).status).toBe(201);
    const pending = await (await secondPage()).text();
    expect(pending).toContain('data-mint-entry="pending"');
    expect(pending).not.toContain('data-link-wallet');
    mint.advanceFixture(first, claimant);
    mint.advanceFixture(first, claimant);
    mint.advanceFixture(first, claimant);
    expect(mint.state.getProjection(first).state).toBe("finalized");
    signatureId = second.signatureId;
    expect(await (await secondPage()).text()).toContain('data-mint-entry="wallet"');
    expect((await writeAuthorization(who)).status).toBe(401);
    await proveRecipient(who);
    expect((await writeAuthorization(who)).status).toBe(201);
    expect(mint.state.getProjection(first).state).toBe("finalized");
    expect(mint.state.getProjection(second.signatureId).state).toBe("authorized");
  });
});
