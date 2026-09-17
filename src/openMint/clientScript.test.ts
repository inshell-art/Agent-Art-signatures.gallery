import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { OPEN_MINT_CLIENT_SCRIPT } from "./clientScript.js";

const WALLET = `0x${"1".repeat(40)}`;
const OTHER = `0x${"2".repeat(40)}`;
const CONTRACT = `0x${"3".repeat(40)}`;
const HASH = `0x${"4".repeat(64)}`;
const BLOCK_HASH = `0x${"5".repeat(64)}`;
const NETWORK = { chainId: '0x7a69', contract: CONTRACT, blockNumber: '0xa', blockHash: BLOCK_HASH };
const PENDING_TRANSACTION = { hash: HASH, from: WALLET, to: CONTRACT, nonce: '0x1', blockNumber: null };
const SUBMISSION_KEY = 'sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
const RECEIPT = { transactionHash: HASH, from: WALLET, to: CONTRACT, blockNumber: '0xb', blockHash: BLOCK_HASH, status: '0x0' };
type Listener = (event: any) => unknown;
class Element {
  dataset: Record<string, string> = {};
  listeners: Record<string, Listener> = {};
  children: Record<string, Element> = {};
  disabled = false;
  hidden = false;
  value = "";
  textContent = "";
  addEventListener(type: string, listener: Listener) { this.listeners[type] = listener; }
  querySelector(selector: string) { return this.children[selector] ?? null; }
  focus() {}
  select() {}
  async emit(type: string) {
    const event: { preventDefault(): void; currentTarget: Element | null } = { preventDefault() {}, currentTarget: this };
    const result = this.listeners[type]?.(event);
    // Native dispatch clears currentTarget before an async listener resumes.
    event.currentTarget = null;
    return result;
  }
}
type SetupOptions = {
  entry?: boolean;
  preview?: boolean;
  pending?: boolean;
  walletProved?: boolean;
  local?: boolean;
  storage?: Map<string, string>;
  accounts?: () => string[];
  api?: (path: string, body: any) => unknown;
  authorize?: Record<string, unknown>;
  duringAuthorize?: () => void;
  walletRequest?: (method: string, params: unknown) => unknown;
  now?: () => number;
};
const flush = async () => { for (let i = 0; i < 250; i++) await Promise.resolve(); };
function setup(options: SetupOptions = {}) {
  const selectors = ['[data-open-mint]', '[data-connect-wallet]', '[data-mint-feedback]', '[data-poll-feedback]', '[data-wallet-label]', '[data-disconnect-wallet]', '[data-copy-handoff]', '[data-handoff-prompt]', '[data-copy-feedback]', ...(options.preview ? [] : options.entry ? ['[data-assessment-request]', '[data-request-feedback]'] : ['[data-assessment-code]', '[data-assessment-status]', '[data-submit-mint]', '[data-mint-form]']), ...(options.local ? ['[data-dev-wallet]', '[data-dev-mint]', '[data-dev-feedback]'] : [])];
  const elements: Record<string, Element> = Object.fromEntries(selectors.map(selector => [selector, new Element()]));
  elements['[data-open-mint]'].dataset = { chainId: "31337", contract: CONTRACT, localChain: String(Boolean(options.local)) };
  if (elements['[data-assessment-code]']) elements['[data-assessment-code]'].dataset = { assessmentCode: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", assessmentHandle: "agent_art", tokenId: "123", assessmentState: options.pending ? "pending" : "ready", canMint: "true", mintState: "unminted", walletProved: String(Boolean(options.walletProved)) };
  if (options.entry) {
    elements['[data-assessment-request]'].children = { 'button[type=submit]': new Element(), 'input[name=handle]': new Element() };
    elements['[data-assessment-request]'].children['input[name=handle]'].value = " @Agent_Art ";
  }
  const requests: Array<{ path: string; body: any; init: any }> = [];
  const walletCalls: Array<{ method: string; params: unknown }> = [];
  const scheduled: Array<() => Promise<void>> = [];
  const timers = new Map<number, () => Promise<void>>();
  let nextTimerId = 0;
  const globalEvents: Record<string, Listener> = {};
  const walletEvents: Record<string, Listener> = {};
  const navigations: string[] = [];
  const storage = options.storage ?? new Map<string, string>();
  let reloads = 0;
  let chain = "0x7a69";
  const state = { csrfToken: "csrf", wallet: WALLET, walletVerified: Boolean(options.walletProved), chainId: "31337", chainName: "Local chain", rpcUrl: "http://127.0.0.1:8545" };
  const window = {
    addEventListener(type: string, cb: Listener) { globalEvents[type] = cb; },
    ethereum: {
      on(type: string, cb: Listener) { walletEvents[type] = cb; },
      removeListener(type: string) { delete walletEvents[type]; },
      async request({ method, params }: { method: string; params: unknown }) {
        walletCalls.push({ method, params });
        const custom = options.walletRequest?.(method, params);
        if (custom !== undefined) return custom;
        if (method === "eth_requestAccounts" || method === "eth_accounts") return options.accounts?.() ?? [WALLET];
        if (method === "eth_chainId") return chain;
        if (method === "eth_getBlockByNumber") return { number: (params as any)[0], hash: BLOCK_HASH };
        if (method === "eth_getTransactionCount") return '0x1';
        if (method === "eth_call") return '0x';
        if (method === "wallet_switchEthereumChain") { chain = ((params as any)[0]).chainId; return null; }
        if (method === "personal_sign") return "0xsignature";
        if (method === "eth_sendTransaction") return HASH;
        if (method === "eth_getTransactionByHash") return { ...PENDING_TRANSACTION };
        if (method === "eth_getTransactionReceipt") return null;
        throw new Error(`Unexpected wallet method ${method}`);
      },
    },
  };
  const context = {
    window,
    document: { querySelector: (selector: string) => elements[selector] ?? null, querySelectorAll: (selector: string) => elements[selector] ? [elements[selector]] : [] },
    location: { origin: "https://example.test", hash: "", assign(path: string) { navigations.push(path); }, reload() { reloads += 1; } },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    URL, AbortController, Date: class extends Date { static now() { return options.now?.() ?? Date.now(); } }, navigator: {},
    setTimeout(fn: () => Promise<void>) { const id = ++nextTimerId; timers.set(id, fn); scheduled.push(fn); return id; },
    clearTimeout(id: number) { const fn = timers.get(id); const index = fn ? scheduled.indexOf(fn) : -1; if (index !== -1) scheduled.splice(index, 1); timers.delete(id); },
    async fetch(path: string, init: any) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ path, body, init });
      const custom = await options.api?.(path, body);
      if (custom !== undefined) return { ok: !(custom as any).error || (custom as any).status === 'failed', json: async () => custom };
      let result: unknown = {};
      if (path === "/api/session") result = state;
      else if (path.startsWith('/api/wallet/context')) result = { ...NETWORK, ...(path.includes('?address=') ? { nonce: '0x1' } : {}) };
      else if (path === "/api/assessments") result = { url: "/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", code: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", handle: body.handle.toLowerCase(), tokenId: "123", status: "pending" };
      else if (path === "/api/assessments/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr") result = { status: "ready", handle: "agent_art", tokenId: "123", canMint: true, walletProvedForCode: true };
      else if (path === "/api/wallet/challenge") result = { challengeId: "challenge", message: "Verify wallet", address: WALLET, ...(body.code ? { code: body.code } : {}) };
      else if (path === "/api/wallet/verify" || path === "/api/dev/wallet") result = { wallet: WALLET };
      else if (path === "/api/mints/authorize") {
        options.duringAuthorize?.();
        result = { expiresAt: new Date(Date.now() + 60_000).toISOString(), code: "rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr", handle: "agent_art", tokenId: "123", network: { ...NETWORK, nonce: '0x1' }, transaction: { from: WALLET, to: CONTRACT, chainId: "31337", data: "0x1234", value: "0x0", nonce: '0x1' }, ...options.authorize };
      } else if (path === "/api/mints/status/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr") result = { state: "pending" };
      else if (path === "/api/dev/mint") result = { transactionHash: HASH };
      return { ok: true, json: async () => result };
    },
  };
  runInNewContext(OPEN_MINT_CLIENT_SCRIPT, context);
  return { elements, requests, walletCalls, scheduled, globalEvents, walletEvents, navigations, storage, state, reloads: () => reloads, rerun: () => runInNewContext(OPEN_MINT_CLIENT_SCRIPT, context) };
}
function intent(storage = new Map<string, string>(), overrides = {}) {
  storage.set('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', JSON.stringify({ code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', handle: 'agent_art', tokenId: '123', wallet: WALLET, mode: 'injected', chain: '0x7a69', contract: CONTRACT, expiresAt: Date.now() + 60_000, ...overrides }));
  return storage;
}
const sends = (test: ReturnType<typeof setup>) => test.walletCalls.filter(call => call.method === 'eth_sendTransaction');
const savedSubmission = (overrides = {}) => new Map([[SUBMISSION_KEY, JSON.stringify({ hash: HASH, wallet: WALLET, mode: 'injected', ...overrides })]]);

describe('submitted mint diagnostics', () => {
  it('detects a wallet actually broadcasting nonce 411 after receiving nonce 1 and never submits a duplicate', async () => {
    let test: ReturnType<typeof setup>;
    let walletPrompt = '', actualNonce = '';
    test = setup({ local: true, walletProved: true, walletRequest: (method, params) => {
      if (method === 'eth_sendTransaction') {
        expect((params as any)[0].nonce).toBe('0x1');
        walletPrompt = test.elements['[data-mint-feedback]'].textContent;
        actualNonce = '0x19b'; // Model the wallet ignoring the caller's explicit nonce.
        return HASH;
      }
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, nonce: actualNonce };
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(walletPrompt).toContain('Transaction nonce: 1.');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411; chain expects 1');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Correct the local wallet nonce');
    expect(test.elements['[data-poll-feedback]'].textContent).toContain(HASH);
    expect(JSON.parse(test.storage.get(SUBMISSION_KEY)!)).toMatchObject({ hash: HASH, wallet: WALLET, expectedNonce: '0x1' });
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await test.elements['[data-mint-form]'].emit('submit');
    await test.scheduled.shift()!();
    await test.elements['[data-dev-mint]'].emit('click');
    expect(sends(test)).toHaveLength(1);
    expect(test.requests.filter(r => r.path === '/api/mints/authorize')).toHaveLength(1);
    expect(test.walletCalls.filter(r => r.method.startsWith('wallet_'))).toEqual([]);
    expect(test.navigations).toEqual([]);
  });
  it.each(['pending', 'unminted'])('detects a nonce gap from an old saved hash without an authorization snapshot when status is %s', async state => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b' } : undefined }); await flush();
    await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411; chain expects 1');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]);
  });
  it('uses the original submitting wallet even if accounts change while the wallet returns its hash', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ walletProved: true, walletRequest: method => {
      if (method === 'eth_sendTransaction') test.walletEvents.accountsChanged([OTHER]);
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, nonce: '0x19b' };
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(JSON.parse(test.storage.get(SUBMISSION_KEY)!).wallet).toBe(WALLET);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
  });
  it('allows brief propagation and reports a missing transaction after 30 seconds without declaring a revert', async () => {
    let now = Date.now();
    const test = setup({ walletProved: true, now: () => now, walletRequest: method => method === 'eth_getTransactionByHash' ? null : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Waiting for it to appear');
    now += 29_999; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('dropped');
    now += 1; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('not currently visible');
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('may have been dropped');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('reverted');
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.scheduled.length).toBeGreaterThan(0);
  });
  it('preserves elapsed time across refresh and reports a previously seen transaction that disappears', async () => {
    let now = Date.now();
    const test = setup({ walletProved: true, now: () => now }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    now += 30_000;
    const refreshed = setup({ walletProved: true, storage: test.storage, now: () => now, walletRequest: method => method === 'eth_getTransactionByHash' ? null : undefined }); await flush();
    await refreshed.scheduled.shift()!();
    expect(refreshed.elements['[data-mint-feedback]'].textContent).toContain('not currently visible');
    expect(refreshed.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(sends(refreshed)).toEqual([]);
  });
  it('keeps a normally pending transaction distinct from a nonce gap and reveals only after server confirmation', async () => {
    let now = Date.now(), minted = false, mined = false;
    const test = setup({ walletProved: true, now: () => now, api: path => path.startsWith('/api/mints/status/') ? { state: minted ? 'minted' : 'unminted' } : undefined, walletRequest: (method, params) => {
      if (method === 'eth_getTransactionCount' && (params as any)[1] === 'pending' && sends(test).length) return '0x2';
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, blockNumber: mined ? '0xb' : null };
      if (method === 'eth_getTransactionReceipt') return mined ? { ...RECEIPT, status: '0x1' } : null;
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    now += 30_000; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('still pending');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('nonce gap');
    mined = true; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Waiting for the server to verify');
    expect(test.navigations).toEqual([]); expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    minted = true; await test.scheduled.shift()!();
    expect(test.navigations).toEqual(['/signatures/agent_art']);
    expect(test.storage.has(SUBMISSION_KEY)).toBe(false); expect(sends(test)).toHaveLength(1);
  });
  it('does not call a gap when earlier transactions fill it in the pending pool', async () => {
    const test = setup({ walletProved: true, storage: savedSubmission(), walletRequest: (method, params) => {
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, nonce: '0x2' };
      if (method === 'eth_getTransactionCount' && (params as any)[1] === 'pending') return '0x3';
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Waiting for confirmation');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('nonce gap');
  });
  it('reports a changed broadcast nonce even if it currently fits in the pending pool', async () => {
    const test = setup({ walletProved: true, storage: savedSubmission({ expectedNonce: '0x1' }), walletRequest: (method, params) => {
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, nonce: '0x2' };
      if (method === 'eth_getTransactionCount' && (params as any)[1] === 'pending') return '0x3';
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('broadcast transaction nonce 2; the mint requested 1');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it.each(['chain ID', 'fingerprint', 'RPC changed during reads'])('does not diagnose transaction data from a different network: %s', async variant => {
    let changed = false;
    const test = setup({ walletProved: true, storage: savedSubmission(), walletRequest: (method, params) => {
      if (method === 'eth_chainId' && variant === 'chain ID') return '0x1';
      if (method === 'eth_getBlockByNumber' && (variant === 'fingerprint' || changed)) return { number: (params as any)[0], hash: HASH };
      if (method === 'eth_getTransactionByHash') { changed = true; return { ...PENDING_TRANSACTION, nonce: '0x19b' }; }
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('different mint network');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('nonce 411');
    if (variant !== 'RPC changed during reads') expect(test.walletCalls.some(r => r.method === 'eth_getTransactionByHash')).toBe(false);
    expect(test.walletCalls.some(r => r.method.startsWith('wallet_'))).toBe(false);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
  });
  it('recovers from intermittent wallet RPC errors while preserving a known nonce gap and the submission guard', async () => {
    let unavailable = true;
    const test = setup({ walletProved: true, storage: savedSubmission(), walletRequest: method => {
      if (method === 'eth_getTransactionByHash') { if (unavailable) throw new Error('RPC unavailable'); return { ...PENDING_TRANSACTION, nonce: '0x19b' }; }
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('temporarily unavailable');
    unavailable = false; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    unavailable = true; await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('temporarily unavailable');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(sends(test)).toEqual([]);
  });
  it('replaces the ready-to-approve status on resume even when the wallet RPC check fails', async () => {
    const test = setup({ walletProved: true, storage: savedSubmission(), walletRequest: method => { if (method === 'eth_getTransactionByHash') throw new Error('RPC unavailable'); } });
    test.elements['[data-assessment-status]'].textContent = 'Your signature is ready to mint. Approve the transaction in your wallet to reveal it.';
    await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-assessment-status]'].textContent).toContain('Mint submitted');
    expect(test.elements['[data-assessment-status]'].textContent).not.toContain('Approve');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(sends(test)).toEqual([]);
  });
  it.each(['report', 'status', 'both'])('continues read-only diagnostics if the %s API fails', async failure => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => (failure !== 'status' && path === '/api/mints/report') || (failure !== 'report' && path.startsWith('/api/mints/status/')) ? { error: 'Temporary error' } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b' } : undefined }); await flush();
    await test.scheduled.shift()!(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    expect(test.requests.filter(r => r.path.startsWith('/api/mints/status/'))).toHaveLength(2);
    if (failure !== 'status') expect(test.requests.filter(r => r.path === '/api/mints/report')).toHaveLength(2);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(sends(test)).toEqual([]);
  });
  it.each([{ hash: BLOCK_HASH }, { from: OTHER }, { to: OTHER }, { nonce: '0x019b' }, { nonce: '411' }, { nonce: 411 }, { nonce: undefined }, { blockNumber: undefined }, { chainId: '0x1' }])('rejects malformed or unrelated broadcast details without releasing the guard %#', async overrides => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state: 'unminted' } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b', ...overrides } : method === 'eth_getTransactionReceipt' ? { ...RECEIPT } : undefined }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('details that do not match this mint');
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('Transaction nonce 411');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.navigations).toEqual([]);
  });
  it.each([null, { transactionHash: HASH, status: '0x0' }, { ...RECEIPT, from: OTHER }, { ...RECEIPT, to: OTHER }, { ...RECEIPT, transactionHash: BLOCK_HASH }, { ...RECEIPT, blockNumber: null }, { ...RECEIPT, status: '0x2' }])('never treats a missing, malformed, or unrelated receipt as a revert %#', async receipt => {
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state: 'unminted' } : undefined, walletRequest: method => method === 'eth_getTransactionReceipt' ? receipt : undefined }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('reverted');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.navigations).toEqual([]);
  });
  it.each(['transaction still pending', 'different transaction block', 'missing canonical block', 'noncanonical receipt block', 'RPC changed during receipt check'])('keeps the submission guard for an unverified reverted receipt: %s', async variant => {
    let changed = false;
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => path.startsWith('/api/mints/status/') ? { state: 'unminted' } : undefined, walletRequest: (method, params) => {
      if (method === 'eth_getTransactionByHash') return { ...PENDING_TRANSACTION, blockNumber: variant === 'transaction still pending' ? null : variant === 'different transaction block' ? '0xc' : '0xb' };
      if (method === 'eth_getTransactionReceipt') return { ...RECEIPT };
      if (method === 'eth_getBlockByNumber') {
        if ((params as any)[0] === '0xb') {
          if (variant === 'missing canonical block') return null;
          if (variant === 'noncanonical receipt block') return { number: '0xb', hash: HASH };
          if (variant === 'RPC changed during receipt check') changed = true;
        } else if (changed) return { number: (params as any)[0], hash: HASH };
      }
    } }); await flush(); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('transaction reverted');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true); expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    expect(test.navigations).toEqual([]);
  });
  it('times out a never-settling transaction lookup, continues canonical confirmation, and discards late diagnostics', async () => {
    let resolveLookup!: (value: unknown) => void;
    const lookup = new Promise(resolve => { resolveLookup = resolve; });
    const test = setup({ walletProved: true, api: path => path.startsWith('/api/mints/status/') ? { state: 'minted' } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? lookup : undefined }); await flush();
    const submission = test.elements['[data-mint-form]'].emit('submit'); await flush();
    expect(test.storage.has(SUBMISSION_KEY)).toBe(true);
    await test.scheduled.shift()!(); await flush(); await submission; // Eight-second diagnostic deadline.
    expect(test.elements['[data-poll-feedback]'].textContent).toContain('temporarily unavailable');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await test.elements['[data-mint-form]'].emit('submit');
    await test.scheduled.shift()!();
    expect(test.navigations).toEqual(['/signatures/agent_art']); expect(sends(test)).toHaveLength(1);
    resolveLookup({ ...PENDING_TRANSACTION, nonce: '0x19b' }); await flush();
    expect(test.elements['[data-mint-feedback]'].textContent).not.toContain('nonce 411');
    expect(test.storage.has(SUBMISSION_KEY)).toBe(false);
  });
  it('times out hanging report requests without blocking nonce diagnosis or canonical confirmation', async () => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/report' ? new Promise(() => {}) : path.startsWith('/api/mints/status/') ? { state: 'minted' } : undefined, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b' } : undefined }); await flush();
    const submission = test.elements['[data-mint-form]'].emit('submit'); await flush();
    await test.scheduled.shift()!(); await flush(); await submission;
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    const polling = test.scheduled.shift()!(); await flush();
    await test.scheduled.shift()!(); await flush(); await polling;
    expect(test.navigations).toEqual(['/signatures/agent_art']); expect(sends(test)).toHaveLength(1);
  });
  it('times out a hanging status read, inspects the existing transaction, and confirms on a later poll', async () => {
    let first = true;
    const test = setup({ walletProved: true, storage: savedSubmission(), api: path => {
      if (path.startsWith('/api/mints/status/')) { if (first) { first = false; return new Promise(() => {}); } return { state: 'minted' }; }
    }, walletRequest: method => method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, nonce: '0x19b' } : undefined }); await flush();
    const polling = test.scheduled.shift()!(); await flush();
    await test.scheduled.shift()!(); await flush(); await polling;
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Transaction nonce 411');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    await test.scheduled.shift()!();
    expect(test.navigations).toEqual(['/signatures/agent_art']); expect(sends(test)).toEqual([]);
  });
});

describe('preview and mint browser lifecycle', () => {
  it('performs no requests on preview and never assesses on a plain mint page load', async () => {
    const preview = setup({ preview: true }); preview.rerun(); await flush();
    expect(preview.requests).toEqual([]); expect(preview.walletCalls).toEqual([]);
    const entry = setup({ entry: true }); await flush();
    expect(entry.requests.map(r => r.path)).toEqual(['/api/session']); expect(entry.walletCalls).toEqual([]);
  });
  it('blocks assessment without verified wallet, including programmatic form submission', async () => {
    const test = setup({ entry: true }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit');
    expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
    expect(test.elements['[data-request-feedback]'].textContent).toContain('Connect and verify');
  });
  it('connects a general wallet without assessment, transaction, or navigation', async () => {
    const test = setup({ entry: true }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.requests.find(r => r.path === '/api/wallet/challenge')?.body).toEqual({ address: WALLET });
    expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
    expect(test.elements['[data-assessment-request]'].children['button[type=submit]'].disabled).toBe(false);
    expect(sends(test)).toEqual([]); expect(test.navigations).toEqual([]);
  });
  it.each(['connect', 'assess', 'mint'])('blocks %s on another Anvil node with the same chain ID', async action => {
    const test = setup({ local: true, entry: action !== 'mint', walletProved: action !== 'connect', walletRequest: method => method === 'eth_getBlockByNumber' ? { number: NETWORK.blockNumber, hash: HASH } : undefined }); await flush();
    await test.elements[action === 'connect' ? '[data-connect-wallet]' : action === 'assess' ? '[data-assessment-request]' : '[data-mint-form]'].emit(action === 'connect' ? 'click' : 'submit');
    expect(test.requests.some(r => ['/api/assessments', '/api/mints/authorize', '/api/wallet/challenge'].includes(r.path))).toBe(false);
    expect(test.walletCalls.some(r => r.method === 'personal_sign')).toBe(false);
    expect(sends(test)).toEqual([]);
    expect(test.elements[action === 'assess' ? '[data-request-feedback]' : '[data-mint-feedback]'].textContent).toContain('Set its RPC to http://127.0.0.1:8545');
  });
  it.each([null, { number: '0x9', hash: BLOCK_HASH }])('fails closed when the wallet cannot confirm the trusted block %#', async block => {
    const test = setup({ walletProved: true, walletRequest: method => method === 'eth_getBlockByNumber' ? block : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]); expect(test.requests.some(r => r.path === '/api/mints/authorize')).toBe(false);
  });
  it.each([{}, { ...NETWORK, contract: OTHER }, { ...NETWORK, chainId: '0x1' }, { ...NETWORK, blockNumber: '0x01' }, { ...NETWORK, blockHash: '0x1234' }])('requires a complete trusted network context before signing %#', async network => {
    const test = setup({ entry: true, api: path => path === '/api/wallet/context' ? network : undefined }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.walletCalls.some(r => r.method === 'personal_sign')).toBe(false);
  });
  it('checks a fresh network context after the sign-in challenge and before personal_sign', async () => {
    let contexts = 0;
    const test = setup({ entry: true, api: path => path === '/api/wallet/context' ? { ...NETWORK, blockHash: ++contexts === 1 ? BLOCK_HASH : HASH } : undefined }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.requests.some(r => r.path === '/api/wallet/challenge')).toBe(true);
    expect(test.walletCalls.some(r => r.method === 'personal_sign')).toBe(false);
    expect(test.requests.filter(r => r.path === '/api/wallet/context').every(r => r.init.cache === 'no-store')).toBe(true);
  });
  it('blocks account-change events during the wallet challenge even if the address changes back', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ entry: true, api: path => { if (path === '/api/wallet/challenge') { test.walletEvents.accountsChanged([OTHER]); test.walletEvents.accountsChanged([WALLET]); } } }); await flush();
    await test.elements['[data-connect-wallet]'].emit('click');
    expect(test.walletCalls.some(r => r.method === 'personal_sign')).toBe(false);
    expect(test.elements['[data-assessment-request]'].children['button[type=submit]'].disabled).toBe(true);
  });
  it('passes the verified canonical nonce explicitly when the wallet honors it', async () => {
    let broadcastNonce = '0x19a';
    const test = setup({ walletProved: true, walletRequest: (method, params) => { if (method === 'eth_sendTransaction') broadcastNonce = (params as any)[0].nonce ?? broadcastNonce; } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1); expect(broadcastNonce).toBe('0x1');
    expect((sends(test)[0].params as any)[0]).toMatchObject({ from: WALLET, to: CONTRACT, nonce: '0x1', value: '0x0' });
    expect(test.requests.some(r => r.path === '/api/wallet/context?address=' + WALLET)).toBe(true);
    expect(test.walletCalls.find(r => r.method === 'eth_getTransactionCount')?.params).toEqual([WALLET, 'pending']);
    expect(test.walletCalls.find(r => r.method === 'eth_call')?.params).toEqual([{ from: WALLET, to: CONTRACT, data: '0x1234', value: '0x0' }, 'latest']);
  });
  it.each(['0x19a', '0x2'])('blocks wallet-reported nonce %s when the authorized nonce is 1', async nonce => {
    const test = setup({ walletProved: true, walletRequest: method => method === 'eth_getTransactionCount' ? nonce : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]); expect(test.elements['[data-mint-feedback]'].textContent).toContain('nonce changed or does not match');
    expect(test.storage.has('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(false);
  });
  it.each([undefined, null, 1, '1', '0x01', '0xA', '0x-1', '0x20000000000000'])('requires canonical safe nonnegative transaction nonce %#', async nonce => {
    const test = setup({ walletProved: true, authorize: { transaction: { from: WALLET, to: CONTRACT, chainId: '31337', data: '0x1234', value: '0x0', nonce } } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('nonce is invalid');
  });
  it.each([undefined, {}, { ...NETWORK }, { ...NETWORK, nonce: '0x2' }, { ...NETWORK, nonce: '0x1', blockHash: HASH }])('requires matching authorization network proof %#', async network => {
    const test = setup({ walletProved: true, authorize: { network } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
  });
  it.each([{ ...NETWORK, nonce: '0x2' }, { ...NETWORK }, { ...NETWORK, nonce: '0x1', blockHash: HASH }])('blocks a changed or incomplete fresh pre-send context %#', async network => {
    const test = setup({ walletProved: true, api: path => path.startsWith('/api/wallet/context?') ? network : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
  });
  it('blocks wallet RPC changes after authorization, even without a chainChanged event', async () => {
    let changed = false;
    const test = setup({ walletProved: true, duringAuthorize: () => { changed = true; }, walletRequest: (method, params) => method === 'eth_getBlockByNumber' && changed ? { number: (params as any)[0], hash: HASH } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.requests.some(r => r.path === '/api/mints/authorize')).toBe(true);
  });
  it('never broadcasts if the exact transaction simulation fails', async () => {
    const test = setup({ walletProved: true, walletRequest: method => { if (method === 'eth_call') throw new Error('Execution reverted'); } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-mint-feedback]'].textContent).toBe('Execution reverted');
    expect(test.storage.has('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
  });
  it('detects a same-chain RPC swap during the simulation before submitting', async () => {
    let changed = false;
    const test = setup({ walletProved: true, walletRequest: (method, params) => {
      if (method === 'eth_call') changed = true;
      if (method === 'eth_getBlockByNumber' && changed) return { number: (params as any)[0], hash: HASH };
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
  });
  it('rechecks the provider nonce after simulation and blocks a concurrently consumed nonce', async () => {
    let simulated = false;
    const test = setup({ walletProved: true, walletRequest: method => {
      if (method === 'eth_call') simulated = true;
      if (method === 'eth_getTransactionCount') return simulated ? '0x2' : '0x1';
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]);
    expect(test.walletCalls.filter(r => r.method === 'eth_getTransactionCount')).toHaveLength(2);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('nonce changed or does not match');
    expect(test.storage.has('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
  });
  it('rechecks the backend nonce after simulation before sending', async () => {
    let contexts = 0;
    const test = setup({ walletProved: true, api: path => path.startsWith('/api/wallet/context?') ? { ...NETWORK, nonce: ++contexts === 1 ? '0x1' : '0x2' } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(contexts).toBe(2);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('nonce changed or does not match');
  });
  it('rechecks account-change generations after all RPC awaits', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ walletProved: true, walletRequest: method => {
      if (method === 'eth_call') { test.walletEvents.accountsChanged([OTHER]); test.walletEvents.accountsChanged([WALLET]); }
    } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it('sends only case-preserved handle under CSRF and stores a wallet-bound intent', async () => {
    const test = setup({ entry: true, walletProved: true }); await flush();
    test.elements['[data-assessment-request]'].children['input[name=handle]'].value = ' @Alice_Bob_Key ';
    await test.elements['[data-assessment-request]'].emit('submit');
    const request = test.requests.find(r => r.path === '/api/assessments')!;
    expect(request.body).toEqual({ handle: 'Alice_Bob_Key' });
    expect(request.init.credentials).toBe('same-origin'); expect(request.init.headers['X-CSRF-Token']).toBe('csrf');
    expect(test.navigations).toEqual(['/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr']);
    expect(JSON.parse(test.storage.get('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')!)).toMatchObject({ handle: 'alice_bob_key', wallet: WALLET, tokenId: '123', mode: 'injected' });
    expect(sends(test)).toEqual([]);
  });
  it.each(['/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr/extra', '/p/agent_art/ENFP', 'https://attacker.test/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', '/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr?mbti=INTJ', '/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr#mint'])('rejects malformed result URL %s', async url => {
    const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { url, code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', handle: 'agent_art', tokenId: '123' } : undefined }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit');
    expect(test.navigations).toEqual([]); expect(test.elements['[data-request-feedback]'].textContent).toContain('invalid result link');
  });
  it('does not accept another handle in the prepare response', async () => {
    const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { url: '/mint/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', handle: 'other', tokenId: '123' } : undefined }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit'); expect(test.navigations).toEqual([]);
  });
  it('navigates an already-minted handle only to its exact same-origin permalink', async () => {
    for (const url of ['/signatures/agent_art', 'https://attacker.test/signatures/agent_art']) {
      const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { error: 'Minted', code: 'ALREADY_MINTED', url } : undefined }); await flush();
      await test.elements['[data-assessment-request]'].emit('submit');
      expect(test.navigations).toEqual(url.startsWith('/') ? [url] : []);
    }
  });
  it('continues an explicit one-shot intent after assessment, without a second art confirmation', async () => {
    const test = setup({ pending: true, walletProved: true, storage: intent() }); await flush();
    expect(sends(test)).toEqual([]); expect(test.scheduled).toHaveLength(1);
    await test.scheduled.shift()!();
    expect(sends(test)).toHaveLength(1);
    expect(test.requests.find(r => r.path === '/api/mints/authorize')?.body).toEqual({ code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', consent: true });
    expect(test.storage.has('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
    expect(test.navigations).toEqual([]);
    expect(test.requests.every(r => !r.path.startsWith('/artifacts/'))).toBe(true);
  });
  it('does not auto-prompt for a ready result without a prior explicit intent', async () => {
    const test = setup({ walletProved: true }); await flush();
    expect(sends(test)).toEqual([]); expect(test.walletCalls).toEqual([]);
    await test.elements['[data-mint-form]'].emit('submit'); await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1); expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it.each([{ expiresAt: 0 }, { wallet: OTHER }, { tokenId: '999' }, { handle: 'other' }, { contract: OTHER }, { chain: '0x1' }, { mode: 'local' }])('discards stale or mismatched resume intent %#', async value => {
    const test = setup({ walletProved: true, storage: intent(undefined, value) }); await flush();
    expect(sends(test)).toEqual([]); expect(test.storage.has('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
  });
  it('waits for an explicit continuation after wallet cancellation and reuses preparation', async () => {
    let cancel = true;
    const test = setup({ walletProved: true, storage: intent(), walletRequest: method => { if (method === 'eth_sendTransaction' && cancel) throw Object.assign(new Error('User rejected'), { code: 4001 }); } }); await flush();
    expect(test.storage.has('sg-open:intent:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false); expect(test.storage.has('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('Cancelled');
    cancel = false; await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(2); expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it('persists unknown submission outcomes and never blindly resubmits on refresh', async () => {
    const test = setup({ walletProved: true, walletRequest: method => { if (method === 'eth_sendTransaction') throw new Error('Connection lost'); } }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toHaveLength(1); expect(test.elements['[data-mint-feedback]'].textContent).toContain('uncertain');
    const refreshed = setup({ walletProved: true, storage: test.storage }); await flush();
    await refreshed.elements['[data-mint-form]'].emit('submit'); expect(sends(refreshed)).toEqual([]);
  });
  it('persists a submitted hash and retries failed reporting after refresh, revealing only on minted state', async () => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/report' ? { error: 'Temporary failure' } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(test.navigations).toEqual([]); expect(test.storage.get('sg-open:submission:rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr')).toContain(HASH);
    const refreshed = setup({ walletProved: true, storage: test.storage, api: path => path === '/api/mints/status/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' ? { state: 'minted' } : undefined }); await flush();
    await refreshed.scheduled.shift()!();
    expect(refreshed.requests.find(r => r.path === '/api/mints/report')?.body).toEqual({ code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', transactionHash: HASH });
    expect(refreshed.navigations).toEqual(['/signatures/agent_art']); expect(sends(refreshed)).toEqual([]);
  });
  it('permits explicit continuation after a matching reverted receipt without reassessment', async () => {
    const test = setup({ walletProved: true, api: path => path === '/api/mints/status/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' ? { state: 'unminted' } : undefined, walletRequest: method => method === 'eth_getTransactionReceipt' ? { ...RECEIPT } : method === 'eth_getTransactionByHash' ? { ...PENDING_TRANSACTION, blockNumber: RECEIPT.blockNumber } : undefined }); await flush();
    await test.elements['[data-mint-form]'].emit('submit'); await test.scheduled.shift()!();
    expect(test.elements['[data-mint-feedback]'].textContent).toContain('reverted'); expect(test.elements['[data-submit-mint]'].disabled).toBe(false);
    expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it.each([
    { code: 'other' }, { handle: 'someone_else' }, { tokenId: '999' }, { expiresAt: '2000-01-01T00:00:00Z' },
    { transaction: { from: OTHER, to: CONTRACT, chainId: '31337', data: '0x1234', value: '0x0' } },
    { transaction: { from: WALLET, to: OTHER, chainId: '31337', data: '0x1234', value: '0x0' } },
    { transaction: { from: WALLET, to: CONTRACT, chainId: '1', data: '0x1234', value: '0x0' } },
    { transaction: { from: WALLET, to: CONTRACT, chainId: '31337', data: '0x1234', value: '0x1' } },
  ])('blocks mismatched or expired authorization %#', async authorize => {
    const test = setup({ walletProved: true, authorize }); await flush(); await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]); expect(test.elements['[data-mint-feedback]'].textContent).toMatch(/different work|expired|does not match/);
  });
  it('blocks account changes during authorization and disables controls', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ walletProved: true, duringAuthorize: () => test.walletEvents.accountsChanged([OTHER]) }); await flush();
    await test.elements['[data-mint-form]'].emit('submit');
    expect(sends(test)).toEqual([]); expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it('does not assess if the injected wallet differs from the signed session', async () => {
    const test = setup({ entry: true, walletProved: true, accounts: () => [OTHER] }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit'); expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it('stops on failed assessment without requesting a wallet transaction', async () => {
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path === '/api/assessments/rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr' ? { handle: 'agent_art', tokenId: '123', status: 'failed', error: 'No usable public content.' } : undefined }); await flush();
    await test.scheduled.shift()!(); expect(sends(test)).toEqual([]); expect(test.elements['[data-mint-feedback]'].textContent).toContain('No usable public content');
  });
  it('connects local DEV wallet without minting and follows only explicit local intent', async () => {
    const entry = setup({ entry: true, local: true }); await flush();
    await entry.elements['[data-dev-wallet]'].emit('click'); expect(entry.navigations).toEqual([]);
    expect(entry.elements['[data-dev-wallet]'].disabled).toBe(false);
    expect(entry.elements['[data-assessment-request]'].children['button[type=submit]'].disabled).toBe(false);
    expect(entry.requests.some(r => r.path === '/api/dev/mint' || r.path === '/api/assessments')).toBe(false);
    await entry.elements['[data-assessment-request]'].emit('submit');
    const result = setup({ local: true, walletProved: true, storage: entry.storage }); await flush();
    expect(result.requests.find(r => r.path === '/api/dev/mint')?.body).toEqual({ code: 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', consent: true });
    expect(result.walletCalls).toEqual([]); expect(result.navigations).toEqual([]);
  });
  it('does not loop on legacy minted markup with an empty request code', async () => {
    const test = setup({ preview: true });
    const article = new Element(); article.dataset = { assessmentCode: '', assessmentHandle: 'agent_art', mintState: 'minted' };
    test.elements['[data-assessment-code]'] = article;
    // A separate execution represents a document with empty-code public markup.
    const scriptWindow: Record<string, unknown> = { addEventListener() {} };
    runInNewContext(OPEN_MINT_CLIENT_SCRIPT, { window: scriptWindow, document: { querySelector: (key: string) => test.elements[key] ?? null, querySelectorAll: () => [] }, AbortController, Date, URL, location: { assign: (url: string) => test.navigations.push(url) }, fetch: () => { throw new Error('Public minted page must not poll.'); } });
    await flush(); expect(test.navigations).toEqual([]); expect(test.requests).toEqual([]);
  });
  it('cancels paid preparation on an account-change event during eth_accounts, even if the account changes back', async () => {
    let test: ReturnType<typeof setup>;
    test = setup({ entry: true, walletProved: true, walletRequest: method => {
      if (method === 'eth_accounts') { test.walletEvents.accountsChanged([OTHER]); test.walletEvents.accountsChanged([WALLET]); return [WALLET]; }
    } }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit');
    expect(test.requests.some(r => r.path === '/api/assessments')).toBe(false);
  });
  it('does not auto-mint when wallet proof expires while an assessment runs', async () => {
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path.startsWith('/api/assessments/') ? { handle: 'agent_art', tokenId: '123', status: 'ready', canMint: true, walletProvedForCode: false } : undefined }); await flush();
    await test.scheduled.shift()!(); expect(sends(test)).toEqual([]);
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
    expect(test.elements['[data-assessment-status]'].textContent).toContain('ready to mint');
  });
  it('waits for confirmation without authorization if the handle is already confirming', async () => {
    const test = setup({ pending: true, walletProved: true, storage: intent(), api: path => path.startsWith('/api/assessments/') ? { handle: 'agent_art', tokenId: '123', status: 'ready', canMint: false, mint: { state: 'pending' } } : undefined }); await flush();
    await test.scheduled.shift()!();
    expect(test.requests.some(r => r.path === '/api/mints/authorize')).toBe(false);
    expect(test.elements['[data-assessment-status]'].textContent).toContain('Waiting to reveal');
    expect(test.elements['[data-submit-mint]'].disabled).toBe(true);
  });
  it.each(['WALLET_PROOF_REQUIRED', 'MINT_NETWORK_UNAVAILABLE'])('keeps local pre-broadcast rejection %s retryable instead of marking an unknown transaction', async code => {
    const test = setup({ local: true, api: path => path === '/api/dev/mint' ? { error: 'Network or wallet unavailable', code } : undefined }); await flush();
    await test.elements['[data-dev-wallet]'].emit('click'); await test.elements['[data-dev-mint]'].emit('click');
    expect([...test.storage.keys()].some(key => key.includes('submission:'))).toBe(false);
    expect(test.elements['[data-mint-feedback]'].textContent).toContain(code === 'WALLET_PROOF_REQUIRED' ? 'Connect and verify' : 'Network or wallet unavailable');
    expect(test.elements['[data-dev-mint]'].disabled).toBe(false);
    expect(test.walletCalls).toEqual([]);
  });
  it('keeps raw server errors meaningful and disposes polling/listeners on navigation', async () => {
    const test = setup({ entry: true, walletProved: true, api: path => path === '/api/assessments' ? { error: 'Generation is not configured.', code: 'GROK_NOT_CONFIGURED' } : undefined }); await flush();
    await test.elements['[data-assessment-request]'].emit('submit'); expect(test.elements['[data-request-feedback]'].textContent).toBe('Generation is not configured.');
    const pending = setup({ pending: true }); await flush(); const poll = pending.scheduled[0]; pending.globalEvents.pagehide({});
    expect(pending.scheduled).toEqual([]);
    await poll(); expect(pending.walletEvents).toEqual({}); expect(pending.requests).toHaveLength(1);
  });
});
