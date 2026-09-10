import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { MINT_CLIENT_SCRIPT } from "./clientScript.js";

describe("dynamic CTA label styling", () => {
  it("uses the shared outlined-button structure for X reauthentication", async () => {
    const node = (tag: string) => ({
      tag, type: "", className: "", textContent: "", children: [] as unknown[],
      append(...children: unknown[]) { this.children.push(...children); },
      addEventListener() {},
    });
    const feedback = node("p");
    let click: (() => Promise<void>) | undefined;
    const revoke = {
      dataset: { csrf: "test-csrf" }, disabled: false,
      closest: () => ({ querySelector: () => feedback }),
      addEventListener(_event: string, callback: () => Promise<void>) { click = callback; },
    };
    runInNewContext(MINT_CLIENT_SCRIPT, {
      window: { addEventListener() {} },
      document: {
        querySelector: () => null,
        querySelectorAll: (selector: string) => selector === "[data-revoke-wallet]" ? [revoke] : [],
        createElement: node, createTextNode: () => node("#text"),
      },
      fetch: async () => ({ ok: false, json: async () => ({ error: { code: "X_REAUTH_REQUIRED", message: "Sign in again." } }) }),
    });
    await click!();
    const button = feedback.children[1] as ReturnType<typeof node>;
    expect(button.tag).toBe("button");
    expect(button.type).toBe("button");
    expect(button.className).toBe("auth-action reauth-button");
    expect(button.children[0]).toMatchObject({ tag: "span", textContent: "Reauthenticate with X" });
    expect(revoke.disabled).toBe(false);
  });

  it("preserves the styled label when a rehearsal action fails", async () => {
    const label = { textContent: "Advance" };
    let click: (() => Promise<void>) | undefined;
    const button = {
      dataset: { signatureId: "sg1_fixture", csrf: "test-csrf" }, disabled: false,
      querySelector: () => label,
      addEventListener(_event: string, callback: () => Promise<void>) { click = callback; },
    };
    runInNewContext(MINT_CLIENT_SCRIPT, {
      window: { addEventListener() {} },
      document: { querySelector: () => null, querySelectorAll: (selector: string) => selector === "[data-advance-rehearsal]" ? [button] : [] },
      fetch: async () => ({ ok: false, json: async () => ({ error: { message: "Please retry." } }) }),
    });
    await click!();
    expect(label.textContent).toBe("Please retry.");
    expect(button.disabled).toBe(false);
    expect(button).not.toHaveProperty("textContent");
  });
});

const CONTRACT: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const WALLET: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const MINT_ABI = parseAbi([
  "function mintAuthorized((bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch) a,string tokenURI_,bytes galleryAttestation) returns (uint256 tokenId)",
]);

function payload(transaction?: { to: string; data: string; value: string }) {
  const response = {
    authorization: {
      signatureDigest: hash("1") as Hex,
      walletBindingId: hash("2") as Hex,
      mintWallet: WALLET,
      svgSha256: hash("3") as Hex,
      pngSha256: hash("4") as Hex,
      metadataSha256: hash("5") as Hex,
      tokenURIHash: hash("6") as Hex,
      authorizationId: hash("7") as Hex,
      validAfter: "1788534000",
      deadline: "1788534900",
      authorizerEpoch: 1,
    },
    tokenURI: "ipfs://bafkreicpuldsgwvhutj4wr2ku2a5qc5pvq4dm55ccdg2jeewionipsdcim",
    galleryAttestation: `0x${"11".repeat(65)}`,
    chainId: "11155111",
    contract: CONTRACT,
  };
  const data = encodeFunctionData({
    abi: MINT_ABI,
    functionName: "mintAuthorized",
    args: [{
      ...response.authorization,
      validAfter: BigInt(response.authorization.validAfter),
      deadline: BigInt(response.authorization.deadline),
    }, response.tokenURI, response.galleryAttestation as Hex],
  });
  return { ...response, transaction: transaction ?? { to: CONTRACT, data, value: "0x0" } };
}

