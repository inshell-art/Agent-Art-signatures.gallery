import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { OPEN_MINT_ABI, normalizeOpenMintAuthorization } from "../authorization.js";
import { canonicalHandle, handleDigest, preservedHandle } from "../identity.js";
import { preparePublicArtifact } from "../publicArtifacts.js";
import { publishPublicArtifact } from "../publicPublication.js";
import { isCode, PublicError } from "../security.js";
import { PostgresAssessmentWorker } from "./assessmentWorker.js";
import { PostgresAuthorizationIssuer, type ReservedAuthorizationSigner } from "./authorizations.js";
import { PostgresPublicationJournal } from "./publication.js";
import { PostgresMintRequests, type DurableMintRequest } from "./requests.js";
import { capabilityHash, PostgresWalletSessions, type DurableSiteSession } from "./sessions.js";

export interface RuntimeIntent {
  readonly session: DurableSiteSession;
  readonly origin: string | undefined;
  readonly csrf: string | undefined;
}
export interface RuntimeEligibilityInput { readonly handle: string; readonly recipient: Address; readonly nonce: Hex }
type Publication = Pick<Parameters<typeof publishPublicArtifact>[0], "uploader" | "reader" | "timeoutMs">;
export interface DurableRuntimeOptions {
  readonly sessions: PostgresWalletSessions;
  readonly requests: PostgresMintRequests;
  readonly worker: PostgresAssessmentWorker;
  readonly journal: PostgresPublicationJournal;
  readonly issuer: PostgresAuthorizationIssuer;
  readonly signer: ReservedAuthorizationSigner;
  /** Must use the pinned backend chain gate; a serialized witness is rejected. */
  readonly eligibility: (input: RuntimeEligibilityInput, signal: AbortSignal) => Promise<unknown>;
  readonly eligibilityTimeoutMs: number;
  readonly publication: Publication;
}

function context(input: RuntimeIntent) {
  return { sessionToken: input.session.id, sessionGeneration: input.session.generation, origin: input.origin, csrf: input.csrf };
}
function proof(session: DurableSiteSession, now: number): boolean {
  return !!session.wallet && session.walletProof?.wallet === session.wallet && session.walletProof.expiresAt > now && session.expiresAt > now;
}
function parseHandle(value: unknown): string {
  try { return preservedHandle(value); }
  catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
}
function parseCode(value: unknown): string {
  if (!isCode(value)) throw new PublicError(404, "NOT_FOUND", "Signature request not found.");
  return value;
}

/** Integrates the durable components without activating public startup. Only
 * explicit POST intent starts work. There is no restart queue pump or retry.
 * One bounded preparation runs at a time; PostgreSQL owns the durable fences.
 */
