import { performance } from "node:perf_hooks";
import { parseCanonicalCidV1 } from "../v2/core/ipfsCid.js";
import { PUBLIC_ARTIFACT_MAX_BYTES, publicArtworkOrigin, verifyPublicObject, type PublicObject } from "./publicArtifacts.js";
import type { PublicArtifactReader } from "./publicPublication.js";

/** An independent read-only HTTPS gateway. The operator must supply an egress-
 * restricted fetch (including DNS policy), not an upload-buffer echo. No default
 * gateway, credentials, public-network choice or automatic retry is provided. */
export function createPublicIpfsReader(input: {
  id: string; gatewayOrigin: string; timeoutMs: number;
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
}): PublicArtifactReader {
  const { id, gatewayOrigin, timeoutMs, fetchFn } = input;
  publicArtworkOrigin(gatewayOrigin);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || typeof fetchFn !== "function") throw new Error("Invalid independent gateway configuration.");
  return Object.freeze({ id, async retrieve(value: PublicObject, options: { signal: AbortSignal; maxBytes: number }): Promise<Uint8Array> {
    const object = structuredClone(value), signal = options.signal, maxBytes = options.maxBytes;
    parseCanonicalCidV1(object.cid);
    if (object.uri !== `ipfs://${object.cid}` || !Number.isSafeInteger(object.byteLength) || object.byteLength < 1
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PUBLIC_ARTIFACT_MAX_BYTES || object.byteLength > maxBytes
      || !["image/svg+xml", "image/png", "application/json"].includes(object.mediaType)) throw new Error("Invalid gateway object bounds.");
    const url = `${gatewayOrigin}/ipfs/${object.cid}`, controller = new AbortController(), expires = performance.now() + timeoutMs;
    const check = () => {
      if (controller.signal.aborted || signal.aborted) throw new Error("Public object retrieval cancelled.");
      if (performance.now() >= expires) throw new Error("Public object retrieval timed out.");
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | null | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); void reader?.cancel().catch(() => undefined); reject(new Error("Public object retrieval cancelled.")); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => undefined); reject(new Error("Public object retrieval timed out.")); }, timeoutMs);
    });
    try {
      check();
      const work = async () => {
        const response = await fetchFn(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
          referrerPolicy: "no-referrer", headers: { Accept: object.mediaType }, signal: controller.signal });
        body = response.body;
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw new Error("Public object retrieval cancelled."); }
        check();
        if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !response.body) throw new Error("Independent gateway did not return the exact object.");
        const length = response.headers.get("content-length");
        if (length !== null && (!/^[1-9][0-9]*$/.test(length) || Number(length) !== object.byteLength)) throw new Error("Gateway content length mismatch.");
        reader = response.body.getReader();
        // Preallocate the bounded object rather than retaining an unbounded
        // number of small chunk objects from a hostile gateway stream.
        const bytes = new Uint8Array(object.byteLength); let total = 0, emptyChunks = 0;
        for (;;) {
          const chunk = await reader.read();
          check();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array) || total + chunk.value.byteLength > object.byteLength) throw new Error("Gateway object exceeded its byte limit.");
          if (chunk.value.byteLength === 0) {
            if (++emptyChunks > 16) throw new Error("Gateway stream made no progress.");
            continue;
          }
          emptyChunks = 0; bytes.set(chunk.value, total); total += chunk.value.byteLength;
        }
        if (total !== object.byteLength) throw new Error("Gateway object length mismatch.");
        await verifyPublicObject({ object, bytes }, object.mediaType);
        check();
        return bytes;
      };
      return await Promise.race([work(), stop]);
    } finally {
      clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort);
      controller.abort(); void reader?.cancel().catch(() => undefined);
      if (!reader) void body?.cancel().catch(() => undefined);
    }
  } });
}