type MintSubmitEvent = { preventDefault(): void; submitter?: { dataset: { walletProvider: string } } };
async function submitMint(returnedPayload: ReturnType<typeof payload> & { fixture?: boolean; localChainRehearsal?: boolean }, options: { local?: boolean; confirm?: boolean; rejectPath?: string; injected?: boolean; twice?: boolean; injectedSubmit?: boolean; chainAfterEstimate?: string; accountAfterEstimate?: string | null } = {}) {
  let submit: ((event: MintSubmitEvent) => Promise<void>) | undefined;
  const feedback = { textContent: "" };
  const button = { disabled: false };
  const walletRequests: Array<{ method: string; params?: unknown[] }> = [];
  const sentTransactions: unknown[] = [];
  const requests: Array<{ path: string; init: { headers?: Record<string, string>; body?: string } }> = [];
  const confirmations: string[] = [];
  const form = {
    action: "/api/v2/signatures/sg1_fixture/mint-authorizations",
    dataset: {
      chainId: returnedPayload.chainId,
      contract: returnedPayload.contract,
      wallet: returnedPayload.authorization.mintWallet,
      signatureDigest: returnedPayload.authorization.signatureDigest,
      svgSha256: returnedPayload.authorization.svgSha256.slice(2),
      pngSha256: returnedPayload.authorization.pngSha256.slice(2),
      metadataSha256: returnedPayload.authorization.metadataSha256,
      tokenUriHash: returnedPayload.authorization.tokenURIHash,
      tokenUri: returnedPayload.tokenURI,
      signatureId: "sg1_fixture",
      localChainRehearsal: String(options.local === true),
      localWallet: String(options.local === true),
    },
    parentElement: { querySelector: () => feedback },
    closest: () => ({ querySelector: () => feedback }),
    querySelector(selector: string) {
      if (selector === "button[type=submit]") return button;
      if (selector === "input[name=permanence_acknowledged]") return { checked: true };
      if (selector === "input[name=csrf]") return { value: "csrf" };
      return null;
    },
    addEventListener(_name: string, listener: (event: MintSubmitEvent) => Promise<void>) {
      submit = listener;
    },
  };
  let estimated = false;
  const ethereum = {
    async request(request: { method: string; params?: unknown[] }) {
      walletRequests.push(request);
      if (request.method === "eth_accounts") return estimated && options.accountAfterEstimate !== undefined ? options.accountAfterEstimate === null ? [] : [options.accountAfterEstimate] : [WALLET];
      if (request.method === "eth_chainId") return estimated && options.chainAfterEstimate ? options.chainAfterEstimate : "0x" + BigInt(returnedPayload.chainId).toString(16);
      if (request.method === "eth_call") return "0x";
      if (request.method === "eth_estimateGas") { estimated = true; return "0x5208"; }
      if (request.method === "eth_sendTransaction") {
        sentTransactions.push(request.params?.[0]);
        return hash("a");
      }
      throw new Error(`Unexpected wallet method ${request.method}`);
    },
  };
  const document = {
    querySelectorAll(selector: string) {
      return selector === ".mint-authorization-form" ? [form] : [];
    },
    querySelector(selector: string) {
      return options.local && selector === "[data-local-chain-rehearsal]" ? {} : null;
    },
  };
  const fetch = async (path: string, init: { headers?: Record<string, string>; body?: string }) => {
    requests.push({ path, init });
    return {
    ok: path !== options.rejectPath,
    async json() {
      if (path === options.rejectPath) return { error: { message: "Local RPC unavailable", code: "CHAIN_UNAVAILABLE" } };
      if (path === "/api/local/wallet") return { chainId: "31337", address: WALLET, contract: CONTRACT };
      if (path === "/api/local/wallet/mint") return { txHash: hash("a") };
      return path === form.action ? returnedPayload : { state: "reported" };
    },
  }; };

  runInNewContext(MINT_CLIENT_SCRIPT, {
    window: { addEventListener() {}, ethereum: options.injected === false ? undefined : ethereum, confirm(message: string) { confirmations.push(message); return options.confirm !== false; } },
    document,
    fetch,
    location: { href: "", reload() {} },
    setTimeout() {},
    TextEncoder,
  });
  if (!submit) throw new Error("Mint submit handler was not installed.");
  const event = { preventDefault() {}, ...(options.injectedSubmit ? { submitter: { dataset: { walletProvider: "injected" } } } : options.local ? { submitter: { dataset: { walletProvider: "local" } } } : {}) };
  await submit(event);
  if (options.twice) await submit(event);
  return { button, feedback, walletRequests, sentTransactions, requests, confirmations };
}

