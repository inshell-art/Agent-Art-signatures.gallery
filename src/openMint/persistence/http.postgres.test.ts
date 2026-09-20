import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { Client } from "pg";
import { decodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssessmentProvider } from "../assessment.js";
import { OPEN_MINT_ABI } from "../authorization.js";
import { opaqueCode } from "../security.js";
import type { XIdentityResolver } from "../xIdentity.js";
import { PostgresAssessmentWorker } from "./assessmentWorker.js";
import { PostgresAuthorizationIssuer } from "./authorizations.js";
import { identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { createDurableMintApiServer } from "./http.js";
import { PostgresPublicationJournal } from "./publication.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { DurableMintRuntime, type DurableRuntimeOptions, type RuntimeEligibilityInput } from "./runtimeService.js";
import { capabilityHash, PostgresWalletSessions } from "./sessions.js";
import { ExclusiveWriter } from "./writer.js";
import { preparationRuntimeGrants } from "./runtimeRole.js";
import { auditPreparationRole } from "./roleAudit.js";

// Public test literals, never a funded/user wallet or live signing adapter.
const signer = privateKeyToAccount(`0x${"0".repeat(63)}1`), wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);
interface Reply { status: number; headers: Record<string, any>; body: Record<string, any> }
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1" || process.env.OPEN_MINT_TEST_HTTP !== "1")("durable HTTP pipeline on disposable PostgreSQL (no paid calls or chain writes)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client;
  const resources: { runtime: DurableMintRuntime; writer: ExclusiveWriter; server: Server }[] = [];
  const factory = () => new Client(cluster.config);
  const runtimeFactory = () => new Client({ ...cluster.config, user: "sg_http_runtime" });
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "publication-schema.sql", "authorization-schema.sql"]) await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    await admin.query("CREATE ROLE sg_http_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query(preparationRuntimeGrants("sg_http_runtime"));
  }, 30000);
  const close = async (item: typeof resources[number]) => {
    await new Promise<void>(resolve => { item.server.close(() => resolve()); item.server.closeAllConnections(); });
    await item.runtime.drain(); await item.writer.close();
  };
  afterEach(async () => { for (const item of resources.splice(0)) await close(item); vi.unstubAllEnvs(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  async function harness() {
    const ns = { ...namespace(), profile: "local-real" as const, provenance: "grok" as const };
    const deployment = randomUUID(), gate = eligibilityFixture(ns.id, deployment);
    const p = { ...gate.profile, authorizer: signer.address.toLowerCase() }, remote = new Map<string, Uint8Array>();
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-http-test','grok-offline-test',true,'2099-01-01',5,5,1,5,100,1000)`, [ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [ns.id, p.origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deployment, p.chain_id, p.contract_address, p.genesis_hash,
      p.runtime_code_hash, p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.publication_profiles VALUES($1,$2,'mock-upload','mock-reader')", [ns.id, p.origin]);
    await admin.query("INSERT INTO open_mint.issuance_profiles VALUES($1,$2,true,600,5000,10000,120000,5000)", [ns.id, deployment]);
    const resolver: XIdentityResolver = { provenance: "x-api", resolve: vi.fn<XIdentityResolver["resolve"]>(async (handle, execution) => {
      await execution!.recordReceipt(receipt("x-identity", "1")); return { ...identity(handle), username: "Alice", provenance: "x-api" };
    }) };
    const provider: AssessmentProvider = { provenance: "grok", model: "grok-offline-test", assess: vi.fn<AssessmentProvider["assess"]>(async (handle, snapshot, execution) => {
      await execution!.recordReceipt(receipt("grok", "1"));
      return { handle, mbti: "INTJ", model: "grok-offline-test", providerResponseId: "offline-http-test", sourceUrls: ["https://x.com/Alice"], xUserId: snapshot!.userId };
    }) };
    const signing = { address: signer.address, signTypedData: vi.fn(data => signer.signTypedData(data)) };
    const eligibility = vi.fn((input: RuntimeEligibilityInput, _signal: AbortSignal) => gate.witness(input.handle, input.recipient, { authorizer: signer.address }, undefined, input.nonce));
    const uploader = { id: "mock-upload", upload: vi.fn(async (object: { uri: string }, bytes: Uint8Array) => { remote.set(object.uri, Uint8Array.from(bytes)); }) };
    const reader = { id: "mock-reader", retrieve: vi.fn(async (object: { uri: string }) => Uint8Array.from(remote.get(object.uri)!)) };
    let item: typeof resources[number], port: number, options: DurableRuntimeOptions;
    const open = async () => {
      const writer = await ExclusiveWriter.acquire(runtimeFactory), repository = await OpenMintRepository.open(writer, ns);
      const requests = await PostgresMintRequests.open(repository, deployment);
      const sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin: p.origin, chainId: 31337 });
      const journal = await PostgresPublicationJournal.open(writer, { namespaceId: ns.id, origin: p.origin, destination: uploader.id, source: reader.id });
      const issuer = await PostgresAuthorizationIssuer.open(requests, journal);
      const worker = new PostgresAssessmentWorker(requests, { timeoutMs: 5000, provider, identityResolver: resolver,
        refreshEligibility: input => gate.witness(input.handle, input.recipient, { authorizer: signer.address }) });
      options = { sessions, requests, worker, journal, issuer, signer: signing, eligibility, eligibilityTimeoutMs: 1000,
        publication: { uploader, reader, timeoutMs: 500 } };
      const runtime = new DurableMintRuntime(options);
      const server = createDurableMintApiServer(runtime); server.listen(0, "127.0.0.1"); await once(server, "listening");
      port = (server.address() as { port: number }).port; item = { runtime, writer, server }; resources.push(item);
    };
    await open();
    const send = (path: string, input?: unknown, auth?: { cookie?: string; csrf?: string }, headers: Record<string, string> = {}, method = input === undefined ? "GET" : "POST"): Promise<Reply> => new Promise((resolve, reject) => {
      const raw = input === undefined ? undefined : typeof input === "string" ? input : JSON.stringify(input);
      const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: new URL(p.origin).host,
        ...(raw !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)), origin: p.origin } : {}),
        ...(auth?.cookie ? { cookie: auth.cookie } : {}), ...(auth?.csrf ? { "x-csrf-token": auth.csrf } : {}), ...headers } }, res => {
        const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => {
          try { resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); }
        });
      }); req.on("error", reject); req.end(raw);
    });
    const session = async (connect = true) => {
      const response = await send("/api/session"); expect(response.status).toBe(200);
      expect(response.headers["set-cookie"][0]).toContain("; Secure");
      const auth = { cookie: response.headers["set-cookie"][0].split(";")[0], csrf: response.body.csrfToken as string };
      if (connect) {
        const challenge = await send("/api/wallet/challenge", { address: wallet.address }, auth); expect(challenge.status).toBe(200);
        const verified = await send("/api/wallet/verify", { challengeId: challenge.body.challengeId, signature: await wallet.signMessage({ message: challenge.body.message }) }, auth);
        expect(verified.status).toBe(200); expect(verified.body.walletVerified).toBe(true);
      }
      return auth;
    };
    const count = async (table: string) => (await admin.query(`SELECT count(*)::int AS n FROM open_mint.${table} WHERE namespace_id=$1`, [ns.id])).rows[0].n;
    return { ns, p, send, session, count, eligibility, resolver, provider, signing, uploader, reader,
      runtime: () => item.runtime, options: () => options,
      restart: async () => { await close(item); resources.splice(resources.indexOf(item), 1); await open(); },
      closeWriter: () => item.writer.close(),
    };
  }

  it("wallet HTTP proof → one assessment/publication → exact mint calldata, across HTTP/writer restart", async () => {
    const h = await harness(), auth = await h.session();
    expect(h.provider.assess).not.toHaveBeenCalled(); expect(h.eligibility).not.toHaveBeenCalled();
    const admitted = await h.send("/api/assessments", { handle: "Alice" }, auth); expect(admitted.status).toBe(202);
    const code = admitted.body.code;
    await h.runtime().idle();
    const status = await h.send(`/api/assessments/${code}`, undefined, auth);
    expect(status.status).toBe(200); expect(status.body).toMatchObject({ handle: "alice", renderHandle: "Alice", status: "ready", canMint: true });
    for (const forbidden of ["INTJ", "ipfs:", "providerResponseId", "sourceUrls", "authorization", "signature", "assessmentId", "walletProof", "sessionHash"]) expect(JSON.stringify(status.body)).not.toContain(forbidden);
    const authorized = await h.send("/api/mints/authorize", { code, consent: true }, auth); expect(authorized.status).toBe(200);
    const decoded = decodeFunctionData({ abi: OPEN_MINT_ABI, data: authorized.body.transaction.data as Hex });
    expect(decoded.functionName).toBe("mint"); expect(decoded.args![0]).toBe("alice");
    expect(authorized.body.transaction).toMatchObject({ from: wallet.address, to: h.p.contract_address, value: "0x0", chainId: "0x7a69" });
    expect(JSON.stringify(authorized.body)).not.toMatch(/sessionHash|generation|csrf|namespaceId|deploymentId|providerResponseId/);
    const before = await admin.query("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [h.ns.id]);
    await h.restart();
    const restored = await h.send("/api/session", undefined, auth); expect(restored.body.walletVerified).toBe(true); expect(restored.headers["set-cookie"]).toBeUndefined();
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [h.ns.id]);
    expect((await h.send(`/api/assessments/${code}`, undefined, auth)).body.status).toBe("ready");
    expect((await h.send("/api/mints/authorize", { code, consent: true }, auth)).body).toEqual(authorized.body);
    expect(h.signing.signTypedData).toHaveBeenCalledOnce(); expect(h.provider.assess).toHaveBeenCalledOnce(); expect(h.resolver.resolve).toHaveBeenCalledOnce();
    const calls = h.eligibility.mock.calls;
    expect(calls.at(-1)![0].nonce).toBe(calls.at(-2)![0].nonce);
    for (const table of ["assessment_attempts", "budget_reservations", "assessments", "authorization_signatures"]) expect(await h.count(table)).toBe(1);
    expect((await admin.query("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [h.ns.id])).rows[0].payload).toEqual(before.rows[0].payload);
    expect(h.uploader.upload).toHaveBeenCalledTimes(3); expect(h.reader.retrieve).toHaveBeenCalledTimes(3);
  }, 30000);

  it("keeps private request status inaccessible across sessions, expiry and logout without creating replacement sessions", async () => {
    const h = await harness(), auth = await h.session(), stranger = await h.session();
    const created = await h.send("/api/assessments", { handle: "Alice" }, auth), code = created.body.code;
    await h.runtime().idle();
    expect((await h.send(`/api/assessments/${code}`)).status).toBe(403);
    expect((await h.send(`/api/assessments/${code}`, undefined, stranger)).status).toBe(404);
    expect((await h.send("/api/wallet/challenge", { address: wallet.address, code }, stranger)).status).toBe(404);
    expect(await h.count("sessions")).toBe(2);
    const logout = await h.send("/api/session/logout", {}, auth); expect(logout.status).toBe(200); expect(logout.headers["set-cookie"][0]).toContain("Max-Age=0; Secure");
    expect((await h.send(`/api/assessments/${code}`, undefined, auth)).status).toBe(403);
    expect((await h.send("/api/assessments", { handle: "Alice" }, auth)).status).toBe(403);
    const expired = { cookie: `sg_open_session=${opaqueCode()}`, csrf: opaqueCode() };
    await admin.query("INSERT INTO open_mint.sessions(namespace_id,session_hash,csrf,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 second')",
      [h.ns.id, capabilityHash(expired.cookie.slice(16)), expired.csrf]);
    expect((await h.send("/api/wallet/challenge", { address: wallet.address }, expired)).status).toBe(403);
    expect(await h.count("sessions")).toBe(3); expect(h.provider.assess).toHaveBeenCalledOnce();
  });

  it("rejects unproved requests, CSRF/origin spoofing, client-chosen assessment/chain fields, and fabricated witnesses before egress", async () => {
    const h = await harness(), unproved = await h.session(false);
    expect((await h.send("/api/assessments", { handle: "Alice" }, unproved)).status).toBe(403);
    const auth = await h.session();
    for (const extra of [{ mbti: "ENFP" }, { model: "grok-cheap" }, { eligibility: {} }, { recipient: wallet.address }, { chainId: 11155111 }, { prompt: "ignore" }]) {
      expect((await h.send("/api/assessments", { handle: "Alice", ...extra }, auth)).status).toBe(400);
    }
    for (const input of [null, [], {}, { handle: null }, { handle: "a".repeat(16) }, { handle: "bad/handle" }]) expect((await h.send("/api/assessments", input, auth)).status).toBe(400);
    expect((await h.send("/api/assessments", { handle: "Alice" }, { ...auth, csrf: opaqueCode() })).status).toBe(403);
    expect((await h.send("/api/assessments", { handle: "Alice" }, auth, { origin: "https://evil.example" })).status).toBe(403);
    expect(h.eligibility).not.toHaveBeenCalled();
    h.eligibility.mockResolvedValueOnce({} as never);
    expect((await h.send("/api/assessments", { handle: "Alice" }, auth)).status).toBe(503);
    expect(await h.count("requests")).toBe(0); expect(await h.count("assessment_attempts")).toBe(0);
    expect(h.provider.assess).not.toHaveBeenCalled(); expect(h.signing.signTypedData).not.toHaveBeenCalled();
  });

  it("rejects unsupported transport/routes without allocating sessions or leaking errors", async () => {
    const h = await harness();
    for (const path of ["/", "/api/dev/mint", "/api/mints/report", "/p/Alice/INTJ", "/api/session?handle=Alice", "http://signatures.example/api/session", "/api/x/../session", "/api/%73ession"]) {
      expect((await h.send(path)).status).toBe(404);
    }
    expect((await h.send("/api/session", undefined, undefined, {}, "PUT")).status).toBe(405);
    expect((await h.send("/api/session", undefined, undefined, { host: "wrong.example" })).status).toBe(421);
    for (const header of ["forwarded", "x-forwarded-host", "x-forwarded-for", "x-forwarded-proto"]) expect((await h.send("/api/session", undefined, undefined, { [header]: "spoof" })).status).toBe(400);
    for (const [input, headers, expected] of [
      ["{", {}, 400], ["x".repeat(8193), {}, 413], [{}, { "content-type": "text/plain" }, 415], [{}, { "content-encoding": "gzip" }, 415],
    ] as const) expect((await h.send("/api/assessments", input, undefined, headers)).status).toBe(expected);
    expect(await h.count("sessions")).toBe(0);
    const auth = await h.session();
    expect((await h.send("/api/session", undefined, { ...auth, cookie: `${auth.cookie}; ${auth.cookie}` })).status).toBe(400);
    h.eligibility.mockRejectedValueOnce(new Error("XAI_API_KEY=secret https://rpc.example/private-token"));
    const failure = await h.send("/api/assessments", { handle: "Alice" }, auth);
    expect(failure.status).toBe(503); expect(JSON.stringify(failure.body)).not.toMatch(/XAI|secret|private-token|rpc.example/);
    expect(failure.headers["cache-control"]).toBe("no-store"); expect(failure.headers["x-robots-tag"]).toContain("noindex");
    expect(failure.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never signs a bad publication or silently retries it on a status read", async () => {
    const h = await harness(), auth = await h.session();
    h.reader.retrieve.mockResolvedValueOnce(new Uint8Array([0]));
    const created = await h.send("/api/assessments", { handle: "Alice" }, auth), code = created.body.code;
    await h.runtime().idle();
    for (let i = 0; i < 3; i++) {
      const status = await h.send(`/api/assessments/${code}`, undefined, auth);
      expect(status.body).toMatchObject({ status: "failed", preparationActive: false, canMint: false });
    }
    const authorization = await h.send("/api/mints/authorize", { code, consent: true }, auth);
    expect(authorization.status).toBe(409); expect(authorization.body.code).toBe("NOT_READY");
    expect(h.reader.retrieve).toHaveBeenCalledOnce(); expect(h.provider.assess).toHaveBeenCalledOnce(); expect(h.signing.signTypedData).not.toHaveBeenCalled();
    // Explicit new request recovers the same accepted result/bytes, not a reroll.
    expect((await h.send("/api/assessments", { handle: "Alice" }, auth)).status).toBe(202); await h.runtime().idle();
    expect((await h.send(`/api/assessments/${code}`, undefined, auth)).body.status).toBe("ready");
    expect(h.provider.assess).toHaveBeenCalledOnce(); expect(await h.count("assessments")).toBe(1);
  });

  it("preserves uncertain signing and never dispatches a second signer call on reload/restart", async () => {
    const h = await harness(), auth = await h.session(), created = await h.send("/api/assessments", { handle: "Alice" }, auth);
    const code = created.body.code; await h.runtime().idle();
    expect((await h.send("/api/mints/authorize", { code, consent: false }, auth)).status).toBe(400);
    h.signing.signTypedData.mockRejectedValueOnce(new Error("private signer failure"));
    const uncertain = await h.send("/api/mints/authorize", { code, consent: true }, auth);
    expect(uncertain.body.code).toBe("SIGNING_UNCERTAIN"); expect(uncertain.status).toBe(409);
    await h.restart();
    expect((await h.send("/api/mints/authorize", { code, consent: true }, auth)).body.code).toBe("SIGNING_UNCERTAIN");
    expect(h.signing.signTypedData).toHaveBeenCalledOnce(); expect(await h.count("authorizations")).toBe(1);
    expect(await h.count("authorization_signatures")).toBe(0);
  });

  it("coalesces concurrent preparation and bounds different-handle work without a queue", async () => {
    const h = await harness(), auth = await h.session();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const original = h.resolver.resolve;
    const implementation = vi.mocked(original).getMockImplementation()!;
    vi.mocked(original).mockImplementationOnce(async (...args) => { await hold; return implementation(...args); });
    try {
      const first = await h.send("/api/assessments", { handle: "Alice" }, auth); expect(first.status).toBe(202);
      expect((await h.send(`/api/assessments/${first.body.code}`, undefined, auth)).body).toMatchObject({ status: "preparing", canMint: false, preparationActive: true });
      const second = await h.send("/api/assessments", { handle: "ALICE" }, auth); expect(second.status).toBe(202);
      expect((await h.send("/api/assessments", { handle: "Bob" }, auth)).status).toBe(429);
    } finally { release(); }
    await h.runtime().idle(); expect(h.provider.assess).toHaveBeenCalledOnce(); expect(await h.count("assessment_attempts")).toBe(1);
    expect(await h.count("requests")).toBe(2);
  });

  it("fails closed after writer loss/drain and cannot construct a production listener", async () => {
    const h = await harness(), auth = await h.session();
    vi.stubEnv("NODE_ENV", "production"); expect(() => createDurableMintApiServer(h.runtime())).toThrow("disabled"); vi.unstubAllEnvs();
    await h.runtime().drain();
    expect((await h.send("/api/assessments", { handle: "Alice" }, auth)).body.code).toBe("SERVICE_DRAINING");
    await h.closeWriter();
    expect((await h.send("/api/session", undefined, auth)).body.code).toBe("SERVICE_UNAVAILABLE");
    expect(h.provider.assess).not.toHaveBeenCalled(); expect(h.signing.signTypedData).not.toHaveBeenCalled();
  });

  it("rejects mismatched components and unbounded adapter settings at construction", async () => {
    const h = await harness(), options = h.options();
    for (const invalid of [0, -1, NaN, 30001, 1.5]) {
      expect(() => new DurableMintRuntime({ ...options, eligibilityTimeoutMs: invalid })).toThrow("deadline");
      expect(() => new DurableMintRuntime({ ...options, publication: { ...options.publication, timeoutMs: invalid } })).toThrow("deadline");
    }
    expect(() => new DurableMintRuntime({ ...options, signer: { ...options.signer, address: wallet.address } })).toThrow("matching isolated");
    expect(() => new DurableMintRuntime({ ...options, journal: { ...options.journal, origin: "https://wrong.example" } as never })).toThrow("matching isolated");
    expect(() => new DurableMintRuntime({ ...options, worker: { requests: {} } as never })).toThrow("matching isolated");
    expect(() => new DurableMintRuntime({ ...options, sessions: { ...options.sessions, chainId: 11155111 } as never })).toThrow("matching isolated");
  });

  it("times out a hung eligibility callback and ignores its late success without admission", async () => {
    const h = await harness(), auth = await h.session();
    let finish!: (value: Awaited<ReturnType<typeof h.eligibility>>) => void;
    h.eligibility.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const response = await h.send("/api/assessments", { handle: "Alice" }, auth);
    expect(response.body.code).toBe("CHAIN_UNAVAILABLE");
    expect(h.eligibility.mock.calls[0][1].aborted).toBe(true);
    finish({} as never); await h.runtime().idle();
    expect(await h.count("requests")).toBe(0); expect(await h.count("budget_reservations")).toBe(0);
    expect(h.provider.assess).not.toHaveBeenCalled();
  });

  it("retains terminal provider failure across polling, restart, and repeated explicit requests", async () => {
    const h = await harness(), auth = await h.session();
    vi.mocked(h.provider.assess).mockRejectedValueOnce(new Error("private provider response"));
    const created = await h.send("/api/assessments", { handle: "Alice" }, auth); await h.runtime().idle();
    const first = await h.send(`/api/assessments/${created.body.code}`, undefined, auth);
    expect(first.body).toMatchObject({ status: "failed", canMint: false }); expect(JSON.stringify(first.body)).not.toContain("private provider response");
    await h.restart();
    expect((await h.send(`/api/assessments/${created.body.code}`, undefined, auth)).body.status).toBe("failed");
    expect((await h.send("/api/assessments", { handle: "Alice" }, auth)).status).toBe(202); await h.runtime().idle();
    expect(h.provider.assess).toHaveBeenCalledOnce(); expect(h.resolver.resolve).toHaveBeenCalledOnce();
    expect(await h.count("assessment_attempts")).toBe(1); expect(await h.count("assessments")).toBe(0);
  });

  it("does not admit behind a changed wallet proof while chain eligibility is in flight", async () => {
    const h = await harness(), auth = await h.session();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), implementation = h.eligibility.getMockImplementation()!;
    let observed!: () => void; const started = new Promise<void>(resolve => { observed = resolve; });
    h.eligibility.mockImplementationOnce(async (...args) => { observed(); await wait; return implementation(...args); });
    const pending = h.send("/api/assessments", { handle: "Alice" }, auth); await started;
    try {
      expect((await h.send("/api/assessments", { handle: "Alice" }, auth)).status).toBe(429);
      expect((await h.send("/api/wallet/challenge", { address: wallet.address }, auth)).status).toBe(200);
    } finally { release(); }
    expect((await pending).body.code).toBe("WALLET_CHANGED");
    expect(await h.count("requests")).toBe(0); expect(h.provider.assess).not.toHaveBeenCalled();
  });

  it("audits the actual restricted preparation login and denies policy/commitment rewriting", async () => {
    const client = runtimeFactory(); await client.connect();
    try {
      await client.query("SET search_path=pg_catalog; SET statement_timeout='5s'");
      expect(await auditPreparationRole(client)).toMatchObject({ scope: "open-mint-preparation-role-v1", ok: true, failedChecks: [] });
      for (const sql of [
        "UPDATE open_mint.issuance_profiles SET enabled=true", "UPDATE open_mint.authorizations SET nonce='0x01'",
        "UPDATE open_mint.requests SET expires_at=clock_timestamp()", "UPDATE open_mint.public_artifacts SET svg='x'",
        "UPDATE open_mint.authorization_heads SET handle='bob'", "DELETE FROM open_mint.authorization_signatures",
        "TRUNCATE open_mint.publication_observations", "ALTER TABLE open_mint.authorizations DISABLE TRIGGER ALL",
        "INSERT INTO open_mint.publication_profiles SELECT * FROM open_mint.publication_profiles",
      ]) await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
      await admin.query("GRANT UPDATE(nonce) ON open_mint.authorizations TO sg_http_runtime");
      const excessive = await auditPreparationRole(client);
      expect(excessive.ok).toBe(false); expect(excessive.failedChecks).toContain("noExtraPrivileges");
    } finally {
      await admin.query("REVOKE UPDATE(nonce) ON open_mint.authorizations FROM sg_http_runtime"); await client.end();
    }
  });
});
