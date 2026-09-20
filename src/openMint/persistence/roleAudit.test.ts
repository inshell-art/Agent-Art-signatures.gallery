import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditFoundationRole, requireFoundationRole, type FoundationRoleCheck, type RoleAuditConnection } from "./roleAudit.js";
import { FOUNDATION_RUNTIME_PRIVILEGES, foundationRuntimeGrants } from "./runtimeRole.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";

const valid = { postgresVersion: true, identity: true, restrictedRoles: true, noRoleDelegation: true, noOwnership: true,
  noCreation: true, noSecurityDefiner: true, noParameterEscalation: true, foundationLayout: true, requiredPrivileges: true,
  noExtraPrivileges: true, noGrantOptions: true };
function mockConnection(row: Record<string, unknown> = valid, settings = { version: "160015", path: "pg_catalog", timeout: "3s" }) {
  return { query: vi.fn(async sql => ({ rows: [sql.startsWith("SELECT") ? settings : row] })) } as RoleAuditConnection & { query: ReturnType<typeof vi.fn> };
}
describe("read-only sanitized foundation role audit", () => {
  it("uses only catalog reads with the exact shared allowlist and returns an immutable finite report", async () => {
    const connection = mockConnection(), report = await requireFoundationRole(connection);
    expect(report).toEqual({ scope: "open-mint-foundation-role-v1", ok: true, checks: valid, failedChecks: [] });
    expect(Object.isFrozen(report)).toBe(true); expect(Object.isFrozen(report.checks)).toBe(true); expect(Object.isFrozen(report.failedChecks)).toBe(true);
    expect(connection.query).toHaveBeenCalledTimes(2);
    for (const [sql] of connection.query.mock.calls) expect(sql).toMatch(/^(?:SELECT|WITH)\b/);
    expect(JSON.parse(connection.query.mock.calls[1][1][0])).toEqual(FOUNDATION_RUNTIME_PRIVILEGES);
    expect(FOUNDATION_RUNTIME_PRIVILEGES.find(table => table.name === "assessment_terminals")).toMatchObject({ insert: true, updates: [] });
  });
  it.each(Object.keys(valid) as FoundationRoleCheck[])("fails closed on rejected %s capability", async key => {
    const report = await auditFoundationRole(mockConnection({ ...valid, [key]: false }));
    expect(report.ok).toBe(false); expect(report.failedChecks).toEqual([key]);
    await expect(requireFoundationRole(mockConnection({ ...valid, [key]: false }))).rejects.toThrow("audit unavailable or rejected");
  });
  it.each([
    { version: "150000" }, { version: "170000" }, { path: '"$user", public' }, { path: "public,pg_catalog" },
    { timeout: "0" }, { timeout: "6s" }, { timeout: "1min" }, { timeout: "-1" },
  ])("rejects unsupported connection prerequisites without issuing the catalog scan: %j", async changes => {
    const connection = mockConnection(valid, { version: "160015", path: "pg_catalog", timeout: "3s", ...changes });
    await expect(auditFoundationRole(connection)).rejects.toThrow("audit unavailable or rejected"); expect(connection.query).toHaveBeenCalledOnce();
  });
  it.each([{}, { ...valid, identity: undefined }, { ...valid, identity: "true" }, { ...valid, private: "secret" }])("rejects missing/malformed/unexpected capability rows", async row => {
    await expect(auditFoundationRole(mockConnection(row))).rejects.toThrow("audit unavailable or rejected");
  });
  it("sanitizes connection errors and does not retry", async () => {
    const connection = { query: vi.fn(async () => { throw new Error("postgres://private:secret@database.invalid"); }) };
    const error = await auditFoundationRole(connection).catch(value => value);
    expect(error.message).toBe("Foundation database role audit unavailable or rejected."); expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("secret"); expect(connection.query).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("directly authenticated role audit in disposable PostgreSQL 16", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, counter = 0;
  const clients: Client[] = [];
  async function restricted(grants = true) {
    const role = `audit_runtime_${++counter}`;
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    if (grants) await admin.query(foundationRuntimeGrants(role));
    const client = new Client({ ...cluster.config, user: role, options: "-c search_path=pg_catalog" }); await client.connect(); clients.push(client);
    return { role, client };
  }
  async function helper() {
    const role = `audit_helper_${++counter}`;
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    return role;
  }
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
  }, 30000);
  afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.end())); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });
  it("accepts direct intended grants, including immutable-key row-lock updates, without changing auth or settings", async () => {
    const { client, role } = await restricted();
    expect((await client.query("SELECT current_user AS current, session_user AS session")).rows[0]).toEqual({ current: role, session: role });
    await expect(requireFoundationRole(client)).resolves.toMatchObject({ ok: true, failedChecks: [] });
    expect((await client.query("SHOW search_path")).rows[0].search_path).toBe("pg_catalog");
    expect((await client.query("SELECT current_user AS current, session_user AS session")).rows[0]).toEqual({ current: role, session: role });
  });
  it("accepts intended privileges inherited from a non-admin ordinary role", async () => {
    const { client, role } = await restricted(false), parent = await helper();
    await admin.query(foundationRuntimeGrants(parent)); await admin.query(`GRANT ${parent} TO ${role}`);
    expect((await auditFoundationRole(client)).ok).toBe(true);
  });
  it("reports missing intended privileges", async () => {
    const { client } = await restricted(false), report = await auditFoundationRole(client);
    expect(report.ok).toBe(false); expect(report.failedChecks).toContain("requiredPrivileges");
  });
  it.each(["SUPERUSER", "BYPASSRLS", "CREATEROLE", "CREATEDB", "REPLICATION"])("rejects direct privileged role attribute %s", async attribute => {
    const { client, role } = await restricted(); await admin.query(`ALTER ROLE ${role} ${attribute}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("restrictedRoles");
  });
  it.each([
    "UPDATE (generation_enabled) ON open_mint.budget_policies", "UPDATE ON open_mint.sessions", "UPDATE (expires_at) ON open_mint.sessions",
    "DELETE ON open_mint.assessments", "TRUNCATE ON open_mint.provider_receipts", "TRIGGER ON open_mint.assessments",
    "REFERENCES (namespace_id) ON open_mint.assessments", "INSERT (namespace_id) ON open_mint.budget_policies",
    "UPDATE (reason) ON open_mint.assessment_terminals",
  ])("rejects an extra direct foundation privilege: %s", async grant => {
    const { client, role } = await restricted(); await admin.query(`GRANT ${grant} TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("noExtraPrivileges");
  });
  it.each([true, false])("rejects inherited/preexisting extra policy privilege, role INHERIT=%s", async inherit => {
    const { client, role } = await restricted(), parent = await helper();
    await admin.query(`GRANT UPDATE (generation_enabled) ON open_mint.budget_policies TO ${parent}`);
    await admin.query(`ALTER ROLE ${role} ${inherit ? "INHERIT" : "NOINHERIT"}; GRANT ${parent} TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("noExtraPrivileges");
  });
  it("rejects dangerous predefined membership even when foundation table privileges would look normal", async () => {
    const { client, role } = await restricted(); await admin.query(`GRANT pg_read_all_data TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("restrictedRoles");
  });
  it("rejects elevated attributes reachable through an ordinary membership role", async () => {
    const { client, role } = await restricted(), parent = await helper();
    await admin.query(`ALTER ROLE ${parent} BYPASSRLS; GRANT ${parent} TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("restrictedRoles");
  });
  it("rejects extra foundation privileges inherited from PUBLIC", async () => {
    const { client } = await restricted();
    await admin.query("GRANT UPDATE (generation_enabled) ON open_mint.budget_policies TO PUBLIC");
    try { expect((await auditFoundationRole(client)).failedChecks).toContain("noExtraPrivileges"); }
    finally { await admin.query("REVOKE UPDATE (generation_enabled) ON open_mint.budget_policies FROM PUBLIC"); }
  });
  it("rejects grant options on an otherwise permitted update column", async () => {
    const { client, role } = await restricted();
    await admin.query(`GRANT UPDATE (generation) ON open_mint.sessions TO ${role} WITH GRANT OPTION`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("noGrantOptions");
  });
  it("rejects grant options and membership admin delegation", async () => {
    const { client, role } = await restricted(), parent = await helper();
    await admin.query(`GRANT SELECT ON open_mint.sessions TO ${role} WITH GRANT OPTION; GRANT ${parent} TO ${role} WITH ADMIN OPTION`);
    const report = await auditFoundationRole(client);
    expect(report.failedChecks).toContain("noGrantOptions"); expect(report.failedChecks).toContain("noRoleDelegation");
  });
  it("rejects schema/database CREATE and object ownership", async () => {
    const { client, role } = await restricted();
    await admin.query(`GRANT CREATE ON SCHEMA open_mint TO ${role}; GRANT CREATE ON DATABASE postgres TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("noCreation");
    await admin.query(`CREATE TABLE open_mint.audit_owned_${counter}(id integer); ALTER TABLE open_mint.audit_owned_${counter} OWNER TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("noOwnership");
  });
  it("rejects inherited owner membership", async () => {
    const { client, role } = await restricted(), parent = await helper();
    await admin.query(`CREATE TABLE open_mint.audit_owned_${counter}(id integer); ALTER TABLE open_mint.audit_owned_${counter} OWNER TO ${parent}; GRANT ${parent} TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("noOwnership");
  });
  it("rejects trigger-disabling parameter grants and ALTER SYSTEM", async () => {
    const { client, role } = await restricted();
    await admin.query(`GRANT SET ON PARAMETER session_replication_role TO ${role}; GRANT ALTER SYSTEM ON PARAMETER log_statement TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("noParameterEscalation");
  });
  it("rejects callable unreviewed SECURITY DEFINER functions without invoking them", async () => {
    const { client, role } = await restricted();
    const name = `audit_definer_${counter}`;
    await admin.query(`CREATE FUNCTION open_mint.${name}() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'; REVOKE ALL ON FUNCTION open_mint.${name}() FROM PUBLIC; GRANT EXECUTE ON FUNCTION open_mint.${name}() TO ${role}`);
    expect((await auditFoundationRole(client)).failedChecks).toContain("noSecurityDefiner");
  });
  it("rejects SET ROLE and SET SESSION AUTHORIZATION disguising an owner login", async () => {
    const { role } = await restricted();
    for (const setting of [`SET ROLE ${role}`, `SET SESSION AUTHORIZATION ${role}`]) {
      const client = new Client({ ...cluster.config, options: "-c search_path=pg_catalog" }); await client.connect(); clients.push(client);
      await client.query(setting);
      expect((await auditFoundationRole(client)).failedChecks).toContain("identity");
    }
  });
  it("rejects a changed foundation layout without writing the schema", async () => {
    const { client } = await restricted();
    await admin.query("ALTER TABLE open_mint.schema_version ADD COLUMN unreviewed text");
    try { expect((await auditFoundationRole(client)).failedChecks).toContain("foundationLayout"); }
    finally { await admin.query("ALTER TABLE open_mint.schema_version DROP COLUMN unreviewed"); }
  });
  it("refuses an unpinned search_path even for an otherwise restricted role", async () => {
    const { client } = await restricted(); await client.query("SET search_path = public, pg_catalog");
    await expect(auditFoundationRole(client)).rejects.toThrow("audit unavailable or rejected");
  });
});
