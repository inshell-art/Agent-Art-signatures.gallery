import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, keccak256, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { startServer, type AppOptions } from "../api/server.js";
import { MemoryAuthState } from "../v1/authState.js";
import { FileArtifactStore } from "../v1/fileArtifactStore.js";
import { signatureIdentityPayload } from "../v1/identity.js";
import { CARD_RENDERER_VERSION, RENDERER_VERSION, formalSignatureRenderer, RendererRegistry, sha256Hex } from "../v1/renderer.js";
import type { MintConfig } from "../v2/config.js";
import { mintAuthorizationDigest, mintAuthorizationTypedData } from "../v2/core/mintAuthorization.js";
import { signatureDigestHex } from "../v2/core/signatureId.js";
import { V2Error } from "../v2/errors.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { V2MintService } from "../v2/service.js";
import { createPostgresPool, PostgresArtifactLedger, PostgresSignatureStore } from "../store/postgresStore.js";
import { LocalPostgresState } from "./postgresState.js";
import { LocalMintRuntime } from "./mintRuntime.js";
import { createLocalClaimWithdrawalRunner } from "./claimWithdrawalRuntime.js";
import { createLocalChainReconciler } from "./chainReconciler.js";
import { assertOwnedAnvil, validateLocalRuntime } from "./runtimeGuards.js";
import { LocalTestWallet } from "./wallet.js";
import { loadLocalAppConfig, localXOAuthClient } from "./xAuthConfig.js";
import { LOCAL_RPC_HTTP_OPTIONS, LOCAL_RPC_TIMEOUT_MS } from "./nodePolicy.js";

const appConfig = loadLocalAppConfig(process.env, process.argv.slice(2));
const oauthClient = localXOAuthClient(appConfig);
const { port, appOrigin } = appConfig;
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const runtime = validateLocalRuntime(JSON.parse(readFileSync(resolve(repoRoot, ".local/rehearsal/runtime.json"), "utf8")));
assertOwnedAnvil(repoRoot, runtime.rpcUrl);
// Guards and the indexer share the same bounded snapshot-aware RPC policy.
const chain = createPublicClient({ transport: http(runtime.rpcUrl, LOCAL_RPC_HTTP_OPTIONS) });
const pool = createPostgresPool(runtime.postgresUrl);
// Avoid an unhandled idle-connection event; active ownership failures are handled below.
pool.on("error", () => console.error("Local PostgreSQL connection unavailable."));
const durable = new LocalPostgresState(pool);
const releaseWriter = await durable.acquireExclusiveWriter();
await pool.query(readFileSync(new URL("../store/migrations/003_claim_withdrawal.sql", import.meta.url), "utf8"));
await pool.query(readFileSync(new URL("../store/migrations/004_formal_algorithm.sql", import.meta.url), "utf8"));
await pool.query(readFileSync(new URL("../store/migrations/005_action_auth_policy.sql", import.meta.url), "utf8"));
const mintState = await durable.loadMintStore();
let indexer = await durable.loadIndexer();
if (!indexer) throw new Error("No durable local indexer snapshot. Run npm run local:up.");
const evidence = await pool.query<{ deployment_block_hash: Buffer; contract_address: Buffer; runtime_code_hash: Buffer }>(
  "SELECT deployment_block_hash, contract_address, runtime_code_hash FROM local_rehearsal.chain_runs WHERE run_name = 'default'",
);
if (evidence.rowCount !== 1) throw new Error("Missing durable local deployment evidence.");
const recorded = evidence.rows[0]!;
const deploymentBlockHash = ("0x" + recorded.deployment_block_hash.toString("hex")) as Hex;
if (getAddress("0x" + recorded.contract_address.toString("hex")) !== getAddress(runtime.contract)
  || "0x" + recorded.runtime_code_hash.toString("hex") !== runtime.runtimeCodeHash) throw new Error("Local runtime disagrees with persisted deployment evidence.");
const genesis = await chain.getBlock({ blockNumber: 0n });

