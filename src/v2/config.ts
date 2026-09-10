import { getAddress, type Address, type Hex } from "viem";

export interface MintConfig {
  enabled: boolean;
  fixtureMode: boolean;
  /** Explicit opt-in for real transactions on the isolated local Anvil chain. */
  localChainRehearsal?: true;
  chainId: bigint;
  chainName: string;
  contract: Address;
  eip712Name: "signatures.gallery";
  eip712Version: "2";
  authorizationTtlSeconds: 900;
  maxAuthorizationWindowSeconds: 1800;
  authorizerEpoch: number;
  authorizer: Address;
  publicArtifactOrigin: string;
  appOrigin: string;
  appHost: string;
  explorerBaseUrl: string | null;
  genesisHash: Hex | null;
  runtimeCodeHash: Hex | null;
  primaryRpcUrl: string | null;
  secondaryRpcUrl: string | null;
}

/** Kept separate from environment loading: no production flag enables Anvil. */
export function assertLocalChainRehearsalConfig(config: MintConfig): void {
  if (!config.localChainRehearsal) return;
  if (config.fixtureMode || config.chainId !== 31_337n || config.explorerBaseUrl !== null) {
    throw new Error("Local chain rehearsal requires non-simulated Anvil 31337 with no public explorer.");
  }
  const assertLoopback = (value: string | null): URL => {
    if (!value) throw new Error("Local chain rehearsal requires explicit loopback origins and RPC URLs.");
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.origin !== value.replace(/\/$/, "") || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Local chain rehearsal URLs must be exact HTTP loopback origins.");
    }
    return url;
  };
  const app = assertLoopback(config.appOrigin);
  if (config.appHost !== app.host || assertLoopback(config.publicArtifactOrigin).origin !== app.origin) {
    throw new Error("Local chain rehearsal application and artifact origins must match exactly.");
  }
  const primary = assertLoopback(config.primaryRpcUrl);
  if (assertLoopback(config.secondaryRpcUrl).origin !== primary.origin) {
    throw new Error("Local chain rehearsal uses one explicitly identified Anvil node, not independent providers.");
  }
  if (!config.genesisHash || !config.runtimeCodeHash) {
    throw new Error("Local chain rehearsal requires pinned genesis and runtime code hashes.");
  }
}

const FIXTURE_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const FIXTURE_AUTHORIZER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error("MINT_FEATURE_ENABLED must be exactly true, false, 1, or 0.");
}

function canonicalOrigin(value: string): { origin: string; host: string } {
  const parsed = new URL(value);
  if (parsed.origin !== value.replace(/\/$/, "") || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Mint application origin must be an exact origin with no path, query, or fragment.");
  }
  const origin = parsed.origin;
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    throw new Error("Mint application origin must use HTTPS outside local development.");
  }
  return { origin, host: parsed.host.toLowerCase() };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`V2 minting is enabled but ${key} is missing.`);
  return value;
}

function parseChainId(value: string): bigint {
  if (!/^(?:1|11155111)$/.test(value)) throw new Error("MINT_CHAIN_ID must be Ethereum mainnet (1) or Sepolia (11155111).");
  return BigInt(value);
}

function parseBytes32(value: string | undefined, field: string): Hex | null {
  if (!value) return null;
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error(`${field} must be 32 lowercase hexadecimal bytes.`);
  return value as Hex;
}

export function loadMintConfig(
  env: NodeJS.ProcessEnv,
  fixtureMode: boolean,
  fallbackOrigin: string,
): MintConfig {
  const enabled = envBool(env.MINT_FEATURE_ENABLED, fixtureMode);
  const originInput = env.APP_ORIGIN ?? fallbackOrigin;
  const { origin, host } = canonicalOrigin(originInput.replace(/\/$/, ""));

  if (fixtureMode) {
    return {
      enabled,
      fixtureMode: true,
      chainId: 11155111n,
      chainName: "Sepolia rehearsal fixture",
      contract: getAddress(FIXTURE_CONTRACT),
      eip712Name: "signatures.gallery",
      eip712Version: "2",
      authorizationTtlSeconds: 900,
      maxAuthorizationWindowSeconds: 1800,
      authorizerEpoch: 1,
      authorizer: getAddress(FIXTURE_AUTHORIZER),
      publicArtifactOrigin: origin,
      appOrigin: origin,
      appHost: host,
      explorerBaseUrl: null,
      genesisHash: null,
      runtimeCodeHash: null,
      primaryRpcUrl: null,
      secondaryRpcUrl: null,
    };
  }

  if (!enabled) {
    return {
      enabled: false,
      fixtureMode: false,
      chainId: 1n,
      chainName: "Ethereum",
      contract: getAddress("0x0000000000000000000000000000000000000001"),
      eip712Name: "signatures.gallery",
      eip712Version: "2",
      authorizationTtlSeconds: 900,
      maxAuthorizationWindowSeconds: 1800,
      authorizerEpoch: 1,
      authorizer: getAddress("0x0000000000000000000000000000000000000001"),
      publicArtifactOrigin: origin,
      appOrigin: origin,
      appHost: host,
      explorerBaseUrl: "https://etherscan.io",
      genesisHash: null,
      runtimeCodeHash: null,
      primaryRpcUrl: null,
      secondaryRpcUrl: null,
    };
  }

  const chainId = parseChainId(required(env, "MINT_CHAIN_ID"));
  const ttl = Number(required(env, "MINT_AUTHORIZATION_TTL_SECONDS"));
  const maxWindow = Number(required(env, "MINT_MAX_AUTH_WINDOW_SECONDS"));
  if (ttl !== 900 || maxWindow !== 1800) throw new Error("V2 authorization windows must remain frozen at 900/1800 seconds.");
  if ((env.MINT_EIP712_NAME ?? "signatures.gallery") !== "signatures.gallery" || (env.MINT_EIP712_VERSION ?? "2") !== "2") {
    throw new Error("V2 EIP-712 domain name/version is frozen at signatures.gallery/2.");
  }
  const epoch = Number(required(env, "MINT_CURRENT_AUTHORIZER_EPOCH"));
  if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > 0xffff_ffff) throw new Error("Invalid authorizer epoch.");

  return {
    enabled: true,
    fixtureMode: false,
    chainId,
    chainName: required(env, "MINT_CHAIN_NAME"),
    contract: getAddress(required(env, "MINT_CONTRACT_ADDRESS")),
    eip712Name: "signatures.gallery",
    eip712Version: "2",
    authorizationTtlSeconds: 900,
    maxAuthorizationWindowSeconds: 1800,
    authorizerEpoch: epoch,
    authorizer: getAddress(required(env, "MINT_CURRENT_AUTHORIZER_ADDRESS")),
    publicArtifactOrigin: required(env, "PUBLIC_ARTIFACT_ORIGIN").replace(/\/$/, ""),
    appOrigin: origin,
    appHost: host,
    explorerBaseUrl: chainId === 1n ? "https://etherscan.io" : "https://sepolia.etherscan.io",
    genesisHash: parseBytes32(required(env, "MINT_GENESIS_HASH"), "MINT_GENESIS_HASH"),
    runtimeCodeHash: parseBytes32(required(env, "MINT_RUNTIME_CODE_HASH"), "MINT_RUNTIME_CODE_HASH"),
    primaryRpcUrl: required(env, "PRIMARY_RPC_URL"),
    secondaryRpcUrl: required(env, "SECONDARY_RPC_URL"),
  };
}
