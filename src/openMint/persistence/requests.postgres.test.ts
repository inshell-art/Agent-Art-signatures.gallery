import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests, type CreateDurableMintRequest } from "./requests.js";
import { PostgresWalletSessions, capabilityHash, type DurableSiteSession } from "./sessions.js";
import { ExclusiveWriter } from "./writer.js";
import { assessment, bytes, identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";

const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("isolated PostgreSQL atomic private request admission", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter, repository: OpenMintRepository,
    sessions: PostgresWalletSessions, requests: PostgresMintRequests, session: DurableSiteSession, ns: ReturnType<typeof namespace>,
    gate: ReturnType<typeof eligibilityFixture>, deploymentId: string;
  const factory = () => new Client(cluster.config);
  async function signedSession(): Promise<DurableSiteSession> {
    const { session } = await sessions.session(), challenge = await sessions.challenge(session.id, account.address);
    await sessions.verify(session.id, challenge.challengeId, await account.signMessage({ message: challenge.message }));
    return (await sessions.session(sessions.cookie(session))).session;
  }
  async function input(handle = "@ALIce"): Promise<CreateDurableMintRequest> {
    return { sessionToken: session.id, sessionGeneration: session.generation, origin: gate.profile.origin, csrf: session.csrf,
      recipient: account.address, handle, eligibility: await gate.witness(handle.replace(/^@/, "").toLowerCase(), account.address) };
  }
  async function complete(id: string): Promise<ReturnType<typeof assessment>> {
    await repository.claimInitial(id); await repository.beforeDispatch(id, "x-identity");
    await repository.recordReceipt(id, bytes(receipt("x-identity"))); await repository.recordIdentity(id, bytes(identity()));
    await repository.beforeDispatch(id, "grok"); await repository.recordReceipt(id, bytes(receipt("grok")));
    const value = assessment(); await repository.acceptAssessment(id, bytes(value)); return value;
  }
  async function counts(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const table of ["requests", "assessment_attempts", "budget_reservations", "jobs"]) result[table] = (await admin.query(`SELECT count(*)::int AS count FROM open_mint.${table} WHERE namespace_id = $1`, [ns.id])).rows[0].count;
    return result;
  }
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    await admin.query(readFileSync(new URL("./requests-schema.sql", import.meta.url), "utf8"));
  }, 30000);
  beforeEach(async () => {
    ns = namespace(); deploymentId = randomUUID(); gate = eligibilityFixture(ns.id, deploymentId);
    await admin.query("INSERT INTO open_mint.namespaces(namespace_id,profile,provenance,policy_version) VALUES ($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES ($1,'fixture-profile-1','development-fixture-v1',true,'2099-01-01',20,10,1,100,100,1000)`, [ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles(namespace_id,origin,chain_id) VALUES ($1,$2,31337)", [ns.id, gate.profile.origin]);
    const p = gate.profile;
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deploymentId, p.chain_id, p.contract_address, p.genesis_hash, p.runtime_code_hash, p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    writer = await ExclusiveWriter.acquire(factory); repository = await OpenMintRepository.open(writer, ns);
    sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin: p.origin, chainId: 31337 });
    requests = await PostgresMintRequests.open(repository, deploymentId); session = await signedSession();
  });
  afterEach(async () => { await writer?.close(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  it("atomically admits one paid job for concurrent duplicate handles while bounding session requests", async () => {
    const parameters = await input(), results = await Promise.allSettled(Array.from({ length: 16 }, () => requests.create(parameters)));
    const fulfilled = results.flatMap(value => value.status === "fulfilled" ? [value.value] : []);
    expect(fulfilled).toHaveLength(10); expect(new Set(fulfilled.map(value => value.attemptId)).size).toBe(1);
    expect(new Set(fulfilled.map(value => value.code)).size).toBe(10);
    expect(await counts()).toEqual({ requests: 10, assessment_attempts: 1, budget_reservations: 1, jobs: 1 });
    const first = fulfilled[0]; expect(first.requestedHandle).toBe("ALIce"); expect(first.expiresAt - first.createdAt).toBe(900000);
    const stored = (await admin.query("SELECT code_hash, session_hash FROM open_mint.requests WHERE namespace_id = $1 AND request_id = $2", [ns.id, first.id])).rows[0];
    expect(stored).toEqual({ code_hash: capabilityHash(first.code), session_hash: capabilityHash(session.id) });
    await expect(admin.query("UPDATE open_mint.requests SET expires_at = expires_at + interval '1 second' WHERE namespace_id = $1", [ns.id])).rejects.toMatchObject({ code: "55000" });
  });
  it("rolls admission/reservation/job back if the last private-request insertion fails", async () => {
    await admin.query(`CREATE FUNCTION open_mint.test_request_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected private request failure'; END $$;
      CREATE TRIGGER test_request_fail BEFORE INSERT ON open_mint.requests FOR EACH ROW EXECUTE FUNCTION open_mint.test_request_fail()`);
    try { await expect(requests.create(await input())).rejects.toThrow("injected private request failure"); }
    finally { await admin.query("DROP TRIGGER test_request_fail ON open_mint.requests; DROP FUNCTION open_mint.test_request_fail()"); }
    expect(await counts()).toEqual({ requests: 0, assessment_attempts: 0, budget_reservations: 0, jobs: 0 });
    expect((await requests.create(await input())).status).toBe("pending-assessment");
  });
  it("requires fresh general proof and exact Origin/CSRF inside admission", async () => {
    const parameters = await input();
    await expect(requests.create({ ...parameters, csrf: "invalid" })).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    await expect(requests.create({ ...parameters, origin: "https://evil.example" })).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    const scoped = await sessions.challenge(session.id, account.address, "a".repeat(43));
    await sessions.verify(session.id, scoped.challengeId, await account.signMessage({ message: scoped.message }));
    const fresh = (await sessions.session(sessions.cookie(session))).session;
    await expect(requests.create({ ...parameters, sessionGeneration: fresh.generation })).rejects.toMatchObject({ code: "WALLET_PROOF_REQUIRED" });
    expect(await counts()).toEqual({ requests: 0, assessment_attempts: 0, budget_reservations: 0, jobs: 0 });
  });
  it.each(["logout", "replace"])("rejects proof changed after external preflight: %s", async operation => {
    const parameters = await input();
    if (operation === "logout") await sessions.logout(session.id); else await sessions.challenge(session.id, account.address);
    await expect(requests.create(parameters)).rejects.toThrow();
    expect(await counts()).toEqual({ requests: 0, assessment_attempts: 0, budget_reservations: 0, jobs: 0 });
  });
  it("rejects fabricated witness and valid witness from a gate with wrong runtime pins", async () => {
    const parameters = await input();
    await expect(requests.create({ ...parameters, eligibility: { eligible: true } })).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    const wrongRuntime = "0x60016001";
    const witness = await gate.witness("alice", account.address, { runtimeCodeHash: keccak256(wrongRuntime) }, wrongRuntime);
    await expect(requests.create({ ...parameters, eligibility: witness })).rejects.toMatchObject({ code: "CHAIN_PROFILE_MISMATCH" });
    expect(await counts()).toEqual({ requests: 0, assessment_attempts: 0, budget_reservations: 0, jobs: 0 });
  });
  it("rolls all writes back if a slow database operation ages the chain witness before commit", async () => {
    await admin.query(`CREATE FUNCTION open_mint.test_request_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$;
      CREATE TRIGGER test_request_delay BEFORE INSERT ON open_mint.requests FOR EACH ROW EXECUTE FUNCTION open_mint.test_request_delay()`);
    const parameters = await input(), eligibility = await gate.witness("alice", account.address, { evidenceTtlMs: 1000 });
    try { await expect(requests.create({ ...parameters, eligibility })).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" }); }
    finally { await admin.query("DROP TRIGGER test_request_delay ON open_mint.requests; DROP FUNCTION open_mint.test_request_delay()"); }
    expect(await counts()).toEqual({ requests: 0, assessment_attempts: 0, budget_reservations: 0, jobs: 0 });
  });
  it("reuses accepted assessment with generation disabled and preserves linkage/read scope on restart", async () => {
    const original = await requests.create(await input()), value = await complete(original.attemptId!);
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled = false WHERE namespace_id = $1", [ns.id]);
    const reused = await requests.create(await input("aLiCe"));
    expect(reused.status).toBe("assessment-accepted"); expect(reused.assessmentId).toBe(value.id); expect(reused.code).not.toBe(original.code);
    expect(await counts()).toEqual({ requests: 2, assessment_attempts: 1, budget_reservations: 1, jobs: 2 });
    const cookie = sessions.cookie(session);
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); repository = await OpenMintRepository.open(writer, ns);
    requests = await PostgresMintRequests.open(repository, deploymentId);
    sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin: gate.profile.origin, chainId: 31337 });
    session = (await sessions.session(cookie)).session;
    expect(await requests.get(reused.code, session.id)).toEqual(reused);
    const observed = await requests.get(original.code, session.id);
    expect(observed.status).toBe("assessment-accepted"); expect(observed.assessmentId).toBe(value.id); expect(observed.expiresAt).toBe(original.expiresAt);
    const other = await signedSession(); await expect(requests.get(reused.code, other.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("keeps expired requests privately readable without extending their original lifetime", async () => {
    const request = await requests.create(await input());
    // Historical fixture seed only: the runtime role must never disable this trigger.
    await admin.query("ALTER TABLE open_mint.requests DISABLE TRIGGER immutable_request");
    try { await admin.query(`UPDATE open_mint.requests SET created_at = created_at - interval '16 minutes', expires_at = expires_at - interval '16 minutes',
      preflight_observed_at = preflight_observed_at - interval '16 minutes', preflight_valid_until = preflight_valid_until - interval '16 minutes' WHERE namespace_id = $1`, [ns.id]); }
    finally { await admin.query("ALTER TABLE open_mint.requests ENABLE TRIGGER immutable_request"); }
    const expired = await requests.get(request.code, session.id);
    expect(expired.expiresAt).toBe(request.expiresAt - 960000); expect(expired.expiresAt).toBeLessThan(Date.now());
    expect(await counts()).toEqual({ requests: 1, assessment_attempts: 1, budget_reservations: 1, jobs: 1 });
  });
});
