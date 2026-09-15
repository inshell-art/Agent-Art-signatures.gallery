import { createServer as createProbeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createOpenMintServer } from "./server.js";
import { OpenMintService } from "./service.js";
import { WalletSessions } from "./security.js";
import { MemoryKeyValueStore } from "./storage.js";
import { AssessmentCoordinator } from "./assessment.js";
import { MemoryAssessmentRepository } from "./assessmentStore.js";
import { DevelopmentAssessmentProvider } from "./grok.js";
import { handleDigest, MBTI_TYPES } from "./identity.js";
import { openMintTokenURIHash } from "./authorization.js";
import type { OpenMintNetwork } from "./network.js";
import type { MintState } from "./service.js";
import { renderSignatureSvg } from "../algorithmV2/index.js";

const servers: Server[] = [];
const wallet = privateKeyToAccount(`0x${"7".repeat(64)}`);
interface RequestOptions { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; skipOrigin?: boolean; skipCsrf?: boolean; skipCookie?: boolean }
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

async function fixture() {
  // By default exercise the actual asynchronous HTTP request listener through streams,
  // without opening a socket. Opt in to transport-level loopback coverage when permitted.
  const httpTransport = process.env.OPEN_MINT_TEST_HTTP === "1";
  let port = 43123;
  if (httpTransport) {
    const probe = createProbeServer();
    probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  }
  const origin = `http://127.0.0.1:${port}`;
  const provider = new DevelopmentAssessmentProvider();
  const assess = vi.spyOn(provider, "assess");
  const assessments = new AssessmentCoordinator({ provider, repository: new MemoryAssessmentRepository() });
  const store = new MemoryKeyValueStore();
  const states = new Map<string, MintState>();
  const network: OpenMintNetwork = {
    chainId: 31337, address: wallet.address, authorizer: wallet.address,
    now: async () => Math.floor(Date.now() / 1000),
    walletContext: vi.fn(async (recipient?: string) => ({ chainId: "0x7a69" as const, contract: wallet.address, blockNumber: "0xa" as const, blockHash: `0x${"b".repeat(64)}` as const, ...(recipient ? { nonce: "0x1" as const } : {}) })),
    state: vi.fn(async handle => states.get(handle) ?? { state: "unminted" as const }),
    sign: async () => `0x${"1".repeat(130)}`,
    transaction: async (_handle, authorization) => ({ from: authorization.recipient, to: wallet.address, data: "0x1234", value: "0x0", chainId: "0x7a69" }),
  };
  const service = new OpenMintService({ assessments, store, origin, fixture: true, network });
  const sessions = new WalletSessions(origin, 31337);
  const server = createOpenMintServer({ origin, fixture: true, service, sessions });
  if (httpTransport) { server.listen(port, "127.0.0.1"); await once(server, "listening"); servers.push(server); }
  const dispatch = async (path: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> => {
    if (httpTransport) return fetch(origin + path, { method, headers, ...(body === undefined ? {} : { body }), redirect: "manual" });
    const incoming = new Headers(headers);
    if (!incoming.has("host")) incoming.set("host", new URL(origin).host);
    const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
      method, url: path, headers: Object.fromEntries(incoming.entries()), socket: { remoteAddress: "127.0.0.1" },
    }) as unknown as IncomingMessage;
    const responseHeaders = new Headers();
    let output = Buffer.alloc(0), ended = false;
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) {
        responseHeaders.delete(name);
        for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, String(item));
        return this;
      },
      end(content?: string | Uint8Array) {
        output = content === undefined ? Buffer.alloc(0) : Buffer.from(content);
        ended = true;
        return this;
      },
    };
    const listener = server.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => Promise<void>;
    await listener(request, response as unknown as ServerResponse);
    expect(ended, "HTTP listener must terminate its response").toBe(true);
    return new Response(output, { status: response.statusCode, headers: responseHeaders });
  };
  const client = () => {
    let cookie = "";
    let csrf = "";
    return {
      get cookie() { return cookie; },
      get csrf() { return csrf; },
      async request(path: string, init: RequestOptions = {}) {
        const method = init.method ?? "GET";
        let currentPath = path;
        let response: Response;
        for (let redirects = 0; ; redirects++) {
          const headers: Record<string, string> = { ...(cookie && !init.skipCookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { "Content-Type": "application/json", ...(!init.skipOrigin ? { Origin: origin } : {}), ...(!init.skipCsrf ? { "X-CSRF-Token": csrf } : {}) } : {}), ...init.headers };
          response = await dispatch(currentPath, method, headers, init.rawBody !== undefined ? init.rawBody : init.body === undefined ? undefined : JSON.stringify(init.body));
          const issued = response.headers.get("set-cookie");
          if (issued) cookie = issued.split(";")[0]!;
          const location = response.headers.get("location");
          if (method !== "GET" || ![301, 302, 303, 307, 308].includes(response.status) || !location) break;
          if (redirects >= 5) throw new Error("Too many test-client redirects.");
          const target = new URL(location, origin + currentPath);
          if (target.origin !== origin) throw new Error("Unexpected cross-origin test redirect.");
          await response.arrayBuffer();
          currentPath = target.pathname + target.search;
        }
        const text = await response.text();
        const json = response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : undefined;
        if (path === "/api/session" && response.ok) csrf = json.csrfToken;
        return { status: response.status, headers: response.headers, text, json };
      },
      async init() { return this.request("/api/session"); },
      async assess(handle = "Agent_Art") {
        await this.prove();
        const response = await this.request("/api/assessments", { method: "POST", body: { handle } });
        expect(response.status).toBe(202);
        await service.idle();
        const url = response.json.url as string;
        return { url, code: url.split("/").at(-1)! };
      },
      async prove(code?: string) {
        const response = await this.request("/api/wallet/challenge", { method: "POST", body: { address: wallet.address, ...(code ? { code } : {}) } });
        expect(response.status).toBe(200);
        const { challengeId, message } = response.json;
        const signature = await wallet.signMessage({ message });
        return { result: await this.request("/api/wallet/verify", { method: "POST", body: { challengeId, signature } }), challengeId, signature, message };
      },
    };
  };
  const mint = async (handle: string, state: "minted" | "pending" = "minted") => {
    const artifact = (await service.artifact(handle))!;
    states.set(handle.toLowerCase(), { state, tokenId: BigInt(handleDigest(handle)).toString(), wallet: wallet.address,
      transactionHash: `0x${"a".repeat(64)}`, assessmentDigest: artifact.assessment.digest, artifactDigest: artifact.digest,
      tokenURIHash: openMintTokenURIHash(artifact.tokenURI) });
  };
  return { origin, client, service, store, sessions, assess, network, mint };
}

