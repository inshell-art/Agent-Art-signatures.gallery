/**
 * HTTP API — handoff §9. Skeleton: routing, validation, and the read paths
 * are real; the mint path's render/rasterize/persist step is blocked on the
 * algorithm (see mint.ts) and returns 501 until that lands.
 *
 * Built on node:http rather than a framework — three routes, no need for
 * more yet. Swap freely once the surface grows.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NotImplementedError, ValidationError } from "../errors.js";
import type { Store } from "../store/types.js";
import { mintOrFetchInstance } from "./mint.js";

const MINT_PATTERN = /^\/s\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
const CLUSTER_PATTERN = /^\/c\/([^/]+)\/?$/;
const VERIFY_PATTERN = /^\/v\/([^/]+)\/?$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function handleMint(store: Store, res: ServerResponse, handle: string, code: string, postId: string) {
  const { instance } = await mintOrFetchInstance(store, { handle, code, postId });
  // Real response per §9.1: HTML with og:image (absolute PNG URL), og:title,
  // og:description, twitter:card. og:image is not populated here — it
  // depends on the PNG rasterized from the (not yet implemented) SVG.
  const html = `<!doctype html>
<html>
<head>
<meta property="og:title" content="${instance.seedHandle}'s signature" />
<meta property="og:description" content="${instance.rationale ?? ""}" />
<meta name="twitter:card" content="summary_large_image" />
</head>
<body></body>
</html>`;
  sendHtml(res, 200, html);
}

async function handleCluster(store: Store, res: ServerResponse, handle: string) {
  const instances = await store.listInstancesForHandle(handle);
  // Canonical rendering (render_canonical) is blocked on the algorithm too;
  // exposed as null here rather than omitted, so clients see it's pending
  // rather than absent.
  sendJson(res, 200, { handle, canonical: null, instances });
}

async function handleVerify(store: Store, res: ServerResponse, id: string) {
  const instance = await store.getInstanceById(id);
  if (!instance) {
    sendJson(res, 404, { error: "instance not found" });
    return;
  }
  // Per §9.4: everything needed to recompute the instance independently.
  sendJson(res, 200, {
    seedHandle: instance.seedHandle,
    reading: instance.readingJson,
    readingCode: instance.readingCode,
    sourcePostId: instance.sourcePostId,
    offsetVector: instance.offsetVector,
    specVersion: instance.specVersion,
    mapVersion: instance.mapVersion,
    schemaVersion: instance.schemaVersion,
  });
}

export function createApp(store: Store) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const mintMatch = url.pathname.match(MINT_PATTERN);
      if (mintMatch) {
        const [, handle, code, postId] = mintMatch;
        await handleMint(store, res, decodeURIComponent(handle), decodeURIComponent(code), decodeURIComponent(postId));
        return;
      }

      const clusterMatch = url.pathname.match(CLUSTER_PATTERN);
      if (clusterMatch) {
        await handleCluster(store, res, decodeURIComponent(clusterMatch[1]));
        return;
      }

      const verifyMatch = url.pathname.match(VERIFY_PATTERN);
      if (verifyMatch) {
        await handleVerify(store, res, decodeURIComponent(verifyMatch[1]));
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof ValidationError) {
        sendJson(res, 400, { error: err.message });
      } else if (err instanceof NotImplementedError) {
        sendJson(res, 501, { error: err.message });
      } else {
        sendJson(res, 500, { error: "internal error" });
      }
    }
  };
}

export function startServer(store: Store, port: number) {
  const server = createServer(createApp(store));
  server.listen(port);
  return server;
}
