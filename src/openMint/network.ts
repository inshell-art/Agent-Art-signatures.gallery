import {
  createPublicClient, encodeFunctionData, getAddress, http, keccak256, numberToHex, parseAbiItem,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { MintConfidence } from "./revealPolicy.js";
import {
  OPEN_MINT_ABI, normalizeOpenMintAuthorization, openMintHandleKey, openMintTokenURIHash,
  signOpenMintAuthorization, verifyOpenMintAuthorization, type OpenMintAuthorization,
} from "./authorization.js";

export interface OpenMintChainState {
  state: MintConfidence;
  tokenId?: string;
  wallet?: string;
  transactionHash?: Hex;
  assessmentDigest?: Hex;
  artifactDigest?: Hex;
  tokenURIHash?: Hex;
}
export interface OpenMintTransaction {
  from: Address;
  to: Address;
  data: Hex;
  value: "0x0";
  chainId: Hex;
}
/** A trusted RPC snapshot used to identify the exact local chain, not just its chain ID. */
export interface OpenMintWalletContext {
  chainId: Hex;
  contract: Address;
  blockNumber: Hex;
  blockHash: Hex;
  /** The next usable transaction nonce, supplied only for a validated recipient. */
  nonce?: Hex;
}
export interface OpenMintNetwork {
  chainId: number;
  address: Address;
  authorizer: Address;
  /** Canonical latest block timestamp, in seconds. */
  now(): Promise<number>;
  /** Read-only eligibility check before spending assessment credits. */
  preflight?(recipient: Address): Promise<void>;
  /** Read-only chain fingerprint and fresh recipient nonce. Callers must fail closed if unavailable. */
  walletContext?(recipient?: Address): Promise<OpenMintWalletContext>;
  state(handle: string): Promise<OpenMintChainState>;
  transaction(handle: string, a: OpenMintAuthorization, tokenURI: string, signature: Hex): Promise<OpenMintTransaction>;
  sign(a: OpenMintAuthorization): Promise<Hex>;
}
export interface OpenMintNetworkConfig {
  rpcUrl: string;
  contract: Address;
  authorizerPrivateKey: Hex;
  expectedCodeHash: Hex;
  confirmations?: number;
  deploymentBlock?: bigint;
}
export interface OpenMintBlock { number: bigint; hash: Hex; timestamp: bigint }
export interface OpenMintLog {
  address: Address;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  removed: boolean;
  args: {
    handleKey: Hex; nonce: Hex; recipient: Address; tokenId: bigint; normalizedHandle: string;
    assessmentDigest: Hex; artifactDigest: Hex; tokenURIHash: Hex; authorizationDigest: Hex;
  };
}
/** Read and simulate only. No transaction-send, mining, or wallet RPC capability. */
export interface OpenMintRpc {
  chainId(): Promise<number>;
  block(number?: bigint): Promise<OpenMintBlock>;
  code(address: Address, number: bigint): Promise<Hex | undefined>;
  transactionCount(address: Address, blockTag: "latest" | "pending"): Promise<number>;
  read(address: Address, name: string, args: readonly unknown[], number: bigint): Promise<unknown>;
  logs(address: Address, handleKey: Hex, from: bigint, to: bigint): Promise<OpenMintLog[]>;
  simulate(tx: OpenMintTransaction, number: bigint): Promise<void>;
}

const MINT_EVENT = parseAbiItem("event OpenSignatureMinted(bytes32 indexed handleKey,bytes32 indexed nonce,address indexed recipient,uint256 tokenId,string normalizedHandle,bytes32 assessmentDigest,bytes32 artifactDigest,bytes32 tokenURIHash,bytes32 authorizationDigest)");
const CHAIN_ID = 31337;
const nonzero32 = (value: string) => /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function assertOpenMintLocalRpc(value: string): void {
  const url = new URL(value);
  check(/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(value)
    && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "Open mint requires a literal loopback HTTP RPC origin.");
}

function createRpc(rpcUrl: string): OpenMintRpc {
  assertOpenMintLocalRpc(rpcUrl);
  const client = createPublicClient({ transport: http(rpcUrl, {
    retryCount: 0, timeout: 30_000, fetchOptions: { redirect: "error" },
  }) });
  return {
    chainId: () => client.getChainId(),
    async block(number) {
      const block = await client.getBlock(number === undefined ? { blockTag: "latest" } : { blockNumber: number });
      check(block.number !== null && block.hash !== null, "Canonical block is unavailable.");
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    code: (address, blockNumber) => client.getCode({ address, blockNumber }),
    transactionCount: (address, blockTag) => client.getTransactionCount({ address, blockTag }),
    read: (address, functionName, args, blockNumber) => client.readContract({ address, abi: OPEN_MINT_ABI, functionName, args, blockNumber } as never),
    async logs(address, handleKey, fromBlock, toBlock) {
      const logs = await client.getLogs({ address, event: MINT_EVENT, args: { handleKey }, fromBlock, toBlock, strict: true });
      return logs.map(log => {
        check(log.blockNumber !== null && log.blockHash !== null && log.transactionHash !== null, "Pending mint log is unavailable.");
        return { address: log.address, blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash, removed: log.removed, args: log.args };
      });
    },
    async simulate(tx, blockNumber) {
      await client.call({ account: tx.from, to: tx.to, data: tx.data, value: 0n, blockNumber });
    },
  };
}

/** Local Anvil confirmation adapter. It never publishes or broadcasts a transaction. */
export function createLocalOpenMintNetwork(config: OpenMintNetworkConfig, injectedRpc?: OpenMintRpc): OpenMintNetwork {
  assertOpenMintLocalRpc(config.rpcUrl);
  check(nonzero32(config.expectedCodeHash), "Expected runtime code hash must be a nonzero bytes32.");
  const address = getAddress(config.contract);
  check(!/^0x0{40}$/i.test(address), "Open mint contract must be nonzero.");
  const signer = privateKeyToAccount(config.authorizerPrivateKey);
  const confirmations = config.confirmations ?? 2;
  check(Number.isSafeInteger(confirmations) && confirmations >= 1, "Confirmations must be a positive safe integer.");
  const deploymentBlock = config.deploymentBlock ?? 0n;
  check(deploymentBlock >= 0n, "Deployment block must be nonnegative.");
  const rpc = injectedRpc ?? createRpc(config.rpcUrl);
  const domain = { chainId: CHAIN_ID, verifyingContract: address };

  async function trustedBlock(): Promise<OpenMintBlock> {
    check(await rpc.chainId() === CHAIN_ID, "Open mint only supports local chain 31337.");
    const block = await rpc.block();
    check(block.number >= deploymentBlock, "Deployment block is not canonical yet.");
    const code = await rpc.code(address, block.number);
    check(code && code !== "0x" && same(keccak256(code), config.expectedCodeHash), "Open mint contract runtime code mismatch.");
    const authorizer = await rpc.read(address, "trustedAuthorizer", [], block.number);
    check(typeof authorizer === "string" && same(authorizer, signer.address), "Open mint trusted authorizer mismatch.");
    return block;
  }
  async function requireStable(block: OpenMintBlock): Promise<void> {
    const after = await rpc.block(block.number);
    check(after.hash === block.hash && after.number === block.number, "Canonical block changed during open mint verification.");
  }
  const read = (name: string, args: readonly unknown[], block: OpenMintBlock) => rpc.read(address, name, args, block.number);

  async function available(a: OpenMintAuthorization, block: OpenMintBlock): Promise<void> {
    check(block.timestamp >= a.issuedAt && block.timestamp <= a.deadline, "Open mint authorization is not currently active.");
    const [minted, used, revoked, paused, code] = await Promise.all([
      read("mintedHandle", [a.handleKey], block), read("usedNonces", [a.nonce], block),
      read("revokedNonces", [a.nonce], block), read("paused", [], block), rpc.code(a.recipient, block.number),
    ]);
    check(minted === false, "This handle has already minted.");
    check(used === false && revoked === false, "Open mint authorization nonce is unavailable.");
    check(paused === false, "Open mint is paused.");
    check(code === undefined || code === "0x", "Open mint only supports recipient EOAs without code.");
  }

  return {
    chainId: CHAIN_ID,
    address,
    authorizer: signer.address,
    async now() {
      const block = await trustedBlock();
      check(block.timestamp >= 0n && block.timestamp <= BigInt(Number.MAX_SAFE_INTEGER), "Block timestamp is outside the safe integer range.");
      await requireStable(block);
      return Number(block.timestamp);
    },
    async walletContext(recipient) {
      const wallet = recipient === undefined ? undefined : getAddress(recipient);
      check(wallet === undefined || !/^0x0{40}$/i.test(wallet), "Open mint recipient must be nonzero.");
      const block = await trustedBlock();
      const context: OpenMintWalletContext = {
        chainId: numberToHex(CHAIN_ID), contract: address,
        blockNumber: numberToHex(block.number), blockHash: block.hash,
      };
      if (wallet !== undefined) {
        const [latest, pending] = await Promise.all([
          rpc.transactionCount(wallet, "latest"), rpc.transactionCount(wallet, "pending"),
        ]);
        check(Number.isSafeInteger(latest) && latest >= 0 && Number.isSafeInteger(pending) && pending >= 0,
          "Wallet transaction nonce is outside the safe integer range.");
        check(latest === pending,
          "This wallet has a pending transaction on the local chain. Wait for it to confirm before continuing the mint.");
        context.nonce = numberToHex(pending);
      }
      await requireStable(block);
      return context;
    },
    async preflight(recipient) {
      const wallet = getAddress(recipient);
      check(!/^0x0{40}$/i.test(wallet), "Open mint recipient must be nonzero.");
      const block = await trustedBlock();
      const [paused, recipientCode] = await Promise.all([read("paused", [], block), rpc.code(wallet, block.number)]);
      check(paused === false, "Open mint is paused.");
      check(recipientCode === undefined || recipientCode === "0x", "Open mint only supports recipient EOAs without code.");
      await requireStable(block);
    },
    async state(handle) {
      const key = openMintHandleKey(handle);
      const block = await trustedBlock();
      const minted = await read("mintedHandle", [key], block);
      check(typeof minted === "boolean", "Invalid minted handle response.");
      if (!minted) { await requireStable(block); return { state: "unminted" }; }
      const tokenId = BigInt(key);
      const [rawProvenance, rawWallet, rawURI, logs] = await Promise.all([
        read("provenance", [tokenId], block), read("ownerOf", [tokenId], block), read("tokenURI", [tokenId], block),
        rpc.logs(address, key, deploymentBlock, block.number),
      ]);
      check(Array.isArray(rawProvenance) && rawProvenance.length === 6 && rawProvenance.every(value => typeof value === "string"), "Mint provenance is unavailable.");
      const [normalizedHandle, assessmentDigest, artifactDigest, mintRecipient, tokenURIHash, authorizationDigest] = rawProvenance as [string, Hex, Hex, Address, Hex, Hex];
      check(normalizedHandle === handle && [assessmentDigest, artifactDigest, tokenURIHash, authorizationDigest].every(nonzero32), "Mint provenance does not match the handle.");
      check(typeof rawURI === "string" && openMintTokenURIHash(rawURI) === tokenURIHash, "Mint token URI commitment mismatch.");
      check(typeof rawWallet === "string", "Token owner is unavailable.");
      const wallet = getAddress(rawWallet);
      check(!/^0x0{40}$/i.test(wallet), "Token owner is zero.");
      check(logs.length === 1, "Exactly one canonical mint event is required.");
      const log = logs[0];
      check(!log.removed && same(log.address, address) && log.blockNumber >= deploymentBlock && log.blockNumber <= block.number,
        "Mint event is not canonical.");
      const args = log.args;
      check(args.handleKey === key && args.tokenId === tokenId && args.normalizedHandle === handle
        && same(args.recipient, mintRecipient) && args.assessmentDigest === assessmentDigest
        && args.artifactDigest === artifactDigest && args.tokenURIHash === tokenURIHash
        && args.authorizationDigest === authorizationDigest && nonzero32(args.nonce), "Mint event and immutable provenance disagree.");
      const mintBlock = await rpc.block(log.blockNumber);
      check(mintBlock.hash === log.blockHash, "Mint event was reorganized out of the canonical chain.");
      await requireStable(block);
      return {
        state: block.number - log.blockNumber + 1n >= BigInt(confirmations) ? "minted" : "confirming",
        tokenId: tokenId.toString(), wallet, transactionHash: log.transactionHash,
        assessmentDigest, artifactDigest, tokenURIHash,
      };
    },
    async sign(input) {
      const a = normalizeOpenMintAuthorization(input);
      const block = await trustedBlock();
      await available(a, block);
      await requireStable(block);
      return signOpenMintAuthorization(domain, a, signer);
    },
    async transaction(handle, input, tokenURI, signature) {
      const a = normalizeOpenMintAuthorization(input);
      check(openMintHandleKey(handle) === a.handleKey, "Authorization handle mismatch.");
      check(openMintTokenURIHash(tokenURI) === a.tokenURIHash, "Authorization token URI mismatch.");
      const block = await trustedBlock();
      check(await verifyOpenMintAuthorization(domain, a, signature, signer.address), "Invalid open mint authorization signature.");
      await available(a, block);
      const transaction: OpenMintTransaction = {
        from: a.recipient, to: address,
        data: encodeFunctionData({ abi: OPEN_MINT_ABI, functionName: "mint", args: [handle, a, tokenURI, signature] }),
        value: "0x0", chainId: numberToHex(CHAIN_ID),
      };
      await rpc.simulate(transaction, block.number);
      await requireStable(block);
      return transaction;
    },
  };
}
