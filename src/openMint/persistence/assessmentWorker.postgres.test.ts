import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Client } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssessmentProvider } from "../assessment.js";
import type { AssessmentExecution } from "../assessmentOperations.js";
import { XApiIdentityResolver } from "../xIdentity.js";
import { PostgresAssessmentWorker, type AssessmentWorkerIntent } from "./assessmentWorker.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { PostgresWalletSessions, type DurableSiteSession } from "./sessions.js";
import { ExclusiveWriter } from "./writer.js";
import { identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";

const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("isolated PostgreSQL explicit assessment execution (mock transports only)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter, repository: OpenMintRepository,
    sessions: PostgresWalletSessions, requests: PostgresMintRequests, session: DurableSiteSession, ns: ReturnType<typeof namespace>,
    gate: ReturnType<typeof eligibilityFixture>, deploymentId: string, worker: PostgresAssessmentWorker, intent: AssessmentWorkerIntent,
    attemptId: string, ownerName: string;
  let provider: AssessmentProvider, resolver: { provenance: "x-api"; resolve: ReturnType<typeof vi.fn<(handle: string, execution?: AssessmentExecution) => Promise<ReturnType<typeof identity>>>> },
    refresh: ReturnType<typeof vi.fn<NonNullable<ConstructorParameters<typeof PostgresAssessmentWorker>[1]>["refreshEligibility"] & Function>>;
  const factory = () => new Client({ ...cluster.config, application_name: ownerName });
  async function create(handle = "alice") {
    return requests.create({ sessionToken: session.id, sessionGeneration: session.generation, origin: gate.profile.origin, csrf: session.csrf,
      recipient: account.address, handle, eligibility: await gate.witness(handle, account.address) });
  }
  async function row() {
    return (await admin.query(`SELECT a.state,j.state AS job_state,(SELECT count(*)::int FROM open_mint.dispatch_fences WHERE namespace_id=a.namespace_id AND attempt_id=a.attempt_id) AS fences,
      (SELECT count(*)::int FROM open_mint.provider_receipts WHERE namespace_id=a.namespace_id AND attempt_id=a.attempt_id) AS receipts,
      (SELECT count(*)::int FROM open_mint.budget_reservations WHERE namespace_id=a.namespace_id AND attempt_id=a.attempt_id) AS reservations
      FROM open_mint.assessment_attempts a JOIN open_mint.jobs j USING(namespace_id,attempt_id)
      WHERE a.namespace_id=$1 AND a.attempt_id=$2 AND j.kind='assessment'`, [ns.id, attemptId])).rows[0];
  }
  async function fault(table: string, work: () => Promise<void>) {
    await admin.query(`CREATE FUNCTION open_mint.test_worker_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected worker write failure'; END $$;
      CREATE TRIGGER test_worker_fail BEFORE INSERT ON open_mint.${table} FOR EACH ROW EXECUTE FUNCTION open_mint.test_worker_fail()`);
    try { await work(); }
    finally { await admin.query(`DROP TRIGGER test_worker_fail ON open_mint.${table}; DROP FUNCTION open_mint.test_worker_fail()`); }
  }
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    await admin.query(readFileSync(new URL("./requests-schema.sql", import.meta.url), "utf8"));
  }, 30000);
  beforeEach(async () => {
    ns = { ...namespace(), profile: "local-real", provenance: "grok" }; deploymentId = randomUUID(); gate = eligibilityFixture(ns.id, deploymentId); ownerName = randomUUID();
    await admin.query("INSERT INTO open_mint.namespaces(namespace_id,profile,provenance,policy_version) VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-test-profile','grok-offline-test',true,'2099-01-01',20,10,1,100,100,1000)`, [ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles(namespace_id,origin,chain_id) VALUES($1,$2,31337)", [ns.id, gate.profile.origin]);
    const p = gate.profile;
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deploymentId, p.chain_id, p.contract_address, p.genesis_hash, p.runtime_code_hash, p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    writer = await ExclusiveWriter.acquire(factory); repository = await OpenMintRepository.open(writer, ns);
    sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin: p.origin, chainId: 31337 }); requests = await PostgresMintRequests.open(repository, deploymentId);
    session = (await sessions.session()).session;
    const challenge = await sessions.challenge(session.id, account.address); await sessions.verify(session.id, challenge.challengeId, await account.signMessage({ message: challenge.message }));
    session = (await sessions.session(sessions.cookie(session))).session;
    const request = await create(); attemptId = request.attemptId!;
    intent = { code: request.code, sessionToken: session.id, sessionGeneration: session.generation, origin: p.origin, csrf: session.csrf, eligibility: await gate.witness("alice", account.address) };
    provider = { provenance: "grok", model: "grok-offline-test", assess: vi.fn<AssessmentProvider["assess"]>(async (handle, snapshot, execution) => {
      expect((await row()).fences).toBe(2); await execution!.recordReceipt(receipt("grok", "1"));
      return { handle, mbti: "INTJ", model: "grok-offline-test", providerResponseId: "offline-test-response", sourceUrls: [`https://x.com/${handle}`], xUserId: snapshot!.userId };
    }) };
    resolver = { provenance: "x-api", resolve: vi.fn(async (handle: string, execution?: AssessmentExecution) => {
      expect((await row()).fences).toBe(1); await execution!.recordReceipt(receipt("x-identity", "1")); return { ...identity(handle), provenance: "x-api" as const };
    }) };
    refresh = vi.fn(async ({ handle, recipient }) => gate.witness(handle, recipient));
    worker = new PostgresAssessmentWorker(requests, { timeoutMs: 5000, provider, identityResolver: resolver, refreshEligibility: refresh });
  });
  afterEach(async () => { await writer?.close(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  it("allows one explicit concurrent execution and atomically accepts result plus render job", async () => {
    const results = await Promise.allSettled([worker.run(intent), worker.run(intent)]);
    expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(provider.assess).toHaveBeenCalledTimes(1); expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(await row()).toEqual({ state: "accepted", job_state: "complete", fences: 2, receipts: 2, reservations: 1 });
    expect((await requests.get(intent.code, session.id)).status).toBe("assessment-accepted");
    expect((await admin.query("SELECT kind,state FROM open_mint.jobs WHERE namespace_id=$1 AND kind='render'", [ns.id])).rows).toEqual([{ kind: "render", state: "queued" }]);
  });
  it("reuses exact accepted work with generation disabled and no generation adapters", async () => {
    const original = await worker.run(intent); await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [ns.id]);
    const reused = await new PostgresAssessmentWorker(requests, { timeoutMs: 5000 }).run(intent);
    expect(reused).toEqual({ ...original, reused: true }); expect(provider.assess).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong request proof and generation kill switch before claiming", async () => {
    await expect(worker.run({ ...intent, csrf: "invalid" })).rejects.toThrow("SESSION_REQUIRED");
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [ns.id]);
    await expect(worker.run(intent)).rejects.toThrow("Generation disabled");
    expect(await row()).toMatchObject({ state: "pending", job_state: "queued", fences: 0 }); expect(resolver.resolve).not.toHaveBeenCalled();
  });
  it.each(["logout", "kill-switch"])("rechecks %s before Grok after retaining X evidence", async change => {
    const resolve = resolver.resolve.getMockImplementation()!;
    resolver.resolve.mockImplementation(async (...args) => {
      const value = await resolve(...args);
      if (change === "logout") await sessions.logout(session.id); else await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [ns.id]);
      return value;
    });
    await expect(worker.run(intent)).resolves.toMatchObject({ outcome: { kind: "uncertain", phase: "x-identity" } });
    expect(provider.assess).not.toHaveBeenCalled(); expect(await row()).toMatchObject({ state: "closed", job_state: "complete", fences: 1, receipts: 1, reservations: 1 });
    if (change === "kill-switch") {
      await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=true WHERE namespace_id=$1", [ns.id]);
      await expect(create("bob")).rejects.toThrow("operator reconciliation");
    }
  });
  it("rejects a forged fresh witness after claim and never reopens a blocked handle", async () => {
    refresh.mockResolvedValue({ eligible: true });
    await expect(worker.run(intent)).resolves.toMatchObject({ outcome: { kind: "blocked-before-dispatch", phase: "before-dispatch" } });
    expect((await requests.get(intent.code, session.id)).status).toBe("assessment-blocked"); expect((await create()).status).toBe("assessment-blocked");
    await expect(worker.run(intent)).rejects.toThrow("attempt/model/profile mismatch"); expect(resolver.resolve).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ state: "closed", job_state: "complete", fences: 0, receipts: 0, reservations: 1 });
  });
  it("rolls back a failed dispatch fence before any transport", async () => {
    await fault("dispatch_fences", async () => { await expect(worker.run(intent)).resolves.toMatchObject({ outcome: { kind: "blocked-before-dispatch" } }); });
    expect(resolver.resolve).not.toHaveBeenCalled(); expect(await row()).toMatchObject({ fences: 0, state: "closed" });
  });
  it.each(["provider_receipts", "assessments", "assessment_terminals"])("preserves interrupted job on %s write failure and refuses restart replay", async table => {
    if (table === "assessment_terminals") vi.mocked(provider.assess).mockImplementation(async (handle, snapshot, execution) => {
      await execution!.recordReceipt(receipt("grok", "1")); return { kind: "abstained", reason: "provider-refusal", handle, model: provider.model, providerResponseId: "offline-refusal", xUserId: snapshot!.userId };
    });
    await fault(table, async () => { await expect(worker.run(intent)).rejects.toThrow("injected worker write failure"); });
    expect(await repository.getTerminal(attemptId)).toBeUndefined(); expect(await row()).toMatchObject({ state: "pending", job_state: "running", reservations: 1 });
    const called = vi.mocked(provider.assess).mock.calls.length;
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, deploymentId);
    worker = new PostgresAssessmentWorker(requests, { timeoutMs: 5000, provider, identityResolver: resolver, refreshEligibility: refresh });
    await expect(worker.run(intent)).rejects.toThrow("already claimed"); expect(provider.assess).toHaveBeenCalledTimes(called);
  });
  it("records abstention immutably, frees active slot only, and retains known spend", async () => {
    vi.mocked(provider.assess).mockImplementation(async (handle, snapshot, execution) => {
      await execution!.recordReceipt(receipt("grok", "1")); return { kind: "abstained", reason: "insufficient-evidence", handle, model: provider.model, providerResponseId: "offline-refusal", xUserId: snapshot!.userId };
    });
    await expect(worker.run(intent)).resolves.toMatchObject({ outcome: { kind: "abstained", reason: "insufficient-evidence" } });
    expect((await requests.get(intent.code, session.id)).status).toBe("assessment-abstained"); expect((await create()).status).toBe("assessment-abstained");
    expect((await create("bob")).status).toBe("pending-assessment");
    expect(await row()).toMatchObject({ state: "closed", job_state: "complete", receipts: 2, reservations: 1 });
    await expect(admin.query("UPDATE open_mint.assessment_terminals SET kind='invalid',reason=NULL WHERE namespace_id=$1", [ns.id])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("UPDATE open_mint.assessment_attempts SET state='pending' WHERE namespace_id=$1 AND attempt_id=$2", [ns.id, attemptId])).rejects.toMatchObject({ code: "55000" });
    await expect(repository.finishAttempt(attemptId, { kind: "invalid" })).rejects.toThrow("Conflicting immutable");
    expect((await admin.query("SELECT sum(reserved_usd_ticks)::text AS total FROM open_mint.budget_reservations WHERE namespace_id=$1", [ns.id])).rows[0].total).toBe("200");
  });
  it("records malformed returned semantics as invalid without inserting an assessment", async () => {
    vi.mocked(provider.assess).mockImplementation(async (_handle, _snapshot, execution) => { await execution!.recordReceipt(receipt("grok", "1")); return { bad: "raw data never saved" } as never; });
    await expect(worker.run(intent)).resolves.toMatchObject({ outcome: { kind: "invalid", phase: "grok" } });
    expect((await requests.get(intent.code, session.id)).status).toBe("assessment-invalid"); expect(await repository.getAssessment("alice")).toBeUndefined();
  });
  it("persists actual X resolver semantic invalidity only after its mocked successful receipt", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { id: "123", username: "wrong" } }))) as typeof globalThis.fetch;
    worker = new PostgresAssessmentWorker(requests, { timeoutMs: 5000, provider, refreshEligibility: refresh,
      identityResolver: new XApiIdentityResolver({ bearerToken: "offline-mock-token", fetch }) });
    await expect(worker.run(intent)).resolves.toMatchObject({ outcome: { kind: "invalid", phase: "x-identity" } });
    expect(await row()).toMatchObject({ state: "closed", job_state: "complete", fences: 1, receipts: 1 });
    expect(await repository.getReceipt(attemptId, "x-identity")).toMatchObject({ category: "success", cost: { status: "unknown" } });
    await expect(create("bob")).rejects.toThrow("operator reconciliation"); expect(provider.assess).not.toHaveBeenCalled();
  });
  it("retains accepted evidence when logout occurs after the final provider response", async () => {
    const assess = vi.mocked(provider.assess).getMockImplementation()!;
    vi.mocked(provider.assess).mockImplementation(async (...args) => { const value = await assess(...args); await sessions.logout(session.id); return value; });
    await expect(worker.run(intent)).rejects.toThrow("SESSION_REQUIRED");
    expect(await row()).toMatchObject({ state: "accepted", job_state: "complete", fences: 2, receipts: 2 });
    expect(await repository.getTerminal(attemptId)).toBeUndefined(); expect(await repository.getAssessment("alice")).toBeDefined();
  });
  it("rolls back a fence when database delay ages its witness before commit", async () => {
    refresh.mockImplementation(async ({ handle, recipient }) => gate.witness(handle, recipient, { evidenceTtlMs: 1000 }));
    await admin.query(`CREATE FUNCTION open_mint.test_worker_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$;
      CREATE TRIGGER test_worker_delay BEFORE INSERT ON open_mint.dispatch_fences FOR EACH ROW EXECUTE FUNCTION open_mint.test_worker_delay()`);
    try { await expect(worker.run(intent)).resolves.toMatchObject({ outcome: { kind: "blocked-before-dispatch" } }); }
    finally { await admin.query("DROP TRIGGER test_worker_delay ON open_mint.dispatch_fences; DROP FUNCTION open_mint.test_worker_delay()"); }
    expect(resolver.resolve).not.toHaveBeenCalled(); expect(await row()).toMatchObject({ fences: 0, state: "closed" });
  });
  it("fails closed on ownership loss after committed X dispatch and never starts Grok", async () => {
    resolver.resolve.mockImplementation(async handle => {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1", [ownerName]);
      return { ...identity(handle), provenance: "x-api" };
    });
    await expect(worker.run(intent)).rejects.toThrow(); expect(provider.assess).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ state: "pending", job_state: "running", fences: 1, receipts: 0 });
  });
  it("times out hung refresh using durable zero-fence evidence and refuses late continuation", async () => {
    let release!: (value: unknown) => void, arrived!: () => void, elapsed = 0;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    refresh.mockImplementation(() => new Promise(resolve => { release = resolve; arrived(); }));
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      worker = new PostgresAssessmentWorker(requests, { timeoutMs: 30, provider, identityResolver: resolver, refreshEligibility: refresh });
      const pending = worker.run(intent); await ready;
      elapsed = 31; await vi.advanceTimersByTimeAsync(31);
      await expect(pending).resolves.toMatchObject({ outcome: { kind: "blocked-before-dispatch", phase: "before-dispatch" } });
      release(await gate.witness("alice", account.address)); await vi.advanceTimersByTimeAsync(0);
      expect(await row()).toMatchObject({ state: "closed", job_state: "complete", fences: 0 }); expect(resolver.resolve).not.toHaveBeenCalled();
    } finally { release?.(undefined); monotonic.mockRestore(); vi.useRealTimers(); }
  });
  it("cannot create a late claim if its deadline expires behind another transaction", async () => {
    const slow = writer.transaction(async tx => { await tx.query("SELECT pg_sleep(0.1)"); });
    worker = new PostgresAssessmentWorker(requests, { timeoutMs: 20, provider, identityResolver: resolver, refreshEligibility: refresh });
    await expect(worker.run(intent)).rejects.toThrow("deadline exceeded"); await slow;
    expect(await row()).toMatchObject({ state: "pending", job_state: "queued", fences: 0 }); expect(await repository.getTerminal(attemptId)).toBeUndefined();
  });
  it("cancels a queued receipt write and determines uncertainty from committed fences", async () => {
    let receiptWrite: Promise<void> | undefined, arrived!: () => void, release!: () => void, elapsed = 0;
    const ready = new Promise<void>(resolve => { arrived = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    resolver.resolve.mockImplementation(async (handle, execution) => {
      const slow = writer.transaction(async tx => { await tx.query("SELECT 1"); arrived(); await held; });
      receiptWrite = execution!.recordReceipt(receipt("x-identity", "1"));
      await Promise.all([receiptWrite, slow]); return { ...identity(handle), provenance: "x-api" };
    });
    // Let real SQL reach the committed dispatch fence and queued receipt before
    // advancing the deadline. Runner speed must not choose a different phase.
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      worker = new PostgresAssessmentWorker(requests, { timeoutMs: 30, provider, identityResolver: resolver, refreshEligibility: refresh });
      const pending = worker.run(intent); await ready;
      elapsed = 31; await vi.advanceTimersByTimeAsync(31); release();
      await expect(pending).resolves.toMatchObject({ outcome: { kind: "uncertain", phase: "x-identity" } });
      await expect(receiptWrite).rejects.toThrow("deadline exceeded");
      expect(await row()).toMatchObject({ state: "closed", job_state: "complete", fences: 1, receipts: 0 }); expect(provider.assess).not.toHaveBeenCalled();
    } finally { release(); monotonic.mockRestore(); vi.useRealTimers(); }
  });
});
