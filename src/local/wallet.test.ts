import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, parseAbi, recoverMessageAddress, type Hex } from "viem";
import { buildExactSiweMessage } from "../v2/core/siwe.js";
import type { WalletBindingChallenge } from "../v2/model.js";
import type { MintAuthorizationResponse } from "../v2/service.js";

const rpc = vi.hoisted(() => ({
  getChainId: vi.fn(), getCode: vi.fn(), call: vi.fn(), estimateGas: vi.fn(), readContract: vi.fn(), sendTransaction: vi.fn(),
}));
vi.mock("viem", async (original) => ({ ...await original<typeof import("viem")>(), createPublicClient: () => rpc, createWalletClient: () => rpc }));
import { LOCAL_TEST_RECIPIENT, LOCAL_TEST_WALLET, LocalTestWallet, validateLocalMintPayload, validateLocalWalletOptions } from "./wallet.js";

const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const HASH = `0x${"12".repeat(32)}` as Hex;
const TX = `0x${"34".repeat(32)}` as Hex;
const options = { rpcUrl: "http://127.0.0.1:8545", appOrigin: "http://127.0.0.1:3000", contract: CONTRACT, runtimeCodeHash: keccak256("0x1234") } as const;
const ABI = parseAbi(["function mintAuthorized((bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch) a,string tokenURI,bytes galleryAttestation)"]);

function payload(): MintAuthorizationResponse {
  const authorization = { signatureDigest: HASH, walletBindingId: HASH, mintWallet: LOCAL_TEST_WALLET, svgSha256: HASH, pngSha256: HASH, metadataSha256: HASH, tokenURIHash: HASH, authorizationId: HASH, validAfter: "1", deadline: "2", authorizerEpoch: 1 };
  const tokenURI = "ipfs://test";
  const galleryAttestation = `0x${"11".repeat(65)}` as Hex;
  const data = encodeFunctionData({ abi: ABI, functionName: "mintAuthorized", args: [{ ...authorization, validAfter: 1n, deadline: 2n }, tokenURI, galleryAttestation] });
  return { authorization, tokenURI, galleryAttestation, authorizer: CONTRACT, chainId: "31337", contract: CONTRACT, localChainRehearsal: true, transaction: { to: CONTRACT, value: "0x0", data } };
}

function challenge(): WalletBindingChallenge {
  const issuedAt = new Date(Date.now() - 1000);
  const expiresAt = new Date(Date.now() + 60_000);
  const result: WalletBindingChallenge = { challengeId: "wc1_local", sessionIdDigest: "session", xUserId: "local:alice", publicAccountId: "public-account", address: LOCAL_TEST_WALLET, chainId: 31337n, nonce: "A".repeat(22), issuedAt, expiresAt, status: "pending", message: "" };
  result.message = buildExactSiweMessage({ appHost: "127.0.0.1:3000", appOrigin: options.appOrigin, walletAddress: result.address, chainId: result.chainId, nonce: result.nonce, issuedAt, expirationTime: expiresAt, challengeId: result.challengeId, publicAccountId: result.publicAccountId });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.getChainId.mockResolvedValue(31337);
  rpc.getCode.mockResolvedValue("0x1234");
  rpc.call.mockResolvedValue({ data: "0x" });
  rpc.estimateGas.mockResolvedValue(100000n);
  rpc.readContract.mockResolvedValue(LOCAL_TEST_WALLET);
  rpc.sendTransaction.mockResolvedValue(TX);
});

