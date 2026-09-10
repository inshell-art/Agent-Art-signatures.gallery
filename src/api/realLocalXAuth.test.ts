import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, type AppOptions } from "./server.js";
import { loadLocalAppConfig, localXOAuthClient } from "../local/xAuthConfig.js";
import { generateCodeChallenge } from "../claim/xOAuthClient.js";
import { MemoryAuthState } from "../v1/authState.js";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemorySignatureStore } from "../v1/store.js";
import { developmentFixtureRenderer, RendererRegistry } from "../v1/renderer.js";
import { loadMintConfig } from "../v2/config.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { V2MintService } from "../v2/service.js";
import { SlidingWindowLimits } from "../v1/limits.js";

// Exercise the real client + app boundary, intercepting only api.x.com.
// No credentials or requests to a live X account are involved in these tests.
const nativeFetch = globalThis.fetch;
const testUser = { id: "1230987654321098765", username: "Real_Test" };
let server: ReturnType<typeof startServer>;
let base: string;
let auth: MemoryAuthState;
let store: MemorySignatureStore;
let mint: V2MintService;
let artifacts: MemoryArtifactStore;
let renderers: RendererRegistry;
let options: AppOptions;
let providerStatus: number;
let identityStatus: number;
let providerCalls: Array<{ url: string; init?: RequestInit }>;

beforeEach(async () => {
  providerStatus = 200;
  identityStatus = 200;
  providerCalls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).origin === "https://api.x.com") {
      providerCalls.push({ url, init });
      const status = url.endsWith("/users/me") ? identityStatus : providerStatus;
      if (status !== 200) return new Response("sensitive-provider-diagnostic", { status });
      return Response.json(url.endsWith("/oauth2/token") ? { access_token: "test-access-token" } : { data: testUser });
    }
    if (new URL(url).hostname !== "127.0.0.1") throw new Error("Unexpected external test request");
    return nativeFetch(input, init);
  });
  store = new MemorySignatureStore();
  auth = new MemoryAuthState();
  artifacts = new MemoryArtifactStore();
  renderers = new RendererRegistry([developmentFixtureRenderer]);
  const config = loadLocalAppConfig({ X_OAUTH_CLIENT_ID: "test-client", X_OAUTH_CLIENT_SECRET: "test-secret" }, ["--x-auth=real"]);
  mint = new V2MintService(loadMintConfig({}, true, config.appOrigin), new MemoryMintStore(), store, artifacts);
  options = { fixtureMode: true, localChainRehearsal: true, enforcePublicOrigin: true, publicOrigin: config.appOrigin, oauthClient: localXOAuthClient(config) };
  server = startServer({ store, auth, artifacts, renderers, mint }, 0, options);
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  options.publicOrigin = base;
  config.oauth!.redirectUri = `${base}/auth/x/callback`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cookieOf(response: Response): string { return response.headers.get("set-cookie")!.split(";")[0]; }
function post(path: string, fields: Record<string, string>, cookie = "", headers: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", redirect: "manual", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, ...headers }, body: new URLSearchParams(fields) });
}
async function begin(fields = { purpose: "account_login" } as Record<string, string>) {
  const response = await post("/auth/x/start", fields);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://x.com/i/oauth2/authorize");
  expect(location.searchParams.get("redirect_uri")).toBe(base + "/auth/x/callback");
  expect(location.searchParams.get("scope")).toBe("users.read tweet.read");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.toString()).not.toContain("test-secret");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax");
  expect(response.headers.get("set-cookie")).not.toContain("; Secure");
  return { cookie: cookieOf(response), state: location.searchParams.get("state")!, challenge: location.searchParams.get("code_challenge")! };
}
function callback(start: Awaited<ReturnType<typeof begin>>, suffix = "&code=test-code", cookie = start.cookie) {
  return fetch(`${base}/auth/x/callback?state=${start.state}${suffix}`, { redirect: "manual", headers: { Cookie: cookie } });
}
async function claim() {
  const started = await begin({ purpose: "claim", handle: "real_test", gr0k: "0.371924" });
  const authenticated = await callback(started);
  expect(authenticated.status).toBe(303);
  const cookie = cookieOf(authenticated);
  const review = await fetch(base + authenticated.headers.get("location"), { headers: { Cookie: cookie } });
  const html = await review.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const flow = html.match(/name="flow" value="([^"]+)"/)![1];
  return { cookie, csrf, flow, html, returnPath: authenticated.headers.get("location")! };
}

