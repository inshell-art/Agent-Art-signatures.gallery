import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { createPublicClient, createWalletClient, http, keccak256, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { OPEN_MINT_ABI } from "./authorization.js";
import { createLocalOpenMintNetwork, type OpenMintNetwork, type OpenMintTransaction } from "./network.js";
import { FileKeyValueStore } from "./storage.js";

// Public Foundry test mnemonic. Never use these accounts outside this isolated local node.
const mnemonic = "test test test test test test test test test test test junk";
const account = (index: number) => mnemonicToAccount(mnemonic, { addressIndex: index });
export const localTestMinter = (): { address: Address; signMessage: (input: { message: string }) => Promise<Hex> } => account(6);

export interface IsolatedLocalChain {
  network: OpenMintNetwork;
  rpcUrl: string;
  send: (transaction: OpenMintTransaction) => Promise<Hex>;
  close: () => Promise<void>;
}

/** Owns a separate node, state file and deployment. Never attaches to or resets an existing listener. */
export async function startIsolatedLocalChain(options: { directory: string; port: number; origin: string; fixture: boolean }): Promise<IsolatedLocalChain> {
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 || [8545, 18545].includes(options.port)) throw new Error("Choose a dedicated open-mint RPC port (not 8545 or 18545).");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const probe = createTcpServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(options.port, "127.0.0.1", resolve); });
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const rpcUrl = `http://127.0.0.1:${options.port}`;
  const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(options.port), "--chain-id", "31337", "--state", join(options.directory, "anvil-state.json"), "--state-interval", "5", "--block-time", "1", "--mnemonic", mnemonic], { stdio: "ignore" });
  let childError: unknown;
  child.once("error", error => { childError = error; });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (child.exitCode !== null || child.signalCode !== null || childError) return;
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  };
  try {
    const client = createPublicClient({ chain: foundry, transport: http(rpcUrl, { retryCount: 0, timeout: 1000, fetchOptions: { redirect: "error" } }) });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (childError || child.exitCode !== null || child.signalCode !== null) throw new Error("The isolated Anvil process could not start.");
      try { ready = await client.getChainId() === 31337; } catch { /* Wait for our child, never launch another node. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("The isolated Anvil process is not ready.");
    const store = await FileKeyValueStore.create(join(options.directory, "deployment"));
    const saved = await store.get<{ contract: Address; codeHash: Hex; deploymentBlock: string; origin: string; fixture: boolean }>("chain:deployment");
    let deployment = saved;
    if (!deployment) {
      const compiled = JSON.parse(await readFile(join(process.cwd(), "contracts/out/OpenSignatures.sol/OpenSignatures.json"), "utf8")) as { bytecode: { object: Hex } };
      const deployer = createWalletClient({ account: account(0), chain: foundry, transport: http(rpcUrl, { retryCount: 0, fetchOptions: { redirect: "error" } }) });
      const hash = await deployer.deployContract({ abi: OPEN_MINT_ABI, bytecode: compiled.bytecode.object,
        args: ["Signatures Open Mint · Local", "SIGNLOCAL", `${options.origin}/about`, 86_400, account(1).address, account(2).address, account(3).address, account(4).address, account(5).address] });
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
      if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Open-mint deployment failed.");
      const code = await client.getCode({ address: receipt.contractAddress });
      if (!code || code === "0x") throw new Error("Open-mint deployment has no bytecode.");
      deployment = { contract: receipt.contractAddress, codeHash: keccak256(code), deploymentBlock: receipt.blockNumber.toString(), origin: options.origin, fixture: options.fixture };
      await store.put("chain:deployment", deployment);
    }
    if (deployment.origin !== options.origin || deployment.fixture !== options.fixture) throw new Error("This isolated deployment belongs to a different origin or assessment mode. Reuse its original configuration.");
    const signerKey = account(5).getHdKey().privateKey;
    if (!signerKey) throw new Error("Local authorizer is unavailable.");
    const network = createLocalOpenMintNetwork({ rpcUrl, contract: deployment.contract, expectedCodeHash: deployment.codeHash,
      authorizerPrivateKey: `0x${Buffer.from(signerKey).toString("hex")}`, deploymentBlock: BigInt(deployment.deploymentBlock), confirmations: 2 });
    await network.now();
    const wallet = createWalletClient({ account: account(6), chain: foundry, transport: http(rpcUrl, { retryCount: 0, fetchOptions: { redirect: "error" } }) });
    return { network, rpcUrl, send: transaction => wallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n }), close };
  } catch (error) { await close(); throw error; }
}
