import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { MemoryAuthState } from "../v1/authState.js";
import { seedDevelopmentFixtures } from "../v1/fixtures.js";
import { FileArtifactStore } from "../v1/fileArtifactStore.js";
import { CARD_RENDERER_VERSION, formalSignatureRenderer, RendererRegistry, sha256Hex } from "../v1/renderer.js";
import { signatureTokenId } from "../v2/core/signatureId.js";
import { mintAuthorizationTypedData } from "../v2/core/mintAuthorization.js";
import {
  applyScanBatch,
  attachMintValidation,
  createIndexerState,
  decodeRawGalleryLog,
  ERC721_TRANSFER_TOPIC,
  FROZEN_GALLERY_ABI_VERSION,
  promoteFinalized,
  SIGNATURE_MINTED_TOPIC,
  type CandidateContractLog,
  type ChainHeader,
  type DeploymentIndexConfig,
  type DurableMintAuthorizationEvidence,
  type Hex as IndexerHex,
  type IndexerState,
  type RawEvmLog,
  type TransactionReceiptInput,
} from "../v2/indexer/index.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import type { MintConfig } from "../v2/config.js";
import { V2MintService, type GallerySigner } from "../v2/service.js";
import { createPostgresPool, PostgresArtifactLedger, PostgresSignatureStore } from "../store/postgresStore.js";
import { LocalPostgresState } from "./postgresState.js";
import { rehearsalMintVerificationPlan } from "./rehearsalVerification.js";
import { LOCAL_ANVIL_PERSISTENCE_ARGS, LOCAL_RPC_HTTP_OPTIONS, LOCAL_RPC_TIMEOUT_MS, waitForLocalNode } from "./nodePolicy.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCAL_ROOT = resolve(REPO_ROOT, ".local/rehearsal");
const POSTGRES_DATA = resolve(LOCAL_ROOT, "postgres/data");
const POSTGRES_SOCKET = resolve(LOCAL_ROOT, "postgres/socket");
const LOG_ROOT = resolve(LOCAL_ROOT, "logs");
const ARTIFACT_ROOT = resolve(LOCAL_ROOT, "artifacts");
const ANVIL_STATE = resolve(LOCAL_ROOT, "anvil/state.json");
const ANVIL_PID = resolve(LOCAL_ROOT, "anvil/anvil.pid");
const RUNTIME_FILE = resolve(LOCAL_ROOT, "runtime.json");

const POSTGRES_BIN = process.env.LOCAL_POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const ANVIL_BIN = process.env.LOCAL_ANVIL_BIN ?? "/Users/bigu/.foundry/bin/anvil";
const FORGE_BIN = process.env.LOCAL_FORGE_BIN ?? "/Users/bigu/.foundry/bin/forge";
const POSTGRES_PORT = portFromEnvironment("LOCAL_POSTGRES_PORT", 55_432);
const ANVIL_PORT = portFromEnvironment("LOCAL_ANVIL_PORT", 18_545);
const DATABASE_USER = "signatures";
const DATABASE_NAME = "signatures_gallery_local";
const DATABASE_URL = `postgresql://${DATABASE_USER}@127.0.0.1:${POSTGRES_PORT}/${DATABASE_NAME}`;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const CHAIN_ID = 31_337n;
const RUN_NAME = "default";
const V2_MIGRATION_NAME = "002_v2_minting.sql";
const V2_MIGRATION_PATH = resolve(REPO_ROOT, "src/store/migrations/002_v2_minting.sql");

// This mnemonic and every derived key are Anvil's public test credentials.
// They must never be copied into a non-local environment.
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const ROLE_ACCOUNTS = {
  deployer: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 }),
  delayedAdmin: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 }),
  authorizerManager: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 2 }),
  pauser: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 3 }),
  authorizationRevoker: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 4 }),
  initialAuthorizer: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 5 }),
  mintWallet: mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 6 }),
} as const;

const COLLECTION = {
  name: "Gallery of Signatures",
  symbol: "SIGN",
  uri: "ipfs://bafkreih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdi",
  metadataSha256: "0xff0e790009201b46d2ffc7a6e6ec671de641a3c48a973ad78ad7caad4430cf1a" as Hex,
  uriHash: "0x51402158eed04f9de88c4774fb6b2b09a030544addecfc1dc0015daef1674a52" as Hex,
  defaultAdminDelay: 3_600,
} as const;

