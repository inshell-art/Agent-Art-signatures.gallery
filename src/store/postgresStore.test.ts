import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { deriveSignatureId } from "../v1/identity.js";
import type { ClaimRecordInput } from "../v1/store.js";
import { PostgresArtifactLedger, PostgresSignatureStore } from "./postgresStore.js";
import { GR0K_SCALE } from "../v1/input.js";
import { V2Error } from "../v2/errors.js";

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

type Scripted = { rowCount: number; rows: Record<string, unknown>[] };
type Script = (sql: string, values?: unknown[]) => Scripted | undefined;

/** Records every statement so the frozen SQL shape stays part of the contract. */
class FakePool {
  readonly queries: { sql: string; values?: unknown[] }[] = [];
  releases = 0;
  constructor(private readonly script: Script = () => undefined) {}
  async query(sql: string, values?: unknown[]): Promise<Scripted> {
    this.queries.push({ sql, values });
    return this.script(sql, values) ?? { rowCount: 0, rows: [] };
  }
  async connect() {
    return {
      query: (sql: string, values?: unknown[]) => this.query(sql, values),
      release: () => { this.releases += 1; },
    };
  }
  sql(fragment: string) {
    return this.queries.filter((entry) => entry.sql.includes(fragment));
  }
}

const asPool = (fake: FakePool) => fake as unknown as ConstructorParameters<typeof PostgresSignatureStore>[0];

const signatureRow = (overrides: Record<string, unknown> = {}) => ({
  signature_id: `sg1_${"a".repeat(52)}`,
  claim_instance_id: "7d3b20c8-e68b-4a62-856c-ab90fb94cb81",
  x_user_id: "1234567890123456789",
  handle_at_claim: "Alice",
  handle_normalized: "alice",
  gr0k_raw: 22,
  gr0k_scale: GR0K_SCALE,
  renderer_version: "sg-renderer-1.0.0",
  svg_sha256: "a".repeat(64),
  svg_storage_key: `sha256/${"a".repeat(64)}.svg`,
  card_renderer_version: "sg-card-1.0.0",
  png_sha256: "b".repeat(64),
  card_storage_key: `sha256/${"b".repeat(64)}.png`,
  claim_method: "x_oauth_v1",
  x_authenticated_at: new Date("2026-09-10T00:00:00.000Z"),
  claimed_at: new Date("2026-09-10T00:01:00.000Z"),
  ...overrides,
});

const accountRow = (overrides: Record<string, unknown> = {}) => ({
  x_user_id: "1234567890123456789",
  public_account_id: "xa1_account",
  current_handle: "ALIce",
  handle_normalized: "alice",
  created_at: new Date("2026-09-01T00:00:00.000Z"),
  last_authenticated_at: new Date("2026-09-10T00:00:00.000Z"),
  ...overrides,
});

