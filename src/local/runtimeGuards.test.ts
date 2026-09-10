import { describe, expect, it } from "vitest";
import { validateLocalRuntime } from "./runtimeGuards.js";

const address = `0x${"11".repeat(20)}`;
const hash = `0x${"22".repeat(32)}`;
const record = { schemaVersion: 1, localOnly: true, chainId: "31337", postgresUrl: "postgresql://signatures@127.0.0.1:55432/local", rpcUrl: "http://127.0.0.1:18545", roleAccounts: { initialAuthorizer: address, mintWallet: address }, contract: address, runtimeCodeHash: hash, deploymentTransaction: hash, deploymentBlockNumber: "1", seededMintTransaction: hash, seededTokenId: "123" };

describe("interactive local runtime boundary", () => {
  it("accepts only the recorded local chain identity", () => {
    expect(validateLocalRuntime(record)).toEqual(record);
  });
  it.each(["https://127.0.0.1:18545", "http://localhost:18545", "http://example.com:18545", "http://127.0.0.1:18545/rpc", "http://127.0.0.1:18545?target=remote", "http://user:pass@127.0.0.1:18545"])("rejects unsafe RPC %s", (rpcUrl) => {
    expect(() => validateLocalRuntime({ ...record, rpcUrl })).toThrow();
  });
  it.each(["1", "11155111"])("rejects public chain %s", (chainId) => {
    expect(() => validateLocalRuntime({ ...record, chainId })).toThrow();
  });
  it("rejects external DB and malformed evidence", () => {
    expect(() => validateLocalRuntime({ ...record, postgresUrl: "postgresql://example.com/local" })).toThrow();
    expect(() => validateLocalRuntime({ ...record, runtimeCodeHash: "0x1234" })).toThrow();
    expect(() => validateLocalRuntime({ ...record, deploymentBlockNumber: "-1" })).toThrow();
  });
});