describe("mint browser transaction guard", () => {
  it.each([
    ["target", { to: "0x000000000000000000000000000000000000badd", data: `0xf722c561${"00".repeat(32)}`, value: "0x0" }],
    ["value", { to: CONTRACT, data: `0xf722c561${"00".repeat(32)}`, value: "0x1" }],
    ["selector", { to: CONTRACT, data: `0xdeadbeef${"00".repeat(32)}`, value: "0x0" }],
  ])("refuses calldata with the wrong %s", async (_field, transaction) => {
    const result = await submitMint(payload(transaction));

    expect(result.feedback.textContent).toBe("The returned authorization does not match the reviewed work.");
    expect(result.button.disabled).toBe(false);
    expect(result.walletRequests).toEqual([]);
  });

  it.each([
    ["token URI", (returned: ReturnType<typeof payload>) => {
      returned.transaction.data = encodeFunctionData({
        abi: MINT_ABI,
        functionName: "mintAuthorized",
        args: [{ ...returned.authorization, validAfter: BigInt(returned.authorization.validAfter), deadline: BigInt(returned.authorization.deadline) }, returned.tokenURI + "x", returned.galleryAttestation as Hex],
      });
    }],
    ["gallery attestation", (returned: ReturnType<typeof payload>) => {
      returned.transaction.data = encodeFunctionData({
        abi: MINT_ABI,
        functionName: "mintAuthorized",
        args: [{ ...returned.authorization, validAfter: BigInt(returned.authorization.validAfter), deadline: BigInt(returned.authorization.deadline) }, returned.tokenURI, `0x${"22".repeat(65)}`],
      });
    }],
  ])("refuses same-selector calldata with an altered %s", async (_field, mutate) => {
    const returned = payload();
    mutate(returned);
    const result = await submitMint(returned);

    expect(result.feedback.textContent).toBe("The returned authorization does not match the reviewed work.");
    expect(result.walletRequests).toEqual([]);
  });

  it.each([
    "signatureDigest",
    "walletBindingId",
    "mintWallet",
    "svgSha256",
    "pngSha256",
    "metadataSha256",
    "tokenURIHash",
    "authorizationId",
    "validAfter",
    "deadline",
    "authorizerEpoch",
  ].map((field, index) => [field, index] as const))("refuses same-selector calldata with an altered %s word", async (_field, wordIndex) => {
    const returned = payload();
    const wordEnd = 10 + ((wordIndex + 1) * 64);
    const lastNibble = returned.transaction.data[wordEnd - 1];
    const replacement = lastNibble === "f" ? "e" : "f";
    returned.transaction.data = `${returned.transaction.data.slice(0, wordEnd - 1)}${replacement}${returned.transaction.data.slice(wordEnd)}`;
    const result = await submitMint(returned);

    expect(result.feedback.textContent).toBe("The returned authorization does not match the reviewed work.");
    expect(result.walletRequests).toEqual([]);
  });

  it("refuses otherwise valid calldata with trailing bytes", async () => {
    const returned = payload();
    returned.transaction.data = `${returned.transaction.data}00`;
    const result = await submitMint(returned);

    expect(result.feedback.textContent).toBe("The returned authorization does not match the reviewed work.");
    expect(result.walletRequests).toEqual([]);
  });

  it("refuses a noncanonical dynamic offset", async () => {
    const returned = payload();
    const offsetWordStart = 10 + (11 * 64);
    returned.transaction.data = `${returned.transaction.data.slice(0, offsetWordStart)}${(448).toString(16).padStart(64, "0")}${returned.transaction.data.slice(offsetWordStart + 64)}`;
    const result = await submitMint(returned);

    expect(result.feedback.textContent).toBe("The returned authorization does not match the reviewed work.");
    expect(result.walletRequests).toEqual([]);
  });

  it("refuses nonzero ABI padding", async () => {
    const returned = payload();
    returned.transaction.data = `${returned.transaction.data.slice(0, -2)}01`;
    const result = await submitMint(returned);

    expect(result.feedback.textContent).toBe("The returned authorization does not match the reviewed work.");
    expect(result.walletRequests).toEqual([]);
  });

  it("passes only the validated zero-value mint call to the wallet", async () => {
    const returned = payload();
    const result = await submitMint(returned);

    expect(result.sentTransactions).toEqual([{
      from: WALLET,
      ...returned.transaction,
      gas: "0x5208",
      chainId: "0xaa36a7",
    }]);
  });

  it("refuses an injected provider switching from local Anvil to mainnet after gas estimation", async () => {
    const returned = { ...payload(), chainId: "31337", localChainRehearsal: true };
    const result = await submitMint(returned, { local: true, injectedSubmit: true, chainAfterEstimate: "0x1" });
    expect(result.walletRequests.some(({ method }) => method === "eth_estimateGas")).toBe(true);
    expect(result.walletRequests.filter(({ method }) => method === "eth_chainId")).toHaveLength(2);
    expect(result.sentTransactions).toEqual([]);
    expect(result.feedback.textContent).toContain("wallet network changed during review");
    expect(result.button.disabled).toBe(false);
  });

  it.each(["0x2222222222222222222222222222222222222222", null])("refuses an injected account change/disconnection after gas estimation (%s)", async (accountAfterEstimate) => {
    const result = await submitMint(payload(), { accountAfterEstimate });
    expect(result.walletRequests.some(({ method }) => method === "eth_estimateGas")).toBe(true);
    expect(result.walletRequests.filter(({ method }) => method === "eth_accounts")).toHaveLength(2);
    expect(result.sentTransactions).toEqual([]);
    expect(result.feedback.textContent).toContain("wallet account changed during review");
    expect(result.button.disabled).toBe(false);
  });

  it("pins a validated injected local transaction to chain 31337 in the send payload", async () => {
    const returned = { ...payload(), chainId: "31337", localChainRehearsal: true };
    const result = await submitMint(returned, { local: true, injectedSubmit: true });
    expect(result.sentTransactions).toEqual([{ from: WALLET, ...returned.transaction, gas: "0x5208", chainId: "0x7a69" }]);
    expect(result.requests.some(({ path }) => path === "/api/local/wallet/mint")).toBe(false);
  });

  it("never sends an Ethereum transaction for a fixture authorization", async () => {
    const returned = { ...payload(), fixture: true };
    const result = await submitMint(returned);
    expect(result.sentTransactions).toEqual([]);
    expect(result.walletRequests).toEqual([]);
    expect(result.feedback.textContent).toBe("Authorization saved. No transaction submitted.");
  });

  it("sends a real local mint only through the restricted endpoint after explicit consent", async () => {
    const returned = { ...payload(), chainId: "31337", localChainRehearsal: true };
    const result = await submitMint(returned, { local: true, injected: false, twice: true });
    expect(result.walletRequests).toEqual([]);
    expect(result.confirmations).toHaveLength(1);
    expect(result.confirmations[0]).toContain("LOCAL TEST WALLET · ANVIL 31337 ONLY");
    expect(result.confirmations[0]).toContain(CONTRACT);
    expect(result.confirmations[0]).toContain(WALLET);
    const mints = result.requests.filter(({ path }) => path === "/api/local/wallet/mint");
    expect(mints).toHaveLength(1);
    expect(mints[0].init.headers).toMatchObject({ "X-CSRF-Token": "csrf", "X-Mint-Permanence-Acknowledged": "1" });
    expect(JSON.parse(mints[0].init.body!)).toEqual({ authorizationId: returned.authorization.authorizationId });
    expect(result.feedback.textContent).toContain("Waiting for automatic local promotion");
  });

  it("does not submit a local mint when confirmation is cancelled, and permits retry", async () => {
    const result = await submitMint({ ...payload(), chainId: "31337", localChainRehearsal: true }, { local: true, confirm: false, twice: true });
    expect(result.requests.some(({ path }) => path === "/api/local/wallet/mint")).toBe(false);
    expect(result.confirmations).toHaveLength(2);
    expect(result.button.disabled).toBe(false);
    expect(result.feedback.textContent).toContain("Cancelled");
  });

  it("surfaces local RPC rejection and re-enables submission", async () => {
    const result = await submitMint({ ...payload(), chainId: "31337", localChainRehearsal: true }, { local: true, rejectPath: "/api/local/wallet/mint" });
    expect(result.feedback.textContent).toBe("Local RPC unavailable");
    expect(result.button.disabled).toBe(false);
  });

  it("refuses to infer actual Anvil minting from the page or chain ID alone", async () => {
    const result = await submitMint({ ...payload(), chainId: "31337" }, { local: true });
    expect(result.feedback.textContent).toContain("did not confirm an actual local Anvil transaction");
    expect(result.walletRequests).toEqual([]);
    expect(result.requests.some(({ path }) => path === "/api/local/wallet/mint")).toBe(false);
  });
});