describe("restricted local TEST wallet", () => {
  it.each(["https://127.0.0.1:8545", "http://localhost:8545", "http://example.com:8545", "http://user:pass@127.0.0.1:8545", "http://127.0.0.1:8545/proxy", "http://127.0.0.1:8545?upstream=mainnet"])("rejects a nonliteral/nonlocal RPC origin %s", (rpcUrl) => {
    expect(() => validateLocalWalletOptions({ ...options, rpcUrl })).toThrow("127.0.0.1 origin");
  });

  it("exposes exactly two public Anvil test accounts and no keys", async () => {
    const info = await new LocalTestWallet(options).info();
    expect(info).toEqual({ chainId: "31337", address: LOCAL_TEST_WALLET, recipientAddress: LOCAL_TEST_RECIPIENT, contract: CONTRACT });
    expect(info.address).not.toBe(info.recipientAddress);
  });

  it("signs the exact local SIWE message as the public test wallet", async () => {
    const exact = challenge();
    const signature = await new LocalTestWallet(options).signChallenge(exact);
    expect(await recoverMessageAddress({ message: exact.message, signature })).toBe(LOCAL_TEST_WALLET);
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("signs a mint-specific proof and rejects a substituted claim target", async () => {
    const exact = challenge();
    exact.mintTarget = { signatureId: `sg1_${"a".repeat(52)}`, claimInstanceId: "00000000-0000-4000-8000-000000000001" };
    exact.message = buildExactSiweMessage({ appHost: "127.0.0.1:3000", appOrigin: options.appOrigin, walletAddress: exact.address,
      chainId: exact.chainId, nonce: exact.nonce, issuedAt: exact.issuedAt, expirationTime: exact.expiresAt,
      challengeId: exact.challengeId, publicAccountId: exact.publicAccountId, mintTarget: exact.mintTarget });
    const signature = await new LocalTestWallet(options).signChallenge(exact);
    expect(await recoverMessageAddress({ message: exact.message, signature })).toBe(LOCAL_TEST_WALLET);
    exact.mintTarget.signatureId = `sg1_${"b".repeat(52)}`;
    await expect(new LocalTestWallet(options).signChallenge(exact)).rejects.toThrow("exact local recipient-control");
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it.each(["message", "chain", "address", "expiry", "status"])("rejects a wallet challenge with the wrong %s", async (field) => {
    const exact = challenge();
    if (field === "message") exact.message += "\nSend assets";
    if (field === "chain") exact.chainId = 1n;
    if (field === "address") exact.address = LOCAL_TEST_RECIPIENT;
    if (field === "expiry") exact.expiresAt = new Date(0);
    if (field === "status") exact.status = "consumed";
    await expect(new LocalTestWallet(options).signChallenge(exact)).rejects.toThrow();
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it.each(["chain", "code", "guard"])("fails closed before signing or submitting when the %s guard fails", async (field) => {
    if (field === "chain") rpc.getChainId.mockResolvedValue(1);
    if (field === "code") rpc.getCode.mockResolvedValue("0xabcd");
    const wallet = new LocalTestWallet({ ...options, assertLocalGuard: async () => { if (field === "guard") throw new Error("Owned process changed"); } });
    await expect(wallet.signChallenge(challenge())).rejects.toThrow();
    await expect(wallet.submitMint(payload())).rejects.toThrow();
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it.each(["chain", "target", "from", "calldata", "tokenURI", "fixture"])("rejects a mint with mismatched %s", (field) => {
    const mint = payload();
    if (field === "chain") mint.chainId = "1";
    if (field === "target") mint.transaction.to = LOCAL_TEST_RECIPIENT;
    if (field === "from") mint.authorization.mintWallet = LOCAL_TEST_RECIPIENT;
    if (field === "calldata") mint.transaction.data += "00";
    if (field === "tokenURI") mint.tokenURI += "x";
    if (field === "fixture") { delete mint.localChainRehearsal; mint.fixture = true; }
    expect(() => validateLocalMintPayload(mint, CONTRACT)).toThrow();
  });

  it("simulates and estimates before the exact zero-value mint; failed calls do not poison retry", async () => {
    const wallet = new LocalTestWallet(options);
    rpc.call.mockRejectedValueOnce(new Error("simulation rejected"));
    await expect(wallet.submitMint(payload())).rejects.toThrow("simulation rejected");
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
    await expect(wallet.submitMint(payload())).resolves.toBe(TX);
    expect(rpc.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: CONTRACT, data: payload().transaction.data, value: 0n, gas: 100000n }));
  });

  it("transfers only from the test wallet to the fixed second test wallet", async () => {
    await expect(new LocalTestWallet(options).transferToRecipient(42n)).resolves.toBe(TX);
    const abi = parseAbi(["function transferFrom(address from,address to,uint256 tokenId)"]);
    const data = encodeFunctionData({ abi, functionName: "transferFrom", args: [LOCAL_TEST_WALLET, LOCAL_TEST_RECIPIENT, 42n] });
    expect(rpc.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: CONTRACT, value: 0n, data }));
    rpc.readContract.mockResolvedValue(LOCAL_TEST_RECIPIENT);
    await expect(new LocalTestWallet(options).transferToRecipient(42n)).rejects.toThrow("no longer owns");
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
