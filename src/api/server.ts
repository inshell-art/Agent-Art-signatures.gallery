/**
 * HTTP API — handoff §9, plus rate limiting (§9.1) and X OAuth claiming
 * (§10). The mint path's render step is blocked on the algorithm (see
 * mint.ts) and 501s until that lands; everything around it — validation,
 * idempotency, rate limiting, rasterization/asset serving, claiming — is
 * real.
 *
 * Built on node:http rather than a framework — the route count doesn't
 * justify one yet. Swap freely once the surface grows.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AssetStore } from "../assets/types.js";
import { PendingClaims } from "../claim/pendingClaims.js";
import { generateCodeChallenge, generateCodeVerifier, generateState, type XOAuthClient } from "../claim/xOAuthClient.js";
import { NotImplementedError, ValidationError } from "../errors.js";
import { RateLimiter } from "../rateLimit.js";
import type { Store } from "../store/types.js";
import { instanceAssetKey, mintOrFetchInstance } from "./mint.js";

const MINT_PATTERN = /^\/s\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
const CLUSTER_PATTERN = /^\/c\/([^/]+)\/?$/;
const VERIFY_PATTERN = /^\/v\/([^/]+)\/?$/;
const INSTANCE_IMAGE_PATTERN = /^\/i\/instance\/([^/]+)\.png$/;

// Handoff §9.1: "Rate-limit per handle and per source IP."
const MINT_LIMIT = 30;
const MINT_WINDOW_MS = 10 * 60 * 1000;

export interface AppOptions {
  oauthClient?: XOAuthClient;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function requestBaseUrl(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  return `${proto}://${req.headers.host}`;
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

async function handleMint(
  store: Store,
  assetStore: AssetStore,
  perHandleLimiter: RateLimiter,
  perIpLimiter: RateLimiter,
  req: IncomingMessage,
  res: ServerResponse,
  handle: string,
  code: string,
  postId: string,
) {
  if (!perHandleLimiter.tryConsume(handle) || !perIpLimiter.tryConsume(clientIp(req))) {
    sendJson(res, 429, { error: "rate limit exceeded" });
    return;
  }

  const { instance } = await mintOrFetchInstance(store, assetStore, { handle, code, postId });

  const ogImage = `${requestBaseUrl(req)}/i/instance/${instance.id}.png`;
  const html = `<!doctype html>
<html>
<head>
<meta property="og:title" content="${instance.seedHandle}'s signature" />
<meta property="og:description" content="${instance.rationale ?? ""}" />
<meta property="og:image" content="${ogImage}" />
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

async function handleInstanceImage(assetStore: AssetStore, res: ServerResponse, id: string) {
  const png = await assetStore.getPng(instanceAssetKey(id));
  if (!png) {
    sendJson(res, 404, { error: "image not found" });
    return;
  }
  res.writeHead(200, { "Content-Type": "image/png" });
  res.end(png);
}

async function handleClaimStart(oauthClient: XOAuthClient, pending: PendingClaims, res: ServerResponse) {
  const state = generateState();
  const verifier = generateCodeVerifier();
  pending.start(state, verifier);
  const url = oauthClient.getAuthorizeUrl(state, generateCodeChallenge(verifier));
  res.writeHead(302, { Location: url });
  res.end();
}

async function handleClaimCallback(
  store: Store,
  oauthClient: XOAuthClient,
  pending: PendingClaims,
  res: ServerResponse,
  query: URLSearchParams,
) {
  const state = query.get("state");
  const code = query.get("code");
  if (!state || !code) {
    sendJson(res, 400, { error: "missing code or state" });
    return;
  }
  const verifier = pending.consume(state);
  if (!verifier) {
    sendJson(res, 400, { error: "unknown or expired state" });
    return;
  }
  const accessToken = await oauthClient.exchangeCode(code, verifier);
  const user = await oauthClient.getUser(accessToken);
  // §10: bind to the numeric ID, never the handle string; freeze
  // seed_handle at first claim only.
  const account = await store.claimAccount(user.id, user.username);
  sendJson(res, 200, { xUserId: account.xUserId, seedHandle: account.seedHandle, currentHandle: account.currentHandle });
}

export function createApp(store: Store, assetStore: AssetStore, options: AppOptions = {}) {
  const perHandleLimiter = new RateLimiter(MINT_LIMIT, MINT_WINDOW_MS);
  const perIpLimiter = new RateLimiter(MINT_LIMIT, MINT_WINDOW_MS);
  const pendingClaims = new PendingClaims();

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const mintMatch = url.pathname.match(MINT_PATTERN);
      if (mintMatch) {
        const [, handle, code, postId] = mintMatch;
        await handleMint(
          store,
          assetStore,
          perHandleLimiter,
          perIpLimiter,
          req,
          res,
          decodeURIComponent(handle),
          decodeURIComponent(code),
          decodeURIComponent(postId),
        );
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

      const imageMatch = url.pathname.match(INSTANCE_IMAGE_PATTERN);
      if (imageMatch) {
        await handleInstanceImage(assetStore, res, decodeURIComponent(imageMatch[1]));
        return;
      }

      if (url.pathname === "/claim/start") {
        if (!options.oauthClient) {
          sendJson(res, 501, { error: "claiming is not configured" });
          return;
        }
        await handleClaimStart(options.oauthClient, pendingClaims, res);
        return;
      }

      if (url.pathname === "/claim/callback") {
        if (!options.oauthClient) {
          sendJson(res, 501, { error: "claiming is not configured" });
          return;
        }
        await handleClaimCallback(store, options.oauthClient, pendingClaims, res, url.searchParams);
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

export function startServer(store: Store, assetStore: AssetStore, port: number, options: AppOptions = {}) {
  const server = createServer(createApp(store, assetStore, options));
  server.listen(port);
  return server;
}
