import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fields, PublicError } from "../security.js";
import { PRIVATE_ROBOTS } from "../sharing.js";
import { IssuanceBlockedError } from "./authorizations.js";
import { AdmissionBlockedError } from "./repository.js";
import { DurableMintRuntime } from "./runtimeService.js";

const posts = new Set(["/api/wallet/challenge", "/api/wallet/verify", "/api/session/logout", "/api/assessments", "/api/mints/authorize"]);
const statusPath = /^\/api\/assessments\/([A-Za-z0-9_-]{43})$/;
const loopback = (ip: string | undefined) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new PublicError(415, "JSON_REQUIRED", "Use a JSON request.");
  if (req.headers["content-encoding"] !== undefined) throw new PublicError(415, "ENCODING_UNSUPPORTED", "Compressed requests are not accepted.");
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > 8192)) throw new PublicError(413, "REQUEST_TOO_LARGE", "Request is too large.");
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.from(raw); size += chunk.length;
    if (size > 8192) throw new PublicError(413, "REQUEST_TOO_LARGE", "Request is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new PublicError(400, "INVALID_JSON", "Invalid JSON request."); }
}
function publicFailure(error: unknown): { status: number; code: string; error: string } {
  if (error instanceof PublicError) return { status: error.status, code: error.code, error: error.message };
  if (error instanceof AdmissionBlockedError) return { status: 503, code: "ASSESSMENT_ADMISSION_CLOSED", error: "New assessments are unavailable. Saved work is preserved." };
  if (error instanceof IssuanceBlockedError) {
    const allowed: Record<string, [number, string]> = {
      CONSENT_REQUIRED: [400, "Choose Mint & reveal to continue."], SESSION_REQUIRED: [403, "Refresh this page and reconnect your wallet."],
      NOT_FOUND: [404, "Signature request not found."], REQUEST_EXPIRED: [410, "This request expired. Saved work is preserved."],
      WALLET_CHANGED: [409, "Your wallet changed. Reconnect it before continuing."], WALLET_PROOF_REQUIRED: [403, "Reconnect your wallet before continuing."],
      NOT_READY: [409, "The saved signature is not ready to mint."], MINT_RESERVED: [409, "This handle has a preserved mint reservation. Operator review is required."],
      AUTHORIZATION_EXPIRED: [409, "The mint authorization expired. Its reservation is preserved for review."],
      SIGNING_UNCERTAIN: [409, "The signing result needs operator review. No new signature will be requested automatically."],
      ISSUANCE_DISABLED: [503, "Mint authorization is unavailable. Saved work is preserved."],
      CHAIN_UNAVAILABLE: [503, "Mint eligibility cannot be verified right now."],
    };
    const known = allowed[error.code];
    if (known) return { status: known[0], code: error.code, error: known[1] };
  }
  return { status: 503, code: "SERVICE_UNAVAILABLE", error: "This operation is unavailable. Saved work is preserved; no automatic retry will occur." };
}

/** Loopback-only integration server, not the public/staging entrypoint. It
 * intentionally has no pages, preview/provider APIs, dev controls, raw artifact
 * reads, transaction broadcaster or user-controlled deployment/MBTI fields.
 */
export function createDurableMintApiServer(runtime: DurableMintRuntime) {
  if (process.env.NODE_ENV === "production" || runtime.requests.repository.namespace.profile !== "local-real"
    || runtime.requests.profile.chain_id !== "31337") throw new Error("Public durable HTTP startup remains disabled.");
  const origin = runtime.sessions.origin, host = new URL(origin).host;
  let active = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", PRIVATE_ROBOTS);
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (active >= 32) { req.resume(); return json(res, 503, { code: "BUSY", error: "Please try again later." }); }
    active++;
    // Bound body streaming too; requestTimeout alone does not protect direct
    // request-listener composition or a peer trickling chunks forever.
    const bodyTimer = setTimeout(() => req.destroy(), 10000);
    try {
      if (!loopback(req.socket.remoteAddress) || !loopback(req.socket.localAddress)) throw new PublicError(403, "LOCAL_ONLY", "This integration server is local only.");
      if (req.headers.host !== host) throw new PublicError(421, "WRONG_HOST", "Open the configured site address.");
      if (req.headers.forwarded !== undefined || Object.keys(req.headers).some(key => key.startsWith("x-forwarded-"))) throw new PublicError(400, "PROXY_UNSUPPORTED", "Proxy headers are not accepted by this local integration server.");
      const path = req.url ?? "/";
      const status = statusPath.exec(path), method = req.method;
      if (method !== "GET" && method !== "POST") throw new PublicError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      if (!(method === "GET" ? path === "/api/session" || !!status : posts.has(path))) throw new PublicError(404, "NOT_FOUND", "Endpoint not found.");
      if (method === "GET" && (req.headers["transfer-encoding"] || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0"))) throw new PublicError(400, "INVALID_INPUT", "GET requests must not include a body.");
      if (method === "GET") {
        clearTimeout(bodyTimer);
        if (path === "/api/session") {
          const found = await runtime.sessions.session(req.headers.cookie);
          if (found.created) res.setHeader("Set-Cookie", runtime.sessions.cookie(found.session));
          return json(res, 200, runtime.sessionView(found.session));
        }
        const session = await runtime.sessions.requireSession(req.headers.cookie);
        return json(res, 200, await runtime.status(status![1], session));
      }
      const input = await readBody(req); clearTimeout(bodyTimer);
      const session = await runtime.sessions.requireSession(req.headers.cookie);
      const csrf = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined;
      await runtime.sessions.authorizePost(session.id, req.headers.origin, csrf);
      const intent = { session, origin: req.headers.origin, csrf };
      if (path === "/api/wallet/challenge") {
        const payload = fields(input, ["address"], ["code"]);
        if (payload.code !== undefined) {
          if (typeof payload.code !== "string") throw new PublicError(400, "INVALID_INPUT", "Invalid request code.");
          await runtime.requests.get(payload.code, session.id);
        }
        return json(res, 200, await runtime.sessions.challenge(session.id, payload.address, payload.code as string | undefined));
      }
      if (path === "/api/wallet/verify") {
        const payload = fields(input, ["challengeId", "signature"]);
        await runtime.sessions.verify(session.id, payload.challengeId, payload.signature);
        return json(res, 200, runtime.sessionView(await runtime.sessions.requireSession(req.headers.cookie)));
      }
      if (path === "/api/session/logout") {
        fields(input, []); await runtime.sessions.logout(session.id);
        res.setHeader("Set-Cookie", `sg_open_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${origin.startsWith("https:") ? "; Secure" : ""}`);
        return json(res, 200, { ok: true });
      }
      if (path === "/api/assessments") { const payload = fields(input, ["handle"]); return json(res, 202, await runtime.create(payload.handle, intent)); }
      const payload = fields(input, ["code", "consent"]);
      return json(res, 200, await runtime.authorize(payload.code, payload.consent, intent));
    } catch (error) {
      // Never serialize a provider, database, signer or RPC error/cause.
      const failure = publicFailure(error); json(res, failure.status, { code: failure.code, error: failure.error });
      req.resume();
    } finally { clearTimeout(bodyTimer); active--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 64;
  return server;
}