const localChain = defineChain({
  id: Number(CHAIN_ID),
  name: "Anvil local rehearsal",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

interface GalleryArtifact {
  abi: readonly unknown[];
  bytecode: { object: Hex };
}

interface ChainRunRow {
  chain_id: string;
  rpc_url: string;
  contract_address: Buffer;
  deployment_transaction: Buffer;
  deployment_block_number: string;
  deployment_block_hash: Buffer;
  runtime_code_hash: Buffer;
  seeded_mint_transaction: Buffer | null;
  seeded_signature_id: string | null;
}

interface RuntimeRecord {
  schemaVersion: 1;
  localOnly: true;
  postgresUrl: string;
  rpcUrl: string;
  chainId: "31337";
  roleAccounts: Record<string, Address>;
  contract: Address;
  deploymentTransaction: Hex;
  deploymentBlockNumber: string;
  runtimeCodeHash: Hex;
  seededMintTransaction: Hex;
  seededSignatureId: string;
  seededTokenId: string;
}

function portFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new Error(`${name} must be an integer port.`);
  const port = Number(raw);
  if (port > 65_535) throw new Error(`${name} must be at most 65535.`);
  return port;
}

function ensureLocalRootIsSafe(): void {
  if (!LOCAL_ROOT.startsWith(`${REPO_ROOT}${sep}`) || basename(LOCAL_ROOT) !== "rehearsal") {
    throw new Error("Refusing to operate outside the repository-local rehearsal directory.");
  }
}

function ensureExecutable(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} was not found at ${path}. Override its LOCAL_*_BIN variable if needed.`);
}

function run(path: string, args: string[], options: { cwd?: string; quiet?: boolean } = {}): string {
  try {
    return execFileSync(path, args, {
      cwd: options.cwd ?? REPO_ROOT,
      encoding: "utf8",
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
      env: process.env,
    }).trim();
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error && Buffer.isBuffer(error.stderr)) {
      const detail = error.stderr.toString("utf8").trim();
      if (detail) throw new Error(`${path} failed: ${detail}`);
    }
    throw error;
  }
}

function postgres(path: string): string {
  return resolve(POSTGRES_BIN, path);
}

function postgresRunning(): boolean {
  if (!existsSync(resolve(POSTGRES_DATA, "PG_VERSION"))) return false;
  return spawnSync(postgres("pg_ctl"), ["-D", POSTGRES_DATA, "status"], { stdio: "ignore" }).status === 0;
}

function ensurePostgres(): void {
  ensureExecutable(postgres("initdb"), "PostgreSQL 16 initdb");
  mkdirSync(POSTGRES_SOCKET, { recursive: true });
  mkdirSync(LOG_ROOT, { recursive: true });
  if (!existsSync(resolve(POSTGRES_DATA, "PG_VERSION"))) {
    mkdirSync(dirname(POSTGRES_DATA), { recursive: true });
    run(postgres("initdb"), [
      "-D", POSTGRES_DATA,
      "--username", DATABASE_USER,
      "--auth-local", "trust",
      "--auth-host", "trust",
      "--encoding", "UTF8",
      "--no-locale",
      "--data-checksums",
      "--no-instructions",
    ]);
  }
  if (!postgresRunning()) {
    const serverOptions = `-p ${POSTGRES_PORT} -h 127.0.0.1 -k ${POSTGRES_SOCKET} -c listen_addresses=127.0.0.1`;
    run(postgres("pg_ctl"), [
      "-D", POSTGRES_DATA,
      "-l", resolve(LOG_ROOT, "postgres.log"),
      "-o", serverOptions,
      "-t", "15",
      "start",
      "-w",
    ]);
  }

  const psqlBase = ["-h", "127.0.0.1", "-p", String(POSTGRES_PORT), "-U", DATABASE_USER];
  const exists = run(postgres("psql"), [
    ...psqlBase,
    "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    "-Atc", `SELECT 1 FROM pg_database WHERE datname = '${DATABASE_NAME}'`,
  ], { quiet: true });
  if (exists !== "1") {
    run(postgres("createdb"), [...psqlBase, DATABASE_NAME]);
  }
}

function psqlScalar(sql: string): string {
  return run(postgres("psql"), [
    "-h", "127.0.0.1",
    "-p", String(POSTGRES_PORT),
    "-U", DATABASE_USER,
    "-d", DATABASE_NAME,
    "-v", "ON_ERROR_STOP=1",
    "-Atc", sql,
  ], { quiet: true });
}

function applySqlFile(path: string): void {
  run(postgres("psql"), [
    "-h", "127.0.0.1",
    "-p", String(POSTGRES_PORT),
    "-U", DATABASE_USER,
    "-d", DATABASE_NAME,
    "-v", "ON_ERROR_STOP=1",
    "-f", path,
  ]);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertV2MigrationChecksum(): void {
  const expected = fileSha256(V2_MIGRATION_PATH);
  const recorded = psqlScalar(
    `SELECT coalesce((SELECT sha256 FROM local_rehearsal.schema_migrations WHERE migration_name = '${V2_MIGRATION_NAME}'), '')`,
  );
  if (recorded !== expected) {
    const reason = recorded ? "its recorded checksum differs from this working tree" : "it has no recorded checksum";
    throw new Error(`Local V2 migration is unsafe to reuse because ${reason}. Run npm run local:reset.`);
  }
}

function migrateDatabase(): void {
  if (psqlScalar("SELECT to_regclass('public.x_accounts') IS NOT NULL") !== "t") {
    applySqlFile(resolve(REPO_ROOT, "src/store/schema.sql"));
  }
  applySqlFile(resolve(REPO_ROOT, "src/local/schema.sql"));
  const migrationExists = psqlScalar("SELECT to_regclass('public.mint_deployments') IS NOT NULL") === "t";
  const recorded = psqlScalar(
    `SELECT coalesce((SELECT sha256 FROM local_rehearsal.schema_migrations WHERE migration_name = '${V2_MIGRATION_NAME}'), '')`,
  );
  if (migrationExists && !recorded) {
    throw new Error("Existing local V2 schema predates checksum tracking. Run npm run local:reset rather than guessing its migration version.");
  }
  if (!migrationExists && recorded) {
    throw new Error("Local migration ledger and database schema disagree. Run npm run local:reset.");
  }
  if (!migrationExists) {
    applySqlFile(V2_MIGRATION_PATH);
    const checksum = fileSha256(V2_MIGRATION_PATH);
    psqlScalar(
      `INSERT INTO local_rehearsal.schema_migrations (migration_name, sha256) VALUES ('${V2_MIGRATION_NAME}', '${checksum}') RETURNING sha256`,
    );
  }
  assertV2MigrationChecksum();
  applySqlFile(resolve(REPO_ROOT, "src/store/migrations/003_claim_withdrawal.sql"));
  applySqlFile(resolve(REPO_ROOT, "src/store/migrations/004_formal_algorithm.sql"));
  applySqlFile(resolve(REPO_ROOT, "src/store/migrations/005_action_auth_policy.sql"));
}

function readPid(path: string): number | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`Invalid PID file: ${path}`);
  return Number(raw);
}

function processCommand(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function anvilRunning(): boolean {
  const pid = readPid(ANVIL_PID);
  if (!pid) return false;
  const command = processCommand(pid);
  return command !== null
    && command.includes("anvil")
    && command.includes(`--port ${ANVIL_PORT}`)
    && command.includes(ANVIL_STATE);
}

async function waitForRpc(): Promise<void> {
  await waitForLocalNode(async () => {
    if (!anvilRunning()) throw new Error("The owned Anvil process exited before its saved state finished loading. Preserve the state and inspect its log.");
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(LOCAL_RPC_TIMEOUT_MS),
      });
      const body = await response.json() as { result?: string };
      return response.ok && body.result === "0x7a69";
    } catch { return false; }
  }, `Anvil did not become ready on ${RPC_URL}. Preserve its saved state and inspect its log; no reset was performed.`);
}

async function rpcChainIdOrNull(): Promise<string | null> {
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(750),
    });
    const body = await response.json() as { result?: string };
    return response.ok && typeof body.result === "string" ? body.result : null;
  } catch {
    return null;
  }
}

async function ensureAnvil(): Promise<void> {
  ensureExecutable(ANVIL_BIN, "Anvil");
  mkdirSync(dirname(ANVIL_STATE), { recursive: true });
  mkdirSync(LOG_ROOT, { recursive: true });
  if (!anvilRunning()) {
    const occupiedChain = await rpcChainIdOrNull();
    if (occupiedChain !== null) {
      throw new Error(`Refusing to use port ${ANVIL_PORT}: an RPC node not owned by this rehearsal is already listening (chain ${occupiedChain}).`);
    }
    const log = openSync(resolve(LOG_ROOT, "anvil.log"), "a", 0o600);
    const child = spawn(ANVIL_BIN, [
      "--host", "127.0.0.1",
      "--port", String(ANVIL_PORT),
      "--chain-id", CHAIN_ID.toString(),
      "--mnemonic", ANVIL_MNEMONIC,
      "--state", ANVIL_STATE,
      ...LOCAL_ANVIL_PERSISTENCE_ARGS,
      "--quiet",
      "--color", "never",
    ], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    closeSync(log);
    if (!child.pid) throw new Error("Anvil did not return a process ID.");
    writeFileSync(ANVIL_PID, `${child.pid}\n`, { mode: 0o600 });
  }
  await waitForRpc();
  if (!anvilRunning()) throw new Error("The owned Anvil process exited while another RPC endpoint answered on its port.");
}

async function stopAnvil(): Promise<boolean> {
  const pid = readPid(ANVIL_PID);
  if (!pid) return false;
  const command = processCommand(pid);
  if (command === null) {
    rmSync(ANVIL_PID, { force: true });
    return false;
  }
  if (!command.includes("anvil") || !command.includes(`--port ${ANVIL_PORT}`) || !command.includes(ANVIL_STATE)) {
    throw new Error(`Refusing to signal PID ${pid}; it is not this repository's Anvil process.`);
  }
  process.kill(pid, "SIGINT");
  await waitForLocalNode(() => processCommand(pid) === null,
    `Anvil PID ${pid} is still saving its state after SIGINT. It was not force-killed; wait for shutdown before restarting.`);
  rmSync(ANVIL_PID, { force: true });
  return true;
}

