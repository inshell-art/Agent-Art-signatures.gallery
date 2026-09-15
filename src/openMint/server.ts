import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SITE_CSS } from "../v1/siteCss.js";
import { SITE_FONT_CSS, siteFontAsset } from "../v1/fonts.js";
import { FAVICON_SVG, FAVICON_URL } from "../brand/favicon.js";
import { formalSignatureRenderer, sha256Hex } from "../v1/renderer.js";
import { canonicalHandle, handleDigest, isMbti, preservedHandle, RENDERER_VERSION, seedForMbti } from "./identity.js";
import { OPEN_MINT_CLIENT_SCRIPT } from "./clientScript.js";
import { OPEN_MINT_CSS, aboutPage, assessmentPage, collectionPage, errorPage, homePage, mintPage, previewPage, previewVariationsPage, type AssessmentPageModel, type GalleryEntry, type OpenMintPageOptions } from "./pages.js";
import { fields, PublicError, WalletSessions, type SiteSession } from "./security.js";
import { OpenMintService, type SignatureArtifact, type SignatureRequest } from "./service.js";

export interface OpenMintServerOptions {
  origin: string; fixture: boolean; service: OpenMintService; sessions: WalletSessions;
  rpcUrl?: string;
  devWallet?: (session: SiteSession, code?: string) => Promise<string>;
  devMint?: (session: SiteSession, code: string, consent: unknown) => Promise<unknown>;
}
const css = `${SITE_FONT_CSS}\n${SITE_CSS}\n${OPEN_MINT_CSS}`;
const cssUrl = `/assets/open-mint-${sha256Hex(Buffer.from(css)).slice(0, 16)}.css`;
const scriptUrl = `/assets/open-mint-${sha256Hex(Buffer.from(OPEN_MINT_CLIENT_SCRIPT)).slice(0, 16)}.js`;
const faviconPath = new URL(FAVICON_URL, "http://127.0.0.1").pathname;

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new PublicError(415, "JSON_REQUIRED", "Use a JSON request.");
  let size = 0; const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.from(raw); size += chunk.length;
    if (size > 8192) throw new PublicError(413, "REQUEST_TOO_LARGE", "Request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PublicError(400, "INVALID_JSON", "Invalid JSON request."); }
}
function send(res: ServerResponse, status: number, content: string | Uint8Array, type = "text/html; charset=utf-8"): void {
  res.statusCode = status; res.setHeader("Content-Type", type); res.end(content);
}
function json(res: ServerResponse, content: unknown, status = 200): void { send(res, status, JSON.stringify(content), "application/json; charset=utf-8"); }