async function localAction(kind: "link" | "transfer", options: { confirm?: boolean; rejectPath?: string; local?: boolean; injected?: boolean; deferredPanel?: boolean; provider?: "local" | "injected" | "fixture"; fixture?: boolean } = {}) {
  let click: (() => Promise<void>) | undefined;
  const feedback = { textContent: "" };
  const requests: Array<{ path: string; init: { headers?: Record<string, string>; body?: string } }> = [];
  const walletRequests: string[] = [];
  const confirmations: string[] = [];
  const timers: Array<() => Promise<void>> = [];
  let reloads = 0;
  let panelLoaded = !options.deferredPanel;
  let installedListeners = 0;
  const windowListeners = new Map<string, () => void>();
  const recipient = "0x2222222222222222222222222222222222222222";
  const button = {
    disabled: false,
    dataset: { walletProvider: options.provider ?? "local", fixture: String(options.fixture === true), csrf: "csrf", chainId: "31337", signatureId: "sg1_fixture", tokenId: "42", owner: WALLET, recipient },
    parentElement: { querySelector: () => feedback },
    closest: () => ({ querySelector: () => feedback }),
    addEventListener(_name: string, listener: () => Promise<void>) { installedListeners++; click = listener; },
  };
  const document = {
    querySelector(selector: string) {
      if (selector === "[data-local-chain-rehearsal]") return options.local === false || !panelLoaded ? null : {};
      if (selector === "[data-wallet-feedback]") return feedback;
      return null;
    },
    querySelectorAll(selector: string) {
      return panelLoaded && selector === (kind === "link" ? "[data-link-wallet]" : "[data-local-transfer]") ? [button] : [];
    },
  };
  const fetch = async (path: string, init: { headers?: Record<string, string>; body?: string }) => {
    requests.push({ path, init });
    return { ok: options.rejectPath !== path, json: async () => {
      if (options.rejectPath === path) return { error: { code: "CHAIN_UNAVAILABLE", message: "Local action rejected" } };
      if (path === "/api/local/wallet") return { chainId: "31337", address: WALLET, recipientAddress: recipient, contract: CONTRACT };
      if (path === "/api/v2/wallet-bindings/challenge") return { challengeId: "challenge", message: "Exact SIWE message\nLine two", chainId: "31337", walletAddress: WALLET };
      if (path === "/api/local/wallet/sign") return { walletProof: "0xproof" };
      if (path === "/api/local/wallet/transfer") return { txHash: hash("a") };
      if (path.endsWith("/mint-status")) return { state: "finalized", currentTokenHolder: recipient };
      return {};
    } };
  };
  runInNewContext(MINT_CLIENT_SCRIPT, {
    document, fetch, TextEncoder,
    window: { addEventListener(name: string, listener: () => void) { windowListeners.set(name, listener); }, ethereum: options.injected ? { request: async ({ method }: { method: string }) => { walletRequests.push(method); return []; } } : undefined, confirm(message: string) { confirmations.push(message); return options.confirm !== false; } },
    location: { reload() { reloads++; } },
    setTimeout(callback: () => Promise<void>) { timers.push(callback); },
  });
  if (options.deferredPanel) {
    expect(click).toBeUndefined();
    panelLoaded = true;
    windowListeners.get("account-panel:ready")!();
    windowListeners.get("account-panel:ready")!();
  }
  if (!click) throw new Error("Local action listener missing");
  await click();
  return { button, feedback, requests, walletRequests, confirmations, timers, click, installedListeners, get reloads() { return reloads; } };
}

