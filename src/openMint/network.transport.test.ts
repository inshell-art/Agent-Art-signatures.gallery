import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256,
  numberToHex, parseAbiParameters, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { OPEN_MINT_ABI, openMintDigest, openMintHandleKey, openMintTokenURIHash, type OpenMintAuthorization } from "./authorization.js";
import { createLocalOpenMintNetwork } from "./network.js";

const bytes32 = (byte: string): Hex => `0x${byte.repeat(32)}`;
const contract = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const privateKey = `0x${"0".repeat(63)}1` as Hex;
const authorizer = privateKeyToAccount(privateKey).address;
const code = "0x60006000" as Hex;
const uri = "ipfs://network-transport-fixture/metadata.json";
const authorization: OpenMintAuthorization = {
  handleKey: openMintHandleKey("bigu"), recipient, assessmentDigest: bytes32("22"), artifactDigest: bytes32("33"),
  tokenURIHash: openMintTokenURIHash(uri), nonce: bytes32("44"), issuedAt: 1800000000n, deadline: 1800000900n,
};
const digest = openMintDigest({ chainId: 31337, verifyingContract: contract }, authorization);
const rpcUrl = "http://127.0.0.1:1/";
type RpcRequest = { id: number; method: string; params?: unknown[] };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Exercise viem's actual HTTP/ABI adapter without opening a socket or using a live wallet. */
function transportFixture() {
  const latest: { number: Hex | null; hash: Hex | null; timestamp: Hex } = {
    number: "0xa", hash: bytes32("10"), timestamp: numberToHex(1800000060),
  };
  const log = {
    address: contract, blockNumber: "0x9" as Hex | null, blockHash: bytes32("09") as Hex | null,
    transactionHash: bytes32("aa") as Hex | null, transactionIndex: "0x0", logIndex: "0x0", removed: false,
    topics: encodeEventTopics({ abi: OPEN_MINT_ABI, eventName: "OpenSignatureMinted", args: {
      handleKey: authorization.handleKey, nonce: authorization.nonce, recipient,
    } }),
    data: encodeAbiParameters(parseAbiParameters("uint256,string,bytes32,bytes32,bytes32,bytes32"), [
      BigInt(authorization.handleKey), "bigu", authorization.assessmentDigest, authorization.artifactDigest,
      authorization.tokenURIHash, digest,
    ]),
  };
  let minted = false;
  const requests: RpcRequest[] = [];
  const fetchRpc = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(rpcUrl);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    requests.push(request);
    const params = request.params ?? [];
    let result: unknown;
    switch (request.method) {
      case "eth_chainId": result = "0x7a69"; break;
      case "eth_getBlockByNumber":
        result = params[0] === "0x9" ? { ...latest, number: "0x9", hash: log.blockHash } : { ...latest };
        break;
      case "eth_getCode": result = params[0] === contract ? code : "0x"; break;
      case "eth_getTransactionCount": result = "0x1"; break;
      case "eth_getLogs": result = minted ? [log] : []; break;
      case "eth_call": {
        const call = decodeFunctionData({ abi: OPEN_MINT_ABI, data: (params[0] as { data: Hex }).data });
        switch (call.functionName) {
          case "trustedAuthorizer": result = encodeFunctionResult({ abi: OPEN_MINT_ABI, functionName: "trustedAuthorizer", result: authorizer }); break;
          case "mintedHandle": result = encodeFunctionResult({ abi: OPEN_MINT_ABI, functionName: "mintedHandle", result: minted }); break;
          case "usedNonces": case "revokedNonces": case "paused":
            result = encodeFunctionResult({ abi: OPEN_MINT_ABI, functionName: call.functionName, result: false }); break;
          case "provenance": result = encodeFunctionResult({ abi: OPEN_MINT_ABI, functionName: "provenance", result: [
            "bigu", authorization.assessmentDigest, authorization.artifactDigest, recipient, authorization.tokenURIHash, digest,
          ] }); break;
          case "ownerOf": result = encodeFunctionResult({ abi: OPEN_MINT_ABI, functionName: "ownerOf", result: recipient }); break;
          case "tokenURI": result = encodeFunctionResult({ abi: OPEN_MINT_ABI, functionName: "tokenURI", result: uri }); break;
          case "mint": result = encodeFunctionResult({ abi: OPEN_MINT_ABI, functionName: "mint", result: BigInt(authorization.handleKey) }); break;
          default: throw new Error(`Unexpected contract read: ${call.functionName}`);
        }
        break;
      }
      default: throw new Error(`Unexpected RPC method (writes forbidden): ${request.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  vi.stubGlobal("fetch", fetchRpc);
  const network = createLocalOpenMintNetwork({
    rpcUrl, contract, authorizerPrivateKey: privateKey, expectedCodeHash: keccak256(code), deploymentBlock: 2n,
  });
  return { network, fetchRpc, requests, latest, log, minted: () => { minted = true; } };
}

describe("open mint HTTP RPC transport", () => {
  it("reads trusted block, EOA code, nonces, and eligibility through the real ABI adapter", async () => {
    const f = transportFixture();
    expect(await f.network.now()).toBe(1800000060);
    await f.network.preflight!(recipient);
    expect(await f.network.walletContext!(recipient)).toEqual({
      chainId: "0x7a69", contract, blockNumber: "0xa", blockHash: f.latest.hash, nonce: "0x1",
    });
    expect(await f.network.state("bigu")).toEqual({ state: "unminted" });
    expect(f.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "eth_getBlockByNumber", params: ["latest", false] }),
      expect.objectContaining({ method: "eth_getBlockByNumber", params: ["0xa", false] }),
      expect.objectContaining({ method: "eth_getCode", params: [recipient, "0xa"] }),
      expect.objectContaining({ method: "eth_getTransactionCount", params: [recipient, "latest"] }),
      expect.objectContaining({ method: "eth_getTransactionCount", params: [recipient, "pending"] }),
    ]));
    expect(f.requests.filter(request => request.method === "eth_call").every(request => request.params?.[1] === "0xa")).toBe(true);
    expect(f.requests.some(request => request.method === "eth_getLogs")).toBe(false);
  });

  it("simulates the exact signed zero-value mint at the trusted block without sending it", async () => {
    const f = transportFixture();
    const signature = await f.network.sign(authorization);
    const tx = await f.network.transaction("bigu", authorization, uri, signature);
    expect(decodeFunctionData({ abi: OPEN_MINT_ABI, data: tx.data }).args).toEqual(["bigu", authorization, uri, signature]);
    const calls = f.requests.filter(request => request.method === "eth_call");
    expect(calls.at(-1)?.params).toEqual([{ from: recipient, to: contract, data: tx.data, value: "0x0" }, "0xa"]);
    expect(f.requests.at(-1)).toMatchObject({ method: "eth_getBlockByNumber", params: ["0xa", false] });
    expect(f.requests.every(request => ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(request.method))).toBe(true);
  });

  it("decodes indexed mint events and confirms them against the immutable provenance and canonical block", async () => {
    const f = transportFixture(); f.minted();
    expect(await f.network.state("bigu")).toEqual({
      state: "minted", tokenId: BigInt(authorization.handleKey).toString(), wallet: recipient,
      transactionHash: f.log.transactionHash, assessmentDigest: authorization.assessmentDigest,
      artifactDigest: authorization.artifactDigest, tokenURIHash: authorization.tokenURIHash,
    });
    expect(f.requests.find(request => request.method === "eth_getLogs")?.params).toEqual([{
      address: contract, fromBlock: "0x2", toBlock: "0xa", topics: [f.log.topics[0], authorization.handleKey, null, null],
    }]);
    expect(f.requests).toContainEqual(expect.objectContaining({ method: "eth_getBlockByNumber", params: ["0x9", false] }));
  });

  it.each(["number", "hash"] as const)("rejects a latest block with null %s before trusting contract state", async field => {
    const f = transportFixture(); f.latest[field] = null;
    await expect(f.network.now()).rejects.toThrow("Canonical block is unavailable.");
    expect(f.requests.map(request => request.method)).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
  });

  it.each(["blockNumber", "blockHash", "transactionHash"] as const)("rejects mint logs with null %s instead of revealing", async field => {
    const f = transportFixture(); f.minted(); f.log[field] = null;
    await expect(f.network.state("bigu")).rejects.toThrow("Pending mint log is unavailable.");
    expect(f.requests.filter(request => request.method === "eth_getBlockByNumber")).toHaveLength(1);
  });

  it("does not retry a failed RPC transport request", async () => {
    const f = transportFixture();
    f.fetchRpc.mockRejectedValue(new TypeError("Connection unavailable"));
    await expect(f.network.now()).rejects.toThrow("HTTP request failed");
    expect(f.fetchRpc).toHaveBeenCalledOnce();
  });

  it("aborts stalled RPC requests at 30 seconds without retrying", async () => {
    vi.useFakeTimers();
    const f = transportFixture();
    let signal: AbortSignal | undefined;
    f.fetchRpc.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const result = f.network.now().catch(error => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ name: "TimeoutError" });
    expect(f.fetchRpc).toHaveBeenCalledOnce();
  });
});
