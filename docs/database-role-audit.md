# Read-only PostgreSQL foundation-role audit

`src/openMint/persistence/roleAudit.ts` inspects an already connected PostgreSQL role. It does not create accounts, connect to a database, apply migrations, alter settings, issue grants/revokes, or enable public startup. `auditFoundationRole` returns a finite frozen capability report; `requireFoundationRole` throws if any check fails. Connection/catalog failures throw a generic `DatabaseRoleAuditError` without retaining raw errors, role names, database names, credentials, URLs or SQL responses.

## Explicit connection prerequisites

The caller must supply its own authenticated, dedicated connection and bounded query implementation. PostgreSQL **16** is the currently reviewed version. Configure `search_path=pg_catalog` and a positive `statement_timeout` of at most five seconds during connection setup; configure a bounded driver query/network timeout too. The audit only reads these settings and never changes them. Unsupported versions, an unpinned search path, missing timeouts or unavailable catalog data fail closed.

Do not share this connection with concurrent operations that can change session authorization or settings during the audit. A small built-in-only prerequisite query runs before a single catalog snapshot statement. PostgreSQL 17+ privilege classes require a separately reviewed update rather than silently passing a PostgreSQL 16 allowlist.

## Checked boundaries

- `current_user`, `session_user` and the backend's originally logged-in role must agree. Tests reject both `SET ROLE` and `SET SESSION AUTHORIZATION` disguising an owner login.
- The role and every reachable membership role must lack superuser, bypass-RLS, create-role, create-database and replication attributes. Predefined `pg_*` memberships and membership admin options are rejected. Membership is checked conservatively even with `NOINHERIT`; possible `SET ROLE` access cannot hide excess privileges.
- Database/schema creation, ownership of persistent schemas, relations, functions, types, extensions or the current database, and callable non-system `SECURITY DEFINER` functions are rejected. Temporary schema/object ownership is excluded; this is not a prohibition on PostgreSQL's ordinary temporary-object capability.
- Trigger-disabling `SET session_replication_role`, privileged parameter settings, parameter grant options and `ALTER SYSTEM` grants are rejected.
- Every foundation relation must be a permanent ordinary table with the exact reviewed column layout. Its required effective SELECT/INSERT/column-UPDATE capabilities must exist. Extra table or column UPDATE/INSERT/REFERENCES/TRIGGER/DELETE/TRUNCATE privileges and grant options are rejected, whether direct, inherited or supplied through PUBLIC.
- The immutable-key UPDATE grants on `budget_policies.namespace_id` and `handle_guards.handle` remain permitted because PostgreSQL requires an update privilege for `SELECT FOR UPDATE`; their mutation triggers still enforce immutability.

`FOUNDATION_RUNTIME_PRIVILEGES` in `runtimeRole.ts` is the one deeply frozen allowlist used by both grant generation and auditing. It includes `assessment_terminals` SELECT/INSERT, with no terminal-update privilege. Changing the foundation schema or intended privilege surface requires updating and reviewing that shared definition and its tests.

## Limits

This is a **point-in-time capability audit**. A later grant, role-membership/attribute change, ownership change, function addition, schema migration or connection replacement can invalidate the result immediately. Re-audit after such changes and at a future reviewed startup boundary; the returned report is diagnostic evidence, not a durable permission token.

The exact table/column allowlist covers the foundation only. Request, publication, issuance and projection extensions need separate reviewed capability profiles; this audit neither approves nor completely audits their grants. Global escalation checks are intentionally conservative, but the module is not an exhaustive sandbox for every PostgreSQL extension or external service privilege. It does not verify stored assessments, trigger/function body integrity, migration checksums, server binary trust, backup freshness or replica failover safety.

The runtime legitimately inserts evidence and updates operational state. These privileges do not prevent a compromised SQL client from fabricating application data. Namespace-qualified queries are not row-level security. The audit is no substitute for distinct migration/operator/runtime credentials, separate staging/production databases, restricted network access, credential custody and the exclusive-writer/application validation boundaries. No role or hosting choice is approved by a passing test.

## Offline evidence

Run `npx vitest run src/openMint/persistence/roleAudit.test.ts src/openMint/persistence/runtimeRole.test.ts` for the default tests. Set `OPEN_MINT_TEST_POSTGRES=1` for the isolated integration matrix. The fixture creates disposable roles inside a temporary private Unix-socket PostgreSQL cluster; it cannot accept a live database URL and has no TCP listener.

The integration matrix authenticates directly as the tested role and covers intended direct/inherited grants, missing grants, all elevated role attributes, extra table/column grants, NOINHERIT membership, grant/admin options, ownership, schema/database CREATE, parameter escalation, callable security-definer functions, disguised owner sessions and changed foundation layout. No live role, account, database or public service is provisioned or changed.