function stopPostgres(): boolean {
  if (!postgresRunning()) return false;
  run(postgres("pg_ctl"), ["-D", POSTGRES_DATA, "-m", "fast", "-t", "15", "stop", "-w"]);
  return true;
}

function hexToBuffer(value: Hex): Buffer {
  return Buffer.from(value.slice(2), "hex");
}

function bufferToHex(value: Buffer): Hex {
  return `0x${value.toString("hex")}`;
}

function galleryArtifact(): GalleryArtifact {
  const path = resolve(REPO_ROOT, "contracts/out/GalleryOfSignatures.sol/GalleryOfSignatures.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as GalleryArtifact;
  if (!Array.isArray(parsed.abi) || !/^0x[0-9a-f]+$/i.test(parsed.bytecode.object)) {
    throw new Error("Forge produced an invalid GalleryOfSignatures artifact.");
  }
  return parsed;
}

function assertRoleSeparation(): void {
  const roles = Object.entries(ROLE_ACCOUNTS).filter(([name]) => name !== "mintWallet");
  const addresses = new Set(roles.map(([, account]) => account.address.toLowerCase()));
  if (addresses.size !== roles.length) throw new Error("Local deployment role accounts are not pairwise distinct.");
  if (addresses.has(ROLE_ACCOUNTS.mintWallet.address.toLowerCase())) {
    throw new Error("The local mint wallet must not be a deployment role account.");
  }
}

function publicClient() {
  return createPublicClient({ chain: localChain, transport: http(RPC_URL, LOCAL_RPC_HTTP_OPTIONS) });
}

async function assertLocalChain(): Promise<void> {
  const parsed = new URL(RPC_URL);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("Local rehearsal transactions are hard-blocked outside 127.0.0.1.");
  }
  const observed = await publicClient().getChainId();
  if (observed !== Number(CHAIN_ID)) throw new Error(`Expected Anvil chain 31337, observed ${observed}.`);
}

async function readChainRun(pool: ReturnType<typeof createPostgresPool>): Promise<ChainRunRow | null> {
  const result = await pool.query<ChainRunRow>(
    `SELECT chain_id::text, rpc_url, contract_address, deployment_transaction,
            deployment_block_number::text, deployment_block_hash, runtime_code_hash,
            seeded_mint_transaction, seeded_signature_id
       FROM local_rehearsal.chain_runs WHERE run_name = $1`,
    [RUN_NAME],
  );
  return result.rowCount === 1 ? result.rows[0]! : null;
}

