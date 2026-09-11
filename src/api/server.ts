import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { LocalTestWallet } from "../local/wallet.js";
import { LocalOAuthEmulatorError, LocalXOAuthEmulator, type LocalOAuthDecision } from "../claim/localXOAuthEmulator.js";
import { generateCodeChallenge, generateCodeVerifier, XOAuthRequestError, type XOAuthClient } from "../claim/xOAuthClient.js";
import { CLAIM_ON_RETURN_INTENT, MemoryAuthState, type BrowserSession, type ClaimFlowInput, type OAuthFlow } from "../v1/authState.js";
import { consumeActionApproval, hasActionApproval, hasMintRecipient, requireSessionIdentity } from "../v1/authPolicy.js";
import type { SensitiveActionIntent } from "../v1/types.js";
import type { ArtifactStore } from "../v1/artifacts.js";
import { finalizeClaim } from "../v1/claim.js";
import { withdrawClaim } from "../v1/withdrawClaim.js";
import { deriveSignatureId } from "../v1/identity.js";
import { formatGr0k, GR0K_SCALE, InputError, normalizeHandleSegment, normalizeHandleValue, validateRenderHandle, parseGr0kSegment, parseGr0kValue } from "../v1/input.js";
import { DailyCircuitBreaker, SlidingWindowLimits } from "../v1/limits.js";
import { aboutPage, collectionPage, errorPage, gonePage, homePage, localOAuthAuthorizePage, mintEntryPage, mintReviewPage, previewPage, signInRequiredPage, signaturePage, type GalleryCardView, type MintEntryStage, type SignatureMintView, type SignatureView, type PreviewPageParams } from "../v1/pages.js";
import { CARD_RENDERER_VERSION, RENDERER_VERSION, RendererRegistry, RendererUnavailableError, renderCardPng, sha256Hex } from "../v1/renderer.js";
import { RendererIntegrityError, type Signature, type SignatureStore } from "../v1/store.js";
import { SITE_CSS } from "../v1/siteCss.js";
import { FAVICON_CSP, FAVICON_SVG, FAVICON_VERSION } from "../brand/favicon.js";
import { siteFontAsset } from "../v1/fonts.js";
import { SLOGAN_TOOLTIP_SCRIPT } from "../brand/sloganTooltipScript.js";
import { ACTION_TOOLTIP_SCRIPT } from "../v1/actionTooltipScript.js";
import { CLAIM_NOTICE_SCRIPT } from "../v1/claimNotice.js";
import { WITHDRAW_CLAIM_DIALOG_SCRIPT } from "../v1/withdrawClaimDialog.js";
import { X_ACTION_PROGRESS_SCRIPT } from "../v1/xActionProgress.js";
import { accountPanelContent, developmentWalletControls, developmentAuthenticationNotice, type AccountPanelView } from "../v1/accountPanel.js";
import { ACCOUNT_PANEL_SCRIPT } from "../v1/accountPanelScript.js";
import { REHEARSAL_OVERLAY_SCRIPT } from "../v1/rehearsalOverlayScript.js";
import { GROK_PROMPT_SCRIPT } from "../v1/grokPrompt.js";
import { signatureDigestHex } from "../v2/core/index.js";
import { MINT_CLIENT_SCRIPT } from "../v2/clientScript.js";
import { V2Error } from "../v2/errors.js";
import { MINT_STATE_LABELS } from "../v2/model.js";
import type { V2MintService } from "../v2/service.js";

const PREVIEW_PATTERN = /^\/s\/([^/]+)\/([^/]+)\/?$/;
const LEGACY_PREVIEW_PATTERN = /^\/s\/[^/]+\/[^/]+\/[^/]+\/?$/;
const RENDER_PATTERN = /^\/renders\/([^/]+)\/([^/]+)\/([^/]+)\.(svg|png)$/;
const SIGNATURE_PATTERN = /^\/signatures\/(sg1_[a-z2-7]+)\/?$/;
const WITHDRAW_CLAIM_PATTERN = /^\/signatures\/(sg1_[a-z2-7]{52})\/withdraw$/;
const ACCOUNT_RETURN_PATTERN = /^\/signatures\/sg1_[a-z2-7]{52}(?:\/mint)?$/;
const ARTIFACT_PATTERN = /^\/artifacts\/(sg1_[a-z2-7]+)\.(svg|png)$/;
const MINT_REVIEW_PATTERN = /^\/signatures\/(sg1_[a-z2-7]{52})\/mint\/?$/;
const MINT_AUTHORIZATION_PATTERN = /^\/api\/v2\/signatures\/(sg1_[a-z2-7]{52})\/mint-authorizations\/?$/;
const MINT_STATUS_PATTERN = /^\/api\/v2\/signatures\/(sg1_[a-z2-7]{52})\/mint-status\/?$/;
const MINT_TRANSACTION_PATTERN = /^\/api\/v2\/mint-authorizations\/(0x[0-9a-f]{64})\/transactions\/?$/;
const DEV_MINT_ADVANCE_PATTERN = /^\/dev\/v2\/signatures\/(sg1_[a-z2-7]{52})\/advance\/?$/;
const CLAIM_INSTANCE_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function safeAccountReturn(path: string): boolean {
  return path === "/me" || ACCOUNT_RETURN_PATTERN.test(path);
}

function claimPageHref(flow: OAuthFlow): string {
  if (flow.purpose !== "claim" || flow.handleAtClaim === null || flow.gr0kRaw === null) throw new Error("Missing claim destination.");
  return `/s/${flow.handleAtClaim}/${formatGr0k(flow.gr0kRaw)}?flow=${encodeURIComponent(flow.id)}#claim`;
}

export interface AppDependencies {
  store: SignatureStore;
  artifacts: ArtifactStore;
  auth: MemoryAuthState;
  renderers: RendererRegistry;
  mint?: V2MintService;
}

export interface AppOptions {
  activeRendererVersion?: string;
  cardRendererVersion?: string;
  fixtureMode?: boolean;
  publicOrigin?: string;
  /** Pin local navigation/cookies to 127.0.0.1 before starting OAuth. */
  enforcePublicOrigin?: boolean;
  oauthClient?: XOAuthClient;
  localOAuthEmulator?: LocalXOAuthEmulator;
  trustProxy?: boolean;
  identityDailyCallLimit?: number;
  /** Local chain evidence; independent of the X authentication provider. */
  localChainRehearsal?: boolean;
  /** Local single-writer durability boundary; completes before a mutation response is sent. */
  runMintOperation?: <T>(operation: () => Promise<T> | T) => Promise<T>;
  /** Local withdrawal-only durability boundary; never substitutes for mint readiness. */
  runClaimWithdrawalOperation?: <T>(signatureId: string, operation: () => Promise<T> | T) => Promise<T>;
  /** Only the dedicated loopback entrypoint supplies the public-key Anvil test wallet. */
  localWallet?: LocalTestWallet;
}

const realXResponses = new WeakSet<ServerResponse>();

function applySecurityHeaders(res: ServerResponse, cacheControl: string): void {
  // Browsers can enforce form-action across the POST -> OAuth redirect.
  // Permit only X, and only on apps actually configured to use that provider.
  const oauthFormTarget = realXResponses.has(res) ? " https://x.com" : "";
  res.setHeader("Content-Security-Policy", `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'${oauthFormTarget}; frame-ancestors 'none'; base-uri 'none'`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Native same-origin form POSTs need their Origin preserved for CSRF checks.
  // Cross-origin navigations (including X) still receive no referrer.
  res.setHeader("Referrer-Policy", "same-origin");
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

function sendErrorResponse(res: ServerResponse, req: IncomingMessage, pathname: string, status: number, code: string, message: string, fixtureMode: boolean, localOAuthMode = false, localChainRehearsal = false): void {
  if (pathname.startsWith("/api/") || wantsJson(req, pathname)) {
    send(res, req, status, "application/json; charset=utf-8", JSON.stringify({ error: { code, message } }));
  } else {
    const withdrawal = pathname.match(WITHDRAW_CLAIM_PATTERN);
    const mint = pathname.match(MINT_REVIEW_PATTERN);
    const returnTo = withdrawal ? `/signatures/${withdrawal[1]}` : mint ? `/signatures/${mint[1]}/mint` : undefined;
    send(res, req, status, "text/html; charset=utf-8", errorPage(status, code, message, fixtureMode, localOAuthMode, localChainRehearsal, returnTo));
  }
}

function sendRemovedSignatureResponse(res: ServerResponse, req: IncomingMessage, pathname: string, fixtureMode: boolean, localOAuthMode = false, localChainRehearsal = false): void {
  sendErrorResponse(
    res,
    req,
    pathname,
    410,
    "SIGNATURE_REMOVED",
    "This signature is no longer available from signatures.gallery.",
    fixtureMode,
    localOAuthMode,
    localChainRehearsal,
  );
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
  const session = deps.auth.getSession(parseCookies(req).get(cookieName(fixtureMode)) ?? null);
  if (session?.identity) {
    try { requireSessionIdentity(session); }
    catch { deps.auth.logout(session.id); return null; }
  }
  return session;
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 8_192) throw new V2Error(400, "WALLET_CHALLENGE_INVALID", "Request body is too large.");
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new V2Error(400, "WALLET_CHALLENGE_INVALID", "Request body must be one JSON object.");
  }
}

function requireSameOrigin(req: IncomingMessage, options: AppOptions): boolean {
  const expected = originFor(req, options);
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  return origin === expected && (fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none");
}

function requireV2SameOrigin(req: IncomingMessage, options: AppOptions): boolean {
  const expected = originFor(req, options);
  const origin = req.headers.origin;
  const fetchSite = req.headers["sec-fetch-site"];
  return origin === expected && (fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none");
}

function requireV2Session(req: IncomingMessage, deps: AppDependencies, options: AppOptions): BrowserSession {
  const fixtureMode = options.fixtureMode ?? false;
  const session = sessionFromRequest(req, deps, fixtureMode);
  if (!session?.identity) throw new V2Error(401, "AUTH_REQUIRED", "Sign in with X before using minting.");
  requireSessionIdentity(session);
  if (!requireV2SameOrigin(req, options)) throw new V2Error(403, "REQUEST_CONFIRMATION_INVALID", "The request did not come from this site.");
  const csrf = req.headers["x-csrf-token"];
  if (typeof csrf !== "string" || csrf !== session.csrfToken) throw new V2Error(403, "REQUEST_CONFIRMATION_INVALID", "Reload the page before trying this action again.");
  return session;
}

function walletActionIntent(deps: AppDependencies, xUserId: string | undefined, kind: "wallet_link" | "wallet_revoke"): Extract<SensitiveActionIntent, { kind: "wallet_link" | "wallet_revoke" }> {
  if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "Wallet management is not enabled.");
  const previousBindingId = xUserId ? deps.mint.state.getActiveBinding(xUserId, deps.mint.config.chainId)?.walletBindingId ?? null : null;
  const chainId = deps.mint.config.chainId.toString();
  if (kind === "wallet_revoke") {
    if (!previousBindingId) throw new V2Error(409, "WALLET_NOT_LINKED", "There is no linked wallet to revoke.");
    return { kind, chainId, previousBindingId };
  }
  return { kind, chainId, previousBindingId };
}

function mintRecipientIntent(deps: AppDependencies, signature: Signature): Extract<SensitiveActionIntent, { kind: "mint_recipient" }> {
  if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "Minting is not enabled.");
  return { kind: "mint_recipient", signatureId: signature.signatureId, claimInstanceId: signature.claimInstanceId,
    chainId: deps.mint.config.chainId.toString(),
    previousBindingId: deps.mint.state.getActiveBinding(signature.xUserId, deps.mint.config.chainId)?.walletBindingId ?? null };
}

