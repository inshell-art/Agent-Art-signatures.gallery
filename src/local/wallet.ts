import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256, parseAbi, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { buildExactSiweMessage } from "../v2/core/siwe.js";
import type { WalletBindingChallenge } from "../v2/model.js";
import type { MintAuthorizationResponse } from "../v2/service.js";
import { LOCAL_RPC_HTTP_OPTIONS } from "./nodePolicy.js";

// Anvil's publicly known test keys only. Never accept user-provided private keys.
const PUBLIC_ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const mintAccount = mnemonicToAccount(PUBLIC_ANVIL_MNEMONIC, { addressIndex: 6 });
const recipientAccount = mnemonicToAccount(PUBLIC_ANVIL_MNEMONIC, { addressIndex: 7 });
export const LOCAL_TEST_WALLET = mintAccount.address;
export const LOCAL_TEST_RECIPIENT = recipientAccount.address;
const ABI = parseAbi([
  "function mintAuthorized((bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch) a,string tokenURI,bytes galleryAttestation)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function transferFrom(address from,address to,uint256 tokenId)",
]);

export interface LocalTestWalletOptions {
  rpcUrl: string;
  contract: Address;
  runtimeCodeHash: Hex;
  appOrigin: string;
  /** Optional durable-runtime/process guard supplied by the rehearsal runner. */
  assertLocalGuard?: () => Promise<void>;
}

export function validateLocalWalletOptions(options: LocalTestWalletOptions): void {
  for (const [name, value] of [["RPC", options.rpcUrl], ["app", options.appOrigin]]) {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(`Local TEST wallet ${name} must be a plain HTTP 127.0.0.1 origin.`);
    }
  }
  getAddress(options.contract);
  if (!/^0x[0-9a-f]{64}$/i.test(options.runtimeCodeHash)) throw new Error("Local TEST wallet needs an exact runtime code hash.");
}

export function validateLocalMintPayload(payload: MintAuthorizationResponse, contract: Address): Hex {
  if (payload.localChainRehearsal !== true || payload.chainId !== "31337" || getAddress(payload.contract) !== getAddress(contract) || getAddress(payload.transaction.to) !== getAddress(contract) || payload.transaction.value !== "0x0" || getAddress(payload.authorization.mintWallet) !== LOCAL_TEST_WALLET) {
    throw new Error("Local TEST wallet accepts only its own zero-value Anvil mint at the pinned contract.");
  }
  const data = encodeFunctionData({ abi: ABI, functionName: "mintAuthorized", args: [
    { ...payload.authorization, validAfter: BigInt(payload.authorization.validAfter), deadline: BigInt(payload.authorization.deadline) },
    payload.tokenURI, payload.galleryAttestation,
  ] });
  if (data.toLowerCase() !== payload.transaction.data.toLowerCase()) throw new Error("Local TEST wallet mint calldata does not match the exact authorization.");
  return data;
}

/** A narrow, server-side rehearsal wallet, never an unrestricted JSON-RPC proxy.
 * Routes must resolve session-owned challenges/authorizations before calling it.
 */
export class LocalTestWallet {
  readonly address = LOCAL_TEST_WALLET;
  readonly recipientAddress = LOCAL_TEST_RECIPIENT;
  readonly chainId = "31337";
  readonly contract: Address;
  private readonly publicClient;
  private readonly walletClient;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: LocalTestWalletOptions) {
    validateLocalWalletOptions(options);
    this.contract = getAddress(options.contract);
    const chain = defineChain({ id: 31337, name: "Local Anvil TEST chain", nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [options.rpcUrl] } } });
    // Redirects may never turn a loopback-only request into an external request.
    const transport = () => http(options.rpcUrl, LOCAL_RPC_HTTP_OPTIONS);
    this.publicClient = createPublicClient({ chain, transport: transport() });
    this.walletClient = createWalletClient({ account: mintAccount, chain, transport: transport() });
  }

  async assertReady(): Promise<void> {
    await this.options.assertLocalGuard?.();
    const [chainId, code] = await Promise.all([this.publicClient.getChainId(), this.publicClient.getCode({ address: this.contract })]);
    if (chainId !== 31337 || !code || code === "0x" || keccak256(code).toLowerCase() !== this.options.runtimeCodeHash.toLowerCase()) {
      throw new Error("Local TEST wallet stopped: Anvil chain or pinned contract code changed.");
    }
  }

  async info() {
    await this.assertReady();
    return { chainId: this.chainId, address: this.address, recipientAddress: this.recipientAddress, contract: this.contract };
  }

  async signChallenge(challenge: WalletBindingChallenge): Promise<Hex> {
    if (challenge.status !== "pending" || challenge.chainId !== 31337n || getAddress(challenge.address) !== this.address || challenge.expiresAt.getTime() <= Date.now() || challenge.issuedAt.getTime() > Date.now()) throw new Error("Local TEST wallet challenge is expired, consumed, or addressed to another wallet/chain.");
    const origin = new URL(this.options.appOrigin);
    const exact = buildExactSiweMessage({ appOrigin: origin.origin, appHost: origin.host, walletAddress: this.address, chainId: 31337n, nonce: challenge.nonce, issuedAt: challenge.issuedAt, expirationTime: challenge.expiresAt, challengeId: challenge.challengeId, publicAccountId: challenge.publicAccountId });
    if (challenge.message !== exact) throw new Error("Local TEST wallet signs only the exact local wallet-link challenge.");
    await this.assertReady();
    return mintAccount.signMessage({ message: exact });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  async submitMint(payload: MintAuthorizationResponse): Promise<Hex> {
    const data = validateLocalMintPayload(payload, this.contract);
    return this.serial(async () => {
      await this.assertReady();
      const transaction = { account: mintAccount, to: this.contract, data, value: 0n } as const;
      await this.publicClient.call(transaction);
      const gas = await this.publicClient.estimateGas(transaction);
      return this.walletClient.sendTransaction({ ...transaction, gas });
    });
  }

  async transferToRecipient(tokenId: bigint): Promise<Hex> {
    if (tokenId < 0n || tokenId >= (1n << 256n)) throw new Error("Invalid local token ID.");
    return this.serial(async () => {
      await this.assertReady();
      const owner = await this.publicClient.readContract({ address: this.contract, abi: ABI, functionName: "ownerOf", args: [tokenId] });
      if (getAddress(owner) !== this.address) throw new Error("The local TEST wallet no longer owns this token.");
      const data = encodeFunctionData({ abi: ABI, functionName: "transferFrom", args: [this.address, this.recipientAddress, tokenId] });
      const transaction = { account: mintAccount, to: this.contract, data, value: 0n } as const;
      await this.publicClient.call(transaction);
      const gas = await this.publicClient.estimateGas(transaction);
      return this.walletClient.sendTransaction({ ...transaction, gas });
    });
  }
}
