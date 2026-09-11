import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertOwnedAnvil, validateLocalRuntime } from "./runtimeGuards.js";

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

describe("owned Anvil process boundary", () => {
  const children: ChildProcess[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const workspace = async () => {
    const root = await mkdtemp(resolve(tmpdir(), "sg-owned-anvil-"));
    roots.push(root);
    await mkdir(resolve(root, ".local/rehearsal/anvil"), { recursive: true });
    return root;
  };

  /** A stand-in process whose argv carries the command line the guard inspects. */
  const spawnShaped = async (root: string, args: string[]) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore" });
    children.push(child);
    await new Promise((settle) => setTimeout(settle, 150));
    await writeFile(resolve(root, ".local/rehearsal/anvil/anvil.pid"), `${child.pid}\n`);
    return child;
  };

  const anvilArgs = (root: string, overrides: Record<string, string> = {}) => [
    "anvil",
    "--host", overrides.host ?? "127.0.0.1",
    "--port", overrides.port ?? "18545",
    "--chain-id", overrides.chainId ?? "31337",
    "--state", overrides.state ?? resolve(root, ".local/rehearsal/anvil/state.json"),
    "--quiet",
  ];

  it("accepts a live process whose command line matches this repository's owned node", async () => {
    const root = await workspace();
    await spawnShaped(root, anvilArgs(root));
    expect(() => assertOwnedAnvil(root, "http://127.0.0.1:18545")).not.toThrow();
  });

  it("refuses a process on another port, host, chain, or state file", async () => {
    for (const [label, overrides, rpcUrl] of [
      ["port", { port: "8545" }, "http://127.0.0.1:18545"],
      ["host", { host: "0.0.0.0" }, "http://127.0.0.1:18545"],
      ["chain", { chainId: "1" }, "http://127.0.0.1:18545"],
      ["state", { state: "/elsewhere/state.json" }, "http://127.0.0.1:18545"],
    ] as const) {
      const root = await workspace();
      await spawnShaped(root, anvilArgs(root, overrides));
      expect(() => assertOwnedAnvil(root, rpcUrl), label).toThrow(/not this repository's owned Anvil process/);
    }
  });

  it("refuses a live process that is not an Anvil command at all", async () => {
    const root = await workspace();
    await spawnShaped(root, ["some-unrelated-daemon"]);
    expect(() => assertOwnedAnvil(root, "http://127.0.0.1:18545")).toThrow(/not this repository's owned Anvil process/);
  });

  it("refuses an Anvil-shaped command line that is missing any single required flag", async () => {
    const required = ["--host", "--port", "--chain-id", "--state"];
    for (const dropped of required) {
      const root = await workspace();
      const full = anvilArgs(root);
      const index = full.indexOf(dropped);
      await spawnShaped(root, [...full.slice(0, index), ...full.slice(index + 2)]);
      expect(() => assertOwnedAnvil(root, "http://127.0.0.1:18545"), dropped).toThrow(/not this repository's owned Anvil process/);
    }
  });

  it("refuses a missing, empty, or non-numeric recorded process ID", async () => {
    const root = await workspace();
    expect(() => assertOwnedAnvil(root, "http://127.0.0.1:18545")).toThrow();
    for (const pid of ["", "   ", "0", "-1", "12a", "abc"]) {
      await writeFile(resolve(root, ".local/rehearsal/anvil/anvil.pid"), pid);
      expect(() => assertOwnedAnvil(root, "http://127.0.0.1:18545")).toThrow(/Missing owned Anvil process/);
    }
  });

  it("refuses a recorded process ID that is no longer running", async () => {
    const root = await workspace();
    const child = await spawnShaped(root, anvilArgs(root));
    child.kill("SIGKILL");
    await new Promise((settle) => setTimeout(settle, 200));
    expect(() => assertOwnedAnvil(root, "http://127.0.0.1:18545")).toThrow();
  });
});
