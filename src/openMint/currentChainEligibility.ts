import { performance } from "node:perf_hooks";
import type { Address, Hex } from "viem";
import { openMintHandleKey } from "./authorization.js";
import { PublicChainGate, PublicChainGateError, type PublicChainBlock, type PublicChainGateConfig } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";

function head(value: unknown): PublicChainBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicChainGateError("Current chain head unavailable.");
  const { number, hash } = value as Record<string, unknown>;
  if (typeof number !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(number) || number.length > 66
    || typeof hash !== "string" || !/^0x[0-9a-f]{64}$/.test(hash) || /^0x0{64}$/.test(hash)) throw new PublicChainGateError("Malformed current chain head.");
  return Object.freeze({ number: BigInt(number), hash: hash as Hex });
}

/** Backend-owned current-head acquisition for *eligibility*, not confirmation
 * or gallery finality. Select a bounded common height, then run all pinned
 * two-source checks. No fallback RPC, older-height search, retries or broadcast.
 */
export function createCurrentChainEligibility(options: {
  config: PublicChainGateConfig;
  rpcs: readonly [PublicChainRpc, PublicChainRpc];
  /** Explicit operator policy, never a browser field or implied finality rule. */
  maxHeadLag: bigint;
}, now: () => number = Date.now) {
  if (typeof options.maxHeadLag !== "bigint" || options.maxHeadLag < 0n || options.maxHeadLag > 64n) throw new PublicChainGateError("Invalid maximum RPC head lag.");
  if (options.rpcs.length !== 2 || options.rpcs[0] === options.rpcs[1]) throw new PublicChainGateError("Two distinct RPC sources are required.");
  const rpcs = Object.freeze(options.rpcs.map(rpc => Object.freeze({ id: rpc.id, request: rpc.request.bind(rpc) }))) as unknown as readonly [PublicChainRpc, PublicChainRpc];
  const gate = new PublicChainGate(options.config, rpcs, now), maxHeadLag = options.maxHeadLag,
    deploymentBlock = options.config.deploymentBlock.number, timeoutMs = options.config.observationTimeoutMs;
  return async (input: { readonly handle: string; readonly recipient: Address; readonly nonce: Hex }, signal: AbortSignal) => {
    const captured = Object.freeze({ handle: input.handle, recipient: input.recipient, nonce: input.nonce });
    openMintHandleKey(captured.handle);
    if (signal.aborted) throw new PublicChainGateError("Chain observation cancelled.");
    const controller = new AbortController(), deadlineAt = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const check = () => {
      if (signal.aborted || controller.signal.aborted || performance.now() >= deadlineAt) throw new PublicChainGateError("Current chain observation expired or cancelled.");
    };
    const stopped = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new PublicChainGateError("Current chain observation cancelled.")); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new PublicChainGateError("Current chain observation timed out.")); }, timeoutMs);
    });
    const work = async () => {
      check();
      const heads = await Promise.all(rpcs.map(async rpc => {
        check(); const result = await rpc.request("eth_getBlockByNumber", ["latest", false], controller.signal);
        check(); return head(result);
      }));
      check();
      const [a, b] = heads, lower = a.number <= b.number ? a : b, higher = a.number >= b.number ? a : b;
      if (higher.number - lower.number > maxHeadLag || lower.number < deploymentBlock) throw new PublicChainGateError("Current RPC heads exceed the configured lag or deployment boundary.");
      if (a.number === b.number && a.hash !== b.hash) throw new PublicChainGateError("Current RPC heads disagree.");
      // Even when heights differ, BOTH sources must verify lower's exact hash
      // and canonical state through the gate; the slower source is not trusted
      // on its own, and freshness/deployment/code/domain checks are unchanged.
      const witness = await gate.preflight({ ...captured, block: lower, signal: controller.signal });
      check(); return witness;
    };
    try { return await Promise.race([work(), stopped]); }
    catch { throw new PublicChainGateError("Current chain eligibility failed closed."); }
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  };
}
