import { canonicalHandle, handleDigest, preservedHandle } from "./identity.js";

export const X_USER_LOOKUP_ENDPOINT = "https://api.x.com/2/users/by/username/";
export const X_IDENTITY_MAX_RESPONSE_BYTES = 64 * 1024;
export interface XIdentitySnapshot {
  readonly canonicalHandle: string;
  readonly username: string;
  /** Evidence binding only. Token uniqueness remains the literal lowercase handle. */
  readonly userId: string;
  readonly verifiedAt: string;
  readonly provenance: "x-api" | "development-fixture";
  readonly freshness: "verified-at-preparation";
}
export interface XIdentityResolver {
  readonly provenance: XIdentitySnapshot["provenance"];
  resolve(handle: string): Promise<XIdentitySnapshot>;
}

export function validateXIdentity(value: unknown, expectedHandle: string): XIdentitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid X identity snapshot.");
  const record = value as Record<string, unknown>;
  const fields = ["canonicalHandle", "username", "userId", "verifiedAt", "provenance", "freshness"];
  if (Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field))) throw new Error("Invalid X identity fields.");
  if (record.canonicalHandle !== canonicalHandle(expectedHandle) || preservedHandle(record.username) !== record.username
    || canonicalHandle(record.username) !== record.canonicalHandle) throw new Error("X username does not match the requested handle.");
  if (typeof record.userId !== "string" || !/^[1-9][0-9]{0,19}$/.test(record.userId)) throw new Error("Invalid X account identifier.");
  if (typeof record.verifiedAt !== "string" || !Number.isFinite(Date.parse(record.verifiedAt)) || new Date(record.verifiedAt).toISOString() !== record.verifiedAt) throw new Error("Invalid X identity timestamp.");
  if (!["x-api", "development-fixture"].includes(String(record.provenance)) || record.freshness !== "verified-at-preparation") throw new Error("Invalid X identity provenance or freshness policy.");
  return Object.freeze({ ...record }) as unknown as XIdentitySnapshot;
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > X_IDENTITY_MAX_RESPONSE_BYTES)) {
    await response.body?.cancel(); throw new Error("X lookup response exceeds size limit.");
  }
  if (!response.body) throw new Error("X lookup returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, body = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > X_IDENTITY_MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("X lookup response exceeds size limit."); }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(body); } catch { throw new Error("X lookup returned invalid JSON."); }
}

/** Official X API app-only lookup; one request, fixed endpoint, no retries or fallback. */
export class XApiIdentityResolver implements XIdentityResolver {
  readonly provenance = "x-api" as const;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  constructor(options: { bearerToken: string; fetch?: typeof fetch; now?: () => Date; timeoutMs?: number }) {
    if (typeof options.bearerToken !== "string" || !options.bearerToken.trim() || /\s/.test(options.bearerToken)) throw new Error("A valid server X bearer token is required.");
    this.#token = options.bearerToken;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) throw new Error("Invalid X lookup timeout.");
  }
  async resolve(value: string): Promise<XIdentitySnapshot> {
    const handle = canonicalHandle(value);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("X username verification timed out.")); }, this.#timeoutMs);
    });
    const request = async () => {
      let response: Response;
      try {
        response = await this.#fetch(`${X_USER_LOOKUP_ENDPOINT}${handle}`, {
          method: "GET", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
        });
      } catch { throw new Error(controller.signal.aborted ? "X username verification timed out." : "X username verification transport failed."); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`X username verification failed (HTTP ${response.status}).`); }
      const payload = await boundedJson(response) as { data?: { id?: unknown; username?: unknown }; errors?: unknown } | null;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.errors !== undefined || !payload.data
        || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new Error("X username verification did not return an unambiguous user.");
      return validateXIdentity({ canonicalHandle: handle, username: payload.data.username, userId: payload.data.id,
        verifiedAt: this.#now().toISOString(), provenance: this.provenance, freshness: "verified-at-preparation" }, handle);
    };
    try { return await Promise.race([request(), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
}

/** Explicit fixture only. It cannot claim X verification and is never a transport fallback. */
export class DevelopmentXIdentityResolver implements XIdentityResolver {
  readonly provenance = "development-fixture" as const;
  constructor(readonly usernames: Readonly<Record<string, string>> = {}, readonly now: () => Date = () => new Date()) {}
  async resolve(value: string): Promise<XIdentitySnapshot> {
    const handle = canonicalHandle(value);
    return validateXIdentity({ canonicalHandle: handle, username: this.usernames[handle] ?? handle,
      userId: String(BigInt(handleDigest(handle)) % 9_000_000_000_000_000_000n + 1n), verifiedAt: this.now().toISOString(),
      provenance: this.provenance, freshness: "verified-at-preparation" }, handle);
  }
}
