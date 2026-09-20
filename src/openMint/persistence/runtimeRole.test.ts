import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foundationRuntimeGrants } from "./runtimeRole.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { assessment, bytes, identity, namespace, receipt } from "./fixtures/data.js";
import { OpenMintRepository } from "./repository.js";
import { ExclusiveWriter } from "./writer.js";
import { PostgresWalletSessions } from "./sessions.js";

describe("explicit foundation runtime grants", () => {
  it.each(["", "PUBLIC", "public", "pg_read_all_data", "runtime; DROP SCHEMA open_mint", "A", "x".repeat(64)])("rejects unsafe/reserved role %s", value => {
    expect(() => foundationRuntimeGrants(value)).toThrow("role");
  });
  it("grants no ownership, blanket privileges, policy mutation or automatic future access", () => {
    const sql = foundationRuntimeGrants("open_mint_runtime");
    expect(sql).toContain('TO "open_mint_runtime"');
    expect(sql).not.toMatch(/CREATE ROLE|ALL PRIVILEGES|ALL TABLES|ALTER DEFAULT|OWNER|GRANT OPTION|DELETE|TRUNCATE|UPDATE \(generation_enabled\)/);
  });
});

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("disposable PostgreSQL restricted foundation role", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, runtime: Client, outsider: Client, writer: ExclusiveWriter;
  const ns = namespace();
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    // Passwordless roles exist only inside this disposable, private Unix-socket
    // cluster. Authenticate directly so RESET ROLE cannot regain owner access.
    await admin.query("CREATE ROLE sg_test_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; CREATE ROLE sg_test_outsider LOGIN NOSUPERUSER");
    await admin.query(foundationRuntimeGrants("sg_test_runtime"));
    await admin.query("INSERT INTO open_mint.namespaces VALUES ($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies VALUES ($1,'fixture-profile-1','development-fixture-v1',true,'2099-01-01',20,10,1,100,100,1000)`, [ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES ($1,'http://127.0.0.1:3021',31337)", [ns.id]);
    runtime = new Client({ ...cluster.config, user: "sg_test_runtime" }); await runtime.connect();
    outsider = new Client({ ...cluster.config, user: "sg_test_outsider" }); await outsider.connect();
    writer = await ExclusiveWriter.acquire(() => new Client({ ...cluster.config, user: "sg_test_runtime" }));
  }, 30000);
  afterAll(async () => { await writer?.close(); await runtime?.end(); await outsider?.end(); await admin?.end(); cluster?.stop(); });

  it("runs committed fences, receipt/identity acceptance and render-job admission without owner privileges", async () => {
    expect((await runtime.query("SELECT current_user AS name")).rows[0].name).toBe("sg_test_runtime");
    const repo = await OpenMintRepository.open(writer, ns), admitted = await repo.admitInitial("alice");
    if (admitted.kind === "accepted") throw new Error("Unexpected prior result");
    await repo.claimInitial(admitted.attemptId); await repo.beforeDispatch(admitted.attemptId, "x-identity");
    await repo.recordReceipt(admitted.attemptId, bytes(receipt("x-identity"))); await repo.recordIdentity(admitted.attemptId, bytes(identity()));
    await repo.beforeDispatch(admitted.attemptId, "grok"); await repo.recordReceipt(admitted.attemptId, bytes(receipt("grok")));
    const accepted = assessment(); await expect(repo.acceptAssessment(admitted.attemptId, bytes(accepted))).resolves.toEqual(accepted);
    expect((await repo.admitInitial("ALICE")).kind).toBe("accepted");
  });
  it("supports sessions and challenge consumption while denying session-lifetime rewriting", async () => {
    const sessions = await PostgresWalletSessions.open({ writer, namespaceId: ns.id, origin: "http://127.0.0.1:3021", chainId: 31337,
      verifySignature: async () => undefined }); // Database-flow test, not signature evidence.
    const { session } = await sessions.session();
    await sessions.authorizePost(session.id, "http://127.0.0.1:3021", session.csrf);
    const challenge = await sessions.challenge(session.id, "0x1111111111111111111111111111111111111111");
    await sessions.verify(session.id, challenge.challengeId, "database-test");
    await expect(runtime.query("UPDATE open_mint.sessions SET expires_at = '2099-01-01'")).rejects.toMatchObject({ code: "42501" });
    await sessions.logout(session.id);
  });
  it("cannot enable generation, change bounds/profiles, insert policies or grant access", async () => {
    for (const sql of [
      "UPDATE open_mint.budget_policies SET generation_enabled = false", "UPDATE open_mint.budget_policies SET max_total = 100000",
      "UPDATE open_mint.namespaces SET policy_version = 'changed'", "UPDATE open_mint.session_profiles SET origin = 'https://other.example'",
      "INSERT INTO open_mint.budget_policies SELECT * FROM open_mint.budget_policies",
    ]) await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    // PostgreSQL reports insufficient GRANT OPTION as a warning/no-op.
    await runtime.query("GRANT USAGE ON SCHEMA open_mint TO sg_test_outsider");
    expect((await admin.query("SELECT has_schema_privilege('sg_test_outsider','open_mint','USAGE') AS access")).rows[0].access).toBe(false);
    expect((await admin.query("SELECT generation_enabled FROM open_mint.budget_policies WHERE namespace_id=$1", [ns.id])).rows[0].generation_enabled).toBe(true);
  });
  it("cannot delete/truncate evidence, bypass triggers or alter the schema", async () => {
    for (const sql of [
      "DELETE FROM open_mint.provider_receipts", "TRUNCATE open_mint.assessments", "ALTER TABLE open_mint.assessments DISABLE TRIGGER ALL",
      "CREATE TABLE open_mint.unreviewed (id integer)", "DROP TABLE open_mint.assessments", "SET session_replication_role = replica",
    ]) await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query("UPDATE open_mint.handle_guards SET handle = 'bob'")).rejects.toMatchObject({ code: "55000" });
  });
  it("gives an unrelated role no access to private records or trigger functions", async () => {
    await expect(outsider.query("SELECT * FROM open_mint.sessions")).rejects.toMatchObject({ code: "42501" });
    expect((await outsider.query("SELECT has_schema_privilege(current_user, 'open_mint', 'USAGE') AS access")).rows[0].access).toBe(false);
  });
});
