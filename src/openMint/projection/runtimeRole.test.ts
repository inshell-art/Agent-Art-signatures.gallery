import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { projectionRpcFixture } from "../fixtures/projectionRpc.js";
import { disposablePostgres, installSchema } from "../persistence/fixtures/postgres.js";
import { auditProjectionRole } from "../persistence/roleAudit.js";
import { projectionRuntimeGrants, PROJECTION_RUNTIME_PRIVILEGES } from "../persistence/runtimeRole.js";
import { ExclusiveWriter } from "../persistence/writer.js";
import { createProjectionCoordinator } from "./coordinator.js";
import { OpenMintProjection } from "./postgres.js";

describe("explicit projection-role grant surface", () => {
  it("limits rollback DELETE to materialized rows and leaves immutable evidence select/insert only", () => {
    const sql = projectionRuntimeGrants("test_projection");
    expect(PROJECTION_RUNTIME_PRIVILEGES.filter(p => p.delete).map(p => p.name)).toEqual(["projection_mints", "projection_ownership"]);
    expect(sql).not.toMatch(/CREATE ROLE|ALL PRIVILEGES|ALL TABLES|ALTER DEFAULT|OWNER|GRANT OPTION|TRUNCATE/);
    expect(sql).toContain('GRANT UPDATE (canonical) ON open_mint.projection_blocks TO "test_projection";');
    for (const name of ["projection_logs", "projection_promotions", "authorizations", "assessments", "public_artifacts"]) expect(sql).not.toContain(`DELETE ON open_mint.${name}`);
  });
  it.each(["public", "pg_read_all_data", "unsafe;drop", ""])("refuses invalid role %s", role => { expect(() => projectionRuntimeGrants(role)).toThrow(); });
});

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("restricted preparation + projection role, real disposable PostgreSQL", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, runtime: Client, writer: ExclusiveWriter;
  let fixture: Awaited<ReturnType<typeof projectionRpcFixture>>, projection: OpenMintProjection, service: ReturnType<typeof createProjectionCoordinator>;
  const role = "sg_projection_runtime";
  const factory = () => new Client({ ...cluster.config, user: role, options: "-c search_path=pg_catalog" });
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "publication-schema.sql", "authorization-schema.sql"]) await admin.query(readFileSync(new URL(`../persistence/${file}`, import.meta.url), "utf8"));
    await admin.query(readFileSync(new URL("./projection-schema.sql", import.meta.url), "utf8"));
    await admin.query(readFileSync(new URL("./projection-v2.sql", import.meta.url), "utf8"));
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(projectionRuntimeGrants(role)); runtime = factory(); await runtime.connect();
  }, 30000);
  beforeEach(async () => {
    fixture = await projectionRpcFixture();
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,'local-fixture','development-fixture','fixture-policy')", [fixture.options.deployment.namespaceId]);
    writer = await ExclusiveWriter.acquire(factory); projection = await OpenMintProjection.open(writer, fixture.options.deployment);
    service = createProjectionCoordinator(projection, fixture.options);
  });
  afterEach(async () => { await writer?.close(); });
  afterAll(async () => { await runtime?.end(); await admin?.end(); cluster?.stop(); });
  it("audits the exact combined surface through a directly authenticated, nonowner role", async () => {
    expect(await auditProjectionRole(runtime)).toMatchObject({ scope: "open-mint-projection-role-v1", ok: true, failedChecks: [] });
    expect((await runtime.query("SELECT current_user,session_user")).rows[0]).toEqual({ current_user: role, session_user: role });
  });
  it("runs verified inclusion, shallow rollback and finalized promotion without superuser privileges", async () => {
    expect(await service.sync(new AbortController().signal)).toBe("observed");
    expect((await service.lookup("alice_bob_key")).state).toBe("confirming");
    fixture.fork(12); expect(await service.sync(new AbortController().signal)).toBe("observed");
    fixture.setFinalized(11); expect(await service.sync(new AbortController().signal)).toBe("observed");
    expect((await service.gallery({ filter: { kind: "home" }, limit: 1 })).items).toHaveLength(1);
    const token = BigInt(fixture.evidence.reservation.authorization.handleKey).toString();
    await projection.setArtifactAvailability({ tokenId: token, artifactDigest: fixture.evidence.artifact.digest, availability: "available" });
    expect((await service.lookup("alice_bob_key")).item?.availability).toBe("available");
    await expect(runtime.query("DELETE FROM open_mint.projection_ownership WHERE deployment_id=$1", [fixture.options.deployment.id])).rejects.toMatchObject({ code: "55000" });
    await expect(runtime.query("UPDATE open_mint.projection_ownership SET end_block=11,end_transaction=1,end_log=2 WHERE deployment_id=$1", [fixture.options.deployment.id])).rejects.toMatchObject({ code: "55000" });
  });
  it("can remove orphan materialization but cannot remove a promoted mint", async () => {
    await service.sync(new AbortController().signal); fixture.fork(11);
    expect(await service.sync(new AbortController().signal)).toBe("observed"); expect((await service.lookup("alice_bob_key")).state).toBe("unknown");
    // A different namespace avoids rewriting the orphaned history or assessment.
    const other = await projectionRpcFixture();
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,'local-fixture','development-fixture','fixture-policy')", [other.options.deployment.namespaceId]);
    const p = await OpenMintProjection.open(writer, other.options.deployment); other.setFinalized(11);
    await createProjectionCoordinator(p, other.options).sync(new AbortController().signal);
    await expect(runtime.query("DELETE FROM open_mint.projection_mints WHERE deployment_id=$1", [other.options.deployment.id])).rejects.toMatchObject({ code: "55000" });
  });
  it.each([
    "DELETE FROM open_mint.projection_logs", "DELETE FROM open_mint.projection_blocks", "DELETE FROM open_mint.projection_promotions",
    "DELETE FROM open_mint.assessments", "DELETE FROM open_mint.authorization_signatures", "DELETE FROM open_mint.public_artifacts",
    "UPDATE open_mint.projection_blocks SET hash='changed'", "UPDATE open_mint.projection_mints SET mbti='ENFP'",
    "UPDATE open_mint.projection_ownership SET owner='changed'", "UPDATE open_mint.projection_deployments SET configuration='changed'",
    "UPDATE open_mint.issuance_profiles SET enabled=true", "UPDATE open_mint.budget_policies SET generation_enabled=true",
    "TRUNCATE open_mint.projection_logs", "ALTER TABLE open_mint.projection_logs DISABLE TRIGGER ALL", "SET session_replication_role=replica",
  ])("denies capability outside the profile: %s", async sql => { await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" }); });
  it.each(["DELETE ON open_mint.projection_logs", "UPDATE (payload) ON open_mint.projection_mints", "UPDATE ON open_mint.projection_blocks", "TRUNCATE ON open_mint.projection_ownership"])("detects excessive grant %s", async grant => {
    await admin.query(`GRANT ${grant} TO ${role}`);
    try { expect((await auditProjectionRole(runtime)).failedChecks).toContain("noExtraPrivileges"); }
    finally { await admin.query(`REVOKE ${grant} FROM ${role}`); await admin.query(projectionRuntimeGrants(role)); }
  });
  it("detects missing rollback privilege and grant-option escalation", async () => {
    await admin.query(`REVOKE DELETE ON open_mint.projection_mints FROM ${role}`);
    try { expect((await auditProjectionRole(runtime)).failedChecks).toContain("requiredPrivileges"); }
    finally { await admin.query(projectionRuntimeGrants(role)); }
    await admin.query(`GRANT DELETE ON open_mint.projection_mints TO ${role} WITH GRANT OPTION`);
    try { expect((await auditProjectionRole(runtime)).failedChecks).toContain("noGrantOptions"); }
    finally { await admin.query(`REVOKE GRANT OPTION FOR DELETE ON open_mint.projection_mints FROM ${role}`); }
  });
});