export function createOpenMintServer(options: OpenMintServerOptions) {
  const { service, sessions } = options;
  const origin = new URL(options.origin);
  const rates = new Map<string, { start: number; count: number }>();
  const preparationWalletVerified = (session: SiteSession): boolean => service.walletVerified(session) && session.walletProof?.code === undefined;
  const pageOptions = (session: SiteSession): OpenMintPageOptions => ({
    csrfToken: session.csrf, wallet: session.wallet, walletVerified: preparationWalletVerified(session), chainId: String(service.network?.chainId ?? 31337),
    chainName: "Local Anvil", contract: service.network?.address, rpcUrl: options.rpcUrl,
    publicOrigin: options.origin, stylesheetUrl: cssUrl, clientScriptUrl: scriptUrl,
    development: { fixture: options.fixture, localChain: !!options.devWallet,
      notes: ["Open-mint development build. The earlier X-claim application and its data are separate.",
        "MBTI currently selects a fixed seed for the locked v1.0.0 renderer; it is not a new renderer.",
        ...(!service.options.assessments ? ["Set XAI_API_KEY to enable real assessments, or explicitly use dev:fixture for simulated results."] : []),
        ...(!service.network ? ["Minting is disabled until the isolated local chain is started."] : ["Artifacts are stored locally, not pinned to a public storage network. These tokens are for local testing only."])],
    },
  });
  const artifactFields = (artifact: SignatureArtifact) => ({ renderHandle: artifact.renderHandle ?? artifact.assessment.handle, mbti: artifact.assessment.mbti, gr0kRaw: artifact.assessment.seed,
    imageUrl: `/artifacts/${artifact.pngSha256}.png`, svgUrl: `/artifacts/${artifact.svgSha256}.svg`,
    rendererVersion: artifact.assessment.rendererVersion, svgSha256: artifact.svgSha256, pngSha256: artifact.pngSha256,
    assessedAt: artifact.assessment.createdAt, sourceLabel: artifact.assessment.provenance === "development-fixture" ? "Development fixture" : "Grok · independent X Search assessment" });
  const model = async (request: SignatureRequest, session: SiteSession): Promise<AssessmentPageModel> => {
    const mint = await service.state(request.handle);
    // This is a UI reveal, not cryptographic secrecy: mint calldata already binds the artifact.
    // Never send an unminted result to the progress UI or its polling endpoint.
    const artifact = mint.state === "minted" ? await service.artifact(request.handle) : undefined;
    return { handle: request.handle, renderHandle: request.requestedHandle ?? request.handle, code: request.code, status: request.status, tokenId: BigInt(handleDigest(request.handle)).toString(), canMint: service.canMint(request, session),
      walletProvedForCode: await service.walletProved(request.code, session), requestExpired: request.expiresAt <= service.now(), error: request.error,
      ...(artifact ? artifactFields(artifact) : {}), mint };
  };
  const entries = async (session?: SiteSession): Promise<GalleryEntry[]> => (await service.gallery(session?.wallet)).map(({ artifact, mint }) => ({
    handle: artifact.assessment.handle, renderHandle: artifact.renderHandle ?? artifact.assessment.handle, code: "", mbti: artifact.assessment.mbti, imageUrl: `/artifacts/${artifact.pngSha256}.png`, url: `/signatures/${artifact.assessment.handle}`, mint,
  }));

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'${options.rpcUrl ? ` ${new URL(options.rpcUrl).origin}` : ""}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    let session: SiteSession | undefined;
    try {
      if (req.headers.host !== origin.host) throw new PublicError(421, "WRONG_HOST", "Open the configured site address.");
      const url = new URL(req.url ?? "/", options.origin);
      if (url.origin !== options.origin) throw new PublicError(400, "INVALID_URL", "Invalid request URL.");
      if (!["GET", "POST"].includes(req.method ?? "")) throw new PublicError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      const path = url.pathname;
      if (req.method === "GET") {
        const previewAsset = /^\/preview\/([A-Za-z0-9_]{1,15})\/([A-Z]{4})\.svg$/.exec(path);
        if (previewAsset) {
          const mbti = previewAsset[2]!;
          if (!isMbti(mbti)) throw new PublicError(404, "NOT_FOUND", "Unknown MBTI type.");
          const svg = formalSignatureRenderer.render({ handle: previewAsset[1]!, gr0kRaw: seedForMbti(mbti), gr0kScale: 1, rendererVersion: RENDERER_VERSION }).svgUtf8;
          res.setHeader("Cache-Control", "public, max-age=300");
          res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
          return send(res, 200, svg, "image/svg+xml");
        }
        const font = siteFontAsset(path);
        if (path === cssUrl || path === scriptUrl || path === faviconPath || font) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (font) return send(res, 200, font.bytes, font.contentType);
          if (path === faviconPath) return send(res, 200, FAVICON_SVG, "image/svg+xml");
          return send(res, 200, path === cssUrl ? css : OPEN_MINT_CLIENT_SCRIPT, path === cssUrl ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
        }
        const asset = /^\/artifacts\/([a-f0-9]{64})\.(png|svg|json)$/.exec(path);
        if (asset) {
          const bytes = await service.asset(asset[1]!, asset[2]!);
          if (!bytes) throw new PublicError(404, "NOT_FOUND", "Artwork not found.");
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
          return send(res, 200, bytes, asset[2] === "png" ? "image/png" : asset[2] === "svg" ? "image/svg+xml" : "application/json");
        }
      }
      const found = sessions.session(req.headers.cookie); session = found.session;
      if (found.created) res.setHeader("Set-Cookie", sessions.cookie(session));
      if (req.method === "POST") {
        sessions.authorizePost(session, req.headers.origin, typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined);
        const now = Date.now();
        for (const [key, rate] of rates) if (now - rate.start > 60_000) rates.delete(key);
        const ip = req.socket.remoteAddress ?? "unknown";
        const rate = rates.get(ip) ?? { start: now, count: 0 };
        rates.set(ip, rate);
        if (++rate.count > 60) throw new PublicError(429, "RATE_LIMIT", "Too many requests. Please wait a minute.");
        const input = await body(req);
        if (path === "/api/assessments") {
          const payload = fields(input, ["handle"]);
          try {
            const request = await service.request(payload.handle, session);
            return json(res, { url: `/mint/${request.code}`, code: request.code, handle: request.handle, tokenId: BigInt(handleDigest(request.handle)).toString(), status: request.status }, 202);
          } catch (error) {
            if (error instanceof PublicError && error.code === "ALREADY_MINTED") return json(res, { error: error.message, code: error.code, url: `/signatures/${canonicalHandle(payload.handle)}` }, error.status);
            throw error;
          }
        }
        if (path === "/api/wallet/challenge") {
          const payload = fields(input, ["address"], ["code"]);
          if (payload.code !== undefined) await service.ownedRequest(payload.code, session);
          return json(res, sessions.challenge(session, payload.address, payload.code as string | undefined));
        }
        if (path === "/api/wallet/verify") { const payload = fields(input, ["challengeId", "signature"]); return json(res, { wallet: await sessions.verify(session, payload.challengeId, payload.signature) }); }
        if (path === "/api/mints/authorize") { const payload = fields(input, ["code", "consent"]); return json(res, await service.authorize(payload.code, payload.consent, session)); }
        if (path === "/api/mints/report") { const payload = fields(input, ["code", "transactionHash"]); await service.report(payload.code, payload.transactionHash, session); return json(res, { ok: true }); }
        if (path === "/api/session/logout") { fields(input, []); sessions.logout(session); res.setHeader("Set-Cookie", "sg_open_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); return json(res, { ok: true }); }
        if (path === "/api/dev/wallet" && options.devWallet) { const payload = fields(input, [], ["code"]); if (payload.code !== undefined) await service.ownedRequest(payload.code, session); return json(res, { wallet: await options.devWallet(session, payload.code as string | undefined) }); }
        if (path === "/api/dev/mint" && options.devMint) { const payload = fields(input, ["code", "consent"]); await service.ownedRequest(payload.code, session); return json(res, await options.devMint(session, String(payload.code), payload.consent)); }
        throw new PublicError(404, "NOT_FOUND", "Endpoint not found.");
      }
      if (path === "/api/session") return json(res, { csrfToken: session.csrf, wallet: session.wallet ?? null, walletVerified: preparationWalletVerified(session), chainId: String(service.network?.chainId ?? 31337), chainName: "Local Anvil", rpcUrl: options.rpcUrl });
      if (path === "/api/wallet/context") {
        if ([...url.searchParams.keys()].some(key => key !== "address") || url.searchParams.getAll("address").length > 1) throw new PublicError(400, "INVALID_REQUEST", "Only one optional wallet address is accepted.");
        return json(res, await service.walletContext(url.searchParams.has("address") ? url.searchParams.get("address") : undefined));
      }
      const status = /^\/api\/assessments\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (status) return json(res, await model(await service.sessionRequest(status[1], session), session));
      const mintStatus = /^\/api\/mints\/status\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (mintStatus) return json(res, await service.state((await service.sessionRequest(mintStatus[1], session)).handle));
      if (path === "/") return send(res, 200, homePage(pageOptions(session), await entries()));
      if (path === "/me") return send(res, 200, collectionPage(session.wallet ? await entries(session) : [], pageOptions(session)));
      if (path === "/about") return send(res, 200, aboutPage(pageOptions(session)));
      if (path === "/mint") {
        let handle = "";
        try { if (url.searchParams.has("handle")) handle = preservedHandle(url.searchParams.get("handle")); }
        catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
        return send(res, 200, mintPage(handle, pageOptions(session)));
      }
      const mintRequest = /^\/mint\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (mintRequest) {
        const request = await service.sessionRequest(mintRequest[1], session);
        const view = await model(request, session);
        if (view.mint?.state === "minted") { res.setHeader("Location", `/signatures/${request.handle}`); return send(res, 303, ""); }
        return send(res, 200, assessmentPage(view, pageOptions(session)));
      }
      const preview = /^\/s\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      if (preview) {
        let spelling: string;
        try { spelling = preservedHandle(decodeURIComponent(preview[1]!)); } catch { throw new PublicError(404, "NOT_FOUND", "Invalid signature handle."); }
        if (!preview[2]) { res.setHeader("Location", `/mint?handle=${spelling}`); return send(res, 303, ""); }
        if (preview[2] === "variations") {
          if (preview[1] !== spelling) { res.setHeader("Location", `/s/${spelling}/variations`); return send(res, 303, ""); }
          return send(res, 200, previewVariationsPage(spelling, pageOptions(session)));
        }
        const mbti = preview[2].toUpperCase();
        if (!isMbti(mbti)) throw new PublicError(404, "NOT_FOUND", "Use a four-letter MBTI type, such as ENFP.");
        if (preview[2] !== mbti || preview[1] !== spelling) { res.setHeader("Location", `/s/${spelling}/${mbti}`); return send(res, 303, ""); }
        return send(res, 200, previewPage(spelling, mbti, pageOptions(session)));
      }
      const permalink = /^\/signatures\/([A-Za-z0-9_]{1,15})$/.exec(path);
      if (permalink) {
        const artifact = await service.artifact(permalink[1]!);
        if (!artifact) throw new PublicError(404, "NOT_FOUND", "Signature not found.");
        const mint = await service.state(artifact.assessment.handle);
        if (mint.state !== "minted") throw new PublicError(404, "NOT_FOUND", "This signature has not been minted yet.");
        return send(res, 200, assessmentPage({ handle: artifact.assessment.handle, code: "", status: "ready", canMint: false, ...artifactFields(artifact), mint }, pageOptions(session)));
      }
      throw new PublicError(404, "NOT_FOUND", "Page not found. Start a new signature request from the gallery.");
    } catch (error) {
      const known = error instanceof PublicError;
      const status = known ? error.status : 503;
      const message = known ? error.message : "This operation is temporarily unavailable. Please try again shortly.";
      if ((req.url ?? "").startsWith("/api/")) json(res, { error: message, code: known ? error.code : "SERVICE_UNAVAILABLE" }, status);
      else send(res, status, errorPage(message, session ? pageOptions(session) : { stylesheetUrl: cssUrl, clientScriptUrl: scriptUrl }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