async function seedV1(pool: ReturnType<typeof createPostgresPool>): Promise<{ store: PostgresSignatureStore; artifacts: FileArtifactStore }> {
  const store = new PostgresSignatureStore(pool);
  const artifacts = new FileArtifactStore(ARTIFACT_ROOT, new PostgresArtifactLedger(pool));
  const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM signatures");
  // `up` is a restart, not a fixture replay: replaying an idempotent claim
  // updates current_handle/last_authenticated_at and can regress later OAuth
  // activity. Only a genuinely empty database is seeded; partial state fails
  // verification and requires the explicit local reset.
  if (count.rows[0]?.count === "0") {
    const auth = new MemoryAuthState();
    await seedDevelopmentFixtures({
      store,
      artifacts,
      renderers: new RendererRegistry([formalSignatureRenderer]),
      cardRendererVersion: CARD_RENDERER_VERSION,
    }, auth);
  }
  return { store, artifacts };
}

function mintConfig(contract: Address, runtimeCodeHash: Hex): MintConfig {
  return {
    enabled: true,
    fixtureMode: true,
    chainId: CHAIN_ID,
    chainName: localChain.name,
    contract,
    eip712Name: "signatures.gallery",
    eip712Version: "2",
    authorizationTtlSeconds: 900,
    maxAuthorizationWindowSeconds: 1_800,
    authorizerEpoch: 1,
    authorizer: ROLE_ACCOUNTS.initialAuthorizer.address,
    publicArtifactOrigin: "http://127.0.0.1:3000",
    appOrigin: "http://127.0.0.1:3000",
    appHost: "127.0.0.1:3000",
    explorerBaseUrl: null,
    genesisHash: null,
    runtimeCodeHash,
    primaryRpcUrl: RPC_URL,
    secondaryRpcUrl: RPC_URL,
  };
}

async function validateDeployment(contract: Address, abi: readonly unknown[], runtimeCodeHash: Hex): Promise<void> {
  const client = publicClient();
  const [
    name,
    symbol,
    collectionUri,
    collectionSha,
    collectionUriHash,
    defaultAdmin,
    defaultAdminDelay,
    managerRole,
    pauserRole,
    revokerRole,
    epoch,
    authorizer,
    paused,
  ] = await Promise.all([
    client.readContract({ address: contract, abi, functionName: "name" }),
    client.readContract({ address: contract, abi, functionName: "symbol" }),
    client.readContract({ address: contract, abi, functionName: "contractURI" }),
    client.readContract({ address: contract, abi, functionName: "collectionMetadataSha256" }),
    client.readContract({ address: contract, abi, functionName: "collectionURIHash" }),
    client.readContract({ address: contract, abi, functionName: "defaultAdmin" }),
    client.readContract({ address: contract, abi, functionName: "defaultAdminDelay" }),
    client.readContract({ address: contract, abi, functionName: "AUTHORIZER_MANAGER_ROLE" }),
    client.readContract({ address: contract, abi, functionName: "PAUSER_ROLE" }),
    client.readContract({ address: contract, abi, functionName: "AUTHORIZATION_REVOKER_ROLE" }),
    client.readContract({ address: contract, abi, functionName: "currentAuthorizerEpoch" }),
    client.readContract({ address: contract, abi, functionName: "authorizerByEpoch", args: [1] }),
    client.readContract({ address: contract, abi, functionName: "paused" }),
  ]);
  const [hasManager, hasPauser, hasRevoker] = await Promise.all([
    client.readContract({ address: contract, abi, functionName: "hasRole", args: [managerRole, ROLE_ACCOUNTS.authorizerManager.address] }),
    client.readContract({ address: contract, abi, functionName: "hasRole", args: [pauserRole, ROLE_ACCOUNTS.pauser.address] }),
    client.readContract({ address: contract, abi, functionName: "hasRole", args: [revokerRole, ROLE_ACCOUNTS.authorizationRevoker.address] }),
  ]);
  const code = await client.getCode({ address: contract });
  if (!code || code === "0x" || keccak256(code) !== runtimeCodeHash) throw new Error("Deployed runtime code hash mismatch.");
  const failures = [
    name !== COLLECTION.name && "name",
    symbol !== COLLECTION.symbol && "symbol",
    collectionUri !== COLLECTION.uri && "contractURI",
    collectionSha !== COLLECTION.metadataSha256 && "collectionMetadataSha256",
    collectionUriHash !== COLLECTION.uriHash && "collectionURIHash",
    getAddress(String(defaultAdmin)) !== ROLE_ACCOUNTS.delayedAdmin.address && "defaultAdmin",
    Number(defaultAdminDelay) !== COLLECTION.defaultAdminDelay && "defaultAdminDelay",
    hasManager !== true && "authorizerManager",
    hasPauser !== true && "pauser",
    hasRevoker !== true && "authorizationRevoker",
    Number(epoch) !== 1 && "authorizerEpoch",
    getAddress(String(authorizer)) !== ROLE_ACCOUNTS.initialAuthorizer.address && "authorizer",
    paused !== false && "paused",
  ].filter(Boolean);
  if (failures.length > 0) throw new Error(`Local deployment invariant failure: ${failures.join(", ")}`);
}

function receiptInput(receipt: TransactionReceipt, expectedMint?: TransactionReceiptInput["expectedMint"]): TransactionReceiptInput {
  return {
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash as IndexerHex,
    txHash: receipt.transactionHash as IndexerHex,
    transactionIndex: receipt.transactionIndex,
    status: receipt.status,
    ...(expectedMint ? { expectedMint } : {}),
  };
}

function rawLog(receipt: TransactionReceipt, log: TransactionReceipt["logs"][number]): RawEvmLog {
  if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.transactionIndex === null || log.logIndex === null) {
    throw new Error("Anvil returned a pending log in a mined receipt.");
  }
  return {
    chainId: CHAIN_ID.toString(),
    address: log.address as IndexerHex,
    topics: log.topics as readonly IndexerHex[],
    data: log.data as IndexerHex,
    blockNumber: log.blockNumber.toString(),
    blockHash: log.blockHash as IndexerHex,
    txHash: log.transactionHash as IndexerHex,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  };
}

