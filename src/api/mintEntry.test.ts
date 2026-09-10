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

function identity(xUserId = claimant, stale = false) {
  const { session } = auth.getOrCreateSession(null);
  session.identity = { xUserId, username: xUserId === claimant ? "alice" : "bob", handleNormalized: xUserId === claimant ? "alice" : "bob", authenticatedAt: new Date(Date.now() - (stale ? 16 * 60_000 : 0)) };
  return { cookie: `sg_dev_session=${session.id}`, csrf: session.csrfToken };
}
function form(path: string, body: URLSearchParams, cookie?: string) {
  return fetch(base + path, { method: "POST", redirect: "manual", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body });
}
async function writeAuthorization(who?: ReturnType<typeof identity>) {
  return fetch(`${base}/api/v2/signatures/${signatureId}/mint-authorizations`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-Mint-Permanence-Acknowledged": "1", ...(who ? { Cookie: who.cookie, "X-CSRF-Token": who.csrf } : {}) }, body: "{}" });
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

  it.each(["sign-in", "reauthenticate", "wrong-account", "wallet", "paused"] as const)("guides %s without preparing metadata or authorizing", async stage => {
    const who = stage === "sign-in" ? undefined : identity(stage === "wrong-account" ? "999" : claimant, stage === "reauthenticate");
    if (stage === "paused") mint.config.enabled = false;
    const snapshot = mint.state.exportSnapshot();
    const metadata = vi.spyOn(mint, "previewMetadata");
    const issue = vi.spyOn(mint, "issueAuthorization");
    const response = await fetch(base + mintPath, { headers: who ? { Cookie: who.cookie } : {} });
    const html = await response.text();
    expect(response.status).toBe(stage === "sign-in" || stage === "reauthenticate" ? 401 : stage === "wrong-account" ? 403 : stage === "paused" ? 503 : 200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain(`data-mint-entry="${stage}"`);
    expect(html).toContain("Minting is optional");
    expect(html).not.toContain('class="mint-authorization-form"');
    const entry = html.match(/<div data-mint-entry=[\s\S]*?<\/main>/)![0];
    if (stage === "wallet") expect(entry).toContain("data-link-wallet");
    else expect(entry).not.toContain("data-link-wallet");
    if (["sign-in", "reauthenticate", "wrong-account"].includes(stage)) {
      expect(entry).toContain(`name="return_to" value="${mintPath}"`);
      expect(entry).toContain('name="purpose" value="account_login"');
    }
    expect(mint.state.exportSnapshot()).toEqual(snapshot);
    expect(metadata).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    const denied = await writeAuthorization(who);
    expect(denied.status).toBe(stage === "paused" ? 503 : stage === "sign-in" || stage === "reauthenticate" ? 401 : 403);
    expect(mint.state.exportSnapshot()).toEqual(snapshot);
  });

  it("keeps the destination through OAuth, wallet linking, and the exact mint review", async () => {
    const count = (await store.listSignaturesForAccount(claimant)).length;
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
    const csrf = entry.match(/name="csrf" value="([^"]+)"/)![1];
    const linked = await fetch(base + "/dev/v2/wallet-bindings/seed", { method: "POST", headers: { Origin: base, Cookie: rotatedCookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ chainId: mint.config.chainId.toString() }) });
    expect(linked.status).toBe(201);
    const review = await (await fetch(base + mintPath, { headers: { Cookie: rotatedCookie } })).text();
    expect(review).toContain("Authorize this exact work.");
    expect(review).toContain('name="permanence_acknowledged"');
    expect(review).not.toContain("data-mint-entry");
    expect(mint.state.getProjection(signatureId).state).toBe("unminted");
    expect((await store.listSignaturesForAccount(claimant)).length).toBe(count);
  });

  it.each(["https://evil.example", "//evil.example", "/me", "/signatures/invalid/mint", "/signatures/sg1_" + "a".repeat(52) + "/mint?next=https://evil.example", "/signatures/sg1_" + "a".repeat(52) + "/mint#x"])("rejects an unapproved OAuth return destination: %s", async return_to => {
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
});
