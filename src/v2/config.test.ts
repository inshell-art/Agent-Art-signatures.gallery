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

describe("production mint configuration", () => {
  const production = {
    MINT_FEATURE_ENABLED: "true",
    APP_ORIGIN: "https://signatures.gallery",
    MINT_CHAIN_ID: "11155111",
    MINT_CHAIN_NAME: "Sepolia",
    MINT_CONTRACT_ADDRESS: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    MINT_AUTHORIZATION_TTL_SECONDS: "900",
    MINT_MAX_AUTH_WINDOW_SECONDS: "1800",
    MINT_CURRENT_AUTHORIZER_EPOCH: "1",
    MINT_CURRENT_AUTHORIZER_ADDRESS: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    MINT_GENESIS_HASH: `0x${"11".repeat(32)}`,
    MINT_RUNTIME_CODE_HASH: `0x${"22".repeat(32)}`,
    PUBLIC_ARTIFACT_ORIGIN: "https://signatures.gallery/",
    PRIMARY_RPC_URL: "https://primary.example",
    SECONDARY_RPC_URL: "https://secondary.example",
  };
  const load = (overrides: Record<string, string | undefined> = {}) =>
    loadMintConfig({ ...production, ...overrides }, false, "https://signatures.gallery");

  it("returns the frozen production shape with a chain-matched explorer", () => {
    const config = load();
    expect(config).toMatchObject({
      enabled: true, fixtureMode: false, chainId: 11155111n, chainName: "Sepolia",
      eip712Name: "signatures.gallery", eip712Version: "2",
      authorizationTtlSeconds: 900, maxAuthorizationWindowSeconds: 1800, authorizerEpoch: 1,
      explorerBaseUrl: "https://sepolia.etherscan.io",
      appOrigin: "https://signatures.gallery", appHost: "signatures.gallery",
    });
    // Addresses are normalized to EIP-55 and the artifact origin loses its trailing slash.
    expect(config.contract).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(config.authorizer).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(config.publicArtifactOrigin).toBe("https://signatures.gallery");
    expect(load({ MINT_CHAIN_ID: "1" }).explorerBaseUrl).toBe("https://etherscan.io");
  });

  it.each([
    "MINT_CHAIN_ID", "MINT_CHAIN_NAME", "MINT_CONTRACT_ADDRESS", "MINT_AUTHORIZATION_TTL_SECONDS",
    "MINT_MAX_AUTH_WINDOW_SECONDS", "MINT_CURRENT_AUTHORIZER_EPOCH", "MINT_CURRENT_AUTHORIZER_ADDRESS",
    "MINT_GENESIS_HASH", "MINT_RUNTIME_CODE_HASH", "PUBLIC_ARTIFACT_ORIGIN", "PRIMARY_RPC_URL", "SECONDARY_RPC_URL",
  ])("refuses to start with %s missing rather than guessing a default", (key) => {
    expect(() => load({ [key]: undefined })).toThrow(`V2 minting is enabled but ${key} is missing.`);
    expect(() => load({ [key]: "" })).toThrow(`V2 minting is enabled but ${key} is missing.`);
  });

  it("accepts only Ethereum mainnet or Sepolia", () => {
    for (const chainId of ["31337", "5", "0", "01", "1.0", "mainnet", "11155112"]) {
      expect(() => load({ MINT_CHAIN_ID: chainId })).toThrow(/Ethereum mainnet \(1\) or Sepolia/);
    }
  });

  it("keeps the authorization windows frozen at 900 and 1800 seconds", () => {
    for (const ttl of ["901", "899", "1800", "0", "nine hundred"]) {
      expect(() => load({ MINT_AUTHORIZATION_TTL_SECONDS: ttl })).toThrow(/frozen at 900\/1800 seconds/);
    }
    for (const window of ["1801", "900", "3600", "-1"]) {
      expect(() => load({ MINT_MAX_AUTH_WINDOW_SECONDS: window })).toThrow(/frozen at 900\/1800 seconds/);
    }
  });

  it("keeps the EIP-712 domain frozen while allowing its exact value to be restated", () => {
    expect(load({ MINT_EIP712_NAME: "signatures.gallery", MINT_EIP712_VERSION: "2" }).eip712Name).toBe("signatures.gallery");
    expect(() => load({ MINT_EIP712_NAME: "Signatures.Gallery" })).toThrow(/frozen at signatures.gallery\/2/);
    expect(() => load({ MINT_EIP712_VERSION: "1" })).toThrow(/frozen at signatures.gallery\/2/);
    expect(() => load({ MINT_EIP712_VERSION: "3" })).toThrow(/frozen at signatures.gallery\/2/);
  });

  it("requires an authorizer epoch inside the contract's uint32 range", () => {
    expect(load({ MINT_CURRENT_AUTHORIZER_EPOCH: "4294967295" }).authorizerEpoch).toBe(0xffff_ffff);
    for (const epoch of ["0", "-1", "1.5", "4294967296", "not-a-number"]) {
      expect(() => load({ MINT_CURRENT_AUTHORIZER_EPOCH: epoch })).toThrow(/Invalid authorizer epoch/);
    }
  });

  it("requires pinned chain evidence as 32 lowercase hexadecimal bytes", () => {
    for (const field of ["MINT_GENESIS_HASH", "MINT_RUNTIME_CODE_HASH"]) {
      for (const value of [`0x${"AB".repeat(32)}`, `0x${"11".repeat(31)}`, `0x${"11".repeat(33)}`, "11".repeat(32)]) {
        expect(() => load({ [field]: value })).toThrow(`${field} must be 32 lowercase hexadecimal bytes.`);
      }
    }
  });

  it("requires the application origin to be an exact HTTPS origin outside loopback", () => {
    for (const origin of ["https://signatures.gallery/app", "https://signatures.gallery?a=1", "https://signatures.gallery#a"]) {
      expect(() => load({ APP_ORIGIN: origin })).toThrow(/exact origin with no path, query, or fragment/);
    }
    expect(() => load({ APP_ORIGIN: "http://signatures.gallery" })).toThrow(/HTTPS outside local development/);
    expect(load({ APP_ORIGIN: "https://signatures.gallery/" }).appOrigin).toBe("https://signatures.gallery");
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(load({ APP_ORIGIN: origin }).appOrigin).toBe(origin);
    }
  });

  it("falls back to the supplied origin only when APP_ORIGIN is absent", () => {
    expect(load({ APP_ORIGIN: undefined }).appOrigin).toBe("https://signatures.gallery");
    expect(loadMintConfig({ ...production, APP_ORIGIN: undefined }, false, "https://fallback.example").appOrigin)
      .toBe("https://fallback.example");
  });
});

