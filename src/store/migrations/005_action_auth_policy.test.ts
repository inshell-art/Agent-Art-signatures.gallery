import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./005_action_auth_policy.sql", import.meta.url), "utf8");
const original = readFileSync(new URL("./002_v2_minting.sql", import.meta.url));

describe("action-specific authentication schema migration", () => {
  it("only matches the two obsolete identity-age constraints by relation and exact definition", () => {
    expect(migration).toContain("conrelid = 'public.wallet_binding_challenges'::regclass");
    expect(migration).toContain("conrelid = 'public.wallet_bindings'::regclass");
    expect(migration).toContain("CHECK ((expires_at <= (x_authenticated_at + ''00:15:00''::interval)))");
    expect(migration).toContain("CHECK ((proved_at <= (x_authenticated_at + ''00:15:00''::interval)))");
    expect(migration.match(/pg_get_constraintdef\(oid\) =/g)).toHaveLength(2);
    expect(migration).toContain("WHERE contype = 'c'");
    expect(migration).toContain("ALTER TABLE %s DROP CONSTRAINT %I");
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+\w+\s+SET\b|DROP\s+(?:TABLE|TRIGGER|INDEX)/i);
  });

  it("is transactional and safe to reapply after the matching constraints are absent", () => {
    expect(migration.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(migration).toContain("FOR obsolete_constraint IN");
    expect(migration).not.toContain("ADD CONSTRAINT");
  });

  it("retains the existing SIWE, chronology and mint-authority requirements in the applied migration", () => {
    const sql = original.toString("utf8");
    expect(sql).toContain("CHECK (expires_at <= created_at + INTERVAL '10 minutes')");
    expect(sql).toContain("CHECK (created_at >= x_authenticated_at)");
    expect(sql).toContain("CHECK (proved_at >= x_authenticated_at)");
    expect(sql).toContain("CHECK (activated_at >= proved_at)");
    expect(sql).toContain("CHECK (deadline = valid_after + INTERVAL '15 minutes')");
    expect(migration).not.toContain("conrelid = 'public.mint_authorizations'");
    expect(createHash("sha256").update(original).digest("hex")).toBe("4ce1881b4e6e1e70c09760a2b9a4b8644dc62944f6601bdb91613cd8b7cc4d06");
  });

  it("applies after the existing migrations in both durable local launch paths", () => {
    for (const path of ["../../local/rehearsalCli.ts", "../../local/rehearsalServer.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source.indexOf("005_action_auth_policy.sql")).toBeGreaterThan(source.indexOf("004_formal_algorithm.sql"));
    }
  });
});