async function assertChain(): Promise<void> {
  assertOwnedAnvil(repoRoot, runtime.rpcUrl);
  const [chainId, observedGenesis, deployment, code] = await Promise.all([
    chain.getChainId(), chain.getBlock({ blockNumber: 0n }),
    chain.getBlock({ blockNumber: BigInt(runtime.deploymentBlockNumber) }),
    chain.getCode({ address: runtime.contract }),
  ]);
  if (chainId !== 31337 || observedGenesis.hash !== genesis.hash || deployment.hash !== deploymentBlockHash
    || !code || code === "0x" || keccak256(code) !== runtime.runtimeCodeHash) {
    throw new V2Error(503, "CHAIN_SAFETY_HALT", "Local Anvil chain or contract evidence changed.");
  }
}
await assertChain();
const seedReceipt = await chain.getTransactionReceipt({ hash: runtime.seededMintTransaction });
if (seedReceipt.status !== "success") throw new Error("The recorded local seed mint is unavailable.");
// Public Anvil test key only; no environment-variable private key is accepted.
const authorizer = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 5 });
if (authorizer.address !== getAddress(runtime.roleAccounts.initialAuthorizer)) throw new Error("The local authorizer is not the recorded public test role.");
const store = new PostgresSignatureStore(pool);
const artifacts = new FileArtifactStore(resolve(repoRoot, ".local/rehearsal/artifacts"), new PostgresArtifactLedger(pool));
const queue = new LocalMintRuntime({
  assertOwnership: () => durable.assertExclusiveWriter(),
  persist: () => durable.saveRuntime(mintState, indexer!),
});
const reconciler = createLocalChainReconciler({
  rpcUrl: runtime.rpcUrl, contract: runtime.contract, runtimeCodeHash: runtime.runtimeCodeHash,
  deploymentBlockHash, expectedAuthorizer: authorizer.address,
  async verifyArtifacts(authorization, metadata) {
    const signature = await store.getSignature(authorization.signatureId);
    if (!signature) return false;
    const payload = signatureIdentityPayload({
      xUserId: signature.xUserId, handleAtClaim: signature.handleAtClaim,
      gr0kRaw: signature.gr0kRaw, gr0kScale: signature.gr0kScale, rendererVersion: signature.rendererVersion,
    });
    if (signatureDigestHex(signature.signatureId) !== "0x" + createHash("sha256").update(payload).digest("hex")) return false;
    const [svg, png] = await Promise.all([artifacts.get(signature.svgStorageKey), artifacts.get(signature.cardStorageKey)]);
    return !!svg && !!png && sha256Hex(svg) === signature.svgSha256 && sha256Hex(png) === signature.pngSha256
      && metadata.svgSha256 === "0x" + signature.svgSha256 && metadata.pngSha256 === "0x" + signature.pngSha256
      && authorization.svgSha256 === metadata.svgSha256 && authorization.pngSha256 === metadata.pngSha256;
  },
});
let chainHealth: "ready" | "blocked" = "blocked";
let chainReason: string | null = "LOCAL_STARTING";
async function reconcile(): Promise<void> {
  assertOwnedAnvil(repoRoot, runtime.rpcUrl);
  const result = await reconciler.tick({ mintSnapshot: mintState.exportSnapshot(), indexer: indexer! });
  // A cursor and its public projection must become durable together, before readers see either.
  await durable.saveRuntime(MemoryMintStore.fromSnapshot(result.mintSnapshot), result.indexer);
  mintState.replaceSnapshot(result.mintSnapshot);
  indexer = result.indexer;
  if (chainReason !== result.code) console.log(result.health === "ready" ? "Local Anvil indexer caught up." : "Local minting paused: " + result.code);
  chainHealth = result.health;
  chainReason = result.code;
}
async function requireChainReady(): Promise<void> {
  await reconcile();
  if (chainHealth !== "ready") throw new V2Error(503, "CHAIN_UNAVAILABLE", "The local chain is temporarily unavailable. Please try again shortly.");
}
const runMintOperation: NonNullable<AppOptions["runMintOperation"]> = (operation) => queue.run(async () => {
  await requireChainReady();
  return operation();
});
const runClaimWithdrawalOperation = createLocalClaimWithdrawalRunner({ queue, mintState, requireChainReady });
const config: MintConfig = {
  enabled: true, fixtureMode: false, localChainRehearsal: true,
  chainId: 31_337n, chainName: "Local Anvil 31337",
  contract: getAddress(runtime.contract), eip712Name: "signatures.gallery", eip712Version: "2",
  authorizationTtlSeconds: 900, maxAuthorizationWindowSeconds: 1_800,
  authorizerEpoch: 1, authorizer: authorizer.address,
  publicArtifactOrigin: appOrigin, appOrigin, appHost: new URL(appOrigin).host,
  explorerBaseUrl: null, genesisHash: genesis.hash, runtimeCodeHash: runtime.runtimeCodeHash,
  primaryRpcUrl: runtime.rpcUrl, secondaryRpcUrl: runtime.rpcUrl,
};
const mint = new V2MintService(config, mintState, store, artifacts, {
  checkpoint: () => queue.checkpoint(),
  async latestCanonicalTimestamp() { await assertChain(); return (await chain.getBlock()).timestamp; },
  eoaVerifier: {
    async verify(address, chainId) {
      if (chainId !== 31337n) throw new V2Error(400, "WRONG_CHAIN", "Use local Anvil 31337.");
      await assertChain();
      const before = await chain.getBlock();
      const code = await chain.getCode({ address, blockNumber: before.number });
      const after = await chain.getBlock({ blockNumber: before.number });
      if (before.hash !== after.hash) throw new V2Error(503, "WALLET_RPC_UNAVAILABLE", "Local chain changed during wallet proof.");
      if (code && code !== "0x") throw new V2Error(422, "WALLET_UNSUPPORTED", "Use an EOA test wallet with no deployed code.");
      return { blockNumber: before.number, blockHash: before.hash };
    },
  },
  signer: {
    address: authorizer.address,
    async sign(_id, digest, authorization, mintConfig) {
      await assertChain();
      if (mintConfig.chainId !== 31337n || mintConfig.contract !== config.contract
        || mintAuthorizationDigest({ chainId: 31337n, verifyingContract: config.contract }, authorization) !== digest) throw new Error("Local signer input mismatch.");
      return authorizer.signTypedData(mintAuthorizationTypedData({ chainId: 31337n, verifyingContract: config.contract }, authorization));
    },
  },
});