function mintRecipientView(session: BrowserSession | null, deps: AppDependencies, signature: Signature): Pick<AccountPanelView, "mintSignatureId" | "mintClaimInstanceId" | "mintRecipientConfirmed" | "mintPreviousBindingId"> {
  let ownSession = false;
  try { if (session) ownSession = Boolean(requireSessionIdentity(session, signature.xUserId)); } catch { /* Sign-in/claimant recovery belongs to mint entry. */ }
  return { mintSignatureId: signature.signatureId, mintClaimInstanceId: signature.claimInstanceId,
    mintPreviousBindingId: deps.mint?.state.getActiveBinding(signature.xUserId, deps.mint.config.chainId)?.walletBindingId ?? null,
    mintRecipientConfirmed: Boolean(ownSession && deps.mint?.config.enabled) };
}

function walletConfirmationView(session: BrowserSession | null, deps: AppDependencies): Pick<AccountPanelView, "walletLinkConfirmed" | "walletRevokeConfirmed"> {
  if (!session?.identity || !deps.mint?.config.enabled) return {};
  const link = walletActionIntent(deps, session.identity.xUserId, "wallet_link");
  return {
    walletLinkConfirmed: hasActionApproval(session, link),
    walletRevokeConfirmed: link.kind === "wallet_link" && link.previousBindingId !== null
      && hasActionApproval(session, { ...link, kind: "wallet_revoke", previousBindingId: link.previousBindingId }),
  };
}

/** Recheck the server-bound target on return; OAuth itself never changes it. */
async function validateActionTarget(deps: AppDependencies, intent: SensitiveActionIntent, xUserId: string): Promise<void> {
  if (intent.kind === "mint_recipient") {
    const signature = await deps.store.getSignature(intent.signatureId);
    if (!signature || signature.claimInstanceId !== intent.claimInstanceId) throw new V2Error(409, "CLAIM_CHANGED", "This claim has changed. Open the current signature before minting.");
    if (signature.xUserId !== xUserId) throw new V2Error(403, "NOT_CLAIMANT", "Only the original X claimant can mint this signature.");
    const current = mintRecipientIntent(deps, signature);
    if (current.chainId !== intent.chainId || current.previousBindingId !== intent.previousBindingId) throw new V2Error(409, "BINDING_TRANSITION", "The recipient changed. Start again from the mint page.");
    if (deps.mint!.state.isSuppressed(signature.signatureId) || !deps.mint!.state.canWithdrawClaim(signature.signatureId)
      || deps.mint!.state.hasUnresolvedBindingAuthorization(xUserId, deps.mint!.config.chainId)) {
      throw new V2Error(409, "LIVE_AUTHORIZATION_EXISTS", "Resolve the current mint before preparing another recipient. An issued mint can be resumed from its signature.");
    }
    return;
  }
  if (intent.kind === "claim_withdraw") {
    const signature = await deps.store.getSignature(intent.signatureId);
    if (!signature || signature.claimInstanceId !== intent.claimInstanceId) throw new V2Error(409, "CLAIM_CHANGED", "This claim has changed. Return to the signature and start again.");
    if (signature.xUserId !== xUserId) throw new V2Error(403, "NOT_CLAIMANT", "Only the original X claimant can withdraw this signature.");
    if (deps.mint && !deps.mint.state.canWithdrawClaim(intent.signatureId)) throw new V2Error(409, "CLAIM_WITHDRAWAL_BLOCKED", "This claim cannot be withdrawn while a mint or mint authorization is unresolved.");
    return;
  }
  const current = walletActionIntent(deps, xUserId, intent.kind);
  if (current.chainId !== intent.chainId || current.previousBindingId !== intent.previousBindingId) {
    throw new V2Error(409, "BINDING_TRANSITION", "Your linked wallet changed. Start a new X confirmation for the current wallet.");
  }
}

function flowRender(deps: AppDependencies, flow: Pick<OAuthFlow, "handleAtClaim" | "gr0kRaw" | "rendererVersion">) {
  if (flow.handleAtClaim === null || flow.gr0kRaw === null || flow.rendererVersion === null) throw new Error("Flow has no render input.");
  return deps.renderers.get(flow.rendererVersion).render({
    handle: flow.handleAtClaim,
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

function publicSignatureJson(signature: Signature, publicAccountId: string, existing: boolean, localOAuthMode: boolean) {
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
      claimStatus: localOAuthMode ? "local_oauth_rehearsal" : "claimed_via_x",
    },
    existing,
  };
}

const GALLERY_PAGE_SIZE = 24;

interface GalleryCursor {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  signatureId: string;
}

function encodeGalleryCursor(cursor: GalleryCursor): string {
  return Buffer.from(JSON.stringify([
    cursor.blockNumber.toString(),
    cursor.transactionIndex,
    cursor.logIndex,
    cursor.signatureId,
  ])).toString("base64url");
}

function decodeGalleryCursor(token: string): GalleryCursor {
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw new Error();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(value) || value.length !== 4) throw new Error();
    const [blockNumber, transactionIndex, logIndex, signatureId] = value;
    if (
      typeof blockNumber !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(blockNumber)
      || typeof transactionIndex !== "number" || !Number.isSafeInteger(transactionIndex) || transactionIndex < 0
      || typeof logIndex !== "number" || !Number.isSafeInteger(logIndex) || logIndex < 0
      || typeof signatureId !== "string" || !/^sg1_[a-z2-7]{52}$/.test(signatureId)
    ) throw new Error();
    return { blockNumber: BigInt(blockNumber), transactionIndex, logIndex, signatureId };
  } catch {
    throw new V2Error(400, "INVALID_GALLERY_CURSOR", "The Gallery cursor is invalid or expired.");
  }
}

function comesAfterGalleryCursor(entry: GalleryCursor, cursor: GalleryCursor): boolean {
  if (entry.blockNumber !== cursor.blockNumber) return entry.blockNumber < cursor.blockNumber;
  if (entry.transactionIndex !== cursor.transactionIndex) return entry.transactionIndex < cursor.transactionIndex;
  if (entry.logIndex !== cursor.logIndex) return entry.logIndex < cursor.logIndex;
  return entry.signatureId > cursor.signatureId;
}

async function galleryCardViews(deps: AppDependencies, afterToken: string | null): Promise<{ entries: GalleryCardView[]; nextCursor: string | null }> {
  const after = afterToken === null ? null : decodeGalleryCursor(afterToken);
  if (!deps.mint) return { entries: [], nextCursor: null };
  const views: GalleryCardView[] = [];
  const eligible = deps.mint.state.listGallery().filter((entry) => !after || comesAfterGalleryCursor(entry, after));
  const page = eligible.slice(0, GALLERY_PAGE_SIZE);
  for (const entry of page) {
    const signature = await deps.store.getSignature(entry.signatureId);
    if (!signature) throw new Error("A finalized Gallery projection is missing its immutable V1 signature.");
    if (deps.mint.state.isSuppressed(entry.signatureId)) continue;
    views.push({
      signatureId: signature.signatureId,
      handleAtClaim: signature.handleAtClaim,
      gr0kRaw: signature.gr0kRaw,
      mintWallet: entry.mintWallet,
      currentTokenHolder: entry.currentTokenHolder,
      finalizedAt: entry.finalizedAt,
    });
  }
  const last = page.at(-1);
  return {
    entries: views.filter((entry) => !deps.mint!.state.isSuppressed(entry.signatureId)),
    nextCursor: eligible.length > GALLERY_PAGE_SIZE && last ? encodeGalleryCursor(last) : null,
  };
}

async function claimedGalleryCardViews(deps: AppDependencies, afterToken: string | null) {
  let after: Pick<Signature, "claimedAt" | "signatureId"> | undefined;
  if (afterToken !== null) {
    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(afterToken)) throw new Error();
      const bytes = Buffer.from(afterToken, "base64url");
      if (bytes.toString("base64url") !== afterToken) throw new Error();
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== "claimed" ||
        typeof value[1] !== "string" || typeof value[2] !== "string" || !/^sg1_[a-z2-7]{52}$/.test(value[2])) throw new Error();
      const claimedAt = new Date(value[1]);
      if (claimedAt.toISOString() !== value[1]) throw new Error();
      after = { claimedAt, signatureId: value[2] };
    } catch {
      throw new V2Error(400, "INVALID_GALLERY_CURSOR", "The Gallery cursor is invalid or expired.");
    }
  }
  const signatures: Signature[] = [];
  // Fill a page plus lookahead after suppression, without listing private account data.
  while (signatures.length <= GALLERY_PAGE_SIZE) {
    const batch = await deps.store.listClaimedSignatures(GALLERY_PAGE_SIZE + 1, after);
    for (const signature of batch) {
      if (!deps.mint?.state.isSuppressed(signature.signatureId)) signatures.push(signature);
      if (signatures.length > GALLERY_PAGE_SIZE) break;
    }
    if (batch.length < GALLERY_PAGE_SIZE + 1 || signatures.length > GALLERY_PAGE_SIZE) break;
    after = batch[batch.length - 1];
  }
  const page = signatures.slice(0, GALLERY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    entries: page.filter((signature) => !deps.mint?.state.isSuppressed(signature.signatureId)).map((signature) => ({
      signatureId: signature.signatureId,
      handleAtClaim: signature.handleAtClaim,
      gr0kRaw: signature.gr0kRaw,
      claimedAt: signature.claimedAt,
    })),
    nextCursor: signatures.length > GALLERY_PAGE_SIZE && last
      ? Buffer.from(JSON.stringify(["claimed", last.claimedAt.toISOString(), last.signatureId])).toString("base64url") : null,
  };
}

function mintStateLabel(mint: V2MintService, state: keyof typeof MINT_STATE_LABELS): string {
  if (mint.config.localChainRehearsal) {
    if (state === "finalized") return "Minted on local Anvil";
    if (state === "included_unfinalized") return "Awaiting automatic local confirmation";
    if (state === "finality_revoked") return "Local chain confirmation revoked";
  }
  return MINT_STATE_LABELS[state];
}

function signatureMintView(mint: V2MintService, signatureId: string): SignatureMintView {
  const status = mint.state.getStatus(signatureId, false);
  const { projection, metadata } = status;
  const explorer = mint.config.explorerBaseUrl;
  return {
    state: projection.state,
    label: mintStateLabel(mint, projection.state),
    txHash: projection.txHash,
    mintWallet: projection.mintWallet,
    currentTokenHolder: projection.currentTokenHolder,
    contract: projection.contract,
    chainName: projection.chainId ? mint.config.chainName : null,
    tokenId: projection.tokenId?.toString() ?? null,
    tokenUri: metadata?.tokenUri ?? null,
    metadataSha256: metadata?.metadataSha256 ?? null,
    finalizedAt: projection.finalizedAt,
    explorerTransactionUrl: explorer && projection.txHash ? `${explorer}/tx/${projection.txHash}` : null,
    explorerContractUrl: explorer && projection.contract ? `${explorer}/address/${projection.contract}` : null,
    finalityLabel: projection.finalityLabel,
  };
}

