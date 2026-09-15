import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { OPEN_MINT_ABI, openMintDigest, openMintHandleKey, openMintTokenURIHash, verifyOpenMintAuthorization, type OpenMintAuthorization } from "./authorization.js";
import { assertOpenMintLocalRpc, createLocalOpenMintNetwork, type OpenMintBlock, type OpenMintLog, type OpenMintNetworkConfig, type OpenMintRpc } from "./network.js";

const bytes32 = (byte: string): Hex => `0x${byte.repeat(32)}`;
const code = "0x60006000" as Hex;
const contract = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const other = "0x3333333333333333333333333333333333333333" as Address;
const key = `0x${"0".repeat(63)}1` as Hex;
const authorizer = privateKeyToAccount(key).address;
const uri = "ipfs://open-mint-vector/metadata.json";
const config: OpenMintNetworkConfig = {
  rpcUrl: "http://127.0.0.1:8545", contract, authorizerPrivateKey: key, expectedCodeHash: keccak256(code), deploymentBlock: 2n,
};
const a: OpenMintAuthorization = {
  handleKey: openMintHandleKey("bigu"), assessmentDigest: bytes32("22"), artifactDigest: bytes32("33"),
  recipient, tokenURIHash: openMintTokenURIHash(uri), nonce: bytes32("44"), issuedAt: 1800000000n, deadline: 1800000900n,
};
const digest = openMintDigest({ chainId: 31337, verifyingContract: contract }, a);

function fixture() {
  const latest: OpenMintBlock = { number: 10n, hash: bytes32("10"), timestamp: 1800000060n };
  let minted = false;
  const log: OpenMintLog = {
    address: contract, blockNumber: 9n, blockHash: bytes32("09"), transactionHash: bytes32("aa"), removed: false,
    args: { ...a, tokenId: BigInt(a.handleKey), normalizedHandle: "bigu", authorizationDigest: digest },
  };
  const responses: Record<string, unknown> = {
    trustedAuthorizer: authorizer, usedNonces: false, revokedNonces: false, paused: false,
    provenance: ["bigu", a.assessmentDigest, a.artifactDigest, recipient, a.tokenURIHash, digest],
    ownerOf: recipient, tokenURI: uri,
  };
  const rpc: OpenMintRpc = {
    chainId: vi.fn(async () => 31337),
    block: vi.fn(async (number?: bigint) => number === 9n ? { ...latest, number: 9n, hash: log.blockHash } : { ...latest }),
    code: vi.fn(async (address: Address) => address === contract ? code : "0x"),
    transactionCount: vi.fn(async () => 1),
    read: vi.fn(async (_address, name) => name === "mintedHandle" ? minted : responses[name]),
    logs: vi.fn(async () => [structuredClone(log)]),
    simulate: vi.fn(async () => {}),
  };
  const network = createLocalOpenMintNetwork(config, rpc);
  return { network, rpc, latest, log, responses, minted: () => { minted = true; } };
}

