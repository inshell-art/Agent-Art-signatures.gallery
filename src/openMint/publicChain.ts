import { performance } from "node:perf_hooks";
import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, numberToHex, parseAbi, type Address, type Hex } from "viem";
import { normalizeOpenMintAuthorization, openMintDigest, openMintDomain, openMintHandleKey, openMintTokenURIHash,
  verifyOpenMintAuthorization, type OpenMintAuthorizationInput } from "./authorization.js";
import type { PublicChainRpc } from "./publicChainRpc.js";

/** Deliberately read-only subset; independent of the local runtime's ABI. */
export const PUBLIC_CHAIN_READ_ABI = parseAbi([
  "struct OpenMintAuthorization { bytes32 handleKey; bytes32 assessmentDigest; bytes32 artifactDigest; address recipient; bytes32 tokenURIHash; bytes32 nonce; uint64 issuedAt; uint64 deadline; }",
  "function eip712Domain() view returns (bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)",
  "function trustedAuthorizer() view returns (address)",
  "function paused() view returns (bool)",
  "function mintedHandle(bytes32 handleKey) view returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (bool)",
  "function revokedNonces(bytes32 nonce) view returns (bool)",
  "function authorizationDigest(OpenMintAuthorization a) view returns (bytes32)",
]);
type ReadName = typeof PUBLIC_CHAIN_READ_ABI[number] extends infer F ? F extends { name: infer N } ? N : never : never;
export interface PublicChainBlock { readonly number: bigint; readonly hash: Hex }
export interface PublicChainGateConfig {
  namespaceId: string; deploymentId: string; chainId: bigint; genesisHash: Hex;
  deploymentBlock: PublicChainBlock; contract: Address; runtimeCodeHash: Hex; authorizer: Address;
  maxBlockAgeMs: number; maxFutureSkewMs: number; evidenceTtlMs: number; observationTimeoutMs: number;
}
export interface PublicChainEvidence {
  readonly namespaceId: string; readonly deploymentId: string; readonly chainId: bigint; readonly genesisHash: Hex;
  readonly deploymentBlock: PublicChainBlock; readonly contract: Address; readonly runtimeCodeHash: Hex; readonly authorizer: Address;
  readonly handle: string; readonly handleKey: Hex; readonly recipient: Address; readonly nonce: Hex;
  readonly block: PublicChainBlock & { readonly timestamp: bigint };
  readonly observedAt: number; readonly validUntil: number; readonly sources: readonly [string, string];
}
declare const eligibilityBrand: unique symbol;
export interface PublicChainEligibility { readonly [eligibilityBrand]: true }
const witnesses = new WeakMap<PublicChainEligibility, PublicChainEvidence>();
export class PublicChainGateError extends Error {
  constructor(message: string) { super(message); this.name = "PublicChainGateError"; }
}
function fail(message: string): never { throw new PublicChainGateError(message); }
function hash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) fail("Missing or invalid chain commitment.");
  return value as Hex;
}
function address(value: unknown): Address {
  if (typeof value !== "string") fail("Missing chain address.");
  const parsed = getAddress(value);
  if (/^0x0{40}$/i.test(parsed)) fail("Zero chain address.");
  return parsed;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || value.length > 66) fail("Missing or invalid chain quantity.");
  return BigInt(value);
}
function clock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("Invalid observation clock.");
  return value;
}
function blockPin(value: PublicChainBlock): PublicChainBlock {
  if (typeof value.number !== "bigint" || value.number < 0n || value.number >= 1n << 256n) fail("Invalid explicit block number.");
  return Object.freeze({ number: value.number, hash: hash(value.hash) });
}
function header(raw: unknown, expected: PublicChainBlock): PublicChainBlock & { timestamp: bigint } {
  if (!raw || typeof raw !== "object") fail("Canonical block unavailable.");
  const value = raw as Record<string, unknown>;
  const result = { number: quantity(value.number), hash: hash(value.hash), timestamp: quantity(value.timestamp) };
  if (result.number !== expected.number || result.hash !== expected.hash) fail("Canonical block pin disagrees.");
  if (result.timestamp > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) fail("Invalid block timestamp.");
  return result;
}
function code(raw: unknown): Hex {
  if (typeof raw !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(raw) || raw.length > 131074) fail("Missing or malformed account code.");
  return raw as Hex;
}
function label(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) fail("Invalid namespace, deployment, or RPC identity.");
  return value;
}

/** Only a witness produced in this process is accepted. Call inside admission
 * with the database clock; serialized copies are intentionally not authority. */