describe("PostgreSQL row mapping", () => {
  it("maps a stored row onto the frozen V1 signature shape", async () => {
    const pool = new FakePool(() => ({ rowCount: 1, rows: [signatureRow()] }));
    const signature = await new PostgresSignatureStore(asPool(pool)).getSignature(`sg1_${"a".repeat(52)}`);
    expect(signature).toMatchObject({
      signatureId: `sg1_${"a".repeat(52)}`, xUserId: "1234567890123456789",
      handleAtClaim: "Alice", handleNormalized: "alice", gr0kRaw: 22, gr0kScale: GR0K_SCALE,
      claimMethod: "x_oauth_v1", rendererVersion: "sg-renderer-1.0.0",
    });
    expect(pool.queries[0]!.values).toEqual([`sg1_${"a".repeat(52)}`]);
  });

  it("refuses a row whose scale or claim method is outside the frozen schema", async () => {
    for (const bad of [{ gr0k_scale: GR0K_SCALE + 1 }, { claim_method: "x_oauth_v2" }]) {
      const pool = new FakePool(() => ({ rowCount: 1, rows: [signatureRow(bad)] }));
      await expect(new PostgresSignatureStore(asPool(pool)).getSignature("sg1_x"))
        .rejects.toThrow(/outside the frozen V1 schema/);
    }
  });

  it("treats a missing or ambiguous lookup as absent rather than picking a row", async () => {
    for (const rowCount of [0, 2]) {
      const pool = new FakePool(() => ({ rowCount, rows: [signatureRow(), signatureRow()] }));
      const store = new PostgresSignatureStore(asPool(pool));
      expect(await store.getSignature("sg1_x")).toBeNull();
      expect(await store.getAccount("1234567890123456789")).toBeNull();
    }
  });

  it("maps an account row and keeps the current spelling separate from the normalized handle", async () => {
    const pool = new FakePool(() => ({ rowCount: 1, rows: [accountRow()] }));
    expect(await new PostgresSignatureStore(asPool(pool)).getAccount("1234567890123456789")).toEqual({
      xUserId: "1234567890123456789", publicAccountId: "xa1_account",
      currentHandle: "ALIce", handleNormalized: "alice",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      lastAuthenticatedAt: new Date("2026-09-10T00:00:00.000Z"),
    });
  });

  it("returns an account's signatures newest first with a stable identifier tiebreak", async () => {
    const pool = new FakePool(() => ({ rowCount: 2, rows: [signatureRow(), signatureRow({ signature_id: `sg1_${"b".repeat(52)}` })] }));
    const list = await new PostgresSignatureStore(asPool(pool)).listSignaturesForAccount("1234567890123456789");
    expect(list.map((entry) => entry.signatureId)).toEqual([`sg1_${"a".repeat(52)}`, `sg1_${"b".repeat(52)}`]);
    expect(pool.queries[0]!.sql).toContain("ORDER BY claimed_at DESC, signature_id");
  });

  it("updates only the mutable login columns for an existing account", async () => {
    const pool = new FakePool();
    const at = new Date("2026-09-11T00:00:00.000Z");
    await new PostgresSignatureStore(asPool(pool)).updateExistingAccountLogin("1234567890123456789", "Alice_Studio", "alice_studio", at);
    expect(pool.queries[0]!.sql).toContain("UPDATE x_accounts");
    expect(pool.queries[0]!.sql).not.toContain("public_account_id");
    expect(pool.queries[0]!.values).toEqual(["1234567890123456789", "Alice_Studio", "alice_studio", at]);
  });
});

describe("PostgreSQL claim keyset pagination", () => {
  const store = (pool: FakePool) => new PostgresSignatureStore(asPool(pool));

  it("refuses a page size outside 1..100 before reaching the database", async () => {
    const pool = new FakePool();
    for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(store(pool).listClaimedSignatures(limit)).rejects.toThrow(RangeError);
    }
    expect(pool.queries).toHaveLength(0);
  });

  it("passes a null cursor for the first page and the exact cursor afterwards", async () => {
    const pool = new FakePool(() => ({ rowCount: 1, rows: [signatureRow()] }));
    await store(pool).listClaimedSignatures(100);
    expect(pool.queries[0]!.values).toEqual([100, null, null]);

    const claimedAt = new Date("2026-09-10T00:01:00.000Z");
    await store(pool).listClaimedSignatures(25, { claimedAt, signatureId: `sg1_${"a".repeat(52)}` });
    expect(pool.queries[1]!.values).toEqual([25, claimedAt, `sg1_${"a".repeat(52)}`]);
    // A byte-ordered tiebreak keeps the page boundary stable under any DB collation.
    expect(pool.queries[1]!.sql).toContain('signature_id COLLATE "C"');
  });
});

describe("PostgreSQL claim withdrawal", () => {
  const ids = [`sg1_${"a".repeat(52)}`, "1234567890123456789", "7d3b20c8-e68b-4a62-856c-ab90fb94cb81"] as const;

  it("rolls back and reports no change when the exact claim instance is absent", async () => {
    const pool = new FakePool((sql) => sql.includes("SELECT 1 FROM signatures") ? { rowCount: 0, rows: [] } : undefined);
    expect(await new PostgresSignatureStore(asPool(pool)).withdraw(...ids)).toBe(false);
    expect(pool.sql("ROLLBACK")).toHaveLength(1);
    expect(pool.sql("DELETE FROM signatures")).toHaveLength(0);
    expect(pool.releases).toBe(1);
  });

  it("deletes this claim's references and row in one committed transaction", async () => {
    const pool = new FakePool((sql) => sql.includes("SELECT 1 FROM signatures") ? { rowCount: 1, rows: [{}] } : undefined);
    expect(await new PostgresSignatureStore(asPool(pool)).withdraw(...ids)).toBe(true);
    expect(pool.sql("FOR UPDATE").length).toBeGreaterThan(0);
    expect(pool.sql("DELETE FROM local_rehearsal.artifact_references")).toHaveLength(1);
    expect(pool.sql("DELETE FROM content_object_references")).toHaveLength(1);
    expect(pool.sql("DELETE FROM signatures")[0]!.values).toEqual([ids[0], ids[2]]);
    expect(pool.sql("COMMIT")).toHaveLength(1);
    expect(pool.sql("ROLLBACK")).toHaveLength(0);
    expect(pool.releases).toBe(1);
  });

  it("translates a database withdrawal guard into a blocked-claim conflict", async () => {
    const pool = new FakePool((sql) => {
      if (sql.includes("SELECT 1 FROM signatures")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("DELETE FROM signatures")) throw Object.assign(new Error("guard"), { code: "P0001" });
      return undefined;
    });
    const rejection = new PostgresSignatureStore(asPool(pool)).withdraw(...ids);
    await expect(rejection).rejects.toBeInstanceOf(V2Error);
    await expect(rejection).rejects.toMatchObject({ status: 409, code: "CLAIM_WITHDRAWAL_BLOCKED" });
    expect(pool.sql("ROLLBACK")).toHaveLength(1);
    expect(pool.releases).toBe(1);
  });

  it("rolls back, releases the client, and preserves an unexpected database failure", async () => {
    const pool = new FakePool((sql) => {
      if (sql.includes("SELECT 1 FROM signatures")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("DELETE FROM signatures")) throw Object.assign(new Error("connection reset"), { code: "57P01" });
      return undefined;
    });
    await expect(new PostgresSignatureStore(asPool(pool)).withdraw(...ids)).rejects.toThrow("connection reset");
    expect(pool.sql("COMMIT")).toHaveLength(0);
    expect(pool.releases).toBe(1);
  });
});

