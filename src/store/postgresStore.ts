import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";

import { createPublicAccountId, deriveSignatureId } from "../v1/identity.js";
import { GR0K_SCALE } from "../v1/input.js";
import {
  RendererIntegrityError,
  validateClaimRecordInput,
  type ClaimRecordInput,
  type Signature,
  type SignatureStore,
  type XAccount,
} from "../v1/store.js";
import type { ArtifactKind, ArtifactReferenceLedger } from "../v1/fileArtifactStore.js";
import { decode, encode } from "../local/postgresState.js";
import { MemoryMintStore, type MemoryMintStoreSnapshot } from "../v2/memoryStore.js";
import { V2Error } from "../v2/errors.js";

interface AccountRow extends QueryResultRow {
  x_user_id: string;
  public_account_id: string;
  current_handle: string;
  handle_normalized: string;
  created_at: Date;
  last_authenticated_at: Date;
}

interface SignatureRow extends QueryResultRow {
  signature_id: string;
  claim_instance_id: string;
  x_user_id: string;
  handle_at_claim: string;
  handle_normalized: string;
  gr0k_raw: number;
  gr0k_scale: number;
  renderer_version: string;
  svg_sha256: string;
  svg_storage_key: string;
  card_renderer_version: string;
  png_sha256: string;
  card_storage_key: string;
  claim_method: "x_oauth_v1";
  x_authenticated_at: Date;
  claimed_at: Date;
}

function accountFromRow(row: AccountRow): XAccount {
  return {
    xUserId: row.x_user_id,
    publicAccountId: row.public_account_id,
    currentHandle: row.current_handle,
    handleNormalized: row.handle_normalized,
    createdAt: row.created_at,
    lastAuthenticatedAt: row.last_authenticated_at,
  };
}

function signatureFromRow(row: SignatureRow): Signature {
  if (row.gr0k_scale !== GR0K_SCALE || row.claim_method !== "x_oauth_v1") {
    throw new Error("PostgreSQL returned a signature outside the frozen V1 schema.");
  }
  return {
    signatureId: row.signature_id,
    claimInstanceId: row.claim_instance_id,
    xUserId: row.x_user_id,
    handleAtClaim: row.handle_at_claim,
    handleNormalized: row.handle_normalized,
    gr0kRaw: row.gr0k_raw,
    gr0kScale: GR0K_SCALE,
    rendererVersion: row.renderer_version,
    svgSha256: row.svg_sha256,
    svgStorageKey: row.svg_storage_key,
    cardRendererVersion: row.card_renderer_version,
    pngSha256: row.png_sha256,
    cardStorageKey: row.card_storage_key,
    claimMethod: "x_oauth_v1",
    xAuthenticatedAt: row.x_authenticated_at,
    claimedAt: row.claimed_at,
  };
}

const SIGNATURE_COLUMNS = `
  signature_id, claim_instance_id, x_user_id, handle_at_claim, handle_normalized,
  gr0k_raw, gr0k_scale, renderer_version, svg_sha256, svg_storage_key,
  card_renderer_version, png_sha256, card_storage_key, claim_method,
  x_authenticated_at, claimed_at`;

const ACCOUNT_COLUMNS = `
  x_user_id, public_account_id, current_handle, handle_normalized,
  created_at, last_authenticated_at`;

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

/** Durable V1 repository used only by the local PostgreSQL rehearsal today. */
export class PostgresSignatureStore implements SignatureStore {
  constructor(readonly pool: Pool) {}