describe("local open mint network", () => {
  it.each(["http://127.0.0.1:8545", "http://127.0.0.1/", "http://[::1]:9545/"])("accepts literal loopback %s", url => {
    expect(() => assertOpenMintLocalRpc(url)).not.toThrow();
  });

  it.each([
    "https://127.0.0.1:8545", "http://localhost:8545", "http://example.com:8545", "http://192.168.1.1:8545",
    "http://127.0.0.1.evil.test", "http://user:secret@127.0.0.1:8545", "http://127.0.0.1:8545/rpc",
    "http://127.0.0.1:8545/?key=secret", "http://127.0.0.1:8545/#x", "http://2130706433:8545", "file:///tmp/rpc",
  ])("rejects unsafe or remote RPC %s", url => {
    expect(() => createLocalOpenMintNetwork({ ...config, rpcUrl: url }, fixture().rpc)).toThrow();
  });

  it("reads chain timestamp and unminted state at one stable trusted block", async () => {
    const { network, rpc } = fixture();
    expect(network.chainId).toBe(31337);
    expect(network.address).toBe(contract);
    expect(network.authorizer).toBe(authorizer);
    expect(await network.now()).toBe(1800000060);
    expect(await network.state("bigu")).toEqual({ state: "unminted" });
    expect(rpc.code).toHaveBeenCalledWith(contract, 10n);
    expect(rpc.read).toHaveBeenCalledWith(contract, "trustedAuthorizer", [], 10n);
    expect(rpc.logs).not.toHaveBeenCalled();
  });

  it("signs only eligible authorizations and builds an EOA zero-value transaction without broadcasting", async () => {
    const { network, rpc } = fixture();
    const signature = await network.sign(a);
    expect(await verifyOpenMintAuthorization({ chainId: 31337, verifyingContract: contract }, a, signature, authorizer)).toBe(true);
    const tx = await network.transaction("bigu", a, uri, signature);
    expect(tx).toMatchObject({ from: recipient, to: contract, value: "0x0", chainId: "0x7a69" });
    const call = decodeFunctionData({ abi: OPEN_MINT_ABI, data: tx.data });
    expect(call.functionName).toBe("mint");
    expect(call.args).toEqual(["bigu", a, uri, signature]);
    expect(rpc.simulate).toHaveBeenCalledWith(tx, 10n);
  });

  it("returns a trusted block fingerprint without requesting a wallet or transaction nonce", async () => {
    const f = fixture();
    expect(await f.network.walletContext!()).toEqual({
      chainId: "0x7a69", contract, blockNumber: "0xa", blockHash: f.latest.hash,
    });
    expect(f.rpc.code).toHaveBeenCalledWith(contract, 10n);
    expect(f.rpc.read).toHaveBeenCalledWith(contract, "trustedAuthorizer", [], 10n);
    expect(f.rpc.block).toHaveBeenCalledWith(10n);
    expect(f.rpc.transactionCount).not.toHaveBeenCalled();
    expect(f.rpc.simulate).not.toHaveBeenCalled();
  });

  it("supplies a fresh explicit nonce from the trusted RPC instead of wallet history", async () => {
    const f = fixture();
    expect(await f.network.walletContext!(recipient)).toMatchObject({ nonce: "0x1", blockHash: f.latest.hash });
    expect(f.rpc.transactionCount).toHaveBeenCalledWith(recipient, "latest");
    expect(f.rpc.transactionCount).toHaveBeenCalledWith(recipient, "pending");
    vi.mocked(f.rpc.transactionCount).mockResolvedValue(2);
    expect(await f.network.walletContext!(recipient)).toMatchObject({ nonce: "0x2" });
    expect(f.rpc.transactionCount).toHaveBeenCalledTimes(4);
    expect(f.rpc.simulate).not.toHaveBeenCalled();
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts safe transaction nonce %s", async nonce => {
    const f = fixture();
    vi.mocked(f.rpc.transactionCount).mockResolvedValue(nonce);
    expect((await f.network.walletContext!(recipient)).nonce).toBe(`0x${nonce.toString(16)}`);
  });

  it.each(["latest", "pending"] as const)("rejects invalid %s transaction nonces", async invalidTag => {
    const f = fixture();
    for (const nonce of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      vi.mocked(f.rpc.transactionCount).mockImplementation(async (_address, tag) => tag === invalidTag ? nonce : 1);
      await expect(f.network.walletContext!(recipient)).rejects.toThrow(/nonce is outside the safe integer range/);
    }
  });

  it.each([[1, 2], [2, 1], [1, 410]])("refuses inconsistent latest=%s pending=%s nonces instead of replacing transactions", async (latest, pending) => {
    const f = fixture();
    vi.mocked(f.rpc.transactionCount).mockImplementation(async (_address, tag) => tag === "latest" ? latest : pending);
    await expect(f.network.walletContext!(recipient)).rejects.toThrow(/pending transaction/);
    expect(f.rpc.simulate).not.toHaveBeenCalled();
  });

  it("rejects malformed or zero wallet addresses before reading a nonce", async () => {
    const f = fixture();
    await expect(f.network.walletContext!("invalid" as Address)).rejects.toThrow();
    await expect(f.network.walletContext!(`0x${"0".repeat(40)}`)).rejects.toThrow(/must be nonzero/);
    expect(f.rpc.transactionCount).not.toHaveBeenCalled();
  });

  it("fails closed on nonce RPC failures and chain reorganization during a wallet context read", async () => {
    const f = fixture();
    vi.mocked(f.rpc.transactionCount).mockRejectedValue(new Error("RPC unavailable"));
    await expect(f.network.walletContext!(recipient)).rejects.toThrow(/RPC unavailable/);
    const fresh = fixture();
    vi.mocked(fresh.rpc.block).mockImplementation(async number => ({ ...fresh.latest, hash: number === undefined ? bytes32("10") : bytes32("ff") }));
    await expect(fresh.network.walletContext!(recipient)).rejects.toThrow(/Canonical block changed/);
    await expect(fresh.network.walletContext!()).rejects.toThrow(/Canonical block changed/);
  });

  it("preflights unpaused minting and recipient eligibility at one stable trusted block without signing or simulation", async () => {
    const f = fixture();
    await f.network.preflight!(recipient);
    expect(f.rpc.read).toHaveBeenCalledWith(contract, "paused", [], 10n);
    expect(f.rpc.code).toHaveBeenCalledWith(recipient, 10n);
    expect(f.rpc.block).toHaveBeenCalledWith(10n);
    expect(f.rpc.logs).not.toHaveBeenCalled();
    expect(f.rpc.simulate).not.toHaveBeenCalled();
  });

  it.each(["paused", "recipient code", "unknown pause state", "reorganized"])("rejects %s before assessment preparation", async reason => {
    const f = fixture();
    if (reason === "paused") f.responses.paused = true;
    if (reason === "unknown pause state") f.responses.paused = undefined;
    if (reason === "recipient code") vi.mocked(f.rpc.code).mockResolvedValue(code);
    if (reason === "reorganized") vi.mocked(f.rpc.block).mockImplementation(async number => ({ ...f.latest, hash: number === undefined ? bytes32("10") : bytes32("ff") }));
    await expect(f.network.preflight!(recipient)).rejects.toThrow();
    expect(f.rpc.simulate).not.toHaveBeenCalled();
  });

  it("returns pending before the configured confirmation count and minted after", async () => {
    const f = fixture(); f.minted();
    f.log.blockNumber = 10n; f.log.blockHash = f.latest.hash;
    expect(await f.network.state("bigu")).toEqual({ state: "pending", tokenId: BigInt(a.handleKey).toString(), wallet: recipient,
      transactionHash: f.log.transactionHash, assessmentDigest: a.assessmentDigest, artifactDigest: a.artifactDigest, tokenURIHash: a.tokenURIHash });
    f.latest.number = 11n;
    vi.mocked(f.rpc.block).mockImplementation(async number => number === 10n ? { number: 10n, hash: f.log.blockHash, timestamp: 1800000060n } : { ...f.latest });
    expect((await f.network.state("bigu")).state).toBe("minted");
    expect(f.rpc.logs).toHaveBeenCalledWith(contract, a.handleKey, 2n, 11n);
  });

  it("reports current transferred owner while preserving assessment and artifact provenance", async () => {
    const f = fixture(); f.minted(); f.responses.ownerOf = other;
    const state = await f.network.state("bigu");
    expect(state.state).toBe("minted");
    expect(state.wallet).toBe(other);
    expect(state.assessmentDigest).toBe(a.assessmentDigest);
    expect(state.artifactDigest).toBe(a.artifactDigest);
  });

  it.each(["chain", "code", "authorizer"])("fails closed on wrong %s for reads and signing", async kind => {
    const f = fixture();
    if (kind === "chain") vi.mocked(f.rpc.chainId).mockResolvedValue(1);
    if (kind === "code") vi.mocked(f.rpc.code).mockResolvedValue("0x6001");
    if (kind === "authorizer") f.responses.trustedAuthorizer = other;
    await expect(f.network.now()).rejects.toThrow();
    await expect(f.network.preflight!(recipient)).rejects.toThrow();
    await expect(f.network.state("bigu")).rejects.toThrow();
    await expect(f.network.walletContext!()).rejects.toThrow();
    await expect(f.network.walletContext!(recipient)).rejects.toThrow();
    await expect(f.network.sign(a)).rejects.toThrow();
    expect(f.rpc.simulate).not.toHaveBeenCalled();
  });

  it("rechecks trust for transaction preparation after authorizer rotation", async () => {
    const f = fixture(); const signature = await f.network.sign(a);
    f.responses.trustedAuthorizer = other;
    await expect(f.network.transaction("bigu", a, uri, signature)).rejects.toThrow(/authorizer mismatch/);
  });

  it.each(["usedNonces", "revokedNonces", "paused"])("refuses signing and transaction preparation for %s", async field => {
    const f = fixture(); const signature = await f.network.sign(a); f.responses[field] = true;
    await expect(f.network.sign(a)).rejects.toThrow();
    await expect(f.network.transaction("bigu", a, uri, signature)).rejects.toThrow();
    expect(f.rpc.simulate).not.toHaveBeenCalled();
  });

  it("rejects already minted handles even with a new nonce or MBTI assessment", async () => {
    const f = fixture(); f.minted();
    await expect(f.network.sign({ ...a, nonce: bytes32("55"), assessmentDigest: bytes32("66"), artifactDigest: bytes32("77") })).rejects.toThrow(/already minted/);
  });

  it("rejects future, expired, and contract-wallet authorizations", async () => {
    const f = fixture();
    f.latest.timestamp = a.issuedAt - 1n; await expect(f.network.sign(a)).rejects.toThrow(/not currently active/);
    f.latest.timestamp = a.deadline + 1n; await expect(f.network.sign(a)).rejects.toThrow(/not currently active/);
    f.latest.timestamp = a.issuedAt;
    vi.mocked(f.rpc.code).mockResolvedValue(code);
    await expect(f.network.sign(a)).rejects.toThrow(/recipient EOAs/);
  });

  it("rejects altered handle, URI, signature, and failed simulation", async () => {
    const f = fixture(); const signature = await f.network.sign(a);
    await expect(f.network.transaction("other", a, uri, signature)).rejects.toThrow(/handle mismatch/);
    await expect(f.network.transaction("Bigu", a, uri, signature)).rejects.toThrow(/lowercase/);
    await expect(f.network.transaction("bigu", a, `${uri}?changed`, signature)).rejects.toThrow(/URI mismatch/);
    await expect(f.network.transaction("bigu", { ...a, artifactDigest: bytes32("77") }, uri, signature)).rejects.toThrow(/Invalid open mint authorization/);
    vi.mocked(f.rpc.simulate).mockRejectedValue(new Error("execution reverted"));
    await expect(f.network.transaction("bigu", a, uri, signature)).rejects.toThrow(/execution reverted/);
  });

  it.each(["removed", "missing", "duplicate", "address", "handle", "recipient", "assessment", "artifact", "uri", "digest", "nonce", "block"])("rejects %s mint log evidence", async kind => {
    const f = fixture(); f.minted();
    if (kind === "removed") f.log.removed = true;
    if (kind === "missing") vi.mocked(f.rpc.logs).mockResolvedValue([]);
    if (kind === "duplicate") vi.mocked(f.rpc.logs).mockResolvedValue([f.log, f.log]);
    if (kind === "address") f.log.address = other;
    if (kind === "handle") f.log.args.normalizedHandle = "other";
    if (kind === "recipient") f.log.args.recipient = other;
    if (kind === "assessment") f.log.args.assessmentDigest = bytes32("77");
    if (kind === "artifact") f.log.args.artifactDigest = bytes32("77");
    if (kind === "uri") f.log.args.tokenURIHash = bytes32("77");
    if (kind === "digest") f.log.args.authorizationDigest = bytes32("77");
    if (kind === "nonce") f.log.args.nonce = bytes32("00");
    if (kind === "block") f.log.blockNumber = 11n;
    await expect(f.network.state("bigu")).rejects.toThrow();
  });

  it("rejects altered token URI or missing immutable provenance", async () => {
    const f = fixture(); f.minted(); f.responses.tokenURI = "ipfs://changed";
    await expect(f.network.state("bigu")).rejects.toThrow(/URI commitment/);
    f.responses.tokenURI = uri; f.responses.provenance = [];
    await expect(f.network.state("bigu")).rejects.toThrow(/provenance/);
  });

  it("rejects reorganized mint events and snapshots", async () => {
    const f = fixture(); f.minted();
    vi.mocked(f.rpc.block).mockImplementation(async number => number === 9n ? { ...f.latest, number: 9n, hash: bytes32("ff") } : { ...f.latest });
    await expect(f.network.state("bigu")).rejects.toThrow(/reorganized/);
    const fresh = fixture();
    vi.mocked(fresh.rpc.block).mockImplementation(async number => ({ ...fresh.latest, hash: number === undefined ? bytes32("10") : bytes32("ff") }));
    await expect(fresh.network.now()).rejects.toThrow(/Canonical block changed/);
    await expect(fresh.network.sign(a)).rejects.toThrow(/Canonical block changed/);
  });

  it("rejects invalid config or a chain older than the deployment", async () => {
    for (const confirmations of [0, -1, 1.5]) expect(() => createLocalOpenMintNetwork({ ...config, confirmations }, fixture().rpc)).toThrow(/Confirmations/);
    expect(() => createLocalOpenMintNetwork({ ...config, expectedCodeHash: bytes32("00") }, fixture().rpc)).toThrow(/runtime code hash/);
    const f = fixture(); f.latest.number = 1n;
    await expect(f.network.now()).rejects.toThrow(/Deployment block/);
  });
});
