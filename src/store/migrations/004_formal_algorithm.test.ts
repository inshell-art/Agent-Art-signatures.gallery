import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("./004_formal_algorithm.sql", import.meta.url), "utf8");
const freshSchema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

describe("formal algorithm schema boundary", () => {
  it("refuses obsolete claims before changing their interpretation", () => {
    const refusal = migration.indexOf("RAISE EXCEPTION 'Obsolete signature claims");
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(migration.indexOf("ALTER TABLE signatures"));
    expect(migration).toContain("gr0k_scale <> 1 OR gr0k_raw NOT BETWEEN 1 AND 100");
    expect(migration).toContain("renderer_version <> 'sg-renderer-1.0.0'");
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+signatures\b/i);
  });

  it("uses the same integer and exact-case uniqueness contract for new and upgraded databases", () => {
    for (const sql of [freshSchema, migration]) {
      expect(sql).toContain("CHECK (gr0k_raw BETWEEN 1 AND 100)");
      expect(sql).toContain("CHECK (gr0k_scale = 1)");
      expect(sql).toContain("UNIQUE (x_user_id, handle_at_claim, gr0k_raw, gr0k_scale, renderer_version)");
      expect(sql).toContain('CHECK (lower(handle_at_claim COLLATE "C") = handle_normalized)');
    }
    expect(migration).toContain('ALTER COLUMN handle_at_claim TYPE TEXT COLLATE "C"');
    expect(freshSchema).toMatch(/handle_at_claim\s+TEXT COLLATE "C"/);
  });

  it("is transactional and replaces only the obsolete normalized-handle tuple index", () => {
    expect(migration.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(migration).toContain("pg_get_constraintdef(oid) = 'UNIQUE (x_user_id, handle_normalized, gr0k_raw, gr0k_scale, renderer_version)'");
    expect(migration).toContain("conname = 'signatures_formal_artwork_unique'");
  });
});
