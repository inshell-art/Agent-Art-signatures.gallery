import { describe, expect, it } from "vitest";
import { assertLocalChainRehearsalConfig, loadMintConfig, type MintConfig } from "./config.js";

describe("V2 HTTP mint configuration", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("parses the exact feature flag value %s", (value, enabled) => {
    expect(loadMintConfig({ MINT_FEATURE_ENABLED: value }, true, "http://localhost:3000").enabled).toBe(enabled);
  });

  it.each(["yes", "TRUE", " false ", "2", ""])("rejects ambiguous feature flag value %j", (value) => {
    expect(() => loadMintConfig({ MINT_FEATURE_ENABLED: value }, true, "http://localhost:3000"))
      .toThrow("MINT_FEATURE_ENABLED must be exactly true, false, 1, or 0.");
  });
});

describe("explicit local-chain rehearsal configuration", () => {
  const local = (): MintConfig => ({
    ...loadMintConfig({}, true, "http://127.0.0.1:3000"),
    fixtureMode: false,
    localChainRehearsal: true,
    chainId: 31337n,
    primaryRpcUrl: "http://127.0.0.1:8545",
    secondaryRpcUrl: "http://127.0.0.1:8545",
    genesisHash: `0x${"11".repeat(32)}`,
    runtimeCodeHash: `0x${"22".repeat(32)}`,
  });

  it("permits only explicitly injected isolated Anvil configuration", () => {
    expect(() => assertLocalChainRehearsalConfig(local())).not.toThrow();
    expect(() => loadMintConfig({ MINT_FEATURE_ENABLED: "true", MINT_CHAIN_ID: "31337" }, false, "http://127.0.0.1:3000"))
      .toThrow("mainnet (1) or Sepolia");
  });

  it.each([
    { fixtureMode: true }, { chainId: 11155111n }, { explorerBaseUrl: "https://sepolia.etherscan.io" },
    { appOrigin: "http://example.com" }, { appHost: "localhost:3000" },
    { publicArtifactOrigin: "http://127.0.0.1:3001" },
    { primaryRpcUrl: "http://127.0.0.1.evil.example:8545" },
    { primaryRpcUrl: "http://127.0.0.1:8545/path" },
    { primaryRpcUrl: "http://user:password@127.0.0.1:8545" },
    { secondaryRpcUrl: "http://127.0.0.1:8546" },
    { genesisHash: null }, { runtimeCodeHash: null },
  ] satisfies Partial<MintConfig>[])("rejects unsafe local configuration %#", (override) => {
    expect(() => assertLocalChainRehearsalConfig({ ...local(), ...override })).toThrow();
  });
});
