import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "./server.js";
import { CLAIM_ON_RETURN_INTENT, MemoryAuthState } from "../v1/authState.js";
import { formatGr0k } from "../v1/input.js";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemorySignatureStore, type Signature } from "../v1/store.js";
import { seedDevelopmentFixtures } from "../v1/fixtures.js";
import { CARD_RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { loadMintConfig } from "../v2/config.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { V2MintService } from "../v2/service.js";
import { unmintedProjection, type MintState, type AuthorizationStatus } from "../v2/model.js";
import { withdrawClaim } from "../v1/withdrawClaim.js";
import { LocalMintRuntime } from "../local/mintRuntime.js";
import { createLocalClaimWithdrawalRunner } from "../local/claimWithdrawalRuntime.js";
import { V2Error } from "../v2/errors.js";

const claimant = "1234567890123456789";
let server: ReturnType<typeof startServer>, base: string, auth: MemoryAuthState, store: MemorySignatureStore;
let mint: V2MintService, artifacts: MemoryArtifactStore, signature: Signature;
let queue: LocalMintRuntime, requireChainReady: ReturnType<typeof vi.fn<() => Promise<void>>>;
let persist: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(async () => {
  store = new MemorySignatureStore(); auth = new MemoryAuthState(); artifacts = new MemoryArtifactStore();
  const renderers = new RendererRegistry([formalSignatureRenderer]);
  await seedDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: CARD_RENDERER_VERSION }, auth);
  signature = (await store.listSignaturesForAccount(claimant))[0];
  mint = new V2MintService(loadMintConfig({}, true, "http://localhost:3000"), new MemoryMintStore(), store, artifacts);
  requireChainReady = vi.fn(async () => {});
  persist = vi.fn(async () => {});
  queue = new LocalMintRuntime({ assertOwnership() {}, persist });
  server = startServer({ store, auth, artifacts, renderers, mint }, 0, {
    fixtureMode: true,
    runMintOperation: operation => queue.run(async () => { await requireChainReady(); return operation(); }),
    runClaimWithdrawalOperation: createLocalClaimWithdrawalRunner({ queue, mintState: mint.state, requireChainReady }),
  });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); });

function login(xUserId = claimant, stale = false) {
  const { session } = auth.getOrCreateSession(null);
  session.identity = { xUserId, username: "alice", handleNormalized: "alice", authenticatedAt: new Date(Date.now() - (stale ? 16 * 60_000 : 0)) };
  return { session, cookie: `sg_dev_session=${session.id}` };
}
function request(who = login(), overrides: Record<string, string> = {}, origin = base) {
  return fetch(`${base}/signatures/${signature.signatureId}/withdraw`, { method: "POST", redirect: "manual",
    headers: { Origin: origin, Cookie: who.cookie, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ csrf: who.session.csrfToken, claim_instance: signature.claimInstanceId, confirm: "withdraw", ...overrides }) });
}
async function issue(status: AuthorizationStatus = "issued") {
  mint.seedFixtureBinding(claimant, (await store.getAccount(claimant))!.publicAccountId);
  const account = (await store.getAccount(claimant))!;
  const response = await mint.issueAuthorization(signature, account);
  const snapshot = mint.state.exportSnapshot();
  snapshot.authorizations[0][1].status = status;
  snapshot.projections = [[signature.signatureId, unmintedProjection(signature.signatureId)]];
  mint.state.replaceSnapshot(snapshot);
  return response;
}