/** Read the real preview form: consent must originate in the displayed CTA. */
async function claimFields(handle = "real_test", gr0k = "0.371924") {
  const html = await (await fetch(`${base}/s/${handle}/${gr0k}`)).text();
  const form = html.match(/<form[^>]*action="\/auth\/x\/start"[^>]*>[\s\S]*?<\/form>/)![0];
  expect(form).toContain("Claim with X");
  const fields = Object.fromEntries([...form.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]));
  expect(fields.claim_intent).toBe("claim-on-return-v1");
  expect(fields.preview_sha256).toMatch(/^[a-f0-9]{64}$/);
  return fields;
}

describe("explicit sign-in-and-claim consent", () => {
  it("saves the exact work before OAuth returns, lists it in both galleries and never mints", async () => {
    const fields = await claimFields();
    const start = await begin(fields);
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
    const response = await callback(start);
    expect(response.status).toBe(303);
    const cookie = cookieOf(response);
    expect(cookie).not.toBe(start.cookie);
    const saved = await store.listSignaturesForAccount(testUser.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ handleNormalized: "real_test", gr0kRaw: 371924, rendererVersion: fields.renderer_version, svgSha256: fields.preview_sha256 });
    const path = response.headers.get("location")!;
    expect(path).toBe(`/signatures/${saved[0].signatureId}`);
    for (let repeat = 0; repeat < 2; repeat++) {
      const page = await fetch(base + path, { headers: { Cookie: cookie } });
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toContain("no-store");
      const html = await page.text();
      expect(html).toContain('data-signature-status="claimed"');
      expect(html).not.toContain('action="/api/v1/signatures"');
      expect(html).not.toContain("Confirm claim");
    }
    for (const destination of ["/me", "/?tab=claimed"]) {
      expect(await (await fetch(base + destination, { headers: { Cookie: cookie } })).text()).toContain(`/signatures/${saved[0].signatureId}`);
    }
    expect(mint.state.exportSnapshot().authorizations).toEqual([]);
    expect((await callback(start, "&code=test-code", cookie)).status).toBe(400);
    expect(providerCalls).toHaveLength(2);
    expect(await store.listClaimedSignatures(20)).toHaveLength(1);
  });

  it("makes a second explicitly authorized OAuth flow idempotent", async () => {
    const fields = await claimFields();
    for (let i = 0; i < 2; i++) expect((await callback(await begin(fields))).status).toBe(303);
    expect(await store.listClaimedSignatures(20)).toHaveLength(1);
  });

  it("delivers success once to the claiming browser, never through public HTML or a query flag", async () => {
    const response = await callback(await begin(await claimFields()));
    const cookie = cookieOf(response);
    const path = response.headers.get("location")!;
    const signatureId = path.slice("/signatures/".length);
    const endpoint = `/api/v1/signatures/${signatureId}/claim-notice`;
    const readNotice = (sessionCookie = cookie, suffix = "") => fetch(base + endpoint + suffix, { headers: { Cookie: sessionCookie } });
    const other = `sg_dev_session=${auth.getOrCreateSession(null).session.id}`;
    for (const sessionCookie of ["", other]) {
      const anonymous = await readNotice(sessionCookie, "?claimed=true");
      expect(await anonymous.json()).toEqual({ show: false });
      expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
      expect(anonymous.headers.get("vary")).toBe("Cookie");
      expect(anonymous.headers.get("set-cookie")).toBeNull();
    }
    for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { Origin: "https://evil.invalid" }] as Array<Record<string, string>>) {
      expect((await fetch(base + endpoint, { headers: { ...headers, Cookie: cookie } })).status).toBe(403);
    }
    const head = await fetch(base + endpoint, { method: "HEAD", headers: { Cookie: cookie } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const wrong = await fetch(`${base}/api/v1/signatures/sg1_${"a".repeat(52)}/claim-notice`, { headers: { Cookie: cookie } });
    expect(await wrong.json()).toEqual({ show: false });
    const publicHtml = await (await fetch(base + path + "?claimed=true")).text();
    const privateHtml = await (await fetch(base + path, { headers: { Cookie: cookie } })).text();
    const withoutOwnerControls = privateHtml
      .replace(/<section class="claim-withdrawal" data-withdraw-control>[\s\S]*?<\/section>/, "")
      .replace(/<div class="signature-mint-entry">[\s\S]*?<\/div>/, "")
      .replace(/<script src="[^"]*action-tooltip\.js[^"]*" defer><\/script>/, "");
    expect(withoutOwnerControls).toBe(publicHtml);
    expect(publicHtml).not.toContain('class="signature-mint-entry"');
    expect(publicHtml).not.toContain('name="claim_instance"');
    expect(publicHtml).not.toContain('name="csrf"');
    expect(publicHtml).toContain(`data-claim-notice="${endpoint}" hidden`);
    expect(publicHtml).not.toContain("Claimed. This signature is now");
    expect(publicHtml).not.toContain("?flow=");
    expect(await (await readNotice()).json()).toEqual({ show: true });
    expect(await (await readNotice()).json()).toEqual({ show: false });
    const asset = await fetch(base + "/assets/claim-notice.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
  });

  it("expires feedback and does not announce old completed flow links again", async () => {
    const prepared = await claim();
    const response = await post("/api/v1/signatures", { flow: prepared.flow, csrf: prepared.csrf }, prepared.cookie);
    const destination = response.headers.get("location")!;
    const signatureId = destination.slice("/signatures/".length);
    const endpoint = `${base}/api/v1/signatures/${signatureId}/claim-notice`;
    const session = auth.getSession(prepared.cookie.split("=")[1])!;
    expect(session.claimNotice?.signatureId).toBe(signatureId);
    session.claimNotice!.expiresAt = new Date(0);
    expect(await (await fetch(endpoint, { headers: { Cookie: prepared.cookie } })).json()).toEqual({ show: false });
    const oldLink = await fetch(base + prepared.returnPath, { headers: { Cookie: prepared.cookie }, redirect: "manual" });
    expect(oldLink.status).toBe(303);
    expect(oldLink.headers.get("location")).toBe(destination);
    expect(oldLink.headers.get("cache-control")).toBe("no-store");
    expect(await (await fetch(endpoint, { headers: { Cookie: prepared.cookie } })).json()).toEqual({ show: false });
  });

  it.each(["purpose", "unknown-intent", "missing-digest", "changed-digest", "changed-handle", "changed-gr0k"])("rejects %s before starting OAuth", async scenario => {
    const fields = await claimFields();
    if (scenario === "purpose") fields.purpose = "account_login";
    if (scenario === "unknown-intent") fields.claim_intent = "anything";
    if (scenario === "missing-digest") delete fields.preview_sha256;
    if (scenario === "changed-digest") fields.preview_sha256 = "0".repeat(64);
    if (scenario === "changed-handle") fields.handle = "someone_else";
    if (scenario === "changed-gr0k") fields.gr0k = "0.820000";
    expect([400, 409]).toContain((await post("/auth/x/start", fields)).status);
    expect(providerCalls).toHaveLength(0);
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
  });

  it.each<Record<string, string>>([{ Origin: "https://evil.invalid" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }])("rejects cross-origin consent %j", async headers => {
    expect((await post("/auth/x/start", await claimFields(), "", headers)).status).toBe(403);
    expect(providerCalls).toHaveLength(0);
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
  });

  it("rejects duplicate consent fields", async () => {
    const body = new URLSearchParams(await claimFields());
    body.append("claim_intent", "claim-on-return-v1");
    const response = await fetch(base + "/auth/x/start", { method: "POST", redirect: "manual", headers: { Origin: base }, body });
    expect(response.status).toBe(400);
    expect(providerCalls).toHaveLength(0);
  });

  it("never claims as a mismatched X account", async () => {
    const response = await callback(await begin(await claimFields("someone_else")));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("HANDLE_MISMATCH");
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
  });

  it.each(["denial", "exchange", "identity", "duplicate-state", "other-browser", "expired"])("does not persist on %s", async scenario => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const started = await begin(await claimFields());
    if (scenario === "exchange") providerStatus = 503;
    if (scenario === "identity") identityStatus = 503;
    if (scenario === "expired") {
      const beginCallback = auth.beginCallback.bind(auth);
      vi.spyOn(auth, "beginCallback").mockImplementation((session, state) => beginCallback(session, state, new Date(Date.now() + 16 * 60_000)));
    }
    const suffix = scenario === "denial" ? "&error=access_denied" : scenario === "duplicate-state" ? `&state=${started.state}&code=test-code` : "&code=test-code";
    const cookie = scenario === "other-browser" ? `sg_dev_session=${auth.getOrCreateSession(null).session.id}` : started.cookie;
    expect([400, 403, 503]).toContain((await callback(started, suffix, cookie)).status);
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
  });

  it.each(["database", "artifacts"])("keeps successful sign-in and offers a CSRF-protected retry after %s failure", async failing => {
    const started = await begin(await claimFields());
    if (failing === "database") vi.spyOn(store, "claim").mockRejectedValueOnce(new Error("private database diagnostic"));
    else vi.spyOn(artifacts, "putVerified").mockRejectedValueOnce(new Error("private asset diagnostic"));
    const response = await callback(started);
    expect(response.status).toBe(303);
    const cookie = cookieOf(response);
    expect(auth.getSession(cookie.split("=")[1])?.identity?.xUserId).toBe(testUser.id);
    const path = response.headers.get("location")!;
    const failed = await fetch(base + path, { headers: { Cookie: cookie } });
    expect(failed.status).toBe(503);
    const html = await failed.text();
    expect(html).toContain('data-claim-state="retry"');
    expect(html).toContain("Your X sign-in succeeded, but the claim could not be saved.");
    expect(html).not.toMatch(/private (?:database|asset) diagnostic|X_AUTH_UNAVAILABLE|data-signature-status="claimed"/);
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const flow = html.match(/name="flow" value="([^"]+)"/)![1];
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
    expect((await post("/api/v1/signatures", { flow, csrf: "wrong" }, cookie)).status).toBe(403);
    expect(auth.getSession(cookie.split("=")[1])?.claimNotice).toBeUndefined();
    const retried = await post("/api/v1/signatures", { flow, csrf }, cookie);
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toMatch(/^\/signatures\/sg1_[a-z2-7]{52}$/);
    expect(auth.getSession(cookie.split("=")[1])?.claimNotice).toBeDefined();
    expect(await store.listClaimedSignatures(20)).toHaveLength(1);
    const recovered = await fetch(base + path, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(recovered.status).toBe(303);
    expect(recovered.headers.get("location")).toBe(`/signatures/${(await store.listSignaturesForAccount(testUser.id))[0].signatureId}`);
    expect(providerCalls).toHaveLength(2);
  });

  it("does not claim altered renderer bytes after OAuth", async () => {
    const start = await begin(await claimFields());
    const original = developmentFixtureRenderer.render.bind(developmentFixtureRenderer);
    vi.spyOn(developmentFixtureRenderer, "render").mockImplementation(input => {
      const output = original(input);
      return { ...output, svgUtf8: Buffer.from(Buffer.from(output.svgUtf8).toString() + "<!-- changed -->") };
    });
    const response = await callback(start);
    expect(response.status).toBe(303);
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
    const page = await fetch(base + response.headers.get("location"), { headers: { Cookie: cookieOf(response) } });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('data-claim-state="retry"');
  });

  it("preserves artwork when a claim commits but its acknowledgement fails", async () => {
    const start = await begin(await claimFields());
    const release = vi.spyOn(artifacts, "releaseReference");
    const commit = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async input => {
      await commit(input);
      throw new Error("Lost database acknowledgement");
    });
    const response = await callback(start);
    expect(response.status).toBe(303);
    const saved = await store.listSignaturesForAccount(testUser.id);
    expect(saved).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
    const page = await fetch(base + response.headers.get("location"), { headers: { Cookie: cookieOf(response) } });
    expect(page.status).toBe(200);
    expect(page.url).toBe(`${base}/signatures/${saved[0].signatureId}`);
    expect(await page.text()).toContain('data-signature-status="claimed"');
    for (const extension of ["svg", "png"]) expect((await fetch(`${base}/artifacts/${saved[0].signatureId}.${extension}`)).status).toBe(200);
  });

  it("applies claim rate limits to the callback without misreporting failed authentication", async () => {
    const start = await begin(await claimFields());
    const consume = SlidingWindowLimits.prototype.consume;
    vi.spyOn(SlidingWindowLimits.prototype, "consume").mockImplementation(function (this: SlidingWindowLimits, ...args) {
      return args[0] === "claim-x" ? false : consume.apply(this, args);
    });
    const response = await callback(start);
    expect(response.status).toBe(303);
    const page = await fetch(base + response.headers.get("location"), { headers: { Cookie: cookieOf(response) } });
    expect(page.status).toBe(429);
    expect(await page.text()).toContain("Your X sign-in succeeded, but the claim limit was reached.");
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
  });
});

