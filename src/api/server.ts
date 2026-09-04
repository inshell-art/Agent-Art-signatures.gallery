import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateCodeChallenge, generateCodeVerifier, type XOAuthClient } from "../claim/xOAuthClient.js";
import { MemoryAuthState, type BrowserSession, type OAuthFlow } from "../v1/authState.js";
import type { ArtifactStore } from "../v1/artifacts.js";
import { finalizeClaim } from "../v1/claim.js";
import { fixtureIdentity } from "../v1/fixtures.js";
import { formatGr0k, GR0K_SCALE, InputError, normalizeHandleSegment, normalizeHandleValue, parseGr0kSegment, parseGr0kValue } from "../v1/input.js";
import { DailyCircuitBreaker, SlidingWindowLimits } from "../v1/limits.js";
import { collectionPage, errorPage, gonePage, homePage, previewPage, reviewPage, signInRequiredPage, signaturePage, type SignatureView } from "../v1/pages.js";
import { DEV_CARD_RENDERER_VERSION, DEV_RENDERER_VERSION, RendererRegistry, RendererUnavailableError, renderCardPng, sha256Hex } from "../v1/renderer.js";
import { RendererIntegrityError, type Signature, type SignatureStore } from "../v1/store.js";
import { SITE_CSS } from "../v1/siteCss.js";
import { THEME_SCRIPT } from "../v1/themeScript.js";

const PREVIEW_PATTERN = /^\/s\/([^/]+)\/([^/]+)\/?$/;
const LEGACY_PREVIEW_PATTERN = /^\/s\/[^/]+\/[^/]+\/[^/]+\/?$/;
const RENDER_PATTERN = /^\/renders\/([^/]+)\/([^/]+)\/([^/]+)\.(svg|png)$/;
const SIGNATURE_PATTERN = /^\/signatures\/(sg1_[a-z2-7]+)\/?$/;
const ARTIFACT_PATTERN = /^\/artifacts\/(sg1_[a-z2-7]+)\.(svg|png)$/;
const IDENTITY_FRESH_MS = 15 * 60 * 1000;
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#101319"/><path d="M14 39c9-20 13 12 21-9s7 13 15-5" fill="none" stroke="#4c70ff" stroke-width="5" stroke-linecap="round"/></svg>';

export interface AppDependencies {
  store: SignatureStore;
  artifacts: ArtifactStore;
  auth: MemoryAuthState;
  renderers: RendererRegistry;
}

export interface AppOptions {
  activeRendererVersion?: string;
  cardRendererVersion?: string;
  fixtureMode?: boolean;
  publicOrigin?: string;
  oauthClient?: XOAuthClient;
  trustProxy?: boolean;
  identityDailyCallLimit?: number;
}

function applySecurityHeaders(res: ServerResponse, cacheControl: string): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", cacheControl);
}