export class DurableMintRuntime {
  readonly sessions: PostgresWalletSessions;
  readonly requests: PostgresMintRequests;
  readonly #worker: PostgresAssessmentWorker;
  readonly #journal: PostgresPublicationJournal;
  readonly #issuer: PostgresAuthorizationIssuer;
  readonly #signer: ReservedAuthorizationSigner;
  readonly #eligibility: DurableRuntimeOptions["eligibility"];
  readonly #eligibilityTimeoutMs: number;
  readonly #publication: Publication;
  readonly #tasks = new Map<string, Promise<void>>();
  #creating = false;
  #draining = false;
  constructor(options: DurableRuntimeOptions) {
    const { sessions, requests, worker, journal, issuer, signer } = options, { repository } = requests;
    if (repository.namespace.profile !== "local-real" || repository.namespace.provenance !== "grok" || requests.profile.chain_id !== "31337"
      || sessions.writer !== repository.writer || sessions.namespaceId !== repository.namespace.id || sessions.origin !== requests.profile.origin
      || String(sessions.chainId) !== requests.profile.chain_id || worker.requests !== requests || issuer.requests !== requests
      || issuer.journal !== journal || journal.writer !== repository.writer || journal.namespaceId !== repository.namespace.id
      || journal.origin !== sessions.origin || getAddress(signer.address) !== getAddress(requests.profile.authorizer)) {
      throw new Error("Durable HTTP integration requires matching isolated local components; public startup remains disabled.");
    }
    if (!Number.isSafeInteger(options.eligibilityTimeoutMs) || options.eligibilityTimeoutMs < 1 || options.eligibilityTimeoutMs > 30000) throw new Error("Invalid eligibility deadline.");
    this.sessions = sessions; this.requests = requests; this.#worker = worker; this.#journal = journal; this.#issuer = issuer;
    this.#signer = Object.freeze({ address: signer.address, signTypedData: signer.signTypedData.bind(signer) });
    this.#eligibility = options.eligibility; this.#eligibilityTimeoutMs = options.eligibilityTimeoutMs;
    const { uploader, reader, timeoutMs } = options.publication;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid publication deadline.");
    this.#publication = Object.freeze({ timeoutMs, uploader: Object.freeze({ id: uploader.id, upload: uploader.upload.bind(uploader) }),
      reader: Object.freeze({ id: reader.id, retrieve: reader.retrieve.bind(reader) }) });
  }
  #available(): void {
    if (this.#draining) throw new PublicError(503, "SERVICE_DRAINING", "The service is restarting. Saved work is preserved.");
    this.requests.repository.writer.assertHealthy();
  }
  async #observe(input: RuntimeEligibilityInput): Promise<unknown> {
    this.#available();
    const controller = new AbortController(), end = performance.now() + this.#eligibilityTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      this.#available();
      if (controller.signal.aborted || performance.now() >= end) throw new Error("Eligibility deadline exceeded.");
    };
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Eligibility timed out.")); }, this.#eligibilityTimeoutMs); });
      const witness = await Promise.race([Promise.resolve().then(() => { check(); return this.#eligibility(Object.freeze({ ...input }), controller.signal); }), timeout]);
      check(); return witness;
    } catch {
      throw new PublicError(503, "CHAIN_UNAVAILABLE", "Mint eligibility cannot be verified right now. No new assessment or signature was requested.");
    } finally { clearTimeout(timer); controller.abort(); }
  }
  sessionView(session: DurableSiteSession) {
    return { csrfToken: session.csrf, wallet: session.wallet ?? null,
      walletVerified: proof(session, Date.now()) && !session.walletProof?.codeHash,
      walletProofExpiresAt: session.walletProof?.expiresAt, serverNow: Date.now(), chainId: this.requests.profile.chain_id, chainName: "Local Anvil" };
  }
  async create(value: unknown, intent: RuntimeIntent) {
    const handle = parseHandle(value), canonical = canonicalHandle(handle), captured = context(intent);
    this.#available();
    if (!proof(intent.session, Date.now()) || intent.session.walletProof?.codeHash) throw new PublicError(403, "WALLET_PROOF_REQUIRED", "Connect your wallet before preparing a mint.");
    if (this.#creating || (this.#tasks.size > 0 && !this.#tasks.has(canonical))) throw new PublicError(429, "BUSY", "Another preparation is in progress. Please wait.");
    this.#creating = true;
    try {
      const witness = await this.#observe({ handle: canonical, recipient: intent.session.wallet!, nonce: `0x${randomBytes(32).toString("hex")}` });
      const request = await this.requests.create({ ...captured, recipient: intent.session.wallet!, handle, eligibility: witness });
      this.#available();
      if (!this.#tasks.has(canonical) && ["pending-assessment", "assessment-accepted"].includes(request.status)) {
        const task = Promise.resolve().then(async () => {
          this.#available();
          const result = await this.#worker.run({ ...captured, code: request.code, eligibility: witness });
          if (result.kind !== "accepted") return;
          this.#available();
          const artifact = await this.#journal.load(canonical) ?? await preparePublicArtifact({ assessment: result.assessment, origin: this.sessions.origin });
          this.#available();
          if (!await this.#journal.load(canonical, true)) await publishPublicArtifact({ ...this.#publication, artifact, journal: this.#journal });
        }).catch(() => {
          // The durable attempt/receipt/publication/reservation records own the
          // outcome. Do not log provider bodies or fabricate completion/retry.
        }).finally(() => { this.#tasks.delete(canonical); });
        this.#tasks.set(canonical, task);
      }
      return { code: request.code, handle: request.handle, tokenId: BigInt(handleDigest(request.handle)).toString(),
        url: `/mint/${request.code}`, status: "preparing" as const };
    } finally { this.#creating = false; }
  }
  async status(code: unknown, session: DurableSiteSession) {
    const request = await this.requests.get(parseCode(code), session.id), now = Date.now();
    const complete = request.status === "assessment-accepted" && !!await this.#journal.load(request.handle, true);
    const active = this.#tasks.has(request.handle);
    const failed = !complete && (!active || !["pending-assessment", "assessment-accepted"].includes(request.status));
    // Explicit allowlist: never expose accepted MBTI, assessment, receipts,
    // publication URI, signer output or wallet capability before reveal.
    return { code: request.code, handle: request.handle, renderHandle: request.requestedHandle,
      tokenId: BigInt(handleDigest(request.handle)).toString(), requestExpiresAt: request.expiresAt, requestExpired: request.expiresAt <= now,
      status: complete ? "ready" : request.status === "assessment-abstained" ? "abstained" : failed ? "failed" : "preparing",
      canMint: complete && request.expiresAt > now && proof(session, now)
        && (!session.walletProof?.codeHash || session.walletProof.codeHash === capabilityHash(request.code)),
      preparationActive: active, diagnosticReference: request.attemptId,
      ...(failed ? { error: request.status === "assessment-abstained" ? "Grok could not assess this handle from the available evidence."
        : "This preparation needs operator review. No assessment will be retried automatically." } : {}), serverNow: now };
  }
  async authorize(value: unknown, consent: unknown, intent: RuntimeIntent) {
    this.#available();
    if (consent !== true) throw new PublicError(400, "CONSENT_REQUIRED", "Choose Mint & reveal to continue.");
    const code = parseCode(value), captured = { ...context(intent), code, consent: true };
    const request: DurableMintRequest = await this.requests.get(code, intent.session.id);
    const nonce = await this.#issuer.preflightNonce(captured);
    const eligibility = await this.#observe({ handle: request.handle, recipient: request.wallet, nonce });
    const { reservation, signature } = await this.#issuer.issue({ ...captured, eligibility }, this.#signer);
    this.#available();
    const authorization = normalizeOpenMintAuthorization(reservation.authorization);
    return { code, handle: request.handle, tokenId: BigInt(authorization.handleKey).toString(),
      expiresAt: new Date(Number(authorization.deadline) * 1000).toISOString(), transaction: {
        from: authorization.recipient, to: reservation.domain.verifyingContract, chainId: `0x${BigInt(reservation.domain.chainId).toString(16)}`,
        value: "0x0", data: encodeFunctionData({ abi: OPEN_MINT_ABI, functionName: "mint", args: [request.handle, authorization, reservation.tokenURI, signature] }),
      } };
  }
  /** Stop accepting new work. Never reschedule jobs after drain/restart. The
   * owner must close the writer after this resolves, not underneath a task. */
  async drain(): Promise<void> { this.#draining = true; await Promise.all([...this.#tasks.values()]); }
  /** Observation for local tests/controlled shutdown, not an HTTP operation. */
  async idle(): Promise<void> { await Promise.all([...this.#tasks.values()]); }
}