describe("claim withdrawal", () => {
  it("serves the confirmation script without requiring a session", async () => {
    const response = await fetch(base + "/assets/withdraw-claim.js?v=test");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain('trigger.type = "button"');
    expect((await fetch(base + "/assets/withdraw-claim.js", { method: "HEAD" })).status).toBe(200);
  });
  it("withdraws a never-authorized claim during an RPC outage without a chain call", async () => {
    requireChainReady.mockRejectedValue(new V2Error(503, "CHAIN_UNAVAILABLE", "Local RPC offline"));
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, redirect: "/me" });
    expect(requireChainReady).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
    expect(await store.getSignature(signature.signatureId)).toBeNull();
    expect(await (await fetch(base + "/?tab=claimed")).text()).not.toContain(`href="/signatures/${signature.signatureId}"`);
  });

  it.each(["prepared", "issued", "signing_unknown", "expired", "consumed"] as AuthorizationStatus[])("requires current chain evidence for %s authority during an outage", async status => {
    await issue(status);
    requireChainReady.mockRejectedValue(new V2Error(503, "CHAIN_UNAVAILABLE", "Local RPC offline"));
    expect((await request()).status).toBe(503);
    expect(requireChainReady).toHaveBeenCalledOnce();
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
    expect(mint.state.hasMintAuthorizationHistory(signature.signatureId)).toBe(true);
  });

  it("does not let an unrelated signature's mint history block database-only withdrawal", async () => {
    await issue();
    const authorized = signature;
    signature = (await store.listSignaturesForAccount(claimant))[1];
    requireChainReady.mockRejectedValue(new V2Error(503, "CHAIN_UNAVAILABLE", "Local RPC offline"));
    expect((await request()).status).toBe(200);
    expect(requireChainReady).not.toHaveBeenCalled();
    expect(await store.getSignature(authorized.signatureId)).not.toBeNull();
    expect(mint.state.hasMintAuthorizationHistory(authorized.signatureId)).toBe(true);
  });

  it("checks authorization history after earlier queued mint work, not before", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const earlier = queue.run(async () => { await gate; await issue(); });
    const operation = vi.fn(async () => {});
    const run = createLocalClaimWithdrawalRunner({ queue, mintState: mint.state, requireChainReady });
    requireChainReady.mockRejectedValue(new V2Error(503, "CHAIN_UNAVAILABLE", "Local RPC offline"));
    const withdrawal = expect(run(signature.signatureId, operation)).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    release(); await earlier; await withdrawal;
    expect(operation).not.toHaveBeenCalled();
    expect(requireChainReady).toHaveBeenCalledOnce();
  });

  it("still rejects a database-only withdrawal when persistence fails", async () => {
    persist.mockRejectedValue(new Error("Database unavailable"));
    const operation = vi.fn(async () => "deleted");
    const run = createLocalClaimWithdrawalRunner({ queue, mintState: mint.state, requireChainReady });
    await expect(run(signature.signatureId, operation)).rejects.toThrow("Database unavailable");
    await expect(run(signature.signatureId, operation)).rejects.toThrow("restart is required");
    expect(operation).toHaveBeenCalledOnce();
    expect(requireChainReady).not.toHaveBeenCalled();
  });

  it("deletes the row and both listings, but retains the account and other claims", async () => {
    const who = login(); auth.setClaimNotice(who.session, signature.signatureId);
    const count = (await store.listClaimedSignatures(100)).length;
    const response = await request(who);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ deleted: true, redirect: "/me" });
    expect(await store.getSignature(signature.signatureId)).toBeNull();
    expect(await store.getAccount(claimant)).not.toBeNull();
    expect(await store.listClaimedSignatures(100)).toHaveLength(count - 1);
    expect(await (await fetch(base + "/?tab=claimed")).text()).not.toContain(`href="/signatures/${signature.signatureId}"`);
    expect(await (await fetch(base + "/me", { headers: { Cookie: who.cookie } })).text()).not.toContain(`href="/signatures/${signature.signatureId}"`);
    for (const path of [`/signatures/${signature.signatureId}`, `/artifacts/${signature.signatureId}.svg`, `/artifacts/${signature.signatureId}.png`]) expect((await fetch(base + path)).status).toBe(404);
    expect((await fetch(base + `/s/${signature.handleNormalized}/82`)).status).toBe(200);
    expect(auth.takeClaimNotice(who.session, signature.signatureId)).toBe(false);
    expect(mint.state.isSuppressed(signature.signatureId)).toBe(false);
  });

  it("creates a genuinely new claim and refuses a stale withdrawal form", async () => {
    const who = login(); expect((await request(who)).status).toBe(200);
    const next = await store.claim({ ...signature, claimedAt: new Date() });
    expect(next.existing).toBe(false);
    expect(next.signature.signatureId).toBe(signature.signatureId);
    expect(next.signature.claimInstanceId).not.toBe(signature.claimInstanceId);
    expect((await request(who)).status).toBe(409);
    expect(await store.getSignature(signature.signatureId)).toEqual(next.signature);
    expect((await request(who, { claim_instance: next.signature.claimInstanceId })).status).toBe(200);
  });

  it("keeps shared artifact bytes and detaches only the removed claim reference", async () => {
    const spy = vi.spyOn(artifacts, "releaseReference");
    const bytes = await artifacts.get(signature.svgStorageKey);
    await artifacts.putVerified("svg", bytes!, { signatureId: (await store.listSignaturesForAccount(claimant))[1].signatureId });
    expect((await request()).status).toBe(200);
    expect(spy).toHaveBeenCalledWith("svg", signature.svgStorageKey, signature.signatureId);
    expect(await artifacts.get(signature.svgStorageKey)).toEqual(bytes);
  });

  it("uses the ordinary OAuth claim path after deletion, with no restore concept", async () => {
    const who = login(); expect((await request(who)).status).toBe(200);
    const post = (path: string, fields: Record<string, string>, cookie?: string) => fetch(base + path, {
      method: "POST", redirect: "manual", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(fields),
    });
    const start = await post("/auth/x/start", { purpose: "claim", handle: signature.handleNormalized,
      gr0k: formatGr0k(signature.gr0kRaw), claim_intent: CLAIM_ON_RETURN_INTENT,
      renderer_version: signature.rendererVersion, preview_sha256: signature.svgSha256 }, who.cookie);
    expect(start.status).toBe(302);
    const approval = await post("/dev/oauth/x/authorize", { request: new URL(start.headers.get("location")!, base).searchParams.get("request")!, decision: "approve", account: "alice" });
    const callback = await fetch(base + approval.headers.get("location"), { redirect: "manual", headers: { Cookie: who.cookie } });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`/signatures/${signature.signatureId}`);
    const fresh = (await store.getSignature(signature.signatureId))!;
    expect(fresh.claimInstanceId).not.toBe(signature.claimInstanceId);
    expect(fresh.claimedAt.getTime()).toBeGreaterThan(signature.claimedAt.getTime());
    expect((await fetch(`${base}/artifacts/${signature.signatureId}.svg`)).status).toBe(200);
    expect(mint.state.getProjection(signature.signatureId).state).toBe("unminted");
  });

  it("only shows owner controls, privately cached, with an explicit confirmation", async () => {
    const owner = login();
    for (const who of [undefined, login("999"), owner]) {
      const response = await fetch(`${base}/signatures/${signature.signatureId}`, { headers: who ? { Cookie: who.cookie } : {} });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
      const html = await response.text();
      expect(html.includes('data-withdraw-control')).toBe(who === owner);
      expect(html.includes('class="signature-mint-entry"')).toBe(who === owner);
      if (who === owner) {
        expect(html).toContain('name="confirm" value="withdraw"');
        expect(html).toContain('>Confirm withdrawal</span>');
        expect(html).toContain('type="button" data-withdraw-cancel hidden');
        expect(html).toContain('id="withdraw-work">@alice · gr0k 82');
        expect(html).toContain("This removes the claim from Claimed and My Collection.");
        expect(html).toContain('<summary>Withdraw claim</summary><p id="withdraw-description">This removes the claim from Claimed and My Collection. You can make a new claim later.</p><div data-withdraw-confirmation>');
        const confirmation = html.split("<div data-withdraw-confirmation>")[1]!.split("</details>")[0]!;
        expect(confirmation).toContain("Withdraw this claim?");
        expect(confirmation).not.toContain("withdraw-description");
        expect(confirmation).not.toContain("This removes the claim");
      } else expect(html).not.toContain(signature.claimInstanceId);
    }
  });

  it("rejects signed-out, wrong-account (even same handle), stale, cross-site, and unconfirmed requests", async () => {
    expect((await fetch(`${base}/signatures/${signature.signatureId}/withdraw`, { method: "POST" })).status).toBe(401);
    expect((await request(login("999"))).status).toBe(403);
    expect((await request(login(claimant, true))).status).toBe(401);
    expect((await request(login(), {}, "https://attacker.example")).status).toBe(403);
    expect((await request(login(), { csrf: "wrong" })).status).toBe(403);
    expect((await request(login(), { confirm: "" })).status).toBe(403);
    expect((await request(login(), { claim_instance: "malformed" })).status).toBe(403);
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
  });

  it("GET and HEAD cannot withdraw a claim", async () => {
    for (const method of ["GET", "HEAD"]) expect((await fetch(`${base}/signatures/${signature.signatureId}/withdraw`, { method, headers: { Cookie: login().cookie } })).status).toBe(404);
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
  });

  it.each(["csrf", "claim_instance", "confirm"])("rejects missing and duplicated %s fields without deleting anything", async field => {
    const who = login();
    for (const mode of ["missing", "duplicate", "conflicting"]) {
      const body = new URLSearchParams({ csrf: who.session.csrfToken, claim_instance: signature.claimInstanceId, confirm: "withdraw" });
      if (mode === "missing") body.delete(field);
      else body.append(field, mode === "duplicate" ? body.get(field)! : "other");
      const response = await fetch(`${base}/signatures/${signature.signatureId}/withdraw`, {
        method: "POST", redirect: "manual",
        headers: { Origin: base, Cookie: who.cookie, Accept: "application/json" }, body,
      });
      expect(response.status).toBe(403);
      expect(await store.getSignature(signature.signatureId)).toEqual(signature);
    }
    expect(persist).not.toHaveBeenCalled();
    expect(requireChainReady).not.toHaveBeenCalled();
  });

  it("rejects another session's CSRF token even for the same X account", async () => {
    const first = login(), second = login();
    expect((await request(second, { csrf: first.session.csrfToken })).status).toBe(403);
    expect(await store.getSignature(signature.signatureId)).toEqual(signature);
    expect(persist).not.toHaveBeenCalled();
  });

  it("supports the native HTML form and redirects only after withdrawal succeeds", async () => {
    const who = login();
    const page = await (await fetch(`${base}/signatures/${signature.signatureId}`, { headers: { Cookie: who.cookie } })).text();
    const form = page.match(/<form method="post" action="([^"]+\/withdraw)">([\s\S]*?)<\/form>/)!;
    expect(form).not.toBeNull();
    const fields = new URLSearchParams();
    for (const [, name, value] of form[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)) fields.append(name, value);
    expect(fields.get("confirm")).toBe("withdraw");
    const response = await fetch(base + form[1], {
      method: "POST", redirect: "manual", headers: { Cookie: who.cookie, Origin: base, Accept: "text/html" }, body: fields,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/me");
    expect(await store.getSignature(signature.signatureId)).toBeNull();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("requires reauthentication instead of rendering a stale owner's delete form", async () => {
    const who = login(claimant, true);
    const page = await (await fetch(`${base}/signatures/${signature.signatureId}`, { headers: { Cookie: who.cookie } })).text();
    expect(page).toContain("<summary>Withdraw claim</summary>");
    expect(page).toContain("Sign in with X again");
    expect(page).toContain('class="signature-mint-entry"');
    expect(page).toContain('name="purpose" value="account_login"');
    expect(page).not.toContain("data-withdraw-confirmation");
    expect(page).not.toContain('name="confirm" value="withdraw"');
    expect(await store.getSignature(signature.signatureId)).toEqual(signature);
  });

  it("accepts only one of two concurrent confirmations for the same claim", async () => {
    const who = login();
    const responses = await Promise.all([request(who), request(who)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await store.getSignature(signature.signatureId)).toBeNull();
    expect((await request(who)).status).toBe(409);
  });

  it.each(["authorized", "finalized"] as MintState[])("exposes no usable withdrawal form for %s claims", async state => {
    const snapshot = mint.state.exportSnapshot();
    snapshot.projections = [[signature.signatureId, { ...unmintedProjection(signature.signatureId), state }]];
    mint.state.replaceSnapshot(snapshot);
    const who = login();
    const page = await (await fetch(`${base}/signatures/${signature.signatureId}`, { headers: { Cookie: who.cookie } })).text();
    expect(page).not.toContain("data-withdraw-control");
    expect(page).not.toContain('name="confirm" value="withdraw"');
    if (state === "authorized") expect(page).toContain('disabled title="Wait for the pending mint');
    expect(await store.getSignature(signature.signatureId)).toEqual(signature);
  });

  it.each(["authorized", "submitted", "included_unfinalized", "finalized", "validation_pending", "quarantined", "finality_revoked"] as MintState[])("blocks %s mint state", async state => {
    const snapshot = mint.state.exportSnapshot();
    snapshot.projections = [[signature.signatureId, { ...unmintedProjection(signature.signatureId), state }]];
    mint.state.replaceSnapshot(snapshot);
    expect((await request()).status).toBe(409);
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
  });

  it.each(["prepared", "issued", "signing_unknown", "signing_failed", "revoked", "consumed"] as AuthorizationStatus[])("blocks %s authorization even when the projection says unminted", async status => {
    await issue(status);
    expect((await request()).status).toBe(409);
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
  });

  it("allows reconciled expiry and deletes stale metadata before a fresh mint", async () => {
    await issue("expired");
    const previous = mint.state.getMetadata(signature.signatureId)!;
    expect((await request()).status).toBe(200);
    expect(mint.state.getStatus(signature.signatureId, true).authorization).toBeNull();
    expect(mint.state.getMetadata(signature.signatureId)).toBeNull();
    const fresh = await store.claim({ ...signature, claimedAt: new Date() });
    await mint.issueAuthorization(fresh.signature, fresh.account);
    expect(mint.state.getMetadata(signature.signatureId)!.metadataSha256).not.toBe(previous.metadataSha256);
  });

  it("does not treat a wall-clock deadline as reconciled expiry", async () => {
    await issue();
    const snapshot = mint.state.exportSnapshot();
    snapshot.authorizations[0][1].deadline = 1000n;
    mint.state.replaceSnapshot(snapshot);
    expect((await request()).status).toBe(409);
  });

  it("serializes withdrawal against authorization and rejects stale mint input", async () => {
    mint.seedFixtureBinding(claimant, (await store.getAccount(claimant))!.publicAccountId);
    const account = (await store.getAccount(claimant))!;
    const result = await Promise.allSettled([
      withdrawClaim({ store, artifacts, mintState: mint.state }, { signatureId: signature.signatureId, xUserId: claimant, claimInstanceId: signature.claimInstanceId }),
      mint.issueAuthorization(signature, account),
    ]);
    expect(result.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(mint.state.getStatus(signature.signatureId, true).authorization).toBeNull();
    await store.claim({ ...signature, claimedAt: new Date() });
    await expect(mint.issueAuthorization(signature, account)).rejects.toMatchObject({ code: "MINT_INELIGIBLE" });
  });

  it("keeps the claim when mint authorization wins the race", async () => {
    mint.seedFixtureBinding(claimant, (await store.getAccount(claimant))!.publicAccountId);
    const account = (await store.getAccount(claimant))!;
    const result = await Promise.allSettled([
      mint.issueAuthorization(signature, account),
      withdrawClaim({ store, artifacts, mintState: mint.state }, { signatureId: signature.signatureId, xUserId: claimant, claimInstanceId: signature.claimInstanceId }),
    ]);
    expect(result.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(await store.getSignature(signature.signatureId)).not.toBeNull();
  });
});