async function mining(method: "anvil_mine" | "anvil_setIntervalMining", params: unknown[]) {
  await assertChain();
  const response = await fetch(runtime.rpcUrl, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(LOCAL_RPC_TIMEOUT_MS),
    headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json() as { error?: unknown };
  if (!response.ok || body.error) throw new Error("Could not configure owned local Anvil mining.");
}
// Keep authorization time and expiry advancing while the interactive app is open.
await mining("anvil_mine", ["0x1"]);
await mining("anvil_setIntervalMining", [2]);
await queue.run(async () => {
  await reconcile();
  // The old CLI seed remains provenance, but never stands in for a new wallet proof.
  for (const [, binding] of mintState.exportSnapshot().bindingsById) {
    if (binding.status === "active" && binding.verificationScheme === "fixture_seed") {
      mintState.revokeBinding(binding.xUserId, binding.chainId);
    }
  }
});
const wallet = new LocalTestWallet({ rpcUrl: runtime.rpcUrl, contract: config.contract, runtimeCodeHash: runtime.runtimeCodeHash, appOrigin, assertLocalGuard: assertChain });
const server = startServer({ store, artifacts, auth: new MemoryAuthState(), renderers: new RendererRegistry([formalSignatureRenderer]), mint }, port, {
  fixtureMode: true, localChainRehearsal: true, activeRendererVersion: RENDERER_VERSION,
  cardRendererVersion: CARD_RENDERER_VERSION, publicOrigin: appOrigin, runMintOperation, runClaimWithdrawalOperation, localWallet: wallet,
  oauthClient, identityDailyCallLimit: appConfig.identityDailyCallLimit, enforcePublicOrigin: true,
});
server.once("listening", () => {
  console.log("Interactive local rehearsal listening on " + appOrigin);
  console.log(appConfig.authMode === "real" ? "X sign-in uses real X OAuth. Simulator endpoints are disabled." : "X sign-in uses the local simulator. No X account is authenticated.");
  console.log("Real Anvil transactions; public TEST wallet keys. IPFS is unpublished; confirmation is single-node only. Seeded accounts remain simulated.");
});
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
async function poll() {
  try { await queue.run(reconcile); }
  catch {
    chainHealth = "blocked";
    chainReason = "LOCAL_RUNTIME_UNAVAILABLE";
    console.error("Local reconciliation unavailable; mint writes fail closed.");
  }
  if (!stopping) timer = setTimeout(() => void poll(), 1_000);
}
timer = setTimeout(() => void poll(), 1_000);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeIdleConnections(); });
  try {
    await queue.settleForShutdown(() => mining("anvil_setIntervalMining", [0]), requireChainReady);
  } catch {
    // Never invent a caught-up checkpoint or reset a chain we cannot verify.
    console.error("Local shutdown could not settle the chain checkpoint. Preserve both saved states and verify before minting.");
  }
  await releaseWriter();
  await pool.end();
  await oauthClient?.close();
}
server.once("error", (error) => {
  console.error("Local rehearsal listen failed: " + error.message);
  void shutdown().finally(() => process.exit(1));
});
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