async function headers(from: bigint, through: bigint): Promise<ChainHeader[]> {
  const client = publicClient();
  const result: ChainHeader[] = [];
  for (let number = from; number <= through; number += 1n) {
    const block = await client.getBlock({ blockNumber: number });
    result.push({
      blockNumber: number.toString(),
      blockHash: block.hash,
      parentHash: block.parentHash,
      blockTimestamp: block.timestamp.toString(),
    });
  }
  return result;
}

async function buildIndexer(params: {
  contract: Address;
  deploymentReceipt: TransactionReceipt;
  mintReceipt: TransactionReceipt;
  authorization: DurableMintAuthorizationEvidence;
  signatureId: string;
}): Promise<IndexerState> {
  const config: DeploymentIndexConfig = {
    deploymentId: "local-anvil-31337",
    chainId: CHAIN_ID.toString(),
    contract: params.contract,
    deploymentBlockNumber: params.deploymentReceipt.blockNumber.toString(),
    abiVersion: FROZEN_GALLERY_ABI_VERSION,
    mintTopic: SIGNATURE_MINTED_TOPIC,
    transferTopic: ERC721_TRANSFER_TOPIC,
  };
  const raw = [...params.deploymentReceipt.logs, ...params.mintReceipt.logs]
    .filter((log) => getAddress(log.address) === params.contract)
    .map((log) => rawLog(log.transactionHash === params.deploymentReceipt.transactionHash ? params.deploymentReceipt : params.mintReceipt, log));
  const decoded: CandidateContractLog[] = [];
  for (const item of raw) {
    const event = decodeRawGalleryLog(config, item);
    if (!event) continue;
    if (event.kind === "signature_minted") {
      decoded.push(attachMintValidation(event, {
        staticProvenance: { status: "valid" },
        executionControl: { status: "valid" },
        tokenURI: { status: "valid" },
        artifactIntegrity: { status: "valid" },
        authorization: { status: "valid", record: params.authorization },
      }));
    } else {
      decoded.push(event);
    }
  }
  const blockHeaders = await headers(params.deploymentReceipt.blockNumber, params.mintReceipt.blockNumber);
  let state = applyScanBatch(createIndexerState(config), {
    savedCheckpointFromPrimary: null,
    savedCheckpointFromSecondary: null,
    headers: blockHeaders,
    logs: decoded,
    receipts: [
      receiptInput(params.deploymentReceipt),
      receiptInput(params.mintReceipt, { signatureId: params.signatureId, authorizationId: params.authorization.authorizationId }),
    ],
  });
  const boundary = blockHeaders.at(-1)!;
  state = promoteFinalized(state, {
    primaryFinalizedHeight: boundary.blockNumber,
    secondaryFinalizedHeight: boundary.blockNumber,
    promotionBlockFromPrimary: { blockNumber: boundary.blockNumber, blockHash: boundary.blockHash },
    promotionBlockFromSecondary: { blockNumber: boundary.blockNumber, blockHash: boundary.blockHash },
    savedCheckpointFromPrimary: null,
    savedCheckpointFromSecondary: null,
    promotedAt: new Date().toISOString(),
  });
  if (state.health !== "running" || state.promotionBlockage || state.galleryEntries.length !== 1) {
    throw new Error(`Local indexer did not finalize exactly one Gallery entry: ${JSON.stringify({
      health: state.health,
      blockage: state.promotionBlockage,
      aggregates: state.aggregates,
      control: state.controlState,
    })}`);
  }
  return state;
}

