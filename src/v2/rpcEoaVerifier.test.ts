import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { DualRpcEoaVerifier, createDualRpcEoaVerifier, type EoaRpcClient } from "./rpcEoaVerifier.js";
import type { MintConfig } from "./config.js";

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

describe("dual-RPC failure isolation", () => {
  const verifier = (secondary: Partial<EoaRpcClient>) => new DualRpcEoaVerifier(11155111n, genesis, rpc(), rpc(secondary));
  const unavailable = /could not be verified against agreed finalized RPC state/;

  it("fails closed when only the secondary provider is on the wrong network", async () => {
    await expect(verifier({ async getChainId() { return 1; } }).verify(address, 11155111n)).rejects.toThrow(unavailable);
  });

  it("fails closed when only the secondary provider reports a different genesis", async () => {
    await expect(verifier({
      async getBlock(args) {
        if ("blockTag" in args) return { number: 120n, hash: blockHash };
        if (args.blockNumber === 0n) return { number: 0n, hash: `0x${"09".repeat(32)}` as Hex };
        return { number: args.blockNumber, hash: blockHash };
      },
    }).verify(address, 11155111n)).rejects.toThrow(unavailable);
  });

  it("fails closed when either provider has no finalized height yet", async () => {
    const none = { async getBlock(args: Parameters<EoaRpcClient["getBlock"]>[0]) {
      if ("blockTag" in args) return { number: null, hash: null };
      if (args.blockNumber === 0n) return { number: 0n, hash: genesis };
      return { number: args.blockNumber, hash: blockHash };
    } };
    await expect(verifier(none).verify(address, 11155111n)).rejects.toThrow(unavailable);
    await expect(new DualRpcEoaVerifier(11155111n, genesis, rpc(none), rpc()).verify(address, 11155111n)).rejects.toThrow(unavailable);
  });

  it("treats an absent code result as empty only when both providers agree", async () => {
    const undefinedCode = { async getCode() { return undefined; } };
    await expect(new DualRpcEoaVerifier(11155111n, genesis, rpc(undefinedCode), rpc(undefinedCode)).verify(address, 11155111n))
      .resolves.toEqual({ blockNumber: 120n, blockHash });
    await expect(new DualRpcEoaVerifier(11155111n, genesis, rpc(undefinedCode), rpc({ async getCode() { return "0x60006000fd" as Hex; } }))
      .verify(address, 11155111n)).rejects.toThrow(unavailable);
  });

  it("treats code that differs only in hexadecimal casing as agreement, and still reports it as unsupported", async () => {
    const upper = { async getCode() { return "0xAB" as Hex; } };
    const lower = { async getCode() { return "0xab" as Hex; } };
    const rejection = new DualRpcEoaVerifier(11155111n, genesis, rpc(upper), rpc(lower)).verify(address, 11155111n);
    // Casing must not read as provider disagreement, and the specific wallet
    // verdict must survive the catch that otherwise reports RPC unavailability.
    await expect(rejection).rejects.toThrow(/only EOAs with empty code/);
    await expect(rejection).rejects.toMatchObject({ code: "WALLET_UNSUPPORTED" });
  });

  it("fails closed when the pinned block is replaced while the code is read", async () => {
    let reads = 0;
    const shifting: Partial<EoaRpcClient> = {
      async getBlock(args) {
        if ("blockTag" in args) return { number: 120n, hash: blockHash };
        if (args.blockNumber === 0n) return { number: 0n, hash: genesis };
        reads += 1;
        return { number: args.blockNumber, hash: reads > 2 ? `0x${"0a".repeat(32)}` as Hex : blockHash };
      },
    };
    await expect(new DualRpcEoaVerifier(11155111n, genesis, rpc(shifting), rpc(shifting)).verify(address, 11155111n))
      .rejects.toThrow(unavailable);
  });

  it("normalizes the requested address before pinning it to a block", async () => {
    const seen: string[] = [];
    const record: Partial<EoaRpcClient> = { async getCode(args) { seen.push(args.address); return "0x"; } };
    const lowercase = address.toLowerCase() as Address;
    await expect(new DualRpcEoaVerifier(11155111n, genesis, rpc(record), rpc(record)).verify(lowercase, 11155111n)).resolves.toBeTruthy();
    expect(seen).toEqual([address, address]);
  });
});

describe("dual-RPC verifier construction", () => {
  const config = {
    chainId: 11155111n, genesisHash: genesis,
    primaryRpcUrl: "https://primary.invalid", secondaryRpcUrl: "https://secondary.invalid",
  } as unknown as MintConfig;

  it("refuses to build without two RPC endpoints and a pinned genesis hash", () => {
    for (const missing of [{ primaryRpcUrl: "" }, { secondaryRpcUrl: "" }, { genesisHash: null }]) {
      expect(() => createDualRpcEoaVerifier({ ...config, ...missing } as MintConfig))
        .toThrow(/requires two RPC URLs and the deployment genesis hash/);
    }
  });

  it("builds a verifier bound to the configured chain when both endpoints are present", () => {
    expect(createDualRpcEoaVerifier(config)).toBeInstanceOf(DualRpcEoaVerifier);
  });
});