describe("mint configuration when minting is off", () => {
  it("returns an inert disabled config that names no real contract or RPC", () => {
    const config = loadMintConfig({ MINT_FEATURE_ENABLED: "false" }, false, "https://signatures.gallery");
    expect(config.enabled).toBe(false);
    expect(config.fixtureMode).toBe(false);
    expect(config.contract).toBe("0x0000000000000000000000000000000000000001");
    expect(config.authorizer).toBe("0x0000000000000000000000000000000000000001");
    expect(config.primaryRpcUrl).toBeNull();
    expect(config.secondaryRpcUrl).toBeNull();
    expect(config.genesisHash).toBeNull();
    expect(config.runtimeCodeHash).toBeNull();
  });

  it("defaults to disabled outside fixture mode, so an unset flag never enables minting", () => {
    expect(loadMintConfig({}, false, "https://signatures.gallery").enabled).toBe(false);
    expect(loadMintConfig({}, true, "https://signatures.gallery").enabled).toBe(true);
  });

  it("ignores production chain variables entirely while disabled", () => {
    const config = loadMintConfig({ MINT_FEATURE_ENABLED: "0", MINT_CHAIN_ID: "31337", MINT_CONTRACT_ADDRESS: "nonsense" },
      false, "https://signatures.gallery");
    expect(config.chainId).toBe(1n);
    expect(config.explorerBaseUrl).toBe("https://etherscan.io");
  });
});

describe("fixture mint configuration", () => {
  it("pins a clearly labelled rehearsal chain that no production variable can redirect", () => {
    const config = loadMintConfig({ MINT_CHAIN_ID: "1", MINT_CONTRACT_ADDRESS: `0x${"ab".repeat(20)}`, MINT_CHAIN_NAME: "Ethereum" },
      true, "http://localhost:3000");
    expect(config.fixtureMode).toBe(true);
    expect(config.chainId).toBe(11155111n);
    expect(config.chainName).toBe("Sepolia rehearsal fixture");
    expect(config.contract).toBe("0x5FbDB2315678afecb367f032d93F642f64180aa3");
    expect(config.explorerBaseUrl).toBeNull();
    expect(config.primaryRpcUrl).toBeNull();
    expect(config.publicArtifactOrigin).toBe("http://localhost:3000");
  });
});
