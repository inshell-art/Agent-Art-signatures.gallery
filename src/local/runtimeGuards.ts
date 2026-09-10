import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { getAddress, type Address, type Hex } from "viem";

export interface LocalRuntimeRecord {
  schemaVersion: 1;
  localOnly: true;
  postgresUrl: string;
  rpcUrl: string;
  chainId: "31337";
  roleAccounts: { initialAuthorizer: Address; mintWallet: Address };
  contract: Address;
  runtimeCodeHash: Hex;
  deploymentTransaction: Hex;
  deploymentBlockNumber: string;
  seededMintTransaction: Hex;
  seededTokenId: string;
}

export function validateLocalRuntime(value: unknown): LocalRuntimeRecord {
  if (!value || typeof value !== "object") throw new Error("Missing local runtime record.");
  const runtime = value as LocalRuntimeRecord;
  if (runtime.schemaVersion !== 1 || runtime.localOnly !== true || runtime.chainId !== "31337") throw new Error("Expected a local Anvil 31337 runtime record.");
  const rpc = new URL(runtime.rpcUrl);
  if (rpc.protocol !== "http:" || rpc.hostname !== "127.0.0.1" || rpc.username || rpc.password || rpc.pathname !== "/" || rpc.search || rpc.hash || !rpc.port) throw new Error("Local RPC must be a plain explicit-port 127.0.0.1 HTTP origin.");
  const database = new URL(runtime.postgresUrl);
  if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" || !database.port || database.search || database.hash) throw new Error("Local PostgreSQL must stay on explicit-port loopback.");
  for (const address of [runtime.contract, runtime.roleAccounts?.initialAuthorizer, runtime.roleAccounts?.mintWallet]) getAddress(address);
  for (const hash of [runtime.runtimeCodeHash, runtime.deploymentTransaction, runtime.seededMintTransaction]) {
    if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("Local runtime has invalid chain evidence.");
  }
  for (const number of [runtime.deploymentBlockNumber, runtime.seededTokenId]) {
    if (typeof number !== "string" || !/^(0|[1-9][0-9]*)$/.test(number)) throw new Error("Local runtime has invalid numeric evidence.");
  }
  return runtime;
}

export function assertOwnedAnvil(repoRoot: string, rpcUrl: string): void {
  const port = new URL(rpcUrl).port;
  const pid = readFileSync(resolve(repoRoot, ".local/rehearsal/anvil/anvil.pid"), "utf8").trim();
  if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("Missing owned Anvil process.");
  const command = execFileSync("/bin/ps", ["-p", pid, "-o", "command="], { encoding: "utf8", timeout: 2_000 });
  if (!command.includes("anvil") || !command.includes(`--port ${port} `)
    || !command.includes("--host 127.0.0.1 ") || !command.includes("--chain-id 31337 ")
    || !command.includes(`--state ${resolve(repoRoot, ".local/rehearsal/anvil/state.json")}`)) {
    throw new Error("The local RPC is not this repository's owned Anvil process.");
  }
}
