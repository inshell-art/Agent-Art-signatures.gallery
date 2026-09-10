import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { DualRpcEoaVerifier, type EoaRpcClient } from "./rpcEoaVerifier.js";

const address = "0x1111111111111111111111111111111111111111" as Address;
const genesis = `0x${"01".repeat(32)}` as Hex;
const blockHash = `0x${"02".repeat(32)}` as Hex;

function rpc(overrides: Partial<EoaRpcClient> = {}): EoaRpcClient {
  return {
    async getChainId() { return 11155111; },
    async getBlock(args) {
      if ("blockTag" in args) return { number: 120n, hash: `0x${"03".repeat(32)}` as Hex };
      if (args.blockNumber === 0n) return { number: 0n, hash: genesis };
      return { number: args.blockNumber, hash: blockHash };
    },
    async getCode() { return "0x"; },
    ...overrides,
  };
}

describe("DualRpcEoaVerifier", () => {
  it("pins the lower agreed finalized height and accepts only empty code", async () => {
    const primary = rpc();
    const secondary = rpc({
      async getBlock(args) {
        if ("blockTag" in args) return { number: 118n, hash: `0x${"04".repeat(32)}` as Hex };
        if (args.blockNumber === 0n) return { number: 0n, hash: genesis };
        return { number: args.blockNumber, hash: blockHash };
      },
    });
    const verifier = new DualRpcEoaVerifier(11155111n, genesis, primary, secondary);
    await expect(verifier.verify(address, 11155111n)).resolves.toEqual({ blockNumber: 118n, blockHash });
  });

  it("rejects deployed or delegated code as an unsupported wallet", async () => {
    const coded = rpc({ async getCode() { return "0xef01001234"; } });
    const verifier = new DualRpcEoaVerifier(11155111n, genesis, coded, coded);
    await expect(verifier.verify(address, 11155111n)).rejects.toMatchObject({ code: "WALLET_UNSUPPORTED", status: 422 });
  });

  it("fails closed on provider disagreement or wrong network", async () => {
    const disagreement = rpc({
      async getBlock(args) {
        if ("blockTag" in args) return { number: 120n, hash: blockHash };
        if (args.blockNumber === 0n) return { number: 0n, hash: genesis };
        return { number: args.blockNumber, hash: `0x${"ff".repeat(32)}` as Hex };
      },
    });
    await expect(new DualRpcEoaVerifier(11155111n, genesis, rpc(), disagreement).verify(address, 11155111n))
      .rejects.toMatchObject({ code: "WALLET_RPC_UNAVAILABLE", status: 503 });
    await expect(new DualRpcEoaVerifier(11155111n, genesis, rpc(), rpc()).verify(address, 1n))
      .rejects.toMatchObject({ code: "WRONG_CHAIN", status: 400 });
  });
});
