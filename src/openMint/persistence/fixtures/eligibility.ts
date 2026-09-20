import { decodeFunctionData, encodeFunctionResult, keccak256, numberToHex, type Address, type Hex } from "viem";
import { PUBLIC_CHAIN_READ_ABI, PublicChainGate, type PublicChainGateConfig } from "../../publicChain.js";
import type { PublicChainRpc } from "../../publicChainRpc.js";

export const chainHash = (byte: string): Hex => `0x${byte.repeat(32)}`;
/** Real witness validation with two entirely mocked, read-only RPC transports. */
export function eligibilityFixture(namespaceId: string, deploymentId: string, now: () => number = Date.now) {
  const origin = "https://signatures.example", runtime = "0x60006000" as Hex;
  const config: PublicChainGateConfig = { namespaceId, deploymentId, chainId: 31337n, genesisHash: chainHash("01"),
    deploymentBlock: { number: 2n, hash: chainHash("02") }, contract: "0x1111111111111111111111111111111111111111",
    runtimeCodeHash: keccak256(runtime), authorizer: "0x2222222222222222222222222222222222222222",
    maxBlockAgeMs: 120000, maxFutureSkewMs: 5000, evidenceTtlMs: 10000, observationTimeoutMs: 1000 };
  const profile = { deployment_id: deploymentId, chain_id: "31337", contract_address: config.contract.toLowerCase(), genesis_hash: config.genesisHash,
    runtime_code_hash: config.runtimeCodeHash, authorizer: config.authorizer.toLowerCase(), deployment_block: "2", deployment_block_hash: config.deploymentBlock.hash,
    origin, session_chain_id: "31337", max_evidence_age_ms: 10000, max_block_age_ms: 120000, max_future_skew_ms: 5000 };
  return { config, profile, async witness(handle: string, recipient: Address, changes: Partial<PublicChainGateConfig> = {}, code: Hex = runtime, nonce: Hex = chainHash("33")) {
    const pinned = { ...config, ...changes }, block = { number: 10n, hash: chainHash("10") }, timestamp = BigInt(Math.floor(now() / 1000));
    const rpc = (id: string): PublicChainRpc => ({ id, async request(method, params) {
      if (method === "eth_chainId") return numberToHex(pinned.chainId);
      if (method === "eth_getBlockByNumber") {
        const number = BigInt(params[0] as string);
        return { number: numberToHex(number), hash: number === 0n ? pinned.genesisHash : number === pinned.deploymentBlock.number ? pinned.deploymentBlock.hash : block.hash, timestamp: numberToHex(timestamp) };
      }
      if (method === "eth_getCode") return params[0] === pinned.contract ? code : "0x";
      const name = decodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, data: (params[0] as { data: Hex }).data }).functionName;
      const result = name === "eip712Domain" ? ["0x0f", "SignaturesOpenMint", "1", pinned.chainId, pinned.contract, chainHash("00"), []]
        : name === "trustedAuthorizer" ? pinned.authorizer : false;
      return encodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: name, result } as Parameters<typeof encodeFunctionResult>[0]);
    } });
    return new PublicChainGate(pinned, [rpc("mock-rpc-one"), rpc("mock-rpc-two")], now).preflight({ block, handle, recipient, nonce });
  } };
}