function send(res: ServerResponse, req: IncomingMessage, status: number, contentType: string, body: string | Buffer, cacheControl = "no-store"): void {
  applySecurityHeaders(res, cacheControl);
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

function redirect(res: ServerResponse, status: 302 | 303 | 308, location: string, cacheControl = "no-store"): void {
  applySecurityHeaders(res, cacheControl);
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
}

function wantsJson(req: IncomingMessage, pathname: string): boolean {
  void pathname;
  return (req.headers.accept ?? "").includes("application/json");
}

function sendError(res: ServerResponse, req: IncomingMessage, pathname: string, status: number, code: string, message: string, fixtureMode: boolean): void {
  if (pathname.startsWith("/api/") || wantsJson(req, pathname)) {
    send(res, req, status, "application/json; charset=utf-8", JSON.stringify({ error: { code, message } }));
  } else {
    send(res, req, status, "text/html; charset=utf-8", errorPage(status, code, message, fixtureMode));
  }
}

function originFor(req: IncomingMessage, options: AppOptions): string {
  if (options.publicOrigin) return options.publicOrigin.replace(/\/$/, "");
  if (options.fixtureMode) return `http://${req.headers.host ?? "localhost:3000"}`;
  throw new Error("APP_ORIGIN is required outside fixture mode.");
}

function clientIp(req: IncomingMessage, options: AppOptions): string {
  if (options.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies.set(key, value);
  }
  return cookies;
}

function cookieName(fixtureMode: boolean): string {
  return fixtureMode ? "sg_dev_session" : "__Host-sg_session";
}

function sessionFromRequest(req: IncomingMessage, deps: AppDependencies, fixtureMode: boolean): BrowserSession | null {
  return deps.auth.getSession(parseCookies(req).get(cookieName(fixtureMode)) ?? null);
}

function ensureSession(req: IncomingMessage, res: ServerResponse, deps: AppDependencies, fixtureMode: boolean): BrowserSession {
  const currentId = parseCookies(req).get(cookieName(fixtureMode)) ?? null;
  const { session, created } = deps.auth.getOrCreateSession(currentId);
  if (created) setSessionCookie(res, session, fixtureMode);
  return session;
}

function setSessionCookie(res: ServerResponse, session: BrowserSession, fixtureMode: boolean): void {
  const secure = fixtureMode ? "" : "; Secure";
  res.setHeader("Set-Cookie", `${cookieName(fixtureMode)}=${session.id}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function clearSessionCookie(res: ServerResponse, fixtureMode: boolean): void {
  const secure = fixtureMode ? "" : "; Secure";
  res.setHeader("Set-Cookie", `${cookieName(fixtureMode)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 8_192) throw new InputError("INVALID_GR0K", "Request body is too large.");
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function requireSameOrigin(req: IncomingMessage, options: AppOptions): boolean {
  if (options.fixtureMode) return true;
  const expected = originFor(req, options);
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  return origin === expected && (fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none");
}

function isFreshIdentity(session: BrowserSession): boolean {
  return !!session.identity && Date.now() - session.identity.authenticatedAt.getTime() <= IDENTITY_FRESH_MS;
}

function flowRender(deps: AppDependencies, flow: Pick<OAuthFlow, "handleNormalized" | "gr0kRaw" | "rendererVersion">) {
  if (flow.handleNormalized === null || flow.gr0kRaw === null || flow.rendererVersion === null) throw new Error("Flow has no render input.");
  return deps.renderers.get(flow.rendererVersion).render({
    handleNormalized: flow.handleNormalized,
    gr0kRaw: flow.gr0kRaw,
    gr0kScale: GR0K_SCALE,
    rendererVersion: flow.rendererVersion,
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("X request timed out.")), milliseconds); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signatureView(signature: Signature, publicAccountId: string): SignatureView {
  return {
    signatureId: signature.signatureId,
    handleAtClaim: signature.handleAtClaim,
    gr0kRaw: signature.gr0kRaw,
    rendererVersion: signature.rendererVersion,
    svgSha256: signature.svgSha256,
    pngSha256: signature.pngSha256,
    cardRendererVersion: signature.cardRendererVersion,
    xAuthenticatedAt: signature.xAuthenticatedAt,
    claimedAt: signature.claimedAt,
    publicAccountId,
  };
}

function publicSignatureJson(signature: Signature, publicAccountId: string, existing: boolean) {
  return {
    signature: {
      id: signature.signatureId,
      accountRef: publicAccountId,
      handleAtClaim: signature.handleAtClaim,
      gr0k: formatGr0k(signature.gr0kRaw),
      rendererVersion: signature.rendererVersion,
      svgSha256: signature.svgSha256,
      cardRendererVersion: signature.cardRendererVersion,
      pngSha256: signature.pngSha256,
      claimedAt: signature.claimedAt.toISOString(),
      claimStatus: "claimed_via_x",
    },
    existing,
  };
}

export function createApp(deps: AppDependencies, options: AppOptions = {}) {
  const fixtureMode = options.fixtureMode ?? false;
  const activeRendererVersion = options.activeRendererVersion ?? DEV_RENDERER_VERSION;
  const cardRendererVersion = options.cardRendererVersion ?? DEV_CARD_RENDERER_VERSION;
  const limits = new SlidingWindowLimits();
  const identityBreaker = new DailyCircuitBreaker(options.identityDailyCallLimit ?? 500);
  let activeRenders = 0;

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://request.invalid").pathname;
      const ip = clientIp(req, options);

      if ((method === "GET" || method === "HEAD") && pathname === "/assets/site.css") {
        send(res, req, 200, "text/css; charset=utf-8", SITE_CSS, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/theme.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", THEME_SCRIPT, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/favicon.svg") {
        send(res, req, 200, "image/svg+xml", FAVICON_SVG, "public, max-age=31536000, immutable");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/") {
        send(res, req, 200, "text/html; charset=utf-8", homePage(fixtureMode));
        return;
      }
      if ((method === "GET" || method === "HEAD") && LEGACY_PREVIEW_PATTERN.test(pathname)) {
        send(res, req, 410, "text/html; charset=utf-8", gonePage(fixtureMode));
        return;
      }
      if ((method === "GET" || method === "HEAD") && (/^\/c\/|^\/v\//).test(pathname)) {
        send(res, req, 410, "text/html; charset=utf-8", gonePage(fixtureMode));
        return;
      }

      const previewMatch = pathname.match(PREVIEW_PATTERN);
      if ((method === "GET" || method === "HEAD") && previewMatch) {
        if (!limits.consume("preview-ip", ip, 120, 60_000)) {
          sendError(res, req, pathname, 429, "RATE_LIMITED", "Too many preview requests. Try again shortly.", fixtureMode);
          return;
        }
        const handle = normalizeHandleSegment(previewMatch[1]);
        const gr0k = parseGr0kSegment(previewMatch[2]);
        if (!handle.isCanonical || !gr0k.isCanonical) {
          redirect(res, 308, `/s/${handle.canonicalSegment}/${gr0k.canonical}`, "public, max-age=300");
          return;
        }
        deps.renderers.get(activeRendererVersion);
        const imagePath = `/renders/${encodeURIComponent(activeRendererVersion)}/${handle.normalized}/${gr0k.canonical}.png`;
        const page = previewPage({ handle: handle.normalized, gr0kRaw: gr0k.raw, rendererVersion: activeRendererVersion, imageUrl: `${originFor(req, options)}${imagePath}`, fixtureMode });
        const etag = `"sha256-${sha256Hex(Buffer.from(page))}"`;
        res.setHeader("ETag", etag);
        if (req.headers["if-none-match"] === etag) {
          applySecurityHeaders(res, "public, max-age=60, s-maxage=300");
          res.statusCode = 304;
          res.end();
          return;
        }
        send(res, req, 200, "text/html; charset=utf-8", page, "public, max-age=60, s-maxage=300");
        return;
      }

      const renderMatch = pathname.match(RENDER_PATTERN);
      if ((method === "GET" || method === "HEAD") && renderMatch) {
        if (!limits.consume("render-ip", ip, 30, 60_000) || activeRenders >= 4) {
          sendError(res, req, pathname, 429, "RATE_LIMITED", "Render capacity is temporarily full.", fixtureMode);
          return;
        }
        const version = decodeURIComponent(renderMatch[1]);
        const handle = normalizeHandleSegment(renderMatch[2]);
        const gr0k = parseGr0kSegment(renderMatch[3]);
        if (!handle.isCanonical || !gr0k.isCanonical) {
          redirect(res, 308, `/renders/${encodeURIComponent(version)}/${handle.normalized}/${gr0k.canonical}.${renderMatch[4]}`, "public, max-age=300");
          return;
        }
        activeRenders += 1;
        try {
          const renderer = deps.renderers.get(version);
          const rendered = renderer.render({ handleNormalized: handle.normalized, gr0kRaw: gr0k.raw, gr0kScale: GR0K_SCALE, rendererVersion: version });
          const body = renderMatch[4] === "svg" ? Buffer.from(rendered.svgUtf8) : await renderCardPng(rendered.svgUtf8);
          const etag = `"sha256-${sha256Hex(body)}"`;
          res.setHeader("ETag", etag);
          if (req.headers["if-none-match"] === etag) {
            applySecurityHeaders(res, "public, max-age=31536000, immutable");
            res.statusCode = 304;
            res.end();
          } else {
            send(res, req, 200, renderMatch[4] === "svg" ? "image/svg+xml" : "image/png", body, "public, max-age=31536000, immutable");
          }
        } finally {
          activeRenders -= 1;
        }
        return;
      }

      if (method === "POST" && pathname === "/dev/login" && fixtureMode) {
        if (!requireSameOrigin(req, options)) {
          sendError(res, req, pathname, 403, "CLAIM_FLOW_INVALID", "The request did not come from this site.", fixtureMode);
          return;
        }
        const session = ensureSession(req, res, deps, fixtureMode);
        const now = new Date();
        const identity = fixtureIdentity("alice", now);
        const { flow } = deps.auth.startFlow(session, "account_login", null, generateCodeVerifier(), now);
        flow.status = "processing";
        const rotated = deps.auth.authenticate(flow, identity, session, now);
        setSessionCookie(res, rotated, fixtureMode);
        await deps.store.updateExistingAccountLogin(identity.xUserId, identity.username, identity.handleNormalized, now);
        redirect(res, 303, "/me");
        return;
      }

      if (method === "POST" && pathname === "/auth/x/start") {
        const session = ensureSession(req, res, deps, fixtureMode);
        if (!requireSameOrigin(req, options)) {
          sendError(res, req, pathname, 403, "CLAIM_FLOW_INVALID", "The request did not come from this site.", fixtureMode);
          return;
        }
        if (!limits.consume("oauth-start-ip", ip, 10, 15 * 60_000) || !limits.consume("oauth-start-session", session.id, 5, 15 * 60_000)) {
          sendError(res, req, pathname, 429, "RATE_LIMITED", "Too many sign-in attempts. Try again later.", fixtureMode);
          return;
        }
        const form = await readForm(req);
        const purpose = form.get("purpose") === "account_login" ? "account_login" : "claim";
        let claimInput = null;
        if (purpose === "claim") {
          const handleNormalized = normalizeHandleValue(form.get("handle") ?? "");
          const gr0k = parseGr0kValue(form.get("gr0k") ?? "");
          const renderer = deps.renderers.get(activeRendererVersion);
          const rendered = renderer.render({ handleNormalized, gr0kRaw: gr0k.raw, gr0kScale: GR0K_SCALE, rendererVersion: activeRendererVersion });
          claimInput = { handleNormalized, gr0kRaw: gr0k.raw, rendererVersion: activeRendererVersion, previewSvgSha256: sha256Hex(rendered.svgUtf8) };
        }
        const verifier = generateCodeVerifier();
        const { flow, state } = deps.auth.startFlow(session, purpose, claimInput, verifier);
        if (fixtureMode) {
          flow.status = "processing";
          const identity = fixtureIdentity(claimInput?.handleNormalized ?? "alice");
          const rotated = deps.auth.authenticate(flow, identity, session);
          setSessionCookie(res, rotated, fixtureMode);
          if (purpose === "account_login") await deps.store.updateExistingAccountLogin(identity.xUserId, identity.username, identity.handleNormalized, identity.authenticatedAt);
          redirect(res, 303, purpose === "claim" ? `/claim/review?flow=${encodeURIComponent(flow.id)}` : "/me");
          return;
        }
        if (!options.oauthClient) {
          deps.auth.fail(flow);
          sendError(res, req, pathname, 503, "X_AUTH_UNAVAILABLE", "X authentication is not configured.", fixtureMode);
          return;
        }
        redirect(res, 302, options.oauthClient.getAuthorizeUrl(state, generateCodeChallenge(verifier)));
        return;
      }

      if (method === "GET" && pathname === "/auth/x/callback") {
        const session = sessionFromRequest(req, deps, fixtureMode);
        if (!session) {
          sendError(res, req, pathname, 400, "INVALID_OAUTH_STATE", "The sign-in session is missing or expired.", fixtureMode);
          return;
        }
        if (!limits.consume("oauth-callback-ip", ip, 10, 60 * 60_000) || !limits.consume("oauth-callback-session", session.id, 5, 60 * 60_000)) {
          sendError(res, req, pathname, 429, "RATE_LIMITED", "Too many callback attempts.", fixtureMode);
          return;
        }
        const url = new URL(req.url ?? "/", "http://request.invalid");
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (!state || !code || !options.oauthClient) {
          sendError(res, req, pathname, 400, "INVALID_OAUTH_STATE", "The X callback is incomplete or unavailable.", fixtureMode);
          return;
        }
        const flow = deps.auth.beginCallback(session, state);
        if (!flow) {
          sendError(res, req, pathname, 400, "INVALID_OAUTH_STATE", "The sign-in state is invalid, expired, or already used.", fixtureMode);
          return;
        }
        if (!identityBreaker.tryConsume()) {
          deps.auth.fail(flow);
          sendError(res, req, pathname, 503, "X_AUTH_UNAVAILABLE", "The daily X identity limit has been reached.", fixtureMode);
          return;
        }
        try {
          const accessToken = await withTimeout(options.oauthClient.exchangeCode(code, flow.pkceVerifier), 10_000);
          const user = await withTimeout(options.oauthClient.getUser(accessToken), 10_000);
          if (!/^(?:0|[1-9]\d*)$/.test(user.id)) throw new Error("X returned an invalid account ID.");
          const handleNormalized = normalizeHandleValue(user.username);
          if (flow.purpose === "claim" && handleNormalized !== flow.handleNormalized) {
            deps.auth.fail(flow);
            sendError(res, req, pathname, 403, "HANDLE_MISMATCH", `Sign in with the X account matching @${flow.handleNormalized} to claim this signature.`, fixtureMode);
            return;
          }
          const identity = { xUserId: user.id, username: user.username, handleNormalized, authenticatedAt: new Date() };
          const rotated = deps.auth.authenticate(flow, identity, session);
          setSessionCookie(res, rotated, fixtureMode);
          if (flow.purpose === "account_login") await deps.store.updateExistingAccountLogin(identity.xUserId, identity.username, identity.handleNormalized, identity.authenticatedAt);
          redirect(res, 303, flow.purpose === "claim" ? `/claim/review?flow=${encodeURIComponent(flow.id)}` : "/me");
        } catch {
          deps.auth.fail(flow);
          sendError(res, req, pathname, 503, "X_AUTH_UNAVAILABLE", "X authentication could not be completed. Start again.", fixtureMode);
        }
        return;
      }

      if (method === "GET" && pathname === "/claim/review") {
        const session = sessionFromRequest(req, deps, fixtureMode);
        const flowId = new URL(req.url ?? "/", "http://request.invalid").searchParams.get("flow") ?? "";
        if (!session || !session.identity) {
          sendError(res, req, pathname, 401, "AUTH_REQUIRED", "Sign in with X to review this claim.", fixtureMode);
          return;
        }
        if (!isFreshIdentity(session)) {
          sendError(res, req, pathname, 401, "AUTH_EXPIRED", "Your X identity check is too old. Start again.", fixtureMode);
          return;
        }
        const flow = deps.auth.getBoundFlow(session, flowId, "authenticated");
        if (!flow || flow.handleNormalized === null || flow.gr0kRaw === null || flow.rendererVersion === null) {
          sendError(res, req, pathname, 409, "CLAIM_FLOW_INVALID", "This claim flow is expired, consumed, or belongs to another session.", fixtureMode);
          return;
        }
        const imageUrl = `${originFor(req, options)}/renders/${encodeURIComponent(flow.rendererVersion)}/${flow.handleNormalized}/${formatGr0k(flow.gr0kRaw)}.png`;
        send(res, req, 200, "text/html; charset=utf-8", reviewPage({ handle: flow.handleNormalized, gr0kRaw: flow.gr0kRaw, rendererVersion: flow.rendererVersion, imageUrl, flowId: flow.id, csrfToken: session.csrfToken, fixtureMode }));
        return;
      }

      if (method === "POST" && pathname === "/api/v1/signatures") {
        const session = sessionFromRequest(req, deps, fixtureMode);
        if (!session || !session.identity) {
          sendError(res, req, pathname, 401, "AUTH_REQUIRED", "Sign in with X before claiming.", fixtureMode);
          return;
        }
        if (!isFreshIdentity(session)) {
          sendError(res, req, pathname, 401, "AUTH_EXPIRED", "Your X identity check is too old. Start again.", fixtureMode);
          return;
        }
        if (!requireSameOrigin(req, options)) {
          sendError(res, req, pathname, 403, "CLAIM_FLOW_INVALID", "The request did not come from this site.", fixtureMode);
          return;
        }
        const form = await readForm(req);
        if (form.get("csrf") !== session.csrfToken) {
          sendError(res, req, pathname, 403, "CLAIM_FLOW_INVALID", "The claim confirmation is invalid.", fixtureMode);
          return;
        }
        const flow = deps.auth.getBoundFlow(session, form.get("flow") ?? "", "authenticated");
        if (!flow || flow.handleNormalized !== session.identity.handleNormalized) {
          sendError(res, req, pathname, 409, "CLAIM_FLOW_INVALID", "This claim flow is expired, consumed, or mismatched.", fixtureMode);
          return;
        }
        if (!limits.consume("claim-x", session.identity.xUserId, 20, 60 * 60_000) || !limits.consume("claim-session", session.id, 10, 60 * 60_000)) {
          sendError(res, req, pathname, 429, "RATE_LIMITED", "Too many claim attempts. Try again later.", fixtureMode);
          return;
        }
        const result = await finalizeClaim({ store: deps.store, artifacts: deps.artifacts, renderers: deps.renderers, cardRendererVersion }, flow, session.identity);
        deps.auth.complete(flow);
        if (wantsJson(req, pathname)) {
          send(res, req, result.existing ? 200 : 201, "application/json; charset=utf-8", JSON.stringify(publicSignatureJson(result.signature, result.account.publicAccountId, result.existing)));
        } else {
          redirect(res, 303, `/signatures/${result.signature.signatureId}`);
        }
        return;
      }

      const signatureMatch = pathname.match(SIGNATURE_PATTERN);
      if ((method === "GET" || method === "HEAD") && signatureMatch) {
        const signature = await deps.store.getSignature(signatureMatch[1]);
        if (!signature) {
          sendError(res, req, pathname, 404, "SIGNATURE_NOT_FOUND", "That claimed signature does not exist.", fixtureMode);
          return;
        }
        const account = await deps.store.getAccount(signature.xUserId);
        if (!account) throw new Error("Signature account is missing.");
        send(res, req, 200, "text/html; charset=utf-8", signaturePage(signatureView(signature, account.publicAccountId), fixtureMode), "public, max-age=60");
        return;
      }

      const artifactMatch = pathname.match(ARTIFACT_PATTERN);
      if ((method === "GET" || method === "HEAD") && artifactMatch) {
        const signature = await deps.store.getSignature(artifactMatch[1]);
        if (!signature) {
          sendError(res, req, pathname, 404, "SIGNATURE_NOT_FOUND", "That claimed signature does not exist.", fixtureMode);
          return;
        }
        const extension = artifactMatch[2];
        const bytes = await deps.artifacts.get(extension === "svg" ? signature.svgStorageKey : signature.cardStorageKey);
        if (!bytes) throw new Error("Claimed artifact is unavailable.");
        const expectedHash = extension === "svg" ? signature.svgSha256 : signature.pngSha256;
        if (sha256Hex(bytes) !== expectedHash) throw new RendererIntegrityError();
        res.setHeader("ETag", `"sha256-${expectedHash}"`);
        send(res, req, 200, extension === "svg" ? "image/svg+xml" : "image/png", bytes, "public, max-age=31536000, immutable");
        return;
      }

      if ((method === "GET" || method === "HEAD") && pathname === "/me") {
        const session = sessionFromRequest(req, deps, fixtureMode);
        if (!session || !session.identity) {
          send(res, req, 401, "text/html; charset=utf-8", signInRequiredPage(fixtureMode));
          return;
        }
        const account = await deps.store.getAccount(session.identity.xUserId);
        const signatures = await deps.store.listSignaturesForAccount(session.identity.xUserId);
        const views = signatures.map((signature) => signatureView(signature, account?.publicAccountId ?? "xa1_unclaimed"));
        send(res, req, 200, "text/html; charset=utf-8", collectionPage({ currentHandle: account?.currentHandle ?? session.identity.username, signatures: views, csrfToken: session.csrfToken, fixtureMode }));
        return;
      }

      if (method === "POST" && pathname === "/auth/logout") {
        const session = sessionFromRequest(req, deps, fixtureMode);
        if (!session || !requireSameOrigin(req, options)) {
          sendError(res, req, pathname, 401, "AUTH_REQUIRED", "No active session was found.", fixtureMode);
          return;
        }
        const form = await readForm(req);
        if (form.get("csrf") !== session.csrfToken) {
          sendError(res, req, pathname, 403, "CLAIM_FLOW_INVALID", "The logout request is invalid.", fixtureMode);
          return;
        }
        deps.auth.logout(session.id);
        clearSessionCookie(res, fixtureMode);
        redirect(res, 303, "/");
        return;
      }

      sendError(res, req, pathname, 404, "NOT_FOUND", "That page does not exist.", fixtureMode);
    } catch (error) {
      if (error instanceof InputError) sendError(res, req, pathname, 400, error.code, error.message, fixtureMode);
      else if (error instanceof RendererIntegrityError) sendError(res, req, pathname, 500, "RENDERER_INTEGRITY_ERROR", error.message, fixtureMode);
      else if (error instanceof RendererUnavailableError) sendError(res, req, pathname, 500, "RENDER_FAILED", error.message, fixtureMode);
      else sendError(res, req, pathname, 500, "RENDER_FAILED", "The request could not be rendered safely.", fixtureMode);
    }
  };
}

export function startServer(deps: AppDependencies, port: number, options: AppOptions = {}) {
  const server = createServer(createApp(deps, options));
  server.listen(port, "127.0.0.1");
  return server;
}