function publicMintStatusJson(mint: V2MintService, signatureId: string, includePrivate: boolean) {
  const status = mint.state.getStatus(signatureId, includePrivate);
  const projection = status.projection;
  const exposeChainDetail = includePrivate || projection.blockNumber !== null;
  return {
    signatureId,
    state: projection.state,
    label: mintStateLabel(mint, projection.state),
    chainId: exposeChainDetail ? projection.chainId?.toString() ?? null : null,
    contract: exposeChainDetail ? projection.contract : null,
    txHash: exposeChainDetail ? projection.txHash : null,
    tokenId: exposeChainDetail ? projection.tokenId?.toString() ?? null : null,
    mintWallet: exposeChainDetail ? projection.mintWallet : null,
    currentTokenHolder: exposeChainDetail ? projection.currentTokenHolder : null,
    finalizedAt: exposeChainDetail ? projection.finalizedAt?.toISOString() ?? null : null,
    finality: exposeChainDetail ? projection.finalityLabel : null,
    ...(includePrivate ? {
      authorization: status.authorization ? {
        authorizationId: status.authorization.authorizationId,
        status: status.authorization.status,
        validAfter: status.authorization.validAfter.toString(),
        deadline: status.authorization.deadline.toString(),
      } : null,
      attempts: status.attempts.map((attempt) => ({ ...attempt, reportedAt: attempt.reportedAt.toISOString() })),
    } : {}),
  };
}