describe("local browser wallet proof and transfer", () => {
  it("does not silently seed a fixture when the normal browser-wallet action has no provider", async () => {
    const result = await localAction("link", { local: false, provider: "injected", fixture: true });
    expect(result.requests).toEqual([]);
    expect(result.feedback.textContent).toContain("No injected Ethereum wallet");
    expect(result.button.disabled).toBe(false);
  });

  it("seeds a fixture only through the explicit DEV simulator control", async () => {
    const result = await localAction("link", { local: false, provider: "fixture", fixture: true });
    expect(result.requests.map(request => request.path)).toEqual(["/dev/v2/wallet-bindings/seed"]);
    expect(result.walletRequests).toEqual([]);
    expect(result.reloads).toBe(1);
  });

  it("binds lazily loaded panel controls once and reads local mode at action time", async () => {
    const result = await localAction("link", { deferredPanel: true, confirm: false });
    expect(result.installedListeners).toBe(1);
    expect(result.confirmations).toHaveLength(1);
    expect(result.feedback.textContent).toContain("Cancelled");
    expect(result.requests.map(r => r.path)).toEqual(["/api/local/wallet", "/api/v2/wallet-bindings/challenge"]);
    expect(result.reloads).toBe(0);
  });
  it("links through the ordinary challenge/confirm lifecycle, signing only its challenge ID", async () => {
    const result = await localAction("link", { injected: true });
    expect(result.walletRequests).toEqual([]);
    expect(result.requests.map(({ path }) => path)).toEqual(["/api/local/wallet", "/api/v2/wallet-bindings/challenge", "/api/local/wallet/sign", "/api/v2/wallet-bindings/confirm"]);
    const sign = result.requests.find(({ path }) => path.endsWith("/sign"))!;
    expect(JSON.parse(sign.init.body!)).toEqual({ challengeId: "challenge" });
    expect(sign.init.headers).toMatchObject({ "X-CSRF-Token": "csrf" });
    expect(JSON.parse(result.requests[3].init.body!)).toEqual({ challengeId: "challenge", walletProof: "0xproof" });
    expect(result.confirmations[0]).toContain("Exact SIWE message\nLine two");
    expect(result.confirmations[0]).toContain("ANVIL 31337 ONLY\nPublic test keys");
    expect(result.reloads).toBe(1);
  });

  it("does not sign or bind after the user declines the exact wallet message", async () => {
    const result = await localAction("link", { confirm: false });
    expect(result.requests.some(({ path }) => path.endsWith("/sign") || path.endsWith("/confirm"))).toBe(false);
    expect(result.button.disabled).toBe(false);
    expect(result.feedback.textContent).toContain("Cancelled");
    await result.click();
    expect(result.confirmations).toHaveLength(2);
  });

  it("does not silently fall back to a simulated binding when the local wallet is unavailable", async () => {
    const result = await localAction("link", { rejectPath: "/api/local/wallet" });
    expect(result.requests.map(({ path }) => path)).toEqual(["/api/local/wallet"]);
    expect(result.feedback.textContent).toBe("Local action rejected");
    expect(result.button.disabled).toBe(false);
  });

  it("confirms the fixed recipient and waits for the indexed holder before refreshing", async () => {
    const result = await localAction("transfer");
    expect(result.confirmations[0]).toContain("Transfer token 42?");
    expect(result.confirmations[0]).toContain(WALLET);
    expect(result.confirmations[0]).toContain("0x2222222222222222222222222222222222222222");
    const transfer = result.requests.find(({ path }) => path.endsWith("/transfer"))!;
    expect(JSON.parse(transfer.init.body!)).toEqual({ signatureId: "sg1_fixture" });
    expect(transfer.init.headers).toMatchObject({ "X-CSRF-Token": "csrf" });
    expect(result.reloads).toBe(0);
    expect(result.feedback.textContent).toContain("Waiting for the local holder projection");
    await result.click();
    expect(result.requests.filter(({ path }) => path.endsWith("/transfer"))).toHaveLength(1);
    await result.timers[0]();
    expect(result.reloads).toBe(1);
  });

  it("sends no transfer after cancellation", async () => {
    const result = await localAction("transfer", { confirm: false });
    expect(result.requests.some(({ path }) => path.endsWith("/transfer"))).toBe(false);
    expect(result.button.disabled).toBe(false);
    expect(result.feedback.textContent).toContain("Cancelled");
  });

  it("surfaces transfer rejection and permits retry", async () => {
    const result = await localAction("transfer", { rejectPath: "/api/local/wallet/transfer" });
    expect(result.feedback.textContent).toBe("Local action rejected");
    expect(result.button.disabled).toBe(false);
  });

  it("does not install usable local transfer behavior on nonlocal pages", async () => {
    const result = await localAction("transfer", { local: false });
    expect(result.requests).toEqual([]);
    expect(result.confirmations).toEqual([]);
  });
});