async function deployMintAndPersist(
  pool: ReturnType<typeof createPostgresPool>,
  store: PostgresSignatureStore,
  artifacts: FileArtifactStore,
  state: LocalPostgresState,
): Promise<RuntimeRecord> {
  state.assertExclusiveWriter();
  await assertLocalChain();
  assertRoleSeparation();
  ensureExecutable(FORGE_BIN, "Forge");
  run(FORGE_BIN, ["build", "--offline"], { cwd: resolve(REPO_ROOT, "contracts") });
  const artifact = galleryArtifact();
  if (keccak256(new TextEncoder().encode(COLLECTION.uri)) !== COLLECTION.uriHash) {
    throw new Error("Frozen local collection URI commitment is internally inconsistent.");
  }
  const deployer = createWalletClient({ account: ROLE_ACCOUNTS.deployer, chain: localChain, transport: http(RPC_URL, LOCAL_RPC_HTTP_OPTIONS) });
  const deploymentTransaction = await deployer.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [
      COLLECTION.name,
      COLLECTION.symbol,
      COLLECTION.uri,
      COLLECTION.metadataSha256,
      COLLECTION.uriHash,
      COLLECTION.defaultAdminDelay,
      ROLE_ACCOUNTS.delayedAdmin.address,
      ROLE_ACCOUNTS.authorizerManager.address,
      ROLE_ACCOUNTS.pauser.address,
      ROLE_ACCOUNTS.authorizationRevoker.address,
      ROLE_ACCOUNTS.initialAuthorizer.address,
    ],
  });
  const client = publicClient();
  const deploymentReceipt = await client.waitForTransactionReceipt({ hash: deploymentTransaction });
  if (deploymentReceipt.status !== "success" || !deploymentReceipt.contractAddress) throw new Error("Local contract deployment reverted.");
  const contract = getAddress(deploymentReceipt.contractAddress);
  const code = await client.getCode({ address: contract });
  if (!code || code === "0x") throw new Error("Local deployment returned no runtime code.");
  const runtimeCodeHash = keccak256(code);
  await validateDeployment(contract, artifact.abi, runtimeCodeHash);

  const signatures = await store.listSignaturesForAccount("1234567890123456789");
  const signature = signatures.sort((left, right) => left.claimedAt.getTime() - right.claimedAt.getTime())[0];
  const account = await store.getAccount("1234567890123456789");
  if (!signature || !account) throw new Error("Durable V1 fixtures were not seeded.");
  const latest = await client.getBlock();
  const mintStore = new MemoryMintStore();
  const bindingId = `0x${"61".repeat(32)}` as Hex;
  mintStore.seedBinding({
    walletBindingId: bindingId,
    xUserId: account.xUserId,
    publicAccountId: account.publicAccountId,
    chainId: CHAIN_ID,
    address: ROLE_ACCOUNTS.mintWallet.address,
    siweMessage: "Local Anvil fixture binding; no reusable proof credential.",
    walletProof: `0x${"00".repeat(65)}`,
    verificationScheme: "fixture_seed",
    verificationBlockNumber: latest.number,
    verificationBlockHash: latest.hash,
    provedAt: new Date(Number(latest.timestamp) * 1_000),
    status: "active",
    version: 1,
  });
  const signer: GallerySigner = {
    address: ROLE_ACCOUNTS.initialAuthorizer.address,
    async sign(_authorizationId, _digest, authorization, config) {
      return ROLE_ACCOUNTS.initialAuthorizer.signTypedData(
        mintAuthorizationTypedData({ chainId: config.chainId, verifyingContract: config.contract }, authorization),
      );
    },
  };
  const config = mintConfig(contract, runtimeCodeHash);
  const service = new V2MintService(config, mintStore, store, artifacts, { signer });
  const authorizationResponse = await service.issueAuthorization(
    signature,
    account,
    new Date(Number(latest.timestamp) * 1_000),
  );
  const mintWallet = createWalletClient({ account: ROLE_ACCOUNTS.mintWallet, chain: localChain, transport: http(RPC_URL, LOCAL_RPC_HTTP_OPTIONS) });
  const mintTransaction = await mintWallet.sendTransaction({
    to: authorizationResponse.transaction.to,
    data: authorizationResponse.transaction.data,
    value: 0n,
  });
  const mintReceipt = await client.waitForTransactionReceipt({ hash: mintTransaction });
  if (mintReceipt.status !== "success") throw new Error("Local seeded mint reverted.");
  const decodedMint = mintReceipt.logs
    .filter((log) => getAddress(log.address) === contract)
    .map((log) => decodeRawGalleryLog({
      deploymentId: "local-anvil-31337",
      chainId: CHAIN_ID.toString(),
      contract,
      deploymentBlockNumber: deploymentReceipt.blockNumber.toString(),
      abiVersion: FROZEN_GALLERY_ABI_VERSION,
      mintTopic: SIGNATURE_MINTED_TOPIC,
      transferTopic: ERC721_TRANSFER_TOPIC,
    }, rawLog(mintReceipt, log)))
    .find((log) => log?.kind === "signature_minted");
  if (!decodedMint || decodedMint.kind !== "signature_minted") throw new Error("Seeded mint emitted no decodable SignatureMinted event.");

  const storedAuthorization = mintStore.getAuthorization(authorizationResponse.authorization.authorizationId);
  if (!storedAuthorization) throw new Error("Local authorization was not retained.");
  const tokenUri = await client.readContract({ address: contract, abi: artifact.abi, functionName: "tokenURI", args: [BigInt(decodedMint.event.tokenId)] });
  if (tokenUri !== storedAuthorization.tokenUri) throw new Error("On-chain token URI differs from the durable authorization.");
  for (const [key, expected] of [[signature.svgStorageKey, signature.svgSha256], [signature.cardStorageKey, signature.pngSha256]] as const) {
    const bytes = await artifacts.get(key);
    if (!bytes || sha256Hex(bytes) !== expected) throw new Error(`Seeded V1 artifact ${key} failed integrity verification.`);
  }

  mintStore.observeSubmitted(signature.signatureId, storedAuthorization.authorizationId, mintTransaction);
  mintStore.observeIncluded({
    signatureId: signature.signatureId,
    authorizationId: storedAuthorization.authorizationId,
    txHash: mintTransaction,
    contract,
    chainId: CHAIN_ID,
    tokenId: BigInt(decodedMint.event.tokenId),
    mintWallet: getAddress(decodedMint.event.mintWallet),
    blockNumber: mintReceipt.blockNumber,
    transactionIndex: mintReceipt.transactionIndex,
    logIndex: decodedMint.logIndex,
  });
  mintStore.finalizeMint(signature.signatureId, new Date(), "Local Anvil manual finality promotion; single node");

  const evidence: DurableMintAuthorizationEvidence = {
    signatureId: storedAuthorization.signatureId,
    signatureDigest: storedAuthorization.signatureDigest,
    walletBindingId: storedAuthorization.walletBindingId,
    mintWallet: storedAuthorization.mintWallet,
    svgSha256: storedAuthorization.svgSha256,
    pngSha256: storedAuthorization.pngSha256,
    metadataSha256: storedAuthorization.metadataSha256,
    tokenURIHash: storedAuthorization.tokenUriHash,
    authorizationId: storedAuthorization.authorizationId,
    authorizerEpoch: storedAuthorization.authorizerEpoch,
    authorizer: storedAuthorization.authorizer,
    typedDataDigest: storedAuthorization.typedDataDigest,
  };
  const indexer = await buildIndexer({ contract, deploymentReceipt, mintReceipt, authorization: evidence, signatureId: signature.signatureId });
  await state.saveRuntime(mintStore, indexer);
  await pool.query(
    `INSERT INTO local_rehearsal.chain_runs (
       run_name, chain_id, rpc_url, contract_address, deployment_transaction,
       deployment_block_number, deployment_block_hash, runtime_code_hash,
       seeded_mint_transaction, seeded_signature_id, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT (run_name) DO UPDATE SET
       chain_id = EXCLUDED.chain_id,
       rpc_url = EXCLUDED.rpc_url,
       contract_address = EXCLUDED.contract_address,
       deployment_transaction = EXCLUDED.deployment_transaction,
       deployment_block_number = EXCLUDED.deployment_block_number,
       deployment_block_hash = EXCLUDED.deployment_block_hash,
       runtime_code_hash = EXCLUDED.runtime_code_hash,
       seeded_mint_transaction = EXCLUDED.seeded_mint_transaction,
       seeded_signature_id = EXCLUDED.seeded_signature_id,
       updated_at = now()`,
    [
      RUN_NAME,
      CHAIN_ID.toString(),
      RPC_URL,
      hexToBuffer(contract),
      hexToBuffer(deploymentTransaction),
      deploymentReceipt.blockNumber.toString(),
      hexToBuffer(deploymentReceipt.blockHash),
      hexToBuffer(runtimeCodeHash),
      hexToBuffer(mintTransaction),
      signature.signatureId,
    ],
  );
  return {
    schemaVersion: 1,
    localOnly: true,
    postgresUrl: DATABASE_URL,
    rpcUrl: RPC_URL,
    chainId: "31337",
    roleAccounts: Object.fromEntries(Object.entries(ROLE_ACCOUNTS).map(([name, accountValue]) => [name, accountValue.address])),
    contract,
    deploymentTransaction,
    deploymentBlockNumber: deploymentReceipt.blockNumber.toString(),
    runtimeCodeHash,
    seededMintTransaction: mintTransaction,
    seededSignatureId: signature.signatureId,
    seededTokenId: signatureTokenId(signature.signatureId).toString(),
  };
}