describe("PostgreSQL artifact reference ledger", () => {
  const input = { storageKey: `sha256/${"a".repeat(64)}.svg`, signatureId: `sg1_${"a".repeat(52)}`, kind: "svg" as const, sha256: "a".repeat(64), byteLength: 1234 };

  it("reports a newly inserted reference", async () => {
    const pool = new FakePool((sql) => sql.includes("INSERT INTO") ? { rowCount: 1, rows: [] } : undefined);
    expect(await new PostgresArtifactLedger(asPool(pool)).add(input)).toBe(true);
    expect(pool.sql("SELECT sha256")).toHaveLength(0);
  });

  it("accepts an identical existing reference without counting it twice", async () => {
    const pool = new FakePool((sql) => sql.includes("INSERT INTO")
      ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [{ sha256: input.sha256, byte_length: "1234" }] });
    expect(await new PostgresArtifactLedger(asPool(pool)).add(input)).toBe(false);
  });

  it("refuses an existing reference whose content address or length disagrees", async () => {
    for (const row of [{ sha256: "c".repeat(64), byte_length: "1234" }, { sha256: input.sha256, byte_length: "1235" }]) {
      const pool = new FakePool((sql) => sql.includes("INSERT INTO") ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [row] });
      await expect(new PostgresArtifactLedger(asPool(pool)).add(input)).rejects.toThrow(/integrity check/);
    }
  });

  it("refuses a conflicting insert whose row cannot then be read back", async () => {
    const pool = new FakePool(() => ({ rowCount: 0, rows: [] }));
    await expect(new PostgresArtifactLedger(asPool(pool)).add(input)).rejects.toThrow(/integrity check/);
  });

  it("compares byte length numerically so a bigint column never fails a correct row", async () => {
    const pool = new FakePool((sql) => sql.includes("INSERT INTO")
      ? { rowCount: 0, rows: [] }
      : { rowCount: 1, rows: [{ sha256: input.sha256, byte_length: "00001234" }] });
    expect(await new PostgresArtifactLedger(asPool(pool)).add(input)).toBe(false);
  });

  it("reports whether a removal matched exactly one reference", async () => {
    const removed = new FakePool(() => ({ rowCount: 1, rows: [] }));
    expect(await new PostgresArtifactLedger(asPool(removed)).remove(input.storageKey, input.signatureId, "svg")).toBe(true);
    const absent = new FakePool(() => ({ rowCount: 0, rows: [] }));
    expect(await new PostgresArtifactLedger(asPool(absent)).remove(input.storageKey, input.signatureId, "svg")).toBe(false);
  });

  it("counts references as a number and treats an empty result as zero", async () => {
    const counted = new FakePool(() => ({ rowCount: 1, rows: [{ count: "3" }] }));
    expect(await new PostgresArtifactLedger(asPool(counted)).count(input.storageKey)).toBe(3);
    const empty = new FakePool(() => ({ rowCount: 0, rows: [] }));
    expect(await new PostgresArtifactLedger(asPool(empty)).count(input.storageKey)).toBe(0);
  });
});