describe("local collection projection polling", () => {
  it.each(["authorized", "submitted", "included_unfinalized", "validation_pending"])("reloads %s only when the reconciler observes a new projection", async (initialState) => {
    const timers: Array<() => Promise<void>> = [];
    const paths: string[] = [];
    let reloads = 0;
    let reads = 0;
    runInNewContext(MINT_CLIENT_SCRIPT, {
      window: { addEventListener() {} },
      document: {
        querySelector: (selector: string) => selector === "[data-local-chain-rehearsal]" ? {} : null,
        querySelectorAll: (selector: string) => selector === "[data-local-mint-pending]" ? [{ dataset: { signatureId: "sg1_fixture", mintState: initialState } }] : [],
      },
      fetch: async (path: string) => {
        paths.push(path);
        reads++;
        // The first post-redirect read can still precede reconciler observation;
        // a transient read failure also must not lose the eventual update.
        if (reads === 2) throw new Error("Temporary network read failure");
        return { ok: true, json: async () => ({ state: reads < 3 ? initialState : "finalized" }) };
      },
      setTimeout: (callback: () => Promise<void>) => { timers.push(callback); },
      location: { reload() { reloads++; } },
    });
    expect(timers).toHaveLength(1);
    await timers.shift()!();
    expect(reloads).toBe(0);
    await timers.shift()!();
    expect(reloads).toBe(0);
    await timers.shift()!();
    expect(reloads).toBe(1);
    expect(timers).toHaveLength(0);
    expect(paths).toEqual(Array(3).fill("/api/v2/signatures/sg1_fixture/mint-status"));
  });
});