export function readPublicChainEligibility(witness: unknown, expected: {
  namespaceId: string; deploymentId: string; handle: string; recipient: string; nonce?: string; now: number;
}): PublicChainEvidence {
  const evidence = witness && typeof witness === "object" ? witnesses.get(witness as PublicChainEligibility) : undefined;
  if (!evidence) fail("Unknown chain eligibility witness.");
  const now = clock(expected.now);
  if (evidence.namespaceId !== expected.namespaceId || evidence.deploymentId !== expected.deploymentId || evidence.handle !== expected.handle
    || evidence.recipient !== address(expected.recipient) || (expected.nonce !== undefined && evidence.nonce !== expected.nonce)) fail("Chain eligibility binding mismatch.");
  if (now < evidence.observedAt || now >= evidence.validUntil) fail("Chain eligibility witness is stale.");
  return evidence;
}

/** Read-only evidence, not an authorization issuer or a public-mode switch. */
export class PublicChainGate {
  readonly #config: Readonly<PublicChainGateConfig>;
  readonly #rpcs: readonly [PublicChainRpc, PublicChainRpc];
  readonly #now: () => number;
  constructor(config: PublicChainGateConfig, rpcs: readonly [PublicChainRpc, PublicChainRpc], now: () => number = Date.now) {
    const domain = openMintDomain({ chainId: config.chainId, verifyingContract: config.contract });
    for (const [value, maximum] of [[config.maxBlockAgeMs, 3_600_000], [config.maxFutureSkewMs, 300_000],
      [config.evidenceTtlMs, 60_000], [config.observationTimeoutMs, 30_000]]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail("Invalid bounded observation policy.");
    }
    if (!config.maxBlockAgeMs || !config.evidenceTtlMs || !config.observationTimeoutMs) fail("Observation bounds must be positive.");
    this.#config = Object.freeze({ ...config, namespaceId: label(config.namespaceId), deploymentId: label(config.deploymentId), chainId: domain.chainId,
      contract: domain.verifyingContract, authorizer: address(config.authorizer), genesisHash: hash(config.genesisHash),
      runtimeCodeHash: hash(config.runtimeCodeHash), deploymentBlock: blockPin(config.deploymentBlock) });
    if (rpcs.length !== 2 || rpcs[0] === rpcs[1] || rpcs[0].id === rpcs[1].id) fail("Two distinct RPC sources are required.");
    this.#rpcs = Object.freeze(rpcs.map(rpc => Object.freeze({ id: label(rpc.id), request: rpc.request.bind(rpc) }))) as unknown as readonly [PublicChainRpc, PublicChainRpc];
    this.#now = now;
  }
  async preflight(input: { block: PublicChainBlock; handle: string; recipient: string; nonce: Hex }): Promise<PublicChainEligibility> {
    return (await this.#observe(input)).witness;
  }
  /** Verify an already supplied signature and its exact commitments. Does not
   * establish that the assessment/artifacts satisfy backend acceptance policy. */
  async verifyAuthorization(input: {
    block: PublicChainBlock; handle: string; tokenURI: string; assessmentDigest: Hex; artifactDigest: Hex;
    authorization: OpenMintAuthorizationInput; signature: string;
  }): Promise<{ readonly eligibility: PublicChainEligibility; readonly authorizationDigest: Hex }> {
    const authorization = Object.freeze(normalizeOpenMintAuthorization(input.authorization)), block = blockPin(input.block);
    const handle = input.handle, signature = input.signature;
    if (authorization.handleKey !== openMintHandleKey(handle) || authorization.tokenURIHash !== openMintTokenURIHash(input.tokenURI)
      || authorization.assessmentDigest !== hash(input.assessmentDigest) || authorization.artifactDigest !== hash(input.artifactDigest)) fail("Authorization commitment mismatch.");
    const domain = { chainId: this.#config.chainId, verifyingContract: this.#config.contract };
    if (!await verifyOpenMintAuthorization(domain, authorization, signature, this.#config.authorizer)) fail("Invalid authorizer signature.");
    const result = await this.#observe({ block, handle, recipient: authorization.recipient, nonce: authorization.nonce }, authorization);
    return Object.freeze({ eligibility: result.witness, authorizationDigest: openMintDigest(domain, authorization) });
  }
  async #observe(input: { block: PublicChainBlock; handle: string; recipient: string; nonce: Hex }, authorization?: ReturnType<typeof normalizeOpenMintAuthorization>) {
    const deadlineAt = performance.now() + this.#config.observationTimeoutMs;
    const c = this.#config, block = blockPin(input.block), handle = input.handle, handleKey = openMintHandleKey(handle), recipient = address(input.recipient), nonce = hash(input.nonce);
    if (block.number < c.deploymentBlock.number) fail("Observation precedes deployment.");
    const startedAt = clock(this.#now()), controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PublicChainGateError("Chain observation timed out.")); }, c.observationTimeoutMs); });
    const check = () => {
      // Resolved RPC promises can keep the event loop in microtasks and prevent
      // the timeout callback from running. Wall-clock freshness is independent.
      if (performance.now() >= deadlineAt) { controller.abort(); fail("Chain observation timed out."); }
      if (controller.signal.aborted) fail("Chain observation cancelled.");
    };
    try {
      check();
      const observations = await Promise.race([Promise.all(this.#rpcs.map(async rpc => {
        const request = async (method: Parameters<PublicChainRpc["request"]>[0], params: readonly unknown[]) => {
          check();
          const result = await rpc.request(method, params, controller.signal);
          check(); return result;
        };
        const getHeader = async (pin: PublicChainBlock) => header(await request("eth_getBlockByNumber", [numberToHex(pin.number), false]), pin);
        const [chainId, , , observed] = await Promise.all([request("eth_chainId", []).then(quantity),
          getHeader({ number: 0n, hash: c.genesisHash }), getHeader(c.deploymentBlock), getHeader(block)]);
        check();
        if (chainId !== c.chainId) fail("Chain ID disagrees.");
        const pinned = Object.freeze({ blockHash: block.hash, requireCanonical: true });
        const read = async (functionName: ReadName, args: readonly unknown[] = []) => {
          const data = encodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
          const raw = code(await request("eth_call", [{ to: c.contract, data }, pinned]));
          return decodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName, data: raw });
        };
        const [runtime, recipientCode, signer, domain, paused, minted, used, revoked, contractDigest] = await Promise.all([
          request("eth_getCode", [c.contract, pinned]).then(code), request("eth_getCode", [recipient, pinned]).then(code),
          read("trustedAuthorizer"), read("eip712Domain"), read("paused"), read("mintedHandle", [handleKey]),
          read("usedNonces", [nonce]), read("revokedNonces", [nonce]), authorization ? read("authorizationDigest", [authorization]) : Promise.resolve(undefined),
        ]);
        check();
        if (runtime === "0x" || keccak256(runtime) !== c.runtimeCodeHash) fail("Contract runtime code disagrees.");
        if (recipientCode !== "0x") fail("Recipient must have no deployed or delegated code.");
        if (address(signer) !== c.authorizer) fail("Trusted authorizer disagrees.");
        if (!Array.isArray(domain) || domain.length !== 7 || domain[0] !== "0x0f" || domain[1] !== "SignaturesOpenMint" || domain[2] !== "1"
          || domain[3] !== c.chainId || address(domain[4]) !== c.contract || domain[5] !== `0x${"00".repeat(32)}` || !Array.isArray(domain[6]) || domain[6].length !== 0) fail("EIP-712 domain disagrees.");
        if (paused !== false || minted !== false || used !== false || revoked !== false) fail("Mint is paused, claimed, or nonce unavailable.");
        if (authorization && contractDigest !== openMintDigest({ chainId: c.chainId, verifyingContract: c.contract }, authorization)) fail("Contract authorization digest disagrees.");
        const [endChain, endBlock] = await Promise.all([request("eth_chainId", []).then(quantity), getHeader(block)]);
        check();
        if (endChain !== c.chainId || endBlock.timestamp !== observed.timestamp) fail("Chain changed during observation.");
        return observed;
      })), deadline]);
      check();
      const [first, second] = observations;
      if (first.timestamp !== second.timestamp) fail("RPC sources disagree on block timestamp.");
      const observedAt = clock(this.#now()), blockTime = Number(first.timestamp) * 1000;
      if (observedAt < startedAt || observedAt - blockTime >= c.maxBlockAgeMs || blockTime - observedAt > c.maxFutureSkewMs) fail("Chain observation is stale or clock disagrees.");
      let validUntil = Math.min(observedAt + c.evidenceTtlMs, blockTime + c.maxBlockAgeMs);
      if (authorization) {
        const nowSeconds = BigInt(Math.floor(observedAt / 1000));
        if (authorization.issuedAt > first.timestamp || authorization.deadline < first.timestamp || authorization.issuedAt > nowSeconds || authorization.deadline <= nowSeconds) fail("Authorization is not active at block and wall clock.");
        validUntil = Math.min(validUntil, Number(authorization.deadline) * 1000);
      }
      const evidence: PublicChainEvidence = Object.freeze({ namespaceId: c.namespaceId, deploymentId: c.deploymentId, chainId: c.chainId,
        genesisHash: c.genesisHash, deploymentBlock: c.deploymentBlock, contract: c.contract, runtimeCodeHash: c.runtimeCodeHash, authorizer: c.authorizer,
        handle, handleKey, recipient, nonce, block: Object.freeze(first), observedAt, validUntil,
        sources: Object.freeze([this.#rpcs[0].id, this.#rpcs[1].id]) as readonly [string, string] });
      check();
      const witness = Object.freeze({}) as PublicChainEligibility;
      witnesses.set(witness, evidence);
      return { witness, evidence };
    } catch (error) {
      if (error instanceof PublicChainGateError) throw error;
      // RPC errors may embed a credential-bearing URL or provider response.
      throw new PublicChainGateError("Chain observation failed closed.");
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