  async withClaimLock<T>(signatureId: string, work: () => Promise<T>): Promise<T> {
    // This lock must span file and ledger writes plus claim(), all of which use
    // the main pool. A dedicated session prevents N concurrent claims from
    // occupying every pooled connection and deadlocking their own work.
    const client = new Client(this.pool.options);
    await client.connect();
    const key = `claim-artifacts:${signatureId}`;
    try {
      // A session lock deliberately spans file/ledger writes and the separate
      // claim transaction, closing the same-signature reference race.
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
      return await work();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } finally {
        await client.end();
      }
    }
  }

  async claim(input: ClaimRecordInput): Promise<{ signature: Signature; account: XAccount; existing: boolean }> {
    validateClaimRecordInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // PostgreSQL text values reject NUL bytes, so use a canonical JSON tuple
      // rather than the in-memory store's private NUL-delimited map key.
      const lockKey = JSON.stringify([input.xUserId, input.handleAtClaim, input.gr0kRaw, GR0K_SCALE, input.rendererVersion]);
      // Serialize both account creation/update and exact-tuple idempotency.
      // Locking only the tuple leaves two first claims for the same X user able
      // to race on x_accounts' primary key.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`account:${input.xUserId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`signature:${lockKey}`]);

      const existing = await client.query<SignatureRow>(
        `SELECT ${SIGNATURE_COLUMNS} FROM signatures
         WHERE x_user_id = $1 AND handle_at_claim = $2 AND gr0k_raw = $3
           AND gr0k_scale = $4 AND renderer_version = $5`,
        [input.xUserId, input.handleAtClaim, input.gr0kRaw, GR0K_SCALE, input.rendererVersion],
      );
      if (existing.rowCount === 1) {
        const signature = signatureFromRow(existing.rows[0]!);
        if (
          signature.svgSha256 !== input.svgSha256
          || signature.svgStorageKey !== input.svgStorageKey
          || signature.cardRendererVersion !== input.cardRendererVersion
          || signature.pngSha256 !== input.pngSha256
          || signature.cardStorageKey !== input.cardStorageKey
        ) {
          throw new RendererIntegrityError();
        }
        const updated = await client.query<AccountRow>(
          `UPDATE x_accounts
             SET current_handle = $2, handle_normalized = $3, last_authenticated_at = $4
           WHERE x_user_id = $1
           RETURNING ${ACCOUNT_COLUMNS}`,
          [input.xUserId, input.currentHandle ?? input.handleAtClaim, input.handleNormalized, input.xAuthenticatedAt],
        );
        if (updated.rowCount !== 1) throw new Error("Signature account index is corrupt.");
        await client.query("COMMIT");
        return { signature, account: accountFromRow(updated.rows[0]!), existing: true };
      }

      let accountResult = await client.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM x_accounts WHERE x_user_id = $1 FOR UPDATE`,
        [input.xUserId],
      );
      if (accountResult.rowCount === 0) {
        for (;;) {
          const publicAccountId = createPublicAccountId();
          const inserted = await client.query<AccountRow>(
            `INSERT INTO x_accounts (
               x_user_id, public_account_id, current_handle, handle_normalized,
               created_at, last_authenticated_at
             ) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (public_account_id) DO NOTHING
             RETURNING ${ACCOUNT_COLUMNS}`,
            [
              input.xUserId,
              publicAccountId,
              input.currentHandle ?? input.handleAtClaim,
              input.handleNormalized,
              input.claimedAt ?? new Date(),
              input.xAuthenticatedAt,
            ],
          );
          if (inserted.rowCount === 1) {
            accountResult = inserted;
            break;
          }
        }
      } else {
        accountResult = await client.query<AccountRow>(
          `UPDATE x_accounts
             SET current_handle = $2, handle_normalized = $3, last_authenticated_at = $4
           WHERE x_user_id = $1
           RETURNING ${ACCOUNT_COLUMNS}`,
          [input.xUserId, input.currentHandle ?? input.handleAtClaim, input.handleNormalized, input.xAuthenticatedAt],
        );
      }

      const signatureId = deriveSignatureId({
        xUserId: input.xUserId,
        handleAtClaim: input.handleAtClaim,
        gr0kRaw: input.gr0kRaw,
        rendererVersion: input.rendererVersion,
      });
      const collision = await client.query("SELECT 1 FROM signatures WHERE signature_id = $1", [signatureId]);
      if (collision.rowCount !== 0) throw new RendererIntegrityError();
      const insertedSignature = await client.query<SignatureRow>(
        `INSERT INTO signatures (
           signature_id, x_user_id, handle_at_claim, handle_normalized,
           gr0k_raw, gr0k_scale, renderer_version, svg_sha256, svg_storage_key,
           card_renderer_version, png_sha256, card_storage_key, claim_method,
           x_authenticated_at, claimed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, 'x_oauth_v1', $13, $14
         ) RETURNING ${SIGNATURE_COLUMNS}`,
        [
          signatureId,
          input.xUserId,
          input.handleAtClaim,
          input.handleNormalized,
          input.gr0kRaw,
          GR0K_SCALE,
          input.rendererVersion,
          input.svgSha256,
          input.svgStorageKey,
          input.cardRendererVersion,
          input.pngSha256,
          input.cardStorageKey,
          input.xAuthenticatedAt,
          input.claimedAt ?? new Date(),
        ],
      );
      await client.query("COMMIT");
      return {
        signature: signatureFromRow(insertedSignature.rows[0]!),
        account: accountFromRow(accountResult.rows[0]!),
        existing: false,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getSignature(signatureId: string): Promise<Signature | null> {
    const result = await this.pool.query<SignatureRow>(
      `SELECT ${SIGNATURE_COLUMNS} FROM signatures WHERE signature_id = $1`,
      [signatureId],
    );
    return result.rowCount === 1 ? signatureFromRow(result.rows[0]!) : null;
  }

  async withdraw(signatureId: string, xUserId: string, claimInstanceId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT 1 FROM signatures WHERE signature_id = $1 AND x_user_id = $2 AND claim_instance_id = $3::uuid FOR UPDATE", [signatureId, xUserId, claimInstanceId]);
      if (!found.rowCount) { await client.query("ROLLBACK"); return false; }
      // The local snapshot and claim deletion commit atomically: restarting
      // after deletion must not resurrect frozen metadata for a later claim.
      const persisted = await client.query("SELECT payload FROM local_rehearsal.state_snapshots WHERE snapshot_name = 'mint-store' FOR UPDATE");
      if (persisted.rowCount) {
        const state = MemoryMintStore.fromSnapshot(decode(persisted.rows[0].payload) as MemoryMintStoreSnapshot);
        if (!state.canWithdrawClaim(signatureId)) throw new V2Error(409, "CLAIM_WITHDRAWAL_BLOCKED", "The mint is still active or unresolved. Wait for it to resolve.");
        state.forgetWithdrawnClaim(signatureId);
        await client.query("UPDATE local_rehearsal.state_snapshots SET payload = $1::jsonb, updated_at = now() WHERE snapshot_name = 'mint-store'", [JSON.stringify(encode(state.exportSnapshot()))]);
      }
      await client.query("SELECT set_config('signatures.claim_withdrawal', $1, true)", [signatureId]);
      // Only this claim's references, never the shared artifact objects.
      await client.query("DELETE FROM local_rehearsal.artifact_references WHERE signature_id = $1", [signatureId]);
      await client.query("DELETE FROM content_object_references WHERE reference_id = $1 AND reference_kind IN ('v1_svg', 'v1_png')", [signatureId]);
      await client.query("DELETE FROM signatures WHERE signature_id = $1 AND claim_instance_id = $2::uuid", [signatureId, claimInstanceId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await rollback(client);
      if ((error as { code?: string }).code === "P0001") throw new V2Error(409, "CLAIM_WITHDRAWAL_BLOCKED", "This signature has mint or publication work that must be resolved before withdrawal.");
      throw error;
    } finally { client.release(); }
  }

  async listSignaturesForAccount(xUserId: string): Promise<Signature[]> {
    const result = await this.pool.query<SignatureRow>(
      `SELECT ${SIGNATURE_COLUMNS} FROM signatures
       WHERE x_user_id = $1 ORDER BY claimed_at DESC, signature_id`,
      [xUserId],
    );
    return result.rows.map(signatureFromRow);
  }

  async getAccount(xUserId: string): Promise<XAccount | null> {
    const result = await this.pool.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM x_accounts WHERE x_user_id = $1`,
      [xUserId],
    );
    return result.rowCount === 1 ? accountFromRow(result.rows[0]!) : null;
  }

  async listClaimedSignatures(limit: number, after?: Pick<Signature, "claimedAt" | "signatureId">): Promise<Signature[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Claim page limit must be between 1 and 100.");
    const result = await this.pool.query<SignatureRow>(
      `SELECT ${SIGNATURE_COLUMNS} FROM signatures
       WHERE ($2::timestamptz IS NULL OR claimed_at < $2 OR
         (claimed_at = $2 AND signature_id COLLATE "C" > $3))
       ORDER BY claimed_at DESC, signature_id COLLATE "C" ASC LIMIT $1`,
      [limit, after?.claimedAt ?? null, after?.signatureId ?? null],
    );
    return result.rows.map(signatureFromRow);
  }

  async updateExistingAccountLogin(
    xUserId: string,
    currentHandle: string,
    handleNormalized: string,
    authenticatedAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE x_accounts
         SET current_handle = $2, handle_normalized = $3, last_authenticated_at = $4
       WHERE x_user_id = $1`,
      [xUserId, currentHandle, handleNormalized, authenticatedAt],
    );
  }
}

export class PostgresArtifactLedger implements ArtifactReferenceLedger {
  constructor(private readonly pool: Pool) {}

  async add(input: {
    storageKey: string;
    signatureId: string;
    kind: ArtifactKind;
    sha256: string;
    byteLength: number;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO local_rehearsal.artifact_references
         (storage_key, signature_id, artifact_kind, sha256, byte_length)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [input.storageKey, input.signatureId, input.kind, input.sha256, input.byteLength],
    );
    if (result.rowCount === 1) return true;
    const existing = await this.pool.query<{ sha256: string; byte_length: string }>(
      `SELECT sha256, byte_length::text AS byte_length
         FROM local_rehearsal.artifact_references
        WHERE storage_key = $1 AND signature_id = $2 AND artifact_kind = $3`,
      [input.storageKey, input.signatureId, input.kind],
    );
    const row = existing.rows[0];
    if (!row || row.sha256 !== input.sha256 || BigInt(row.byte_length) !== BigInt(input.byteLength)) {
      throw new Error("Existing local artifact reference failed its integrity check.");
    }
    return false;
  }

  async remove(storageKey: string, signatureId: string, kind: ArtifactKind): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM local_rehearsal.artifact_references
       WHERE storage_key = $1 AND signature_id = $2 AND artifact_kind = $3`,
      [storageKey, signatureId, kind],
    );
    return result.rowCount === 1;
  }

  async count(storageKey: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM local_rehearsal.artifact_references WHERE storage_key = $1",
      [storageKey],
    );
    return Number(result.rows[0]?.count ?? "0");
  }
}

export function createPostgresPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 8, idleTimeoutMillis: 10_000 });
}
