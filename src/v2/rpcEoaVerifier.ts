import { createPublicClient, getAddress, http, type Address, type Hex, type PublicClient } from "viem";
import type { MintConfig } from "./config.js";
import { v2Error } from "./errors.js";
import type { EoaVerification, EoaVerifier } from "./service.js";

interface BlockRef {
  number: bigint | null;
  hash: Hex | null;
}

export interface EoaRpcClient {
  getChainId(): Promise<number>;
  getBlock(args: { blockTag: "finalized" } | { blockNumber: bigint }): Promise<BlockRef>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
}

function asEoaRpcClient(client: PublicClient): EoaRpcClient {
  return client as unknown as EoaRpcClient;
}

/**
 * Uses two independent RPC observations and a pinned agreed finalized block.
 * Provider lag delays binding; disagreement never becomes permission to guess.
 */
export class DualRpcEoaVerifier implements EoaVerifier {
  constructor(
    private readonly chainId: bigint,
    private readonly expectedGenesisHash: Hex,
    private readonly primary: EoaRpcClient,
    private readonly secondary: EoaRpcClient,
  ) {}

  async verify(inputAddress: Address, requestedChainId: bigint): Promise<EoaVerification> {
    if (requestedChainId !== this.chainId) throw v2Error(400, "WRONG_CHAIN", "The wallet proof targets the wrong chain.");
    const address = getAddress(inputAddress);
    try {
      const [primaryChain, secondaryChain, primaryGenesis, secondaryGenesis] = await Promise.all([
        this.primary.getChainId(),
        this.secondary.getChainId(),
        this.primary.getBlock({ blockNumber: 0n }),
        this.secondary.getBlock({ blockNumber: 0n }),
      ]);
      if (BigInt(primaryChain) !== this.chainId || BigInt(secondaryChain) !== this.chainId) throw new Error("RPC chain ID mismatch.");
      if (primaryGenesis.hash !== this.expectedGenesisHash || secondaryGenesis.hash !== this.expectedGenesisHash) throw new Error("RPC genesis mismatch.");

      const [primaryFinalized, secondaryFinalized] = await Promise.all([
        this.primary.getBlock({ blockTag: "finalized" }),
        this.secondary.getBlock({ blockTag: "finalized" }),
      ]);
      if (primaryFinalized.number === null || secondaryFinalized.number === null) throw new Error("RPC returned no finalized height.");
      const blockNumber = primaryFinalized.number < secondaryFinalized.number ? primaryFinalized.number : secondaryFinalized.number;
      const [beforePrimary, beforeSecondary] = await Promise.all([
        this.primary.getBlock({ blockNumber }),
        this.secondary.getBlock({ blockNumber }),
      ]);
      if (!beforePrimary.hash || beforePrimary.hash !== beforeSecondary.hash) throw new Error("RPC finalized block disagreement.");
      const blockHash = beforePrimary.hash;

      const [primaryCode, secondaryCode] = await Promise.all([
        this.primary.getCode({ address, blockNumber }),
        this.secondary.getCode({ address, blockNumber }),
      ]);
      const normalizeCode = (value: Hex | undefined) => value === undefined ? "0x" : value.toLowerCase();
      if (normalizeCode(primaryCode) !== normalizeCode(secondaryCode)) throw new Error("RPC wallet-code disagreement.");
      if (normalizeCode(primaryCode) !== "0x") {
        throw v2Error(422, "WALLET_UNSUPPORTED", "V2 supports only EOAs with empty code at the pinned canonical block.");
      }

      const [afterPrimary, afterSecondary] = await Promise.all([
        this.primary.getBlock({ blockNumber }),
        this.secondary.getBlock({ blockNumber }),
      ]);
      if (afterPrimary.hash !== blockHash || afterSecondary.hash !== blockHash) throw new Error("Pinned block changed during wallet verification.");
      return { blockNumber, blockHash };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "WALLET_UNSUPPORTED") throw error;
      throw v2Error(503, "WALLET_RPC_UNAVAILABLE", "Wallet eligibility could not be verified against agreed finalized RPC state.");
    }
  }
}

export function createDualRpcEoaVerifier(config: MintConfig): DualRpcEoaVerifier {
  if (!config.primaryRpcUrl || !config.secondaryRpcUrl || !config.genesisHash) {
    throw new Error("Dual RPC EOA verification requires two RPC URLs and the deployment genesis hash.");
  }
  const primary = asEoaRpcClient(createPublicClient({ transport: http(config.primaryRpcUrl) }));
  const secondary = asEoaRpcClient(createPublicClient({ transport: http(config.secondaryRpcUrl) }));
  return new DualRpcEoaVerifier(config.chainId, config.genesisHash, primary, secondary);
}