export function createApp(deps: AppDependencies, options: AppOptions = {}) {
  if (options.enforcePublicOrigin && !options.publicOrigin) throw new Error("Canonical origin enforcement requires publicOrigin.");
  if (options.localWallet && (!options.localChainRehearsal || !deps.mint?.config.localChainRehearsal || !options.runMintOperation)) {
    throw new Error("Local test wallet requires the guarded durable Anvil entrypoint.");
  }
  const runMintOperation = options.runMintOperation ?? (async <T>(operation: () => Promise<T> | T) => operation());
  const runClaimWithdrawalOperation = options.runClaimWithdrawalOperation ?? ((_signatureId, operation) => runMintOperation(operation));
  const fixtureMode = options.fixtureMode ?? false;
  const localOAuth = fixtureMode && !options.oauthClient ? (options.localOAuthEmulator ?? new LocalXOAuthEmulator()) : null;
  const oauthClient = options.oauthClient ?? localOAuth;
  const localOAuthMode = oauthClient?.providerKind === "local_rehearsal";
  const redirectClaimSuccess = (res: ServerResponse, flow: OAuthFlow, session: BrowserSession, signatureId: string) => {
    // Only a newly completed, persisted claim schedules feedback. Following an
    // old completion URL must not repeatedly announce success.
    if (flow.status !== "completed") deps.auth.setClaimNotice(session, signatureId);
    deps.auth.complete(flow);
    redirect(res, 303, `/signatures/${signatureId}`);
  };
  const activeRendererVersion = options.activeRendererVersion ?? RENDERER_VERSION;
  const cardRendererVersion = options.cardRendererVersion ?? CARD_RENDERER_VERSION;
  const limits = new SlidingWindowLimits();
  const identityBreaker = new DailyCircuitBreaker(options.identityDailyCallLimit ?? 500);
  let activeRenders = 0;
  const sendError = (
    res: ServerResponse,
    req: IncomingMessage,
    pathname: string,
    status: number,
    code: string,
    message: string,
    pageFixtureMode = fixtureMode,
    pageLocalOAuthMode = localOAuthMode,
  ) => sendErrorResponse(res, req, pathname, status, code, message, pageFixtureMode, pageLocalOAuthMode, options.localChainRehearsal);
  const sendRemovedSignature = (res: ServerResponse, req: IncomingMessage, pathname: string, pageFixtureMode = fixtureMode) =>
    sendRemovedSignatureResponse(res, req, pathname, pageFixtureMode, localOAuthMode, options.localChainRehearsal);

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (oauthClient?.providerKind === "x") realXResponses.add(res);
    const method = req.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://request.invalid").pathname;
      if (options.enforcePublicOrigin && req.headers.host !== new URL(options.publicOrigin!).host) {
        if (method === "GET" || method === "HEAD") {
          const path = new URL(req.url ?? "/", "http://request.invalid");
          redirect(res, 308, `${originFor(req, options)}${path.pathname}${path.search}`);
        } else {
          sendError(res, req, pathname, 403, "ORIGIN_MISMATCH", "Open the app at its configured 127.0.0.1 address and try again.");
        }
        return;
      }
      const ip = clientIp(req, options);

      if ((method === "GET" || method === "HEAD") && pathname === "/assets/site.css") {
        send(res, req, 200, "text/css; charset=utf-8", SITE_CSS, fixtureMode || options.localChainRehearsal ? "no-store" : "public, max-age=300");
        return;
      }
      const fontAsset = siteFontAsset(pathname);
      if ((method === "GET" || method === "HEAD") && fontAsset) {
        send(res, req, 200, fontAsset.contentType, fontAsset.bytes, "public, max-age=31536000, immutable");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/mint.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", MINT_CLIENT_SCRIPT, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/account-panel.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", ACCOUNT_PANEL_SCRIPT, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/x-action-progress.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", X_ACTION_PROGRESS_SCRIPT, "public, max-age=300");
        return;
      }
      if ((fixtureMode || options.localChainRehearsal) && (method === "GET" || method === "HEAD") && pathname === "/assets/rehearsal-overlay.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", REHEARSAL_OVERLAY_SCRIPT, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/grok-prompt.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", GROK_PROMPT_SCRIPT, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/api/v1/account-panel") {
        const fetchSite = req.headers["sec-fetch-site"];
        if ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") || (req.headers.origin && req.headers.origin !== originFor(req, options))) {
          sendError(res, req, pathname, 403, "AUTH_REQUIRED", "Account controls are available only on this site.");
          return;
        }
        const session = sessionFromRequest(req, deps, fixtureMode);
        const query = new URL(req.url ?? "/", "http://request.invalid").searchParams;
        const returnTo = query.get("return_to");
        const actionReturnTo = returnTo && query.getAll("return_to").length === 1 && safeAccountReturn(returnTo) ? returnTo : "/me";
        const identity = session?.identity;
        const account = identity ? await deps.store.getAccount(identity.xUserId) : null;
        const binding = identity && deps.mint ? deps.mint.state.getActiveBinding(identity.xUserId, deps.mint.config.chainId) : null;
        const accountView: AccountPanelView = {
          currentHandle: identity ? account?.currentHandle ?? identity.username : undefined,
          csrfToken: identity ? session!.csrfToken : undefined,
          wallet: binding && deps.mint ? { address: binding.address, chainName: deps.mint.config.chainName, chainId: binding.chainId.toString(), provedAt: binding.provedAt } : null,
          fixtureMode, localOAuthMode, localChainRehearsal: options.localChainRehearsal,
          mintEnabled: deps.mint?.config.enabled ?? false,
          mintChainId: deps.mint?.config.chainId.toString() ?? "",
          ...walletConfirmationView(session, deps),
          actionReturnTo,
        };
        // Account controls stay X-only. Only a canonical mint page can expose
        // its session-bound recipient simulator inside the separate DEV area.
        const mintContext = actionReturnTo.match(MINT_REVIEW_PATTERN);
        if (mintContext && identity) {
          const signature = await deps.store.getSignature(mintContext[1]);
          if (signature?.xUserId === identity.xUserId && deps.mint?.config.enabled
            && deps.mint.state.canWithdrawClaim(signature.signatureId)
            && !deps.mint.state.hasUnresolvedBindingAuthorization(identity.xUserId, deps.mint.config.chainId)) {
            Object.assign(accountView, mintRecipientView(session, deps, signature));
          }
        }
        const html = accountPanelContent(accountView);
        const developmentHtml = developmentAuthenticationNotice(accountView) + developmentWalletControls(accountView);
        res.setHeader("Vary", "Cookie");
        send(res, req, 200, "application/json; charset=utf-8", JSON.stringify({ html, developmentHtml }), "private, no-store");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/slogan-tooltip.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", SLOGAN_TOOLTIP_SCRIPT, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/action-tooltip.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", ACTION_TOOLTIP_SCRIPT, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/claim-notice.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", CLAIM_NOTICE_SCRIPT, "public, max-age=300");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/withdraw-claim.js") {
        send(res, req, 200, "text/javascript; charset=utf-8", WITHDRAW_CLAIM_DIALOG_SCRIPT, "public, max-age=300");
        return;
      }
      const claimNoticeMatch = pathname.match(/^\/api\/v1\/signatures\/(sg1_[a-z2-7]{52})\/claim-notice$/);
      if ((method === "GET" || method === "HEAD") && claimNoticeMatch) {
        res.setHeader("Vary", "Cookie");
        const fetchSite = req.headers["sec-fetch-site"];
        if ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") || (req.headers.origin && req.headers.origin !== originFor(req, options))) {
          send(res, req, 403, "application/json; charset=utf-8", JSON.stringify({ show: false }), "private, no-store");
          return;
        }
        const session = sessionFromRequest(req, deps, fixtureMode);
        const show = method === "GET" && Boolean(session && deps.auth.takeClaimNotice(session, claimNoticeMatch[1]));
        send(res, req, 200, "application/json; charset=utf-8", JSON.stringify({ show }), "private, no-store");
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/assets/favicon.svg") {
        const version = new URL(req.url ?? "/", "http://request.invalid").searchParams.get("v");
        applySecurityHeaders(res, version === FAVICON_VERSION ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate");
        res.setHeader("Content-Security-Policy", FAVICON_CSP);
        res.writeHead(200, { "Content-Type": "image/svg+xml" });
        res.end(method === "HEAD" ? undefined : FAVICON_SVG);
        return;
      }
      if (fixtureMode && (method === "GET" || method === "HEAD") && (pathname === "/dev/collection-states" || pathname === "/dev/collection-states/artwork.svg")) {
        const fixtures = await import("../v1/collectionStateFixtures.js");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        if (pathname.endsWith(".svg")) {
          send(res, req, 200, "image/svg+xml", fixtures.collectionStateArtwork());
        } else {
          const query = new URL(req.url ?? "/", "http://request.invalid").searchParams;
          const page = query.getAll("state").length <= 1 && query.getAll("view").length <= 1 ? fixtures.collectionStatePage(query.get("state") ?? "empty", originFor(req, options), query.get("view") ?? "collection") : null;
          if (page) send(res, req, 200, "text/html; charset=utf-8", page);
          else sendError(res, req, pathname, 404, "NOT_FOUND", "That collection state fixture does not exist.");
        }
        return;
      }
      if (fixtureMode && (method === "GET" || method === "HEAD") && (pathname === "/dev/slogan-study" || pathname === "/dev/slogan-study.css")) {
        const study = await import("../brand/sloganStudy.js");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        if (pathname.endsWith(".css")) send(res, req, 200, "text/css; charset=utf-8", study.SLOGAN_STUDY_CSS);
        else send(res, req, 200, "text/html; charset=utf-8", study.sloganStudyPage());
        return;
      }
      if (fixtureMode && (method === "GET" || method === "HEAD") && ["/dev/button-study", "/dev/button-study.css", "/dev/button-study.js"].includes(pathname)) {
        const study = await import("../brand/buttonStudy.js");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        if (pathname.endsWith(".css")) send(res, req, 200, "text/css; charset=utf-8", study.BUTTON_STUDY_CSS);
        else if (pathname.endsWith(".js")) send(res, req, 200, "application/javascript; charset=utf-8", study.BUTTON_STUDY_SCRIPT);
        else send(res, req, 200, "text/html; charset=utf-8", study.buttonStudyPage());
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/") {
        const requestUrl = new URL(req.url ?? "/", "http://request.invalid");
        const tab = requestUrl.searchParams.get("tab") ?? "claimed";
        if ((tab !== "claimed" && tab !== "minted") || requestUrl.searchParams.getAll("tab").length > 1) {
          throw new V2Error(400, "INVALID_GALLERY_TAB", "Choose the Claimed or Minted gallery.");
        }
        const gallery = await (tab === "claimed" ? claimedGalleryCardViews : galleryCardViews)(deps, requestUrl.searchParams.get("after"));
        const nextHref = gallery.nextCursor ? `/?tab=${tab}&after=${encodeURIComponent(gallery.nextCursor)}` : null;
        send(res, req, 200, "text/html; charset=utf-8", homePage(fixtureMode, gallery.entries, nextHref, options.localChainRehearsal, tab, { publicOrigin: originFor(req, options) }));
        return;
      }
      if ((method === "GET" || method === "HEAD") && pathname === "/about") {
        send(res, req, 200, "text/html; charset=utf-8", aboutPage(fixtureMode, options.localChainRehearsal));
        return;
      }
      if ((method === "GET" || method === "HEAD") && LEGACY_PREVIEW_PATTERN.test(pathname)) {
        send(res, req, 410, "text/html; charset=utf-8", gonePage(fixtureMode, options.localChainRehearsal));
        return;
      }
      if ((method === "GET" || method === "HEAD") && (/^\/c\/|^\/v\//).test(pathname)) {
        send(res, req, 410, "text/html; charset=utf-8", gonePage(fixtureMode, options.localChainRehearsal));
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
        const query = new URL(req.url ?? "/", "http://request.invalid").searchParams;
        const flowId = query.get("flow");
        if (!handle.isCanonical || !gr0k.isCanonical) {
          redirect(res, 308, `/s/${handle.canonicalSegment}/${gr0k.canonical}${flowId !== null ? `?flow=${encodeURIComponent(flowId)}#claim` : ""}`, flowId !== null ? "no-store" : "public, max-age=300");
          return;
        }
        const previewRenderer = deps.renderers.get(activeRendererVersion);
        const previewSvgSha256 = sha256Hex(previewRenderer.render({ handle: handle.renderHandle, gr0kRaw: gr0k.raw, gr0kScale: GR0K_SCALE, rendererVersion: activeRendererVersion }).svgUtf8);
        const imagePath = `/renders/${encodeURIComponent(activeRendererVersion)}/${handle.renderHandle}/${gr0k.canonical}.png`;
        const params: PreviewPageParams = { handle: handle.renderHandle, gr0kRaw: gr0k.raw, rendererVersion: activeRendererVersion, previewSvgSha256, imageUrl: `${originFor(req, options)}${imagePath}`, fixtureMode, localOAuthMode, localChainRehearsal: options.localChainRehearsal };
        // Private action state lives on the same artwork URL. Never put a bound
        // flow, identity or CSRF token in the publicly cached preview response.
        if (flowId !== null) {
          const session = sessionFromRequest(req, deps, fixtureMode);
          const flow = session && query.getAll("flow").length === 1
            ? deps.auth.getBoundFlow(session, flowId, "authenticated") ?? deps.auth.getBoundFlow(session, flowId, "completed") : null;
          let status = 200;
          if (!session?.identity) {
            status = 401;
            params.notice = "Your sign-in session expired. Sign in again to continue here.";
          } else if (!flow || flow.purpose !== "claim" || flow.handleAtClaim !== handle.renderHandle || flow.handleNormalized !== handle.normalized || flow.gr0kRaw !== gr0k.raw || !flow.rendererVersion || flow.identity?.xUserId !== session.identity.xUserId || session.identity.handleNormalized !== handle.normalized) {
            status = 409;
            params.notice = "This claim session is no longer available for this signature. Sign in again to continue here.";
          } else {
            const signatureId = deriveSignatureId({ xUserId: session.identity.xUserId, handleAtClaim: handle.renderHandle, gr0kRaw: gr0k.raw, rendererVersion: flow.rendererVersion });
            const saved = await deps.store.getSignature(signatureId);
            if (deps.mint?.state.isSuppressed(signatureId)) {
              sendRemovedSignature(res, req, pathname, fixtureMode);
              return;
            }
            params.rendererVersion = flow.rendererVersion;
            params.previewSvgSha256 = flow.previewSvgSha256 ?? undefined;
            params.imageUrl = `${originFor(req, options)}/renders/${encodeURIComponent(flow.rendererVersion)}/${handle.renderHandle}/${gr0k.canonical}.png`;
            if (saved) {
              res.setHeader("Vary", "Cookie");
              if (method === "HEAD") redirect(res, 303, `/signatures/${saved.signatureId}`);
              else redirectClaimSuccess(res, flow, session, saved.signatureId);
              return;
            } else if (flow.status === "authenticated") {
              if (flow.claimIntent === CLAIM_ON_RETURN_INTENT) {
                status = flow.claimFailure === "rate_limited" ? 429 : 503;
                params.claim = { state: "retry", flowId: flow.id, csrfToken: session.csrfToken };
                if (flow.claimFailure === "rate_limited") params.notice = "Your X sign-in succeeded, but the claim limit was reached. Wait before trying again.";
              } else {
                params.claim = { state: "confirm", flowId: flow.id, csrfToken: session.csrfToken };
              }
            } else {
              status = 409;
              params.notice = "The saved claim could not be found. Sign in again to continue here.";
            }
          }
          res.setHeader("Vary", "Cookie");
          send(res, req, status, "text/html; charset=utf-8", previewPage(params), "private, no-store");
          return;
        }
        const page = previewPage(params);
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
        if (version === "sg-renderer-dev-fixture") {
          sendError(res, req, pathname, 410, "RENDERER_RETIRED", "This pre-release artwork has been retired. Use a new Signature Algorithm v1.0.0 preview.", fixtureMode);
          return;
        }
        const handle = normalizeHandleSegment(renderMatch[2]);
        const gr0k = parseGr0kSegment(renderMatch[3]);
        if (!handle.isCanonical || !gr0k.isCanonical) {
          redirect(res, 308, `/renders/${encodeURIComponent(version)}/${handle.renderHandle}/${gr0k.canonical}.${renderMatch[4]}`, "public, max-age=300");
          return;
        }
        activeRenders += 1;
        try {
          const renderer = deps.renderers.get(version);
          const rendered = renderer.render({ handle: handle.renderHandle, gr0kRaw: gr0k.raw, gr0kScale: GR0K_SCALE, rendererVersion: version });
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

      if ((method === "GET" || method === "HEAD") && pathname === "/dev/oauth/x/authorize" && localOAuth) {
        const requestId = new URL(req.url ?? "/", "http://request.invalid").searchParams.get("request") ?? "";
        const authorization = localOAuth.getAuthorizationRequest(requestId);
        if (!authorization) {
          sendError(res, req, pathname, 400, "LOCAL_OAUTH_REQUEST_INVALID", "This local OAuth rehearsal request is invalid, expired, or already used.", true);
          return;
        }
        send(res, req, 200, "text/html; charset=utf-8", localOAuthAuthorizePage({ requestId: authorization.requestId, accounts: authorization.accounts, localChainRehearsal: options.localChainRehearsal }), "no-store");
        return;
      }

      if (method === "POST" && pathname === "/dev/oauth/x/authorize" && localOAuth) {
        if (!requireSameOrigin(req, options)) {
          sendError(res, req, pathname, 403, "LOCAL_OAUTH_REQUEST_INVALID", "The local OAuth decision did not come from this site.", true);
          return;
        }
        if (!limits.consume("local-oauth-ip", ip, 20, 15 * 60_000)) {
          sendError(res, req, pathname, 429, "RATE_LIMITED", "Too many local OAuth rehearsal attempts.", true);
          return;
        }
        const form = await readForm(req);
        const decision = form.get("decision") as LocalOAuthDecision | null;
        if (!decision) {
          sendError(res, req, pathname, 400, "LOCAL_OAUTH_REQUEST_INVALID", "Choose a local OAuth rehearsal outcome.", true);
          return;
        }
        try {
          redirect(res, 303, localOAuth.completeAuthorization(form.get("request") ?? "", decision, form.get("account") ?? undefined));
        } catch (error) {
          const message = error instanceof LocalOAuthEmulatorError ? error.message : "The local OAuth rehearsal could not be completed.";
          sendError(res, req, pathname, 400, "LOCAL_OAUTH_REQUEST_INVALID", message, true);
        }
        return;
      }

      if (method === "POST" && pathname === "/auth/x/start") {
        if (!requireSameOrigin(req, options)) {
          sendError(res, req, pathname, 403, "CLAIM_FLOW_INVALID", "The request did not come from this site.", fixtureMode);
          return;
        }
        const session = ensureSession(req, res, deps, fixtureMode);
        if (!limits.consume("oauth-start-ip", ip, 10, 15 * 60_000) || !limits.consume("oauth-start-session", session.id, 5, 15 * 60_000)) {
          sendError(res, req, pathname, 429, "RATE_LIMITED", "Too many sign-in attempts. Try again later.", fixtureMode);
          return;
        }
        const form = await readForm(req);
        const purpose = form.get("purpose");
        const claimIntent = form.get("claim_intent");
        if ((purpose !== "claim" && purpose !== "account_login" && purpose !== "sensitive_action") || ["purpose", "handle", "gr0k", "claim_intent", "renderer_version", "preview_sha256", "action", "signature_id", "claim_instance", "csrf"].some(key => form.getAll(key).length > 1)
          || claimIntent !== null && (purpose !== "claim" || claimIntent !== CLAIM_ON_RETURN_INTENT)
          || purpose !== "sensitive_action" && ["action", "signature_id", "claim_instance"].some(key => form.has(key))
          || purpose === "sensitive_action" && ["handle", "gr0k", "renderer_version", "preview_sha256"].some(key => form.has(key))) {
          sendError(res, req, pathname, 400, "CLAIM_FLOW_INVALID", "The sign-in or claim intent is invalid.", fixtureMode);
          return;
        }
        const returnTo = form.get("return_to");
        if (form.getAll("return_to").length > 1 || returnTo !== null && (purpose === "claim" || !safeAccountReturn(returnTo))) {
          sendError(res, req, pathname, 400, "CLAIM_FLOW_INVALID", "The sign-in return destination is invalid.", fixtureMode);
          return;
        }
        let actionIntent: SensitiveActionIntent | undefined;
        let mintClaimantXUserId: string | undefined;
        if (purpose === "sensitive_action") {
          const action = form.get("action");
          if (session.identity) {
            requireSessionIdentity(session);
            if (form.get("csrf") !== session.csrfToken) throw new V2Error(403, "REQUEST_CONFIRMATION_INVALID", "Reload the page before confirming this action with X.");
          } else if (action !== "wallet_link" && action !== "mint_recipient") {
            throw new V2Error(401, "AUTH_REQUIRED", "Sign in with X to access your account actions.");
          }
          const xUserId = session.identity?.xUserId;
          if (action === "mint_recipient") {
            const signatureId = form.get("signature_id") ?? "";
            const claimInstanceId = form.get("claim_instance") ?? "";
            if (!/^sg1_[a-z2-7]{52}$/.test(signatureId) || !CLAIM_INSTANCE_PATTERN.test(claimInstanceId)
              || returnTo !== `/signatures/${signatureId}/mint`) {
              throw new V2Error(400, "REQUEST_CONFIRMATION_INVALID", "Open the exact signature before connecting a mint recipient.");
            }
            const signature = await deps.store.getSignature(signatureId);
            if (!signature || signature.claimInstanceId !== claimInstanceId) throw new V2Error(409, "CLAIM_CHANGED", "This claim has changed. Open the current signature before minting.");
            actionIntent = mintRecipientIntent(deps, signature);
            mintClaimantXUserId = signature.xUserId;
            await validateActionTarget(deps, actionIntent, xUserId ?? signature.xUserId);
          } else if (action === "wallet_link" || action === "wallet_revoke") {
            if (form.has("signature_id") || form.has("claim_instance")) throw new V2Error(400, "REQUEST_CONFIRMATION_INVALID", "The wallet action must not contain a claim target.");
            actionIntent = walletActionIntent(deps, xUserId, action);
          } else if (action === "claim_withdraw") {
            const signatureId = form.get("signature_id") ?? "";
            const claimInstanceId = form.get("claim_instance") ?? "";
            if (!/^sg1_[a-z2-7]{52}$/.test(signatureId) || !CLAIM_INSTANCE_PATTERN.test(claimInstanceId)
              || returnTo !== null && returnTo !== `/signatures/${signatureId}`) {
              throw new V2Error(400, "INVALID_WITHDRAWAL", "Reload the signature before confirming withdrawal with X.");
            }
            actionIntent = { kind: action, signatureId, claimInstanceId };
            await validateActionTarget(deps, actionIntent, xUserId!);
          } else {
            throw new V2Error(400, "REQUEST_CONFIRMATION_INVALID", "Choose a valid account action to confirm with X.");
          }
          // A logout or account switch during target lookup cannot start a grant.
          if (xUserId) requireSessionIdentity(session, xUserId);
        }
        let claimInput: ClaimFlowInput | null = null;
        if (purpose === "claim") {
          const handleAtClaim = validateRenderHandle(form.get("handle") ?? "");
          const handleNormalized = normalizeHandleValue(handleAtClaim);
          const gr0k = parseGr0kValue(form.get("gr0k") ?? "");
          // Bind consent to the displayed renderer and bytes, including a
          // cached preview from before an active-renderer change.
          const rendererVersion = claimIntent === CLAIM_ON_RETURN_INTENT ? form.get("renderer_version") ?? "" : activeRendererVersion;
          if (claimIntent === CLAIM_ON_RETURN_INTENT && (!rendererVersion || !/^[a-f0-9]{64}$/.test(form.get("preview_sha256") ?? ""))) {
            sendError(res, req, pathname, 400, "CLAIM_FLOW_INVALID", "Reload the signature before signing in and claiming it.", fixtureMode);
            return;
          }
          const renderer = deps.renderers.get(rendererVersion);
          const rendered = renderer.render({ handle: handleAtClaim, gr0kRaw: gr0k.raw, gr0kScale: GR0K_SCALE, rendererVersion });
          const previewSvgSha256 = sha256Hex(rendered.svgUtf8);
          if (claimIntent === CLAIM_ON_RETURN_INTENT && form.get("preview_sha256") !== previewSvgSha256) {
            sendError(res, req, pathname, 409, "PREVIEW_CHANGED", "The preview no longer matches this signature. Reload it before claiming.", fixtureMode);
            return;
          }
          claimInput = { handleAtClaim, handleNormalized, gr0kRaw: gr0k.raw, rendererVersion, previewSvgSha256,
            ...(claimIntent === CLAIM_ON_RETURN_INTENT ? { claimIntent: CLAIM_ON_RETURN_INTENT } : {}) };
        }
        const verifier = generateCodeVerifier();
        const { flow, state } = deps.auth.startFlow(session, purpose, claimInput, verifier);
        if (returnTo) flow.returnTo = returnTo;
        if (actionIntent) {
          flow.actionIntent = actionIntent;
          if (actionIntent.kind === "claim_withdraw") flow.returnTo = `/signatures/${actionIntent.signatureId}`;
          if (actionIntent.kind === "mint_recipient") {
            flow.returnTo = `/signatures/${actionIntent.signatureId}/mint`;
            // A signed-out entry still has an exact original claimant. Do not
            // turn this into a grant for whichever account the provider returns.
            flow.actionXUserId = mintClaimantXUserId;
          }
        }
        if (!oauthClient) {
          deps.auth.fail(flow);
          sendError(res, req, pathname, 503, "X_AUTH_UNAVAILABLE", "X authentication is not configured.", fixtureMode);
          return;
        }
        redirect(res, 302, oauthClient.getAuthorizeUrl(state, generateCodeChallenge(verifier)));
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
        const oauthError = url.searchParams.get("error");
        if (!state || !oauthClient || ["state", "code", "error"].some(key => url.searchParams.getAll(key).length > 1) || code && oauthError) {
          sendError(res, req, pathname, 400, "INVALID_OAUTH_STATE", localOAuthMode ? "The local OAuth callback is incomplete or unavailable." : "The X callback is incomplete or unavailable.", fixtureMode);
          return;
        }
        const flow = deps.auth.beginCallback(session, state);
        if (!flow) {
          sendError(res, req, pathname, 400, "INVALID_OAUTH_STATE", "The sign-in state is invalid, expired, or already used.", fixtureMode);
          return;
        }
        if (oauthError) {
          deps.auth.fail(flow);
          const denied = oauthError === "access_denied";
          sendError(
            res,
            req,
            pathname,
            denied ? 403 : 503,
            localOAuthMode ? (denied ? "LOCAL_OAUTH_DENIED" : "LOCAL_OAUTH_UNAVAILABLE") : (denied ? "X_AUTH_DENIED" : "X_AUTH_UNAVAILABLE"),
            localOAuthMode
              ? (denied ? "The simulated account denied the local OAuth rehearsal. No X authentication occurred." : "The local OAuth provider simulated an error. No X authentication occurred.")
              : (denied ? "X authentication was denied. Start again when you are ready." : "X authentication could not be completed. Start again."),
            fixtureMode,
          );
          return;
        }
        if (!code) {
          deps.auth.fail(flow);
          sendError(res, req, pathname, 400, "INVALID_OAUTH_STATE", localOAuthMode ? "The local OAuth callback did not include an authorization code." : "The X callback did not include an authorization code.", fixtureMode);
          return;
        }
        if (!localOAuthMode && !identityBreaker.tryConsume()) {
          deps.auth.fail(flow);
          sendError(res, req, pathname, 503, "X_AUTH_UNAVAILABLE", "The daily X identity limit has been reached.", fixtureMode);
          return;
        }
        let callbackStage = "token_exchange";
        try {
          const accessToken = await withTimeout(oauthClient.exchangeCode(code, flow.pkceVerifier), 10_000);
          callbackStage = "identity_lookup";
          const user = await withTimeout(oauthClient.getUser(accessToken), 10_000);
          callbackStage = "identity_validation";
          if (!/^(?:0|[1-9]\d*)$/.test(user.id)) throw new Error("X returned an invalid account ID.");
          const handleNormalized = normalizeHandleValue(user.username);
          if (flow.purpose === "claim" && handleNormalized !== flow.handleNormalized) {
            deps.auth.fail(flow);
            sendError(res, req, pathname, 403, "HANDLE_MISMATCH", `Sign in with the X account matching @${flow.handleNormalized} to claim this signature.`, fixtureMode);
            return;
          }
          const identity = { xUserId: user.id, username: user.username, handleNormalized, authenticatedAt: new Date() };
          if (flow.purpose === "sensitive_action") {
            if (flow.actionXUserId !== undefined && flow.actionXUserId !== identity.xUserId) throw new V2Error(403, "NOT_CLAIMANT", "Confirm this action with the same X account that started it.");
            if (!flow.actionIntent) throw new V2Error(400, "REQUEST_CONFIRMATION_INVALID", "This action confirmation has no target. Start again.");
            if (flow.actionXUserId === undefined && flow.actionIntent.kind === "wallet_link"
              && deps.mint?.state.getActiveBinding(identity.xUserId, deps.mint.config.chainId)) {
              // First sign-in may discover an already-linked wallet. Keep that
              // binding and sign in normally; never upgrade link consent into
              // replacement consent or trap a returning user in a login loop.
              flow.purpose = "account_login";
              delete flow.actionIntent;
            } else {
              await validateActionTarget(deps, flow.actionIntent, identity.xUserId);
            }
          }
          callbackStage = "account_storage";
          if (flow.purpose !== "claim") await deps.store.updateExistingAccountLogin(identity.xUserId, identity.username, identity.handleNormalized, identity.authenticatedAt);
          callbackStage = "session_authentication";
          const rotated = deps.auth.authenticate(flow, identity, session);
          setSessionCookie(res, rotated, fixtureMode);
          if (flow.claimIntent === CLAIM_ON_RETURN_INTENT && flow.purpose === "claim") {
            callbackStage = "claim_persistence";
            if (!limits.consume("claim-x", identity.xUserId, 20, 60 * 60_000) || !limits.consume("claim-session", rotated.id, 10, 60 * 60_000)) {
              flow.claimFailure = "rate_limited";
              redirect(res, 303, claimPageHref(flow));
              return;
            }
            const result = await finalizeClaim({ store: deps.store, artifacts: deps.artifacts, renderers: deps.renderers, cardRendererVersion }, flow, identity);
            redirectClaimSuccess(res, flow, rotated, result.signature.signatureId);
            return;
          }
          const accountReturn = flow.returnTo && safeAccountReturn(flow.returnTo) ? flow.returnTo : "/me";
          redirect(res, 303, flow.purpose === "claim" ? claimPageHref(flow)
            : accountReturn + (flow.actionIntent?.kind === "claim_withdraw" ? "#withdraw" : ""));
        } catch (error) {
          if (callbackStage === "claim_persistence") {
            // Authentication succeeded. The read-only return checks for a
            // committed record first; otherwise it offers an explicit retry.
            flow.claimFailure = "storage_unavailable";
            redirect(res, 303, claimPageHref(flow));
            return;
          }
          if (error instanceof V2Error) {
            deps.auth.fail(flow);
            sendError(res, req, pathname, error.status, error.code, error.message, fixtureMode);
            return;
          }
          if (!localOAuthMode) console.error("X authentication failed", {
            stage: callbackStage,
            reason: error instanceof XOAuthRequestError ? error.kind : "internal_or_timeout",
            ...(error instanceof XOAuthRequestError && error.httpStatus ? { httpStatus: error.httpStatus } : {}),
          });
          deps.auth.fail(flow);
          sendError(res, req, pathname, 503, localOAuthMode ? "LOCAL_OAUTH_UNAVAILABLE" : "X_AUTH_UNAVAILABLE", localOAuthMode ? "The local OAuth rehearsal could not be completed. No X authentication occurred." : "X authentication could not be completed. Start again.", fixtureMode);
        }
        return;
      }

      if (method === "GET" && pathname === "/claim/review") {
        const session = sessionFromRequest(req, deps, fixtureMode);
        const flowId = new URL(req.url ?? "/", "http://request.invalid").searchParams.get("flow") ?? "";
        if (!session || !session.identity) {
          sendError(res, req, pathname, 401, "AUTH_REQUIRED", localOAuthMode ? "Complete the local OAuth rehearsal to review this claim." : "Sign in with X to review this claim.", fixtureMode, localOAuthMode);
          return;
        }
        requireSessionIdentity(session);
        const flow = deps.auth.getBoundFlow(session, flowId, "authenticated") ?? deps.auth.getBoundFlow(session, flowId, "completed");
        if (!flow || flow.handleNormalized === null || flow.gr0kRaw === null || flow.rendererVersion === null) {
          sendError(res, req, pathname, 409, "CLAIM_FLOW_INVALID", "This claim flow is expired, consumed, or belongs to another session.", fixtureMode);
          return;
        }
        // Old bookmarks land on the same artwork/action area, never a second layout.
        redirect(res, 303, claimPageHref(flow));
        return;
      }

      if (method === "POST" && pathname === "/api/v1/signatures") {
        const session = sessionFromRequest(req, deps, fixtureMode);
        if (!session || !session.identity) {
          sendError(res, req, pathname, 401, "AUTH_REQUIRED", localOAuthMode ? "Complete the local OAuth rehearsal before claiming." : "Sign in with X before claiming.", fixtureMode, localOAuthMode);
          return;
        }
        requireSessionIdentity(session);
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
        let result;
        try {
          result = await finalizeClaim({ store: deps.store, artifacts: deps.artifacts, renderers: deps.renderers, cardRendererVersion }, flow, session.identity);
        } catch (error) {
          if (flow.claimIntent !== CLAIM_ON_RETURN_INTENT) throw error;
          flow.claimFailure = "storage_unavailable";
          if (wantsJson(req, pathname)) sendError(res, req, pathname, 503, "CLAIM_SAVE_UNAVAILABLE", "Signed in, but the claim could not be saved. Try again.", fixtureMode);
          else redirect(res, 303, claimPageHref(flow));
          return;
        }
        if (wantsJson(req, pathname)) {
          deps.auth.complete(flow);
          send(res, req, result.existing ? 200 : 201, "application/json; charset=utf-8", JSON.stringify(publicSignatureJson(result.signature, result.account.publicAccountId, result.existing, localOAuthMode)));
        } else {
          redirectClaimSuccess(res, flow, session, result.signature.signatureId);
        }
        return;
      }

      if (pathname.startsWith("/api/local/wallet") && options.localChainRehearsal && options.localWallet && deps.mint) {
        const wallet = options.localWallet;
        const mint = deps.mint;
        if ((method === "GET" || method === "HEAD") && pathname === "/api/local/wallet") {
          const session = sessionFromRequest(req, deps, fixtureMode);
          if (!session?.identity) throw new V2Error(401, "AUTH_REQUIRED", "Sign in to the local rehearsal first.");
          requireSessionIdentity(session);
          send(res, req, 200, "application/json; charset=utf-8", JSON.stringify(await wallet.info()));
          return;
        }
        if (method === "POST" && ["/api/local/wallet/sign", "/api/local/wallet/mint", "/api/local/wallet/transfer"].includes(pathname)) {
          const session = requireV2Session(req, deps, options);
          const xUserId = requireSessionIdentity(session).xUserId;
          if (!limits.consume("local-wallet-actions", session.id, 60, 60_000)) throw new V2Error(429, "RATE_LIMITED", "Too many local wallet actions.");
          const body = await readJson(req);
          const response = await runMintOperation(async () => {
            requireV2Session(req, deps, options);
            requireSessionIdentity(session, xUserId);
            if (pathname.endsWith("/sign")) {
              const challenge = typeof body.challengeId === "string" ? mint.state.getChallenge(body.challengeId) : null;
              if (!challenge || challenge.xUserId !== xUserId
                || challenge.sessionIdDigest !== createHash("sha256").update(session.id).digest("hex")
                || challenge.mintTarget && session.mintRecipientChallengeId !== challenge.challengeId
                || challenge.status !== "pending" || challenge.expiresAt <= new Date()) {
                throw new V2Error(409, "WALLET_CHALLENGE_INVALID", "This local wallet challenge is unavailable for this session.");
              }
              return { walletProof: await wallet.signChallenge(challenge) };
            }
            if (pathname.endsWith("/mint")) {
              if (req.headers["x-mint-permanence-acknowledged"] !== "1") throw new V2Error(409, "AUTHORIZATION_UNAVAILABLE", "Confirm the reviewed local transaction before sending it.");
              const authorization = typeof body.authorizationId === "string" ? mint.state.getAuthorization(body.authorizationId) : null;
              const signature = authorization ? await deps.store.getSignature(authorization.signatureId) : null;
              requireSessionIdentity(session, xUserId);
              if (!authorization || !signature || signature.xUserId !== xUserId || mint.state.isSuppressed(signature.signatureId)) {
                throw new V2Error(403, "NOT_CLAIMANT", "This authorization does not belong to the active local claimant.");
              }
              const attempts = mint.state.getStatus(signature.signatureId, true).attempts;
              const prior = attempts.find((attempt) => attempt.authorizationId === authorization.authorizationId && attempt.localWalletBroadcast === true && attempt.state !== "reverted" && attempt.state !== "stale_unknown");
              if (prior) return { txHash: prior.txHash };
              const account = await deps.store.getAccount(signature.xUserId);
              if (!account) throw new V2Error(403, "NOT_CLAIMANT", "The local claimant is unavailable.");
              const exact = await mint.issueAuthorization(signature, account, undefined, session);
              if (exact.authorization.authorizationId !== authorization.authorizationId) throw new V2Error(409, "AUTHORIZATION_UNAVAILABLE", "Review the current local authorization again.");
              requireSessionIdentity(session, xUserId);
              const txHash = await wallet.submitMint(exact);
              // Once broadcast, retain transaction evidence even if the browser
              // logs out while awaiting the RPC response.
              mint.reportTransaction(xUserId, authorization.authorizationId, txHash).localWalletBroadcast = true;
              return { txHash };
            }
            const signature = typeof body.signatureId === "string" ? await deps.store.getSignature(body.signatureId) : null;
            requireSessionIdentity(session, xUserId);
            if (!signature || signature.xUserId !== xUserId || mint.state.isSuppressed(signature.signatureId)) throw new V2Error(403, "NOT_CLAIMANT", "This token is not in the active local claimant's collection.");
            const projection = mint.state.getProjection(signature.signatureId);
            if (projection.state !== "finalized" || projection.tokenId === null) throw new V2Error(409, "AUTHORIZATION_UNAVAILABLE", "Wait for local mint confirmation before transferring.");
            const binding = mint.state.getActiveBinding(xUserId, 31337n);
            if (!binding || binding.verificationScheme === "fixture_seed" || binding.address.toLowerCase() !== wallet.address.toLowerCase()) throw new V2Error(403, "WALLET_NOT_LINKED", "Prove control of the local TEST wallet before transferring.");
            return { txHash: await wallet.transferToRecipient(projection.tokenId) };
          });
          send(res, req, 200, "application/json; charset=utf-8", JSON.stringify(response));
          return;
        }
      }

      if (method === "POST" && pathname === "/dev/v2/wallet-bindings/seed" && fixtureMode && !options.localChainRehearsal) {
        if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "The V2 rehearsal is disabled.");
        const session = requireV2Session(req, deps, options);
        const account = await deps.store.getAccount(session.identity!.xUserId);
        if (!account) throw new V2Error(403, "NOT_CLAIMANT", "Only an account with a V1 claim can link a mint wallet.");
        requireSessionIdentity(session, account.xUserId);
        const body = await readJson(req);
        let binding;
        if (body.signatureId !== undefined || body.claimInstanceId !== undefined) {
          const signature = typeof body.signatureId === "string" ? await deps.store.getSignature(body.signatureId) : null;
          if (!signature || signature.claimInstanceId !== body.claimInstanceId) throw new V2Error(409, "CLAIM_CHANGED", "Open the current signature before verifying a recipient.");
          requireSessionIdentity(session, signature.xUserId);
          binding = await deps.mint.seedFixtureMintRecipient(session, signature, account, new Date(), body);
        } else {
          // Legacy developer-only binding seeding is not per-mint authority.
          consumeActionApproval(session, walletActionIntent(deps, account.xUserId, "wallet_link"));
          binding = deps.mint.seedFixtureBinding(account.xUserId, account.publicAccountId);
        }
        send(res, req, 201, "application/json; charset=utf-8", JSON.stringify({ walletBindingId: binding.walletBindingId, walletAddress: binding.address, chainId: binding.chainId.toString(), fixture: true }));
        return;
      }

      if (method === "POST" && pathname === "/api/v2/wallet-bindings/challenge") {
        if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "Minting is not enabled.");
        const session = requireV2Session(req, deps, options);
        if (!limits.consume("v2-wallet-challenge-session", session.id, 10, 15 * 60_000) || !limits.consume("v2-wallet-challenge-x", session.identity!.xUserId, 10, 60 * 60_000)) {
          throw new V2Error(429, "RATE_LIMITED", "Too many wallet challenges. Try again later.");
        }
        const account = await deps.store.getAccount(session.identity!.xUserId);
        if (!account) throw new V2Error(403, "NOT_CLAIMANT", "Only an account with a V1 claim can link a mint wallet.");
        const body = await readJson(req);
        if (typeof body.walletAddress !== "string") throw new V2Error(400, "INVALID_WALLET_ADDRESS", "Enter one exact 20-byte Ethereum address.");
        if (typeof body.chainId !== "string") throw new V2Error(400, "WRONG_CHAIN", `Use ${deps.mint.config.chainName}.`);
        const signature = typeof body.signatureId === "string" ? await deps.store.getSignature(body.signatureId) : undefined;
        if ((body.signatureId !== undefined || body.claimInstanceId !== undefined)
          && (!signature || signature.claimInstanceId !== body.claimInstanceId)) throw new V2Error(409, "CLAIM_CHANGED", "Open the current signature before verifying a recipient.");
        if (signature) requireSessionIdentity(session, signature.xUserId);
        const challenge = await runMintOperation(() => deps.mint!.createChallenge({ session, account, walletAddress: body.walletAddress as string, chainId: body.chainId as string, ...(signature ? { signature, recipientConsent: body.recipientConsent, previousBindingId: body.previousBindingId } : {}) }));
        send(res, req, 201, "application/json; charset=utf-8", JSON.stringify(challenge));
        return;
      }

      if (method === "POST" && pathname === "/api/v2/wallet-bindings/confirm") {
        if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "Minting is not enabled.");
        const session = requireV2Session(req, deps, options);
        if (!limits.consume("v2-wallet-confirm-session", session.id, 5, 60 * 60_000) || !limits.consume("v2-wallet-confirm-x", session.identity!.xUserId, 5, 60 * 60_000)) {
          throw new V2Error(429, "RATE_LIMITED", "Too many wallet confirmations. Try again later.");
        }
        const body = await readJson(req);
        const identity = requireSessionIdentity(session);
        if (typeof body.challengeId !== "string" || typeof body.walletProof !== "string") {
          throw new V2Error(409, "WALLET_CHALLENGE_INVALID", "The wallet confirmation is incomplete.");
        }
        const challenge = deps.mint.state.getChallenge(body.challengeId);
        if (
          challenge?.xUserId === identity.xUserId
          && !limits.consume("v2-wallet-confirm-address", challenge.address.toLowerCase(), 5, 60 * 60_000)
        ) {
          throw new V2Error(429, "RATE_LIMITED", "Too many wallet confirmations for this address. Try again later.");
        }
        const activeBinding = deps.mint.state.getActiveBinding(identity.xUserId, deps.mint.config.chainId);
        if (
          challenge?.xUserId === identity.xUserId
          && activeBinding
          && activeBinding.address.toLowerCase() !== challenge.address.toLowerCase()
          && !limits.consume("v2-wallet-change-x", identity.xUserId, 3, 24 * 60 * 60_000)
        ) {
          throw new V2Error(429, "RATE_LIMITED", "Too many wallet changes. Try again later.");
        }
        const binding = await runMintOperation(() => deps.mint!.confirmChallenge({ session, challengeId: body.challengeId as string, walletProof: body.walletProof as string }));
        send(res, req, 201, "application/json; charset=utf-8", JSON.stringify({ walletBindingId: binding.walletBindingId, walletAddress: binding.address, chainId: binding.chainId.toString(), provedAt: binding.provedAt.toISOString() }));
        return;
      }

      if (method === "DELETE" && pathname === "/api/v2/wallet-bindings/current") {
        if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "Minting is not enabled.");
        const session = requireV2Session(req, deps, options);
        if (!limits.consume("v2-wallet-change-x", session.identity!.xUserId, 3, 24 * 60 * 60_000)) {
          throw new V2Error(429, "RATE_LIMITED", "Too many wallet changes. Try again later.");
        }
        const xUserId = requireSessionIdentity(session).xUserId;
        await runMintOperation(() => deps.mint!.revokeBinding(xUserId, undefined, session));
        send(res, req, 200, "application/json; charset=utf-8", JSON.stringify({ revoked: true }));
        return;
      }

      const mintReviewMatch = pathname.match(MINT_REVIEW_PATTERN);
      if ((method === "GET" || method === "HEAD") && mintReviewMatch) {
        const session = sessionFromRequest(req, deps, fixtureMode);
        const signature = await deps.store.getSignature(mintReviewMatch[1]);
        if (!signature) throw new V2Error(409, "MINT_INELIGIBLE", "That V1 signature does not exist.");
        if (deps.mint?.state.isSuppressed(signature.signatureId)) {
          sendRemovedSignature(res, req, pathname, fixtureMode);
          return;
        }
        const account = await deps.store.getAccount(signature.xUserId);
        if (!account) throw new Error("Signature account is missing.");
        const projection = deps.mint?.state.getProjection(signature.signatureId);
        if (projection?.state === "finalized") {
          redirect(res, 303, `/signatures/${signature.signatureId}`);
          return;
        }
        const ownClaim = session?.identity?.xUserId === signature.xUserId;
        const binding = ownClaim && deps.mint ? deps.mint.state.getActiveBinding(account.xUserId, deps.mint.config.chainId) : null;
        const status = ownClaim ? deps.mint?.state.getStatus(signature.signatureId, true) : undefined;
        const liveAuthorization = binding && deps.mint ? deps.mint.state.getLiveAuthorization(signature.signatureId, binding.walletBindingId) : null;
        const resumeAuthorization = Boolean(liveAuthorization?.status === "issued" && liveAuthorization.galleryAttestation);
        const unresolvedBinding = Boolean(deps.mint?.state.hasUnresolvedBindingAuthorization(account.xUserId, deps.mint.config.chainId));
        const pendingElsewhere = Boolean(ownClaim && unresolvedBinding && !liveAuthorization);
        const pending = ["submitted", "included_unfinalized", "validation_pending", "quarantined", "finality_revoked"].includes(projection?.state ?? "")
          || ["prepared", "signing_unknown"].includes(status?.authorization?.status ?? "")
          || Boolean(ownClaim && unresolvedBinding && !resumeAuthorization);
        const recipientVerified = Boolean(session && binding && hasMintRecipient(session, signature, binding));
        const stage: MintEntryStage | null = !deps.mint?.config.enabled ? "paused"
          : !session?.identity ? "sign-in"
          : !ownClaim ? "wrong-account"
          : pending ? "pending"
          : !binding || !resumeAuthorization && (!recipientVerified || new URL(req.url ?? "/", "http://request.invalid").searchParams.get("recipient") === "change") ? "wallet" : null;
        if (stage) {
          const currentAccount = session?.identity ? await deps.store.getAccount(session.identity.xUserId) : null;
          send(res, req, stage === "sign-in" ? 401 : stage === "wrong-account" ? 403 : stage === "paused" ? 503 : 200, "text/html; charset=utf-8", mintEntryPage({
            signature: signatureView(signature, account.publicAccountId), stage,
            pendingElsewhere,
            statusLabel: stage === "pending" && !pendingElsewhere ? status?.authorization?.status === "prepared" ? "Authorization preparation pending" : status?.authorization?.status === "signing_unknown" ? "Authorization reconciliation required" : MINT_STATE_LABELS[projection?.state ?? "unminted"] : undefined,
            account: { currentHandle: currentAccount?.currentHandle ?? session?.identity?.username, csrfToken: session?.csrfToken,
              wallet: binding && deps.mint ? { address: binding.address, chainId: binding.chainId.toString(), chainName: deps.mint.config.chainName, provedAt: binding.provedAt } : null,
              mintEnabled: deps.mint?.config.enabled ?? false, mintChainId: deps.mint?.config.chainId.toString() ?? "",
              mintCanStart: Boolean(deps.mint?.config.enabled && !unresolvedBinding && deps.mint.state.canWithdrawClaim(signature.signatureId)),
              fixtureMode, localOAuthMode, localChainRehearsal: options.localChainRehearsal,
              ...mintRecipientView(session, deps, signature), actionReturnTo: `/signatures/${signature.signatureId}/mint` },
          }));
          return;
        }
        // The entry page above is read-only. Exact review still requires every prerequisite.
        if (!deps.mint?.config.enabled || !session?.identity || !ownClaim || !binding) throw new V2Error(403, "MINT_INELIGIBLE", "Complete the mint prerequisites first.");
        requireSessionIdentity(session, signature.xUserId);
        if (!resumeAuthorization && !hasMintRecipient(session, signature, binding)) throw new V2Error(401, "MINT_RECIPIENT_REQUIRED", "Verify the wallet for this mint before reviewing it.");
        const metadata = await deps.mint.previewMetadata(signature, account);
        requireSessionIdentity(session, signature.xUserId);
        if (deps.mint.state.getActiveBinding(signature.xUserId, deps.mint.config.chainId)?.walletBindingId !== binding.walletBindingId) {
          throw new V2Error(409, "BINDING_TRANSITION", "Your linked wallet changed. Reload the mint review.");
        }
        if (deps.mint.state.isSuppressed(signature.signatureId)) {
          sendRemovedSignature(res, req, pathname, fixtureMode);
          return;
        }
        const currentClaim = await deps.store.getSignature(signature.signatureId);
        requireSessionIdentity(session, signature.xUserId);
        if (currentClaim?.claimInstanceId !== signature.claimInstanceId) throw new V2Error(409, "CLAIM_CHANGED", "This claim changed while opening the mint review.");
        if (deps.mint.state.getActiveBinding(signature.xUserId, deps.mint.config.chainId)?.walletBindingId !== binding.walletBindingId) {
          throw new V2Error(409, "BINDING_TRANSITION", "The recipient changed while opening the mint review. Reload to review it again.");
        }
        if (!resumeAuthorization && !hasMintRecipient(session, signature, binding)) throw new V2Error(401, "MINT_RECIPIENT_REQUIRED", "Wallet verification expired. Open the mint page to start again.");
        send(res, req, 200, "text/html; charset=utf-8", mintReviewPage({
          signature: signatureView(signature, account.publicAccountId),
          currentHandle: account.currentHandle,
          wallet: { address: binding.address, chainId: binding.chainId.toString(), chainName: deps.mint.config.chainName, provedAt: binding.provedAt },
          walletBindingId: binding.walletBindingId,
          claimInstanceId: signature.claimInstanceId,
          resumeAuthorization,
          csrfToken: session.csrfToken,
          chainName: deps.mint.config.chainName,
          metadataUri: metadata.tokenUri,
          metadataSha256: metadata.metadataSha256,
          signatureDigest: signatureDigestHex(signature.signatureId),
          tokenUriHash: metadata.tokenUriHash,
          contract: deps.mint.config.contract,
          fixtureMode,
          localChainRehearsal: options.localChainRehearsal,
        }));
        return;
      }

      const mintAuthorizationMatch = pathname.match(MINT_AUTHORIZATION_PATTERN);
      if (method === "POST" && mintAuthorizationMatch) {
        if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "Minting is not enabled.");
        const session = requireV2Session(req, deps, options);
        if (req.headers["x-mint-permanence-acknowledged"] !== "1") {
          throw new V2Error(409, "AUTHORIZATION_UNAVAILABLE", "Review and acknowledge the permanent publication notice before authorizing.");
        }
        if (!limits.consume("v2-authorization-x", session.identity!.xUserId, 10, 60 * 60_000) || !limits.consume("v2-authorization-signature", mintAuthorizationMatch[1], 3, 60 * 60_000)) {
          throw new V2Error(429, "RATE_LIMITED", "Too many mint authorization attempts. Try again later.");
        }
        const body = await readJson(req);
        const signature = await deps.store.getSignature(mintAuthorizationMatch[1]);
        if (!signature) throw new V2Error(409, "MINT_INELIGIBLE", "That V1 signature does not exist.");
        requireSessionIdentity(session, signature.xUserId);
        const account = await deps.store.getAccount(signature.xUserId);
        if (!account) throw new Error("Signature account is missing.");
        if (typeof body.walletBindingId !== "string" || typeof body.recipient !== "string") throw new V2Error(400, "REQUEST_CONFIRMATION_INVALID", "Review the exact recipient before authorizing this mint.");
        const response = await runMintOperation(() => deps.mint!.issueAuthorization(signature, account, undefined, session, { walletBindingId: body.walletBindingId as string, recipient: body.recipient as string }));
        send(res, req, 201, "application/json; charset=utf-8", JSON.stringify(response));
        return;
      }

      const mintTransactionMatch = pathname.match(MINT_TRANSACTION_PATTERN);
      if (method === "POST" && mintTransactionMatch) {
        if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "Minting is not enabled.");
        const session = requireV2Session(req, deps, options);
        if (!limits.consume("v2-transaction-x", session.identity!.xUserId, 30, 60 * 60_000)) {
          throw new V2Error(429, "RATE_LIMITED", "Too many transaction reports. Try again later.");
        }
        const body = await readJson(req);
        if (typeof body.txHash !== "string") throw new V2Error(400, "INVALID_TRANSACTION_HASH", "Transaction hash must be exactly 32 bytes.");
        const xUserId = requireSessionIdentity(session).xUserId;
        const attempt = await runMintOperation(() => {
          requireSessionIdentity(session, xUserId);
          return deps.mint!.reportTransaction(xUserId, mintTransactionMatch[1], body.txHash as string);
        });
        send(res, req, 201, "application/json; charset=utf-8", JSON.stringify({ txHash: attempt.txHash, state: attempt.state }));
        return;
      }

      const mintStatusMatch = pathname.match(MINT_STATUS_PATTERN);
      if ((method === "GET" || method === "HEAD") && mintStatusMatch) {
        if (!deps.mint) throw new V2Error(503, "CHAIN_UNAVAILABLE", "Mint status is not configured.");
        const signature = await deps.store.getSignature(mintStatusMatch[1]);
        if (!signature) throw new V2Error(409, "MINT_INELIGIBLE", "That V1 signature does not exist.");
        if (deps.mint.state.isSuppressed(signature.signatureId)) {
          sendRemovedSignature(res, req, pathname, fixtureMode);
          return;
        }
        const session = sessionFromRequest(req, deps, fixtureMode);
        const includePrivate = session?.identity?.xUserId === signature.xUserId;
        send(res, req, 200, "application/json; charset=utf-8", JSON.stringify(publicMintStatusJson(deps.mint, signature.signatureId, includePrivate)));
        return;
      }

      const devAdvanceMatch = pathname.match(DEV_MINT_ADVANCE_PATTERN);
      if (method === "POST" && devAdvanceMatch && fixtureMode && !options.localChainRehearsal) {
        if (!deps.mint?.config.enabled) throw new V2Error(503, "MINT_PAUSED", "The V2 rehearsal is disabled.");
        const session = requireV2Session(req, deps, options);
        const signature = await deps.store.getSignature(devAdvanceMatch[1]);
        if (!signature) throw new V2Error(403, "NOT_CLAIMANT", "Only the fixture claimant can advance this rehearsal.");
        await readJson(req);
        const identity = requireSessionIdentity(session, signature.xUserId);
        deps.mint.advanceFixture(signature.signatureId, identity.xUserId);
        send(res, req, 200, "application/json; charset=utf-8", JSON.stringify(publicMintStatusJson(deps.mint, signature.signatureId, true)));
        return;
      }

      const withdrawMatch = pathname.match(WITHDRAW_CLAIM_PATTERN);
      if (method === "POST" && withdrawMatch) {
        const session = sessionFromRequest(req, deps, fixtureMode);
        if (!session?.identity) throw new V2Error(401, "AUTH_REQUIRED", "Sign in with X before withdrawing your claim.");
        const xUserId = requireSessionIdentity(session).xUserId;
        if (!requireSameOrigin(req, options)) throw new V2Error(403, "INVALID_WITHDRAWAL", "The withdrawal request must come from this site.");
        const form = await readForm(req);
        if (["csrf", "claim_instance", "confirm"].some(key => form.getAll(key).length !== 1)
          || form.get("csrf") !== session.csrfToken || form.get("confirm") !== "withdraw"
          || !CLAIM_INSTANCE_PATTERN.test(form.get("claim_instance") ?? "")) {
          throw new V2Error(403, "INVALID_WITHDRAWAL", "Reload the signature and confirm withdrawal.");
        }
        const intent: SensitiveActionIntent = { kind: "claim_withdraw", signatureId: withdrawMatch[1], claimInstanceId: form.get("claim_instance")! };
        requireSessionIdentity(session, xUserId);
        if (!hasActionApproval(session, intent)) throw new V2Error(401, "X_ACTION_CONFIRMATION_REQUIRED", "Confirm withdrawal of this signature with X first.");
        if (!limits.consume("withdraw-x", xUserId, 20, 60 * 60_000)) throw new V2Error(429, "RATE_LIMITED", "Too many withdrawal requests. Try again later.");
        await runClaimWithdrawalOperation(withdrawMatch[1], () => withdrawClaim({ store: deps.store, artifacts: deps.artifacts, mintState: deps.mint?.state,
          authorize: () => { requireSessionIdentity(session, xUserId); consumeActionApproval(session, intent); },
        }, {
          signatureId: withdrawMatch[1], xUserId, claimInstanceId: intent.claimInstanceId,
        }));
        deps.auth.clearClaimNotices(withdrawMatch[1]);
        if (wantsJson(req, pathname)) send(res, req, 200, "application/json; charset=utf-8", JSON.stringify({ deleted: true, redirect: "/me" }));
        else redirect(res, 303, "/me");
        return;
      }

      const signatureMatch = pathname.match(SIGNATURE_PATTERN);
      if ((method === "GET" || method === "HEAD") && signatureMatch) {
        const signature = await deps.store.getSignature(signatureMatch[1]);
        if (!signature) {
          sendError(res, req, pathname, 404, "SIGNATURE_NOT_FOUND", "That claimed signature does not exist.", fixtureMode);
          return;
        }
        if (deps.mint?.state.isSuppressed(signature.signatureId)) {
          sendRemovedSignature(res, req, pathname, fixtureMode);
          return;
        }
        const account = await deps.store.getAccount(signature.xUserId);
        if (!account) throw new Error("Signature account is missing.");
        if (deps.mint?.state.isSuppressed(signature.signatureId)) {
          sendRemovedSignature(res, req, pathname, fixtureMode);
          return;
        }
        const mint = deps.mint ? signatureMintView(deps.mint, signature.signatureId) : undefined;
        const session = sessionFromRequest(req, deps, fixtureMode);
        const mintBinding = session?.identity?.xUserId === signature.xUserId && deps.mint
          ? deps.mint.state.getActiveBinding(signature.xUserId, deps.mint.config.chainId) : null;
        const mintRecipientVerified = Boolean(session && mintBinding && hasMintRecipient(session, signature, mintBinding));
        const withdrawal = session?.identity?.xUserId === signature.xUserId ? {
          csrfToken: session.csrfToken, claimInstanceId: signature.claimInstanceId,
          requiresXConfirmation: !hasActionApproval(session, { kind: "claim_withdraw", signatureId: signature.signatureId, claimInstanceId: signature.claimInstanceId }), allowed: deps.mint?.state.canWithdrawClaim(signature.signatureId) ?? true,
        } : undefined;
        res.setHeader("Vary", "Cookie");
        send(res, req, 200, "text/html; charset=utf-8", signaturePage(signatureView(signature, account.publicAccountId), fixtureMode, mint, originFor(req, options), options.localChainRehearsal, withdrawal, mintRecipientVerified), "private, no-store");
        return;
      }

      const artifactMatch = pathname.match(ARTIFACT_PATTERN);
      if ((method === "GET" || method === "HEAD") && artifactMatch) {
        const signature = await deps.store.getSignature(artifactMatch[1]);
        if (!signature) {
          sendError(res, req, pathname, 404, "SIGNATURE_NOT_FOUND", "That claimed signature does not exist.", fixtureMode);
          return;
        }
        if (deps.mint?.state.isSuppressed(signature.signatureId)) {
          sendRemovedSignature(res, req, pathname, fixtureMode);
          return;
        }
        const extension = artifactMatch[2];
        const bytes = await deps.artifacts.get(extension === "svg" ? signature.svgStorageKey : signature.cardStorageKey);
        if (!bytes) throw new Error("Claimed artifact is unavailable.");
        if (deps.mint?.state.isSuppressed(signature.signatureId)) {
          sendRemovedSignature(res, req, pathname, fixtureMode);
          return;
        }
        const expectedHash = extension === "svg" ? signature.svgSha256 : signature.pngSha256;
        if (sha256Hex(bytes) !== expectedHash) throw new RendererIntegrityError();
        res.setHeader("ETag", `"sha256-${expectedHash}"`);
        send(res, req, 200, extension === "svg" ? "image/svg+xml" : "image/png", bytes, "no-store");
        return;
      }

      if ((method === "GET" || method === "HEAD") && pathname === "/me") {
        const session = sessionFromRequest(req, deps, fixtureMode);
        if (!session || !session.identity) {
          send(res, req, 401, "text/html; charset=utf-8", signInRequiredPage(fixtureMode, localOAuthMode, options.localChainRehearsal, undefined, originFor(req, options)));
          return;
        }
        const account = await deps.store.getAccount(session.identity.xUserId);
        const signatures = (await deps.store.listSignaturesForAccount(session.identity.xUserId))
          .filter((signature) => !deps.mint?.state.isSuppressed(signature.signatureId));
        const views = signatures.map((signature) => signatureView(signature, account?.publicAccountId ?? "xa1_unclaimed"));
        const binding = deps.mint ? deps.mint.state.getActiveBinding(session.identity.xUserId, deps.mint.config.chainId) : null;
        const mintBySignature = new Map(signatures.map((signature) => {
          const status = deps.mint?.state.getStatus(signature.signatureId, true);
          const projection = status?.projection;
          let state: string = projection?.state ?? "unminted";
          let label = deps.mint ? mintStateLabel(deps.mint, projection?.state ?? "unminted") : "Not minted";
          if (projection?.state === "unminted" && status?.authorization?.status === "signing_unknown") {
            state = "signing_unknown";
            label = "Authorization reconciliation required";
          } else if (projection?.state === "unminted" && status?.authorization?.status === "prepared") {
            state = "prepared";
            label = "Authorization preparation pending";
          }
          const explorer = deps.mint?.config.explorerBaseUrl;
          const txHash = projection?.txHash ?? null;
          const contract = projection?.contract ?? null;
          const tokenId = projection?.tokenId?.toString() ?? null;
          return [signature.signatureId, {
            state,
            label,
            txHash,
            currentTokenHolder: projection?.currentTokenHolder ?? null,
            tokenId,
            explorerTransactionUrl: explorer && txHash ? `${explorer}/tx/${txHash}` : null,
            explorerTokenUrl: explorer && contract && tokenId ? `${explorer}/token/${contract}?a=${encodeURIComponent(tokenId)}` : null,
          }];
        }));
        send(res, req, 200, "text/html; charset=utf-8", collectionPage({
          currentHandle: account?.currentHandle ?? session.identity.username,
          signatures: views,
          csrfToken: session.csrfToken,
          fixtureMode,
          mintEnabled: deps.mint?.config.enabled ?? false,
          mintChainId: deps.mint?.config.chainId.toString() ?? "",
          wallet: binding && deps.mint ? { address: binding.address, chainName: deps.mint.config.chainName, chainId: binding.chainId.toString(), provedAt: binding.provedAt } : null,
          mintBySignature,
          localOAuthMode,
          ...walletConfirmationView(session, deps),
          localChainRehearsal: options.localChainRehearsal,
          publicOrigin: originFor(req, options),
        }));
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
      if (error instanceof InputError) sendError(res, req, pathname, 400, error.code, error.message, fixtureMode, localOAuthMode);
      else if (error instanceof V2Error) sendError(res, req, pathname, error.status, error.code, error.message, fixtureMode, localOAuthMode);
      else if (error instanceof RendererIntegrityError) sendError(res, req, pathname, 500, "RENDERER_INTEGRITY_ERROR", error.message, fixtureMode, localOAuthMode);
      else if (error instanceof RendererUnavailableError) sendError(res, req, pathname, 500, "RENDER_FAILED", error.message, fixtureMode, localOAuthMode);
      else sendError(res, req, pathname, 500, "RENDER_FAILED", "The request could not be rendered safely.", fixtureMode, localOAuthMode);
    }
  };
}

export function startServer(deps: AppDependencies, port: number, options: AppOptions = {}) {
  const server = createServer(createApp(deps, options));
  server.listen(port, "127.0.0.1");
  return server;
}