async function runtimeFromExisting(row: ChainRunRow): Promise<RuntimeRecord> {
  if (!row.seeded_mint_transaction || !row.seeded_signature_id) throw new Error("Local chain run is incomplete; use local:reset.");
  return {
    schemaVersion: 1,
    localOnly: true,
    postgresUrl: DATABASE_URL,
    rpcUrl: RPC_URL,
    chainId: "31337",
    roleAccounts: Object.fromEntries(Object.entries(ROLE_ACCOUNTS).map(([name, accountValue]) => [name, accountValue.address])),
    contract: getAddress(bufferToHex(row.contract_address)),
    deploymentTransaction: bufferToHex(row.deployment_transaction),
    deploymentBlockNumber: row.deployment_block_number,
    runtimeCodeHash: bufferToHex(row.runtime_code_hash),
    seededMintTransaction: bufferToHex(row.seeded_mint_transaction),
    seededSignatureId: row.seeded_signature_id,
    seededTokenId: signatureTokenId(row.seeded_signature_id).toString(),
  };
}

async function verify(): Promise<RuntimeRecord> {
  if (!postgresRunning()) throw new Error("Local PostgreSQL is not running. Run npm run local:up.");
  assertV2MigrationChecksum();
  await assertLocalChain();
  const pool = createPostgresPool(DATABASE_URL);
  try {
    const row = await readChainRun(pool);
    if (!row) throw new Error("No local chain run is recorded. Run npm run local:up.");
    if (row.chain_id !== CHAIN_ID.toString() || row.rpc_url !== RPC_URL) throw new Error("Recorded local chain identity is inconsistent.");
    const runtime = await runtimeFromExisting(row);
    const artifact = galleryArtifact();
    await validateDeployment(runtime.contract, artifact.abi, runtime.runtimeCodeHash);
    const [signatureCount, fixtureCount, artifactCount, referencedSignatureCount, artifactReferences] = await Promise.all([
      pool.query<{ count: string }>("SELECT count(*)::text AS count FROM signatures"),
      pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM signatures
          WHERE x_user_id = '1234567890123456789'
            AND renderer_version = 'sg-renderer-1.0.0'
            AND gr0k_raw IN (12, 37, 82)`,
      ),
      pool.query<{ count: string }>("SELECT count(*)::text AS count FROM local_rehearsal.artifact_references"),
      pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM signatures signature
          WHERE EXISTS (
                  SELECT 1 FROM local_rehearsal.artifact_references ref
                   WHERE ref.signature_id = signature.signature_id
                     AND ref.artifact_kind = 'svg'
                     AND ref.storage_key = signature.svg_storage_key
                     AND ref.sha256 = signature.svg_sha256
                )
            AND EXISTS (
                  SELECT 1 FROM local_rehearsal.artifact_references ref
                   WHERE ref.signature_id = signature.signature_id
                     AND ref.artifact_kind = 'png'
                     AND ref.storage_key = signature.card_storage_key
                     AND ref.sha256 = signature.png_sha256
                )`,
      ),
      pool.query<{ storage_key: string; sha256: string; byte_length: string }>(
        "SELECT storage_key, sha256, byte_length::text AS byte_length FROM local_rehearsal.artifact_references",
      ),
    ]);
    const totalSignatures = Number(signatureCount.rows[0]?.count ?? "0");
    const totalArtifactReferences = Number(artifactCount.rows[0]?.count ?? "0");
    if (fixtureCount.rows[0]?.count !== "3") throw new Error(`Expected all 3 seeded V1 signatures, found ${fixtureCount.rows[0]?.count ?? "none"}.`);
    // The foreground durable app may add legitimate local claims after reset.
    if (totalSignatures < 3) throw new Error(`Expected at least 3 durable V1 signatures, found ${totalSignatures}.`);
    if (totalArtifactReferences < totalSignatures * 2) {
      throw new Error(`Expected at least two durable artifact references per V1 signature, found ${totalArtifactReferences} for ${totalSignatures}.`);
    }
    if (Number(referencedSignatureCount.rows[0]?.count ?? "0") !== totalSignatures) {
      throw new Error("At least one durable V1 signature is missing its exact SVG or PNG ledger reference.");
    }
    const fileStore = new FileArtifactStore(ARTIFACT_ROOT);
    for (const reference of artifactReferences.rows) {
      const bytes = await fileStore.get(reference.storage_key);
      if (
        !bytes
        || sha256Hex(bytes) !== reference.sha256
        || BigInt(bytes.byteLength) !== BigInt(reference.byte_length)
      ) {
        throw new Error(`Durable artifact ${reference.storage_key} is missing or does not match its PostgreSQL reference.`);
      }
    }
    const client = publicClient();
    const receipt = await client.getTransactionReceipt({ hash: runtime.seededMintTransaction });
    if (receipt.status !== "success") throw new Error("Recorded local mint did not succeed.");
    const durable = new LocalPostgresState(pool);
    const { mintStore, indexer } = await durable.loadRuntime();
    const plan = rehearsalMintVerificationPlan(mintStore, indexer, runtime.seededSignatureId);
    const checkpoint = await client.getBlock({ blockNumber: plan.blockNumber });
    if (checkpoint.hash !== plan.blockHash) {
      throw new Error("The promoted local checkpoint no longer matches Anvil. Preserve both states and investigate the chain mismatch.");
    }
    for (const token of plan.tokens) {
      const owner = await client.readContract({
        address: runtime.contract,
        abi: artifact.abi,
        functionName: "ownerOf",
        args: [token.tokenId],
        blockNumber: plan.blockNumber,
      });
      if (getAddress(String(owner)) !== token.currentHolder) {
        throw new Error(`Token ${token.tokenId} holder differs from its promoted checkpoint. Preserve state for reconciliation.`);
      }
    }
    return runtime;
  } finally {
    await pool.end();
  }
}

