import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { deriveSignatureId } from "../v1/identity.js";
import type { ClaimRecordInput } from "../v1/store.js";
import { PostgresSignatureStore } from "./postgresStore.js";

const input: ClaimRecordInput = {
  xUserId: "1234567890123456789", handleAtClaim: "Alice", currentHandle: "ALIce", handleNormalized: "alice",
  gr0kRaw: 22, rendererVersion: "sg-renderer-1.0.0", cardRendererVersion: "sg-card-1.0.0",
  svgSha256: "a".repeat(64), svgStorageKey: "fixture.svg", pngSha256: "b".repeat(64), cardStorageKey: "fixture.png",
  xAuthenticatedAt: new Date("2026-09-10T00:00:00.000Z"), claimedAt: new Date("2026-09-10T00:00:00.000Z"),
};

describe("PostgreSQL formal claim identity", () => {
  it("locks and looks up exact-case input while keeping current OAuth spelling separate", async () => {
    const statements: { sql: string; values?: unknown[] }[] = [];
    let released = false;
    const client = {
      async query(sql: string, values?: unknown[]) {
        statements.push({ sql, values });
        if (/SELECT[\s\S]*FROM signatures\s+WHERE x_user_id/.test(sql)) return { rowCount: 0, rows: [] };
        if (sql.includes("FROM x_accounts WHERE")) return { rowCount: 0, rows: [] };
        if (sql.includes("INSERT INTO x_accounts")) {
          return { rowCount: 1, rows: [{ x_user_id: values![0], public_account_id: values![1], current_handle: values![2], handle_normalized: values![3], created_at: values![4], last_authenticated_at: values![5] }] };
        }
        if (sql.includes("SELECT 1 FROM signatures")) return { rowCount: 0, rows: [] };
        if (sql.includes("INSERT INTO signatures")) {
          const v = values!;
          return { rowCount: 1, rows: [{ signature_id: v[0], claim_instance_id: "7d3b20c8-e68b-4a62-856c-ab90fb94cb81", x_user_id: v[1], handle_at_claim: v[2], handle_normalized: v[3], gr0k_raw: v[4], gr0k_scale: v[5], renderer_version: v[6], svg_sha256: v[7], svg_storage_key: v[8], card_renderer_version: v[9], png_sha256: v[10], card_storage_key: v[11], claim_method: "x_oauth_v1", x_authenticated_at: v[12], claimed_at: v[13] }] };
        }
        return { rowCount: 0, rows: [] };
      },
      release() { released = true; },
    };
    const store = new PostgresSignatureStore({ async connect() { return client; } } as unknown as Pool);
    const claimed = await store.claim(input);
    expect(claimed.signature.signatureId).toBe(deriveSignatureId(input));
    expect(claimed.signature.handleAtClaim).toBe("Alice");
    expect(claimed.signature.gr0kRaw).toBe(22);
    expect(claimed.signature.gr0kScale).toBe(1);
    expect(claimed.account.currentHandle).toBe("ALIce");
    const lookup = statements.find(({ sql }) => /SELECT[\s\S]*FROM signatures\s+WHERE x_user_id/.test(sql))!;
    expect(lookup.sql).toContain("handle_at_claim = $2");
    expect(lookup.values).toEqual([input.xUserId, "Alice", 22, 1, input.rendererVersion]);
    const tupleLock = statements.find(({ values }) => String(values?.[0]).startsWith("signature:"))!;
    expect(tupleLock.values?.[0]).toBe(`signature:${JSON.stringify([input.xUserId, "Alice", 22, 1, input.rendererVersion])}`);
    expect(statements.at(-1)?.sql).toBe("COMMIT");
    expect(released).toBe(true);
  });

  it("rejects obsolete seeds and account mismatches before opening a transaction", async () => {
    const store = new PostgresSignatureStore({ async connect() { throw new Error("must not connect"); } } as unknown as Pool);
    await expect(store.claim({ ...input, gr0kRaw: 371924 })).rejects.toThrow(/integer/);
    await expect(store.claim({ ...input, currentHandle: "Bob" })).rejects.toThrow(/Current OAuth handle/);
  });
});
