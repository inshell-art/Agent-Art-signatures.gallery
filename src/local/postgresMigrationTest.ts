import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FileArtifactStore } from "../v1/fileArtifactStore.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { createPostgresPool, PostgresArtifactLedger, PostgresSignatureStore } from "../store/postgresStore.js";
import { LocalPostgresState } from "./postgresState.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const postgresBin = process.env.LOCAL_POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
// PostgreSQL's Unix-domain socket path has a small platform limit. A short,
// unique OS-temp path keeps this disposable test isolated and portable.
const testRoot = mkdtempSync(resolve(tmpdir(), "sg-pg-"));
const data = resolve(testRoot, "data");
const socket = resolve(testRoot, "socket");
const log = resolve(testRoot, "postgres.log");
const user = "signatures_migration_test";
const database = "signatures_gallery_migration_test";

function binary(name: string): string {
  return resolve(postgresBin, name);
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

async function unusedPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local PostgreSQL test port."));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

const port = await unusedPort();
let started = false;
let pool: ReturnType<typeof createPostgresPool> | null = null;
try {
  mkdirSync(socket, { recursive: true });
  run(binary("initdb"), [
    "-D", data,
    "--username", user,
    "--auth-local", "trust",
    "--auth-host", "trust",
    "--encoding", "UTF8",
    "--no-locale",
    "--data-checksums",
    "--no-instructions",
  ]);
  run(binary("pg_ctl"), [
    "-D", data,
    "-l", log,
    "-o", `-p ${port} -h 127.0.0.1 -k ${socket} -c listen_addresses=127.0.0.1`,
    "-t", "15",
    "start",
    "-w",
  ]);
  started = true;
  const base = ["-h", "127.0.0.1", "-p", String(port), "-U", user];
  run(binary("createdb"), [...base, database]);
  for (const file of [
    resolve(repoRoot, "src/store/schema.sql"),
    resolve(repoRoot, "src/store/migrations/002_v2_minting.sql"),
    resolve(repoRoot, "src/local/schema.sql"),
    resolve(repoRoot, "src/store/migrations/003_claim_withdrawal.sql"),
    resolve(repoRoot, "src/store/migrations/004_formal_algorithm.sql"),
  ]) {
    run(binary("psql"), [...base, "-d", database, "-v", "ON_ERROR_STOP=1", "-f", file]);
  }
  const check = run(binary("psql"), [
    ...base,
    "-d", database,
    "-v", "ON_ERROR_STOP=1",
    "-Atc",
    `SELECT json_build_object(
       'server_version', current_setting('server_version'),
       'mint_deployments', to_regclass('public.mint_deployments') IS NOT NULL,
       'chain_blocks', to_regclass('public.chain_blocks') IS NOT NULL,
       'gallery_entries', to_regclass('public.gallery_entries') IS NOT NULL,
       'local_snapshots', to_regclass('local_rehearsal.state_snapshots') IS NOT NULL,
       'chain_block_trigger', EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'public.chain_blocks'::regclass
            AND NOT tgisinternal
       )
     )::text`,
  ]);
  const result = JSON.parse(check) as Record<string, unknown>;
  for (const key of ["mint_deployments", "chain_blocks", "gallery_entries", "local_snapshots", "chain_block_trigger"]) {
    if (result[key] !== true) throw new Error(`Fresh PostgreSQL migration catalog check failed: ${key}`);
  }
  pool = createPostgresPool(`postgresql://${user}@127.0.0.1:${port}/${database}`);
  const signatures = new PostgresSignatureStore(pool);
  await Promise.race([
    Promise.all(Array.from({ length: 8 }, (_, index) =>
      signatures.withClaimLock(`sg1_${String(index).padStart(52, "a")}`, async () => {
        await pool!.query("SELECT 1");
      }),
    )),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Claim lock pool-exhaustion regression timed out.")), 5_000)),
  ]);
  const claimedAt = new Date("2026-09-05T00:00:00.000Z");
  const input = (gr0kRaw: number) => ({
    xUserId: "1234567890123456789",
    handleAtClaim: "alice",
    handleNormalized: "alice",
    gr0kRaw,
    rendererVersion: "sg-renderer-1.0.0",
    svgSha256: "11".repeat(32),
    svgStorageKey: `sha256/${"11".repeat(32)}.svg`,
    cardRendererVersion: "sg-card-1.0.0",
    pngSha256: "22".repeat(32),
    cardStorageKey: `sha256/${"22".repeat(32)}.png`,
    xAuthenticatedAt: claimedAt,
    claimedAt,
  });
  const concurrent = await Promise.all([
    signatures.claim(input(11)),
    signatures.claim(input(22)),
  ]);
  if (new Set(concurrent.map((entry) => entry.account.publicAccountId)).size !== 1) {
    throw new Error("Concurrent first claims did not converge on one PostgreSQL account.");
  }
  // Exercise the additive policy migration over existing data, without touching
  // the application's database. Only the two identity-age CHECKs may disappear.
  const walletConstraints = async () => (await pool!.query<{ relation: string; name: string; definition: string }>(`
    SELECT conrelid::regclass::text AS relation, conname AS name,
           pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid IN ('wallet_binding_challenges'::regclass, 'wallet_bindings'::regclass,
                      'wallet_binding_heads'::regclass, 'mint_authorizations'::regclass)
    ORDER BY conrelid::regclass::text, conname
  `)).rows;
  const beforePolicyConstraints = await walletConstraints();
  const obsoleteDefinitions = new Set([
    "CHECK ((expires_at <= (x_authenticated_at + '00:15:00'::interval)))",
    "CHECK ((proved_at <= (x_authenticated_at + '00:15:00'::interval)))",
  ]);
  if (beforePolicyConstraints.filter(row => obsoleteDefinitions.has(row.definition)).length !== 2) {
    throw new Error("Expected exactly two pre-policy X identity-age constraints.");
  }
  const insertChallenge = (name: string, nonceByte: string, created: string, expires: string) => pool!.query(`
    INSERT INTO wallet_binding_challenges (
      challenge_id, bound_session_id_digest, x_user_id, public_account_id, wallet_address,
      chain_id, purpose, nonce_digest, exact_siwe_message, status,
      x_authenticated_at, created_at, expires_at
    ) VALUES ($1, decode(repeat('01', 32), 'hex'), $2, $3, decode(repeat('11', 20), 'hex'),
      11155111, 'mint_wallet_binding_v1', decode(repeat($4, 32), 'hex'), 'exact test SIWE',
      'pending', '2026-09-05T00:00:00Z', $5, $6)
  `, [name, concurrent[0]!.account.xUserId, concurrent[0]!.account.publicAccountId, nonceByte, created, expires]);
  await insertChallenge("before-policy", "02", "2026-09-05T00:01:00Z", "2026-09-05T00:10:00Z");
  const beforeChallenge = (await pool.query("SELECT to_jsonb(c) AS data FROM wallet_binding_challenges c WHERE challenge_id = 'before-policy'")).rows;
  const applyPolicyMigration = () => run(binary("psql"), [...base, "-d", database, "-v", "ON_ERROR_STOP=1", "-f", resolve(repoRoot, "src/store/migrations/005_action_auth_policy.sql")]);
  applyPolicyMigration();
  const afterPolicyConstraints = await walletConstraints();
  if (JSON.stringify(afterPolicyConstraints) !== JSON.stringify(beforePolicyConstraints.filter(row => !obsoleteDefinitions.has(row.definition)))) {
    throw new Error("Action policy migration changed constraints beyond the two obsolete identity-age checks.");
  }
  applyPolicyMigration();
  if (JSON.stringify(await walletConstraints()) !== JSON.stringify(afterPolicyConstraints)
      || JSON.stringify((await pool.query("SELECT to_jsonb(c) AS data FROM wallet_binding_challenges c WHERE challenge_id = 'before-policy'")).rows) !== JSON.stringify(beforeChallenge)) {
    throw new Error("Action policy migration reapplication changed existing schema or wallet evidence.");
  }
  // X confirms near flow start; issuing SIWE near the flow deadline still gives
  // that separate proof its full ten minutes, without a second X freshness cap.
  await insertChallenge("independent-proof", "03", "2026-09-05T00:14:00Z", "2026-09-05T00:24:00Z");
  for (const [name, nonce, created, expires] of [
    ["too-long-proof", "04", "2026-09-05T00:14:00Z", "2026-09-05T00:24:01Z"],
    ["future-identity", "05", "2026-09-04T23:59:00Z", "2026-09-05T00:05:00Z"],
  ]) {
    let rejected = false;
    try { await insertChallenge(name!, nonce!, created!, expires!); }
    catch (error) { if ((error as { code?: string }).code === "23514") rejected = true; else throw error; }
    if (!rejected) throw new Error(`Action policy migration weakened the ${name} constraint.`);
  }
  const bindingClient = await pool.connect();
  try {
    await bindingClient.query("BEGIN");
    await bindingClient.query("INSERT INTO wallet_binding_heads(x_user_id, chain_id) VALUES ($1, 11155111)", [concurrent[0]!.account.xUserId]);
    await bindingClient.query(`
      INSERT INTO wallet_bindings (
        wallet_binding_id, x_user_id, chain_id, wallet_address, proof_scheme,
        siwe_message, siwe_message_hash, wallet_proof, verification_block_number,
        verification_block_hash, x_authenticated_at, proved_at, activated_at
      ) VALUES (decode(repeat('31', 32), 'hex'), $1, 11155111, decode(repeat('11', 20), 'hex'),
        'eoa_siwe_v1', 'exact test SIWE', decode(repeat('32', 32), 'hex'),
        decode(repeat('01', 64) || '1b', 'hex'), 1, decode(repeat('33', 32), 'hex'),
        '2026-09-05T00:00:00Z', '2026-09-05T00:24:00Z', '2026-09-05T00:24:00Z')
    `, [concurrent[0]!.account.xUserId]);
    await bindingClient.query("UPDATE wallet_binding_heads SET active_wallet_binding_id = decode(repeat('31', 32), 'hex'), version = version + 1 WHERE x_user_id = $1 AND chain_id = 11155111", [concurrent[0]!.account.xUserId]);
    await bindingClient.query("COMMIT");
  } catch (error) {
    await bindingClient.query("ROLLBACK");
    throw error;
  } finally {
    bindingClient.release();
  }
  const duplicate = await Promise.all([signatures.claim(input(33)), signatures.claim(input(33))]);
  if (duplicate.filter((entry) => entry.existing).length !== 1) {
    throw new Error("Concurrent identical PostgreSQL claims were not idempotent.");
  }

  const artifactLedger = new PostgresArtifactLedger(pool);
  await signatures.claim({ ...input(44), xUserId: "987654321", handleAtClaim: "bob", handleNormalized: "bob", claimedAt: new Date("2026-09-06T00:00:00Z") });
  const allClaims = await signatures.listClaimedSignatures(100);
  const firstPage = await signatures.listClaimedSignatures(2);
  const secondPage = await signatures.listClaimedSignatures(2, firstPage[1]);
  if (allClaims.length !== 4 || allClaims[0]!.handleAtClaim !== "bob" ||
    JSON.stringify([...firstPage, ...secondPage].map(s => s.signatureId)) !== JSON.stringify(allClaims.map(s => s.signatureId)) ||
    allClaims.slice(1).map(s => s.signatureId).join() !== allClaims.slice(1).map(s => s.signatureId).sort().join() ||
    (await signatures.listClaimedSignatures(2, secondPage[1])).length !== 0) {
    throw new Error("PostgreSQL Claimed gallery ordering or keyset pagination failed.");
  }
  const fileArtifacts = new FileArtifactStore(resolve(testRoot, "artifacts"), artifactLedger);
  const stored = await fileArtifacts.putVerified("svg", Buffer.from("postgres integration artifact"), { signatureId: duplicate[0]!.signature.signatureId });
  const repeated = await fileArtifacts.putVerified("svg", Buffer.from("postgres integration artifact"), { signatureId: duplicate[0]!.signature.signatureId });
  if (!stored.referenceCreated || repeated.referenceCreated || !(await fileArtifacts.get(stored.key))) {
    throw new Error("PostgreSQL-backed file artifact deduplication/reference check failed.");
  }
  let mismatchedReferenceRejected = false;
  try {
    await artifactLedger.add({
      storageKey: stored.key,
      signatureId: duplicate[0]!.signature.signatureId,
      kind: "svg",
      sha256: "ff".repeat(32),
      byteLength: stored.byteLength,
    });
  } catch {
    mismatchedReferenceRejected = true;
  }
  if (!mismatchedReferenceRejected) {
    throw new Error("PostgreSQL artifact ledger accepted conflicting integrity metadata.");
  }

  const mintStore = new MemoryMintStore();
  mintStore.seedBinding({
    walletBindingId: `0x${"33".repeat(32)}`,
    xUserId: "1234567890123456789",
    publicAccountId: concurrent[0]!.account.publicAccountId,
    chainId: 31337n,
    address: `0x${"44".repeat(20)}`,
    siweMessage: "PG16 JSONB snapshot integration test",
    walletProof: `0x${"55".repeat(65)}`,
    verificationScheme: "fixture_seed",
    verificationBlockNumber: 7n,
    verificationBlockHash: `0x${"66".repeat(32)}`,
    provedAt: claimedAt,
    status: "active",
    version: 1,
  });
  const durable = new LocalPostgresState(pool);
  await durable.saveMintStore(mintStore);
  const restored = await durable.loadMintStore();
  if (restored.getActiveBinding("1234567890123456789", 31337n)?.verificationBlockNumber !== 7n) {
    throw new Error("PostgreSQL JSONB mint snapshot round-trip failed.");
  }

  const removable = duplicate[0]!.signature;
  const originalInstance = removable.claimInstanceId;
  // The administrative erasure guard remains closed to ordinary SQL DELETE.
  let rawDeleteBlocked = false;
  try { await pool.query("DELETE FROM signatures WHERE signature_id = $1", [removable.signatureId]); }
  catch { rawDeleteBlocked = true; }
  if (!rawDeleteBlocked) throw new Error("Raw deletion bypassed the mint erasure guard.");
  if (await signatures.withdraw(removable.signatureId, "999", originalInstance)) throw new Error("Withdrawal accepted the wrong account.");
  await signatures.withClaimLock(removable.signatureId, async () => {
    if (!await signatures.withdraw(removable.signatureId, removable.xUserId, originalInstance)) throw new Error("PostgreSQL withdrawal failed.");
  });
  if (await signatures.getSignature(removable.signatureId)) throw new Error("Withdrawn claim remained in PostgreSQL.");
  const references = await pool.query("SELECT 1 FROM local_rehearsal.artifact_references WHERE signature_id = $1", [removable.signatureId]);
  if (references.rowCount) throw new Error("Withdrawn claim retained local artifact references.");
  const freshClaim = await signatures.claim({ ...input(33), claimedAt: new Date() });
  if (freshClaim.existing || freshClaim.signature.claimInstanceId === originalInstance) throw new Error("A fresh claim reused the withdrawn database instance.");
  if (await signatures.withdraw(removable.signatureId, removable.xUserId, originalInstance)) throw new Error("An old withdrawal removed a new claim.");

  // Restart-safe snapshot guard: even an unminted-looking claim cannot be
  // removed when the durable mint state carries unresolved authority.
  const blockedSnapshot = restored.exportSnapshot();
  blockedSnapshot.projections = [[removable.signatureId, {
    ...restored.getProjection(removable.signatureId), state: "submitted",
  }]];
  await durable.saveMintStore(MemoryMintStore.fromSnapshot(blockedSnapshot));
  let mintBlocked = false;
  try { await signatures.withdraw(removable.signatureId, removable.xUserId, freshClaim.signature.claimInstanceId); }
  catch { mintBlocked = true; }
  if (!mintBlocked || !await signatures.getSignature(removable.signatureId)) throw new Error("Durable unresolved mint did not block withdrawal.");
  // Normalized mint controls still block even when the local snapshot is safe.
  await durable.saveMintStore(restored);
  await pool.query("UPDATE signature_mint_controls SET issuance_state = 'blocked', broad_reason_class = 'test', version = version + 1 WHERE signature_id = $1", [removable.signatureId]);
  let normalizedBlocked = false;
  try { await signatures.withdraw(removable.signatureId, removable.xUserId, freshClaim.signature.claimInstanceId); }
  catch { normalizedBlocked = true; }
  if (!normalizedBlocked || !await signatures.getSignature(removable.signatureId)) throw new Error("Normalized mint control did not block withdrawal.");
  const caseVariants = await Promise.all([
    signatures.claim({ ...input(22), handleAtClaim: "Alice", currentHandle: "ALIce" }),
    signatures.claim({ ...input(22), handleAtClaim: "ALICE", currentHandle: "ALIce" }),
  ]);
  if (new Set([...caseVariants, concurrent[1]!].map(({ signature }) => signature.signatureId)).size !== 3
      || new Set(caseVariants.map(({ account }) => account.publicAccountId)).size !== 1
      || caseVariants.some(({ account }) => account.currentHandle !== "ALIce")) {
    throw new Error("Exact-case artwork inputs did not remain distinct within the same X account.");
  }
  const uppercaseReplay = await signatures.claim({ ...input(22), handleAtClaim: "Alice", currentHandle: "alice" });
  if (!uppercaseReplay.existing || uppercaseReplay.signature.handleAtClaim !== "Alice" || uppercaseReplay.account.currentHandle !== "alice") {
    throw new Error("OAuth current spelling overwrote the frozen artwork handle.");
  }
  // Reapplying the migration must preserve valid formal records and indexes.
  run(binary("psql"), [...base, "-d", database, "-v", "ON_ERROR_STOP=1", "-f", resolve(repoRoot, "src/store/migrations/004_formal_algorithm.sql")]);
  await pool.end();
  pool = null;
  console.log(JSON.stringify({ migrated: true, repositoriesExercised: true, withdrawalExercised: true, caseSensitiveArtworkExercised: true, actionAuthPolicyExercised: true, ...result }, null, 2));
} catch (error) {
  if (existsSync(log)) console.error(readFileSync(log, "utf8"));
  throw error;
} finally {
  if (pool) await pool.end().catch(() => undefined);
  if (started) {
    spawnSync(binary("pg_ctl"), ["-D", data, "-m", "fast", "-t", "15", "stop", "-w"], { stdio: "inherit" });
  }
  rmSync(testRoot, { recursive: true, force: true });
}