async function up(): Promise<RuntimeRecord> {
  ensureLocalRootIsSafe();
  mkdirSync(LOCAL_ROOT, { recursive: true });
  ensurePostgres();
  const pool = createPostgresPool(DATABASE_URL);
  const state = new LocalPostgresState(pool);
  let release: (() => Promise<void>) | undefined;
  try {
    // Own the writer before migrations, fixture replay, node startup, or any
    // chain transaction. A live local:serve process causes immediate refusal.
    release = await state.acquireExclusiveWriter();
    migrateDatabase();
    await ensureAnvil();
    await assertLocalChain();
    const { store, artifacts } = await seedV1(pool);
    const prior = await readChainRun(pool);
    let runtime: RuntimeRecord;
    if (prior) {
      runtime = await runtimeFromExisting(prior);
      const code = await publicClient().getCode({ address: runtime.contract });
      if (!code || code === "0x" || keccak256(code) !== runtime.runtimeCodeHash) {
        throw new Error("PostgreSQL and persisted Anvil state disagree; use npm run local:reset.");
      }
    } else {
      runtime = await deployMintAndPersist(pool, store, artifacts, state);
    }
    writeFileSync(RUNTIME_FILE, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
    return await verify();
  } finally {
    try { await release?.(); } finally { await pool.end(); }
  }
}

/** Refuse lifecycle changes while the browser server owns durable mint state. */
async function withExistingWriter<T>(operation: () => T | Promise<T>): Promise<T> {
  if (!postgresRunning()) return operation();
  const exists = run(postgres("psql"), [
    "-h", "127.0.0.1", "-p", String(POSTGRES_PORT), "-U", DATABASE_USER,
    "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc",
    `SELECT 1 FROM pg_database WHERE datname = '${DATABASE_NAME}'`,
  ], { quiet: true });
  if (exists !== "1") return operation();
  const pool = createPostgresPool(DATABASE_URL);
  const state = new LocalPostgresState(pool);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await state.acquireExclusiveWriter();
    return await operation();
  } finally {
    try {
      await release?.();
    } catch (error) {
      // stop/reset intentionally close PostgreSQL and therefore the lease.
      if (postgresRunning()) throw error;
    } finally {
      await pool.end();
    }
  }
}

async function reset(): Promise<RuntimeRecord> {
  ensureLocalRootIsSafe();
  await withExistingWriter(async () => {
    await stopAnvil();
    stopPostgres();
    rmSync(LOCAL_ROOT, { recursive: true, force: true });
  });
  return up();
}

async function stop(): Promise<{ anvil: boolean; postgres: boolean }> {
  ensureLocalRootIsSafe();
  return withExistingWriter(async () => {
    const anvil = await stopAnvil();
    const postgresStopped = stopPostgres();
    return { anvil, postgres: postgresStopped };
  });
}

async function status(): Promise<Record<string, unknown>> {
  const postgresUp = postgresRunning();
  let anvilUp = false;
  let chainId: number | null = null;
  if (anvilRunning()) {
    try {
      chainId = await publicClient().getChainId();
      anvilUp = chainId === Number(CHAIN_ID);
    } catch {
      anvilUp = false;
    }
  }
  let run: RuntimeRecord | null = null;
  if (postgresUp) {
    const pool = createPostgresPool(DATABASE_URL);
    try {
      const row = await readChainRun(pool).catch(() => null);
      run = row ? await runtimeFromExisting(row) : null;
    } finally {
      await pool.end();
    }
  }
  return { postgres: postgresUp, anvil: anvilUp, observedChainId: chainId, expectedChainId: 31_337, runtime: run };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "up":
      console.log(JSON.stringify(await up(), null, 2));
      break;
    case "reset":
      console.log(JSON.stringify(await reset(), null, 2));
      break;
    case "verify":
      console.log(JSON.stringify({ verified: true, ...(await verify()) }, null, 2));
      break;
    case "status":
      console.log(JSON.stringify(await status(), null, 2));
      break;
    case "stop":
      console.log(JSON.stringify(await stop(), null, 2));
      break;
    default:
      throw new Error("Usage: rehearsalCli.ts <up|reset|verify|status|stop>");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