describe("real X authentication in the local app", () => {
  it("shows real-provider notes only in DEV and allows the X form redirect under CSP", async () => {
    const response = await fetch(base + "/me");
    const html = await response.text();
    expect(response.status).toBe(401);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self' https://x.com;");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain('data-dev-x-auth="real"');
    expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toContain("simulator");
    expect(html).not.toContain("No X account was authenticated");
    const panel = await (await fetch(base + "/api/v1/account-panel")).json();
    expect(panel.developmentHtml).toContain('data-dev-x-auth="real"');
    expect(panel.html).toContain("Sign in with X");
    expect(providerCalls).toHaveLength(0);
  });

  it("disables simulator consent and fake mint progression even with fixtures enabled", async () => {
    expect((await fetch(base + "/dev/oauth/x/authorize?request=example")).status).toBe(404);
    expect((await post("/dev/oauth/x/authorize", { decision: "approve", account: "alice" })).status).toBe(404);
    expect((await post("/dev/v2/wallet-bindings/seed", {})).status).toBe(404);
  });

  it("exchanges the PKCE code server-side, rotates the session and creates no claim on login", async () => {
    const start = await begin();
    const response = await callback(start);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/me");
    const cookie = cookieOf(response);
    expect(cookie).not.toBe(start.cookie);
    expect(providerCalls.map(call => call.url)).toEqual(["https://api.x.com/2/oauth2/token", "https://api.x.com/2/users/me"]);
    const exchange = providerCalls[0].init!;
    const body = new URLSearchParams(exchange.body as string);
    expect(generateCodeChallenge(body.get("code_verifier")!)).toBe(start.challenge);
    expect((exchange.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
    expect(auth.getSession(start.cookie.split("=")[1])).toBeNull();
    const me = await fetch(base + "/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const html = await me.text();
    expect(html).toContain("@Real_Test");
    expect(html).toContain("No claimed signatures yet");
    expect(html).not.toMatch(/test-access-token|test-secret/);
    expect(await store.listSignaturesForAccount(testUser.id)).toEqual([]);
    expect(await store.getAccount(testUser.id)).toBeNull();
    const session = auth.getSession(cookie.split("=")[1])!;
    expect(JSON.stringify(session)).not.toMatch(/test-access-token|test-secret/);
    expect(session.claimNotice).toBeUndefined();
    expect((await callback(start, "&code=test-code", cookie)).status).toBe(400);
    expect(providerCalls).toHaveLength(2);
  });

  it("keeps legacy forms on explicit CSRF-protected Claim before wallet linking", async () => {
    const prepared = await claim();
    expect(prepared.html).toContain('data-claim-state="confirm"');
    expect(prepared.html).toContain("Signed in as @real_test. Confirm to add this signature");
    expect(await store.listSignaturesForAccount(testUser.id)).toEqual([]);
    expect((await post("/api/v1/signatures", { flow: prepared.flow, csrf: "wrong" }, prepared.cookie)).status).toBe(403);
    const response = await post("/api/v1/signatures", { flow: prepared.flow, csrf: prepared.csrf }, prepared.cookie, { Accept: "application/json" });
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.signature.claimStatus).toBe("claimed_via_x");
    expect((await store.listSignaturesForAccount(testUser.id))).toHaveLength(1);
    const entry = await fetch(`${base}/signatures/${payload.signature.id}/mint`, { headers: { Cookie: prepared.cookie } });
    expect(entry.status).toBe(200);
    expect(await entry.text()).toContain('data-mint-entry="wallet"');
    const detail = await (await fetch(`${base}/signatures/${payload.signature.id}`)).text();
    expect(detail).toContain("Local claim record");
    expect(detail).not.toContain("Development claim fixture");
    expect(detail).toContain('data-signature-status="claimed"');
    expect(detail).not.toContain('aria-label="Claim destinations"');
    expect(detail).not.toContain("My Collection →");
    expect(detail).not.toContain("Claimed gallery →");
    const gallery = await (await fetch(`${base}/?tab=claimed`)).text();
    const collection = await (await fetch(`${base}/me`, { headers: { Cookie: prepared.cookie } })).text();
    for (const html of [gallery, collection]) expect(html).toContain(`/signatures/${payload.signature.id}`);
    expect(mint.state.exportSnapshot().authorizations).toEqual([]);
  });

  it("rejects the wrong X account for a claim", async () => {
    const start = await begin({ purpose: "claim", handle: "alice", gr0k: "0.500000" });
    const response = await callback(start);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("HANDLE_MISMATCH");
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
  });

  it("keeps legacy consent on the preview but sends native claim completion to the permanent page", async () => {
    const prepared = await claim();
    const target = new URL(prepared.returnPath, base);
    expect(target.pathname).toBe("/s/real_test/0.371924");
    expect(target.searchParams.get("flow")).toBe(prepared.flow);
    expect(target.hash).toBe("#claim");
    const response = await post("/api/v1/signatures", { flow: prepared.flow, csrf: prepared.csrf }, prepared.cookie);
    expect(response.status).toBe(303);
    const destination = `/signatures/${(await store.listSignaturesForAccount(testUser.id))[0].signatureId}`;
    expect(response.headers.get("location")).toBe(destination);
    for (let i = 0; i < 2; i++) {
      const saved = await fetch(base + prepared.returnPath, { headers: { Cookie: prepared.cookie } });
      expect(saved.url).toBe(base + destination);
      expect(saved.headers.get("cache-control")).toBe("private, no-store");
      const html = await saved.text();
      expect(html).toContain('data-signature-status="claimed"');
      expect(html).not.toContain('action="/api/v1/signatures"');
    }
    expect(await store.listSignaturesForAccount(testUser.id)).toHaveLength(1);
    expect((await post("/api/v1/signatures", { flow: prepared.flow, csrf: prepared.csrf }, prepared.cookie)).status).toBe(409);
  });

  it("never caches authenticated action state or lets a public ETag suppress it", async () => {
    const prepared = await claim();
    const preview = await fetch(base + "/s/real_test/0.371924", { headers: { Cookie: prepared.cookie } });
    const publicHtml = await preview.text();
    expect(preview.headers.get("cache-control")).toContain("public");
    expect(publicHtml).not.toContain(prepared.csrf);
    expect(publicHtml).not.toContain(prepared.flow);
    const response = await fetch(base + prepared.returnPath, { headers: { Cookie: prepared.cookie, "If-None-Match": preview.headers.get("etag")! } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(await response.text()).toContain(prepared.csrf);
    const head = await fetch(base + prepared.returnPath, { method: "HEAD", headers: { Cookie: prepared.cookie } });
    expect(head.headers.get("cache-control")).toBe("private, no-store");
    expect(await head.text()).toBe("");
    expect(await store.listSignaturesForAccount(testUser.id)).toHaveLength(0);
  });

  it.each(["anonymous", "other-browser", "other-handle", "other-gr0k", "duplicate-flow", "expired"])("does not expose confirmation for %s and recovers on the artwork page", async scenario => {
    const prepared = await claim();
    let cookie = prepared.cookie;
    let path = prepared.returnPath;
    if (scenario === "anonymous") cookie = "";
    if (scenario === "other-browser") cookie = `sg_dev_session=${auth.getOrCreateSession(null).session.id}`;
    if (scenario === "other-handle") path = path.replace("real_test", "someone_else");
    if (scenario === "other-gr0k") path = path.replace("0.371924", "0.371925");
    if (scenario === "duplicate-flow") path = path.replace("#claim", `&flow=${prepared.flow}#claim`);
    if (scenario === "expired") auth.getSession(cookie.split("=")[1])!.identity!.authenticatedAt = new Date(0);
    const response = await fetch(base + path, { headers: { Cookie: cookie } });
    expect([401, 409]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain('data-claim-state="sign-in"');
    expect(html).toContain('class="signature-art"');
    expect(html).not.toContain(prepared.csrf);
    expect(html).not.toContain('action="/api/v1/signatures"');
    expect(await store.listSignaturesForAccount(testUser.id)).toHaveLength(0);
  });

  it("redirects the legacy review URL into the bound artwork page", async () => {
    const prepared = await claim();
    const response = await fetch(`${base}/claim/review?flow=${prepared.flow}`, { redirect: "manual", headers: { Cookie: prepared.cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(prepared.returnPath);
    expect(await store.listSignaturesForAccount(testUser.id)).toHaveLength(0);
  });

  it("rejects a callback from a different browser without burning the legitimate state", async () => {
    const start = await begin();
    const other = auth.getOrCreateSession(null).session;
    expect((await callback(start, "&code=test-code", `sg_dev_session=${other.id}`)).status).toBe(400);
    expect(providerCalls).toHaveLength(0);
    expect((await callback(start)).status).toBe(303);
  });

  it("handles denied consent without contacting the token endpoint or authenticating", async () => {
    const start = await begin();
    const response = await callback(start, "&error=access_denied");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("X_AUTH_DENIED");
    expect(auth.getSession(start.cookie.split("=")[1])!.identity).toBeNull();
    expect(providerCalls).toHaveLength(0);
  });

  it("fails closed on X API errors without fallback, secrets, or a claim", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const start = await begin();
    providerStatus = 403;
    const response = await callback(start);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("X_AUTH_UNAVAILABLE");
    expect(html).not.toMatch(/sensitive-provider-diagnostic|test-secret|test-access-token|local OAuth emulator/);
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
    expect(auth.getSession(start.cookie.split("=")[1])!.identity).toBeNull();
    expect(log).toHaveBeenCalledWith("X authentication failed", { stage: "token_exchange", reason: "http", httpStatus: 403 });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/sensitive-provider-diagnostic|test-secret|test-access-token/);
  });

  it("distinguishes an account lookup failure from a token exchange failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    identityStatus = 402;
    const start = await begin();
    const response = await callback(start);
    expect(response.status).toBe(503);
    expect(providerCalls).toHaveLength(2);
    expect(log).toHaveBeenCalledWith("X authentication failed", { stage: "identity_lookup", reason: "http", httpStatus: 402 });
    expect(await store.listClaimedSignatures(20)).toHaveLength(0);
    expect(auth.getSession(start.cookie.split("=")[1])!.identity).toBeNull();
    expect(await response.text()).not.toContain("sensitive-provider-diagnostic");
  });

  it("does not authenticate when persisting existing-account login metadata fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "updateExistingAccountLogin").mockRejectedValueOnce(new Error("database unavailable"));
    const start = await begin();
    expect((await callback(start)).status).toBe(503);
    expect(auth.getSession(start.cookie.split("=")[1])!.identity).toBeNull();
    expect(log).toHaveBeenCalledWith("X authentication failed", { stage: "account_storage", reason: "internal_or_timeout" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("database unavailable");
  });

  it("pins navigation to 127.0.0.1 and rejects writes under an alias or foreign origin", async () => {
    const alias = base.replace("127.0.0.1", "localhost");
    const response = await nativeFetch(alias + "/me?tab=claimed", { redirect: "manual" });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(base + "/me?tab=claimed");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await nativeFetch(alias + "/auth/x/start", { method: "POST", redirect: "manual", headers: { Origin: base }, body: new URLSearchParams({ purpose: "account_login" }) })).status).toBe(403);
    expect((await post("/auth/x/start", { purpose: "account_login" }, "", { Origin: "https://evil.invalid" })).status).toBe(403);
    expect(providerCalls).toHaveLength(0);
  });
});