describe("open mint HTTP boundary", () => {
  it("exposes a read-only exact-chain fingerprint and optional wallet nonce without signing or assessing", async () => {
    const test = await fixture(); const client = test.client();
    const context = await client.request("/api/wallet/context");
    expect(context.status).toBe(200);
    expect(context.headers.get("cache-control")).toBe("no-store");
    expect(context.json).toEqual({ chainId: "0x7a69", contract: wallet.address, blockNumber: "0xa", blockHash: `0x${"b".repeat(64)}` });
    const address = wallet.address.toLowerCase();
    expect((await client.request(`/api/wallet/context?address=${address}`)).json.nonce).toBe("0x1");
    expect(test.network.walletContext).toHaveBeenLastCalledWith(wallet.address);
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries("issuance:")).toEqual([]);
    for (const query of ["address=not-a-wallet", `address=${address}&address=${address}`, "rpcUrl=http://127.0.0.1:18545", `address=${address}&nonce=410`]) {
      expect((await client.request(`/api/wallet/context?${query}`)).status).toBe(400);
    }
    test.network.walletContext = undefined;
    expect((await client.request("/api/wallet/context")).status).toBe(503);
  });

  it("sets an HttpOnly session cookie and reads it consistently among other cookies", async () => {
    const test = await fixture(); const client = test.client();
    const initial = await client.init();
    expect(initial.status).toBe(200);
    expect(initial.headers.get("set-cookie")).toMatch(/^sg_open_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\//);
    expect(initial.json.wallet).toBeNull();
    expect(initial.json).not.toHaveProperty("id");
    expect(initial.json).not.toHaveProperty("challenge");
    const again = await client.request("/api/session", { headers: { Cookie: `other=example; ${client.cookie}; trailing=1` } });
    expect(again.json.csrfToken).toBe(initial.json.csrfToken);
    expect(again.headers.get("set-cookie")).toBeNull();
    const forged = await client.request("/api/session", { headers: { Cookie: `sg_open_session=${"a".repeat(43)}` } });
    expect(forged.json.csrfToken).not.toBe(initial.json.csrfToken);
  });

  it("requires matching Origin, session cookie, and CSRF for every state-changing request", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const invalidRequests: RequestOptions[] = [{ skipOrigin: true }, { skipCsrf: true }, { skipCookie: true }, { headers: { Origin: "https://attacker.example" } }, { headers: { "X-CSRF-Token": "forged" } }];
    for (const init of invalidRequests) {
      const result = await client.request("/api/assessments", { method: "POST", body: { handle: "alice" }, ...init });
      expect(result.status).toBe(403);
      expect(result.json.code).toBe("SESSION_REQUIRED");
      await client.init();
    }
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("rejects extra generation fields and malformed JSON without starting Grok", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    for (const body of [{ handle: "alice", mbti: "INTJ" }, { handle: "alice", gr0k: 42 }, { handle: "alice", signature: "forged" }, { handle: "alice", wallet: wallet.address }, {}, [], null]) {
      const response = await client.request("/api/assessments", { method: "POST", body });
      expect(response.status).toBe(400);
    }
    expect((await client.request("/api/assessments", { method: "POST", rawBody: "{" })).status).toBe(400);
    expect((await client.request("/api/assessments", { method: "POST", body: { handle: "alice" }, headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    expect(test.assess).not.toHaveBeenCalled();
  });

  it("exposes no legacy claim routes or development mutation endpoints by default", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    for (const path of ["/auth/x/start", "/api/v1/signatures", "/api/v2/wallet-bindings/challenge", "/api/dev/wallet", "/api/dev/mint"]) {
      const response = await client.request(path, { method: "POST", body: {} });
      expect(response.status).toBe(404);
    }
    for (const path of ["/api/assessments", "/api/wallet/challenge", "/api/wallet/verify", "/api/mints/authorize", "/api/mints/report", "/api/session/logout", "/api/dev/wallet", "/auth/x/start"]) expect((await client.request(path)).status).toBe(404);
    expect(test.assess).not.toHaveBeenCalled();
    expect((await client.request("/api/assessments", { method: "PUT", body: { handle: "alice" } })).status).toBe(405);
  });

  it("keeps mint progress private, wallet-bound, and unrevealed before confirmation", async () => {
    const test = await fixture(); const owner = test.client(); const visitor = test.client();
    await owner.init(); await visitor.init();
    const { url, code } = await owner.assess("@AGENT_ART");
    expect(url).toMatch(/^\/mint\/[A-Za-z0-9_-]{43}$/);
    const own = await owner.request(`/api/assessments/${code}`);
    expect(own.json).toMatchObject({ handle: "agent_art", renderHandle: "AGENT_ART", status: "ready", canMint: true, walletProvedForCode: true });
    expect(own.json).not.toHaveProperty("owner");
    expect(own.json).not.toHaveProperty("csrf");
    const shared = await visitor.request(`/api/assessments/${code}`);
    expect(shared.status).toBe(403);
    const view = await visitor.request(url);
    expect(view.status).toBe(403);
    expect(view.text).not.toContain("data-mint-form");
    expect((await visitor.request(`/api/mints/status/${code}`)).status).toBe(403);
    expect((await visitor.request(`/api/wallet/challenge`, { method: "POST", body: { code, address: wallet.address } })).status).toBe(403);
    for (const field of ["imageUrl", "svgUrl", "mbti", "svgSha256", "pngSha256", "assessedAt"]) expect(own.json).not.toHaveProperty(field);
    expect((await owner.request(url)).text).not.toContain("/artifacts/");
    expect((await owner.request("/signatures/agent_art")).status).toBe(404);
    expect((await visitor.assess("agent_art")).code).not.toBe(code);
    expect(test.assess).toHaveBeenCalledTimes(1);
    await test.mint("agent_art", "pending");
    expect((await owner.request(`/api/assessments/${code}`)).json).not.toHaveProperty("mbti");
    expect((await owner.request("/")).text).not.toContain('/signatures/agent_art');
    await test.mint("agent_art");
    const revealed = await owner.request(`/api/assessments/${code}`);
    expect(revealed.json.mbti).toBeDefined();
    expect((await owner.request(url)).text).toContain(revealed.json.svgUrl);
    expect((await owner.request("/")).text).toContain('/signatures/agent_art');
    expect((await owner.request("/me")).text).toContain('/signatures/agent_art');
  });

  it("preserves mixed-case request URLs and labels without introducing another assessment or permalink identity", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const entry = await client.request("/s/Alice_Bob_Key");
    expect(entry.status).toBe(200);
    expect(entry.text).toContain('value="Alice_Bob_Key"');
    const { url, code } = await client.assess("@Alice_Bob_Key");
    expect(url).toContain("/mint/");
    const status = await client.request(`/api/assessments/${code}`);
    expect(status.json).toMatchObject({ handle: "alice_bob_key", renderHandle: "Alice_Bob_Key" });
    for (const path of [url]) {
      const page = await client.request(path);
      expect(page.status).toBe(200);
      expect(page.text).toContain("@Alice_Bob_Key");
    }
    const second = test.client(); await second.init();
    const again = await second.assess("ALICE_BOB_KEY");
    const secondStatus = await second.request(`/api/assessments/${again.code}`);
    expect(secondStatus.json.renderHandle).toBe("ALICE_BOB_KEY");
    expect(secondStatus.json).not.toHaveProperty("svgUrl");
    expect(test.assess).toHaveBeenCalledTimes(1);
    await test.mint("alice_bob_key");
    expect((await second.request(`/api/assessments/${again.code}`)).json.renderHandle).toBe("Alice_Bob_Key");
    for (const path of ["/signatures/alice_bob_key", "/signatures/Alice_Bob_Key"]) expect((await client.request(path)).text).toContain("@Alice_Bob_Key");
  });

  it("requires proof before assessment, keeps explicit mint consent and consumes challenges once", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const anonymous = await client.request("/api/assessments", { method: "POST", body: { handle: "alice" } });
    expect(anonymous.status).toBe(403);
    expect(test.assess).not.toHaveBeenCalled();
    const { code } = await client.assess();
    expect((await client.prove()).result.json.wallet).toBe(wallet.address);
    expect((await client.request(`/api/assessments/${code}`)).json.walletProvedForCode).toBe(true);
    const proof = await client.prove(code);
    expect(proof.result.status).toBe(200);
    expect(proof.message).toContain(code);
    expect((await client.request(`/api/assessments/${code}`)).json.walletProvedForCode).toBe(true);
    expect((await client.request("/api/wallet/verify", { method: "POST", body: { challengeId: proof.challengeId, signature: proof.signature } })).status).toBe(409);
    expect((await client.request("/api/mints/authorize", { method: "POST", body: { code, consent: false } })).status).toBe(400);
    const authorized = await client.request("/api/mints/authorize", { method: "POST", body: { code, consent: true } });
    expect(authorized.status).toBe(200);
    expect(authorized.json.transaction.from).toBe(wallet.address);
    expect((await client.request("/me")).text).toContain(wallet.address);
    expect((await client.request("/api/session/logout", { method: "POST", body: {} })).status).toBe(200);
    expect((await client.init()).json.wallet).toBeNull();
  });

  it("serves locked artwork, hashed assets, public permalink, and restrictive browser headers", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    const { code } = await client.assess("alice");
    await test.mint("alice");
    const status = await client.request(`/api/assessments/${code}`);
    const permalink = await client.request("/signatures/alice");
    expect(permalink.status).toBe(200);
    expect(permalink.text).toContain(status.json.mbti);
    expect(permalink.text).toContain("Simulated assessment");
    expect(permalink.text.match(/<main>([\s\S]*?)<\/main>/)![1]).not.toMatch(/development fixture|simulated assessment/i);
    expect(permalink.text).not.toContain("data-mint-form");
    const svg = await client.request(status.json.svgUrl);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("cache-control")).toContain("immutable");
    expect(svg.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(svg.text).toContain("<svg");
    const home = await client.request("/");
    expect(home.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(home.headers.get("referrer-policy")).toBe("no-referrer");
    expect(home.headers.get("x-content-type-options")).toBe("nosniff");
    expect(home.headers.get("cache-control")).toBe("no-store");
    const style = home.text.match(/<link rel="stylesheet" href="([^"]+)"/)![1]!;
    const script = home.text.match(/<script src="([^"]+)"/)![1]!;
    expect(style).toMatch(/^\/assets\/open-mint-[a-f0-9]+\.css$/);
    expect(script).toMatch(/^\/assets\/open-mint-[a-f0-9]+\.js$/);
    expect((await client.request(style)).text).toContain("Instrument Sans");
    expect((await client.request(script)).text).toContain("eth_sendTransaction");
    for (const path of ["/", "/me", "/about", "/s/alice", "/signatures/alice"]) expect((await client.request(path)).text).not.toMatch(/(?:xai|sk)-[A-Za-z0-9]{16,}|authorizerPrivateKey|providerResponse|walletProof|client_secret/);
  });

  it("renders all editable preview types without assessments, storage, mint authority or wallet access", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    for (const mbti of MBTI_TYPES) {
      const preview = await client.request(`/s/Alice_Bob_Key/${mbti}`);
      expect(preview.status).toBe(200);
      expect(preview.text).toContain(`/preview/Alice_Bob_Key/${mbti}.svg`);
      expect(preview.text).toContain('/mint?handle=Alice_Bob_Key');
      expect(preview.text).not.toContain('data-mint-form');
      const svg = await client.request(`/preview/Alice_Bob_Key/${mbti}.svg`);
      expect(svg.status).toBe(200);
      expect(svg.text).toBe(renderSignatureSvg("Alice_Bob_Key", mbti));
    }
    expect((await client.request('/s/Alice_Bob_Key/enfp')).text).toContain('/preview/Alice_Bob_Key/ENFP.svg');
    for (const path of ['/s/alice/17', '/s/alice/INXX', '/s/alice/1.000000', '/preview/alice/INXX.svg', '/s/invalid%2Fhandle/ENFP']) expect((await client.request(path)).status).toBe(404);
    expect((await client.request('/mint?handle=Alice_Bob_Key&mbti=INTJ')).text).toContain('value="Alice_Bob_Key"');
    expect((await client.request('/mint')).status).toBe(200);
    await client.prove();
    expect((await client.request('/api/session')).json.walletVerified).toBe(true);
    expect(test.assess).not.toHaveBeenCalled();
    expect(await test.store.entries('request:')).toHaveLength(0);
    expect(await test.store.entries('artifact:')).toHaveLength(0);
  });

  it("serves all 16 variation links and their SVGs without wallet proof or paid and durable operations", async () => {
    const test = await fixture(); const client = test.client();
    const put = vi.spyOn(test.store, "put");
    const grid = await client.request('/s/Alice_Bob_Key/variations');
    expect(grid.status).toBe(200);
    expect(grid.headers.get('content-type')).toContain('text/html');
    expect(grid.text).toContain('data-preview-variations');
    const links = [...grid.text.matchAll(/href="(\/s\/Alice_Bob_Key\/[A-Z]{4})"/g)].map(match => match[1]!);
    expect(links).toHaveLength(16);
    expect(new Set(links)).toEqual(new Set(MBTI_TYPES.map(mbti => `/s/Alice_Bob_Key/${mbti}`)));
    for (const mbti of MBTI_TYPES) {
      const detail = await client.request(`/s/Alice_Bob_Key/${mbti}`);
      expect(detail.status).toBe(200);
      expect(detail.text).toContain('href="/s/Alice_Bob_Key/variations">View all 16 variations</a>');
      const svg = await client.request(`/preview/Alice_Bob_Key/${mbti}.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toContain('image/svg+xml');
      expect(svg.text).toContain('<svg');
    }
    expect(grid.text).not.toMatch(/data-assessment-request|data-assessment-code|data-mint-form|data-connect-wallet|data-dev-wallet|data-dev-mint|\/artifacts\//);
    expect((await client.request('/api/session')).json).toMatchObject({ wallet: null, walletVerified: false });
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toHaveLength(0);
  });

  it("normalizes only variations URL syntax, preserves handle case, and rejects hostile or unknown paths", async () => {
    const test = await fixture(); const client = test.client();
    for (const path of ['/s/@Alice_Bob_Key/variations', '/s/%40Alice_Bob_Key/variations', '/s/%41lice_Bob_Key/variations']) {
      const result = await client.request(path);
      expect(result.status).toBe(200);
      expect(result.text).toContain('data-preview-variations');
      expect(result.text).toContain('/s/Alice_Bob_Key/ENFP');
      expect(result.text).not.toContain('/s/alice_bob_key/');
    }
    for (const path of ['/s/invalid%2Fhandle/variations', '/s/%3Cscript%3E/variations', '/s/a%00b/variations', '/s/%/variations', `/s/${'a'.repeat(16)}/variations`, '/s/alice/variation', '/s/alice/INXX', '/s/alice/variations/ENFP']) {
      expect((await client.request(path)).status, path).toBe(404);
    }
    const bareHandle = await client.request('/s/Alice_Bob_Key');
    expect(bareHandle.status).toBe(200);
    expect(bareHandle.text).toContain('data-mint-entry');
    expect(bareHandle.text).toContain('value="Alice_Bob_Key"');
    expect(bareHandle.text).not.toContain('data-preview-variations');
    expect(test.assess).not.toHaveBeenCalled();
    expect(test.network.state).not.toHaveBeenCalled();
    expect(await test.store.entries('')).toHaveLength(0);
  });

  it("returns the already-minted permalink without another assessment", async () => {
    const test = await fixture(); const client = test.client(); await client.init();
    await client.assess('alice'); await test.mint('alice');
    const response = await client.request('/api/assessments', { method: 'POST', body: { handle: 'ALICE' } });
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ code: 'ALREADY_MINTED', url: '/signatures/alice' });
    expect(test.assess).toHaveBeenCalledTimes(1);
  });
});
