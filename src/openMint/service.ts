import { randomBytes } from "node:crypto";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { formalSignatureRenderer, renderCardPng, sha256Hex } from "../v1/renderer.js";
import { AssessmentCoordinator, validateAssessment, type Assessment } from "./assessment.js";
import { canonicalHandle, handleDigest, preservedHandle } from "./identity.js";
import { normalizeOpenMintAuthorization, openMintTokenURIHash, type OpenMintAuthorizationInput } from "./authorization.js";
import { isCode, opaqueCode, PublicError, type SiteSession } from "./security.js";
import { SerialKeys, type KeyValueStore } from "./storage.js";
import type { OpenMintNetwork } from "./network.js";

export interface MintState {
  state: "unminted" | "pending" | "minted";
  tokenId?: string;
  wallet?: string;
  transactionHash?: Hex;
  assessmentDigest?: Hex;
  artifactDigest?: Hex;
  tokenURIHash?: Hex;
}
export interface SignatureRequest {
  code: string; handle: string; owner: string; status: "pending" | "ready" | "failed";
  /** Requests created before wallet-gated preparation have no recipient binding and cannot mint. */
  wallet?: Address;
  /** Missing only on requests saved before case-preserving rendering. */
  requestedHandle?: string;
  createdAt: number; expiresAt: number; assessmentId?: string; error?: string;
}
export interface SignatureArtifact {
  assessment: Assessment; svgSha256: string; pngSha256: string; metadataSha256: string;
  /** Frozen first artwork spelling. Older artifacts retain their original lowercase bytes. */
  renderHandle?: string;
  tokenURI: string; digest: Hex;
}
interface Issuance {
  code: string; owner: string; handle: string; tokenURI: string;
  authorization: OpenMintAuthorizationInput; signature?: Hex;
}
interface AssessmentAttempt {
  handle: string; createdAt: number; status: "started" | "succeeded" | "failed";
  assessmentId?: string;
}
const ASSESSMENT_FAILED = "The assessment could not be completed. No mint was submitted. It will not be retried automatically; please contact support.";
const ownerKey = (session: SiteSession): string => sha256Hex(Buffer.from(session.id));
const nowSeconds = (now: () => number): number => Math.floor(now() / 1000);
const artifactDigest = (value: Omit<SignatureArtifact, "digest">): Hex => keccak256(stringToHex(JSON.stringify(value)));

export class OpenMintService {
  readonly #locks = new SerialKeys();
  readonly #jobs = new Set<Promise<void>>();
  readonly #assessing = new Map<string, Promise<Assessment>>();
  readonly now: () => number;
  constructor(readonly options: {
    assessments?: AssessmentCoordinator;
    store: KeyValueStore;
    origin: string;
    network?: OpenMintNetwork;
    fixture: boolean;
    now?: () => number;
    dailyAssessmentLimit?: number;
  }) { this.now = options.now ?? Date.now; }
  get network(): OpenMintNetwork | undefined { return this.options.network; }
  async idle(): Promise<void> { await Promise.all([...this.#jobs]); }

  /** Read-only network identity and nonce; never accept an RPC URL from the caller. */
  async walletContext(value?: unknown) {
    let address: Address | undefined;
    if (value !== undefined) {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new PublicError(400, "INVALID_WALLET", "Enter a valid wallet address.");
      address = getAddress(value.toLowerCase());
    }
    if (!this.network?.walletContext) throw new PublicError(503, "MINT_NETWORK_UNAVAILABLE", "The mint network cannot be verified. No transaction was sent.");
    try { return await this.network.walletContext(address); }
    catch { throw new PublicError(503, "MINT_NETWORK_UNAVAILABLE", "Cannot verify the mint network or wallet nonce. Wait for any pending wallet transactions to confirm, then try again."); }
  }

  /** A request is session-bound. Public callers never supply model output or authorization fields. */
  async request(value: unknown, session: SiteSession): Promise<SignatureRequest> {
    let handle: string;
    try { handle = canonicalHandle(value); } catch { throw new PublicError(400, "INVALID_HANDLE", "Enter a valid X handle."); }
    this.#requirePreparationWallet(session);
    if (!this.network) throw new PublicError(503, "MINT_UNAVAILABLE", "Minting is not configured yet.");
    return this.#locks.run("request-budget", async () => {
      this.#requirePreparationWallet(session);
      const wallet = session.wallet!;
      const generation = session.generation;
      let chainState: MintState;
      let chainTime: number;
      try { [chainState, chainTime] = await Promise.all([this.state(handle), this.network!.now()]); }
      catch { throw new PublicError(503, "CHAIN_UNAVAILABLE", "The local chain is temporarily unavailable. Please try again shortly."); }
      if (chainState.state === "minted") throw new PublicError(409, "ALREADY_MINTED", "This handle has already been minted. View its minted signature.");
      if (chainState.state === "pending") throw new PublicError(409, "MINT_PENDING", "This handle's mint is already confirming.");
      if (Math.abs(chainTime - nowSeconds(this.now)) > 60) throw new PublicError(503, "CHAIN_CLOCK", "The chain is not synchronized. Please try again shortly.");
      try { await this.network!.preflight?.(wallet); }
      catch { throw new PublicError(503, "CHAIN_UNAVAILABLE", "Minting is not available for this wallet right now. No assessment was requested."); }
      if (!this.options.assessments) throw new PublicError(503, "GROK_NOT_CONFIGURED", "Signature generation is not available yet. Please try again later.");
      const requests = await this.options.store.entries<SignatureRequest>("request:");
      const active = requests.map(([, request]) => request).filter(request => request.owner === ownerKey(session) && request.expiresAt > this.now());
      const existing = active.find(request => request.handle === handle && request.wallet === wallet && request.status !== "failed");
      const cached = await this.options.assessments.get(handle);
      const joining = this.#assessing.get(handle);
      if (existing && (existing.status === "ready" || joining)) {
        this.#requirePreparationWallet(session);
        if (session.wallet !== wallet || session.generation !== generation) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Connect it again before preparing a mint.");
        return existing;
      }
      const recovering = cached && existing;
      if (!recovering && active.length >= 10) throw new PublicError(429, "REQUEST_LIMIT", "Please finish an existing request first.");
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const budgetKey = `budget:${day}`;
      const used = await this.options.store.get<number>(budgetKey) ?? 0;
      if (!cached && !joining) {
        // A durable pending record is not evidence of live work. In particular, a failed
        // terminal write or a restarted process must never create a free paid retry.
        const attempted = await this.options.store.get<AssessmentAttempt>(`attempt:${handle}`);
        if (attempted || requests.some(([, request]) => request.handle === handle)) {
          throw new PublicError(409, "ASSESSMENT_RETRY_BLOCKED", ASSESSMENT_FAILED);
        }
        if (used >= (this.options.dailyAssessmentLimit ?? 25)) throw new PublicError(429, "ASSESSMENT_LIMIT", "Today's signature generation limit has been reached.");
        await this.options.store.put(budgetKey, used + 1);
        // Both cost admission and the one-attempt guard are durable before transport.
        // A crash between writes may over-count a budget slot, never under-count a call.
        await this.options.store.put<AssessmentAttempt>(`attempt:${handle}`, { handle, createdAt: this.now(), status: "started" });
      }
      const request: SignatureRequest = recovering || { code: opaqueCode(), handle, requestedHandle: preservedHandle(value), owner: ownerKey(session), wallet, status: "pending", createdAt: this.now(), expiresAt: this.now() + 900_000 };
      await this.options.store.put(`request:${request.code}`, request);
      this.#requirePreparationWallet(session);
      if (session.wallet !== wallet || session.generation !== generation) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Connect it again before preparing a mint.");
      const assessment = cached ? Promise.resolve(cached) : joining ?? this.#startAssessment(handle);
      const operation = this.#complete(request, assessment).finally(() => { this.#jobs.delete(operation); });
      this.#jobs.add(operation);
      return request;
    });
  }
  #startAssessment(handle: string): Promise<Assessment> {
    const operation = (async () => {
      try {
        const assessment = await this.options.assessments!.assess(handle);
        await this.options.store.put<AssessmentAttempt>(`attempt:${handle}`, { handle, createdAt: this.now(), status: "succeeded", assessmentId: assessment.id });
        return assessment;
      } catch (error) {
        await this.options.store.put<AssessmentAttempt>(`attempt:${handle}`, { handle, createdAt: this.now(), status: "failed" }).catch(() => undefined);
        throw error;
      }
    })().finally(() => { this.#assessing.delete(handle); });
    this.#assessing.set(handle, operation);
    return operation;
  }
  async #complete(request: SignatureRequest, result: Promise<Assessment>): Promise<void> {
    try {
      const assessment = await result;
      await this.#locks.run(request.handle, () => this.#artifact(assessment, request.requestedHandle ?? request.handle));
      await this.options.store.put(`request:${request.code}`, { ...request, status: "ready", assessmentId: assessment.id });
    } catch {
      // Provider responses and credentials are never exposed in browser errors or logs.
      const cached = await this.options.assessments!.get(request.handle).catch(() => undefined);
      await this.options.store.put(`request:${request.code}`, { ...request, status: "failed", error: cached ? "Your assessment is saved, but mint preparation was interrupted. Try again to reuse the same result." : ASSESSMENT_FAILED }).catch(() => undefined);
    }
  }
  async recoverInterruptedRequests(): Promise<void> {
    for (const [key, request] of await this.options.store.entries<SignatureRequest>("request:")) {
      if (request.status === "pending") await this.options.store.put(key, { ...request, status: "failed", error: "This request was interrupted. A saved assessment can be reused; an unfinished assessment will not be retried automatically." });
    }
  }
  async getRequest(code: unknown): Promise<SignatureRequest> {
    if (!isCode(code)) throw new PublicError(404, "NOT_FOUND", "Signature request not found.");
    const record = await this.options.store.get<SignatureRequest>(`request:${code}`);
    if (!record) throw new PublicError(404, "NOT_FOUND", "Signature request not found.");
    if (record.code !== code || canonicalHandle(record.handle) !== record.handle || !/^[a-f0-9]{64}$/.test(record.owner)
      || !["pending", "ready", "failed"].includes(record.status) || !Number.isSafeInteger(record.createdAt) || record.expiresAt !== record.createdAt + 900_000) throw new Error("Corrupt signature request.");
    if (record.requestedHandle !== undefined && (preservedHandle(record.requestedHandle) !== record.requestedHandle || canonicalHandle(record.requestedHandle) !== record.handle)) throw new Error("Corrupt request spelling.");
    if (record.wallet !== undefined && (!/^0x[0-9a-fA-F]{40}$/.test(record.wallet) || /^0x0{40}$/i.test(record.wallet))) throw new Error("Corrupt request wallet.");
    return record;
  }
  async sessionRequest(code: unknown, session: SiteSession): Promise<SignatureRequest> {
    const request = await this.getRequest(code);
    if (request.owner !== ownerKey(session)) throw new PublicError(403, "REQUEST_SESSION_MISMATCH", "Open this request in the browser that created it, or start your own request.");
    if (session.expiresAt <= this.now() || (request.wallet && request.wallet !== session.wallet)) throw new PublicError(403, "REQUEST_WALLET_MISMATCH", "Connect the wallet that started this mint.");
    return request;
  }
  async ownedRequest(code: unknown, session: SiteSession): Promise<SignatureRequest> {
    const request = await this.sessionRequest(code, session);
    if (request.expiresAt <= this.now()) throw new PublicError(410, "REQUEST_EXPIRED", "This mint window has expired. Start a new request; the saved assessment will be reused.");
    return request;
  }
  canMint(request: SignatureRequest, session: SiteSession): boolean {
    return request.status === "ready" && request.expiresAt > this.now() && session.expiresAt > this.now()
      && request.owner === ownerKey(session) && !!request.wallet && request.wallet === session.wallet;
  }
  #walletFresh(session: SiteSession): boolean {
    return session.expiresAt > this.now() && !!session.wallet && session.walletProof?.wallet === session.wallet && session.walletProof.expiresAt > this.now();
  }
  /** General sign-in can prepare a mint; an older code-scoped proof cannot. */
  walletVerified(session: SiteSession): boolean {
    return this.#walletFresh(session) && session.walletProof?.code === undefined;
  }
  #requirePreparationWallet(session: SiteSession): void {
    if (!this.walletVerified(session)) throw new PublicError(403, "WALLET_PROOF_REQUIRED", "Connect and verify your wallet before choosing Mint & reveal.");
  }
  async walletProved(code: string, session: SiteSession): Promise<boolean> {
    if (!this.#walletFresh(session) || (session.walletProof?.code !== undefined && session.walletProof.code !== code)) return false;
    const request = await this.getRequest(code);
    return this.#walletFresh(session) && (session.walletProof?.code === undefined || session.walletProof.code === code)
      && request.owner === ownerKey(session) && !!request.wallet && request.wallet === session.wallet;
  }
  async artifact(handle: string): Promise<SignatureArtifact | undefined> {
    const value = await this.options.store.get<SignatureArtifact>(`artifact:${canonicalHandle(handle)}`);
    if (!value) return undefined;
    validateAssessment(value.assessment);
    if (value.assessment.handle !== canonicalHandle(handle) || (value.assessment.provenance === "development-fixture") !== this.options.fixture) throw new Error("Artifact provenance mismatch.");
    if (value.renderHandle !== undefined && (preservedHandle(value.renderHandle) !== value.renderHandle || canonicalHandle(value.renderHandle) !== value.assessment.handle)) throw new Error("Artifact spelling does not match its identity.");
    const { digest, ...unsigned } = value;
    if (digest !== artifactDigest(unsigned)) throw new Error("Corrupt artifact commitment.");
    for (const [hash, extension] of [[value.svgSha256, "svg"], [value.pngSha256, "png"], [value.metadataSha256, "json"]]) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid artifact hash.");
      const bytes = await this.asset(hash, extension);
      if (!bytes) throw new Error("Artifact bytes unavailable.");
    }
    if (!value.tokenURI.endsWith(`/artifacts/${value.metadataSha256}.json`)) throw new Error("Invalid metadata URI.");
    return value;
  }
  async #artifact(assessment: Assessment, renderHandle: string): Promise<SignatureArtifact> {
    const existing = await this.artifact(assessment.handle);
    if (existing) { if (existing.assessment.digest !== assessment.digest) throw new Error("Canonical artwork cannot be replaced."); return existing; }
    if ((assessment.provenance === "development-fixture") !== this.options.fixture) throw new Error("Wrong assessment mode.");
    if (preservedHandle(renderHandle) !== renderHandle || canonicalHandle(renderHandle) !== assessment.handle) throw new Error("Invalid artwork spelling.");
    const svg = formalSignatureRenderer.render({ handle: renderHandle, gr0kRaw: assessment.seed, gr0kScale: 1, rendererVersion: assessment.rendererVersion }).svgUtf8;
    const png = await renderCardPng(svg);
    const svgSha256 = sha256Hex(svg), pngSha256 = sha256Hex(png);
    const metadata = Buffer.from(JSON.stringify({
      name: `@${renderHandle} · ${assessment.mbti}`,
      description: assessment.provenance === "development-fixture" ? "Development fixture: not a Grok assessment; local-chain token only." : "An artwork using Grok's inferred MBTI reading, not a psychological diagnosis or account-owner endorsement. Anyone may mint; no ownership of an X account is claimed.",
      image: `${this.options.origin}/artifacts/${pngSha256}.png`,
      animation_url: `${this.options.origin}/artifacts/${svgSha256}.svg`,
      external_url: `${this.options.origin}/signatures/${assessment.handle}`,
      attributes: [{ trait_type: "Handle", value: renderHandle }, { trait_type: "MBTI", value: assessment.mbti }],
      assessment, renderer: { version: assessment.rendererVersion, handle: renderHandle, mappingVersion: assessment.mappingVersion, gr0k: assessment.seed, svgSha256, pngSha256 },
    }));
    const metadataSha256 = sha256Hex(metadata);
    for (const [hash, extension, bytes] of [[svgSha256, "svg", svg], [pngSha256, "png", png], [metadataSha256, "json", metadata]] as const) {
      await this.options.store.put(`asset:${hash}`, { extension, base64: Buffer.from(bytes).toString("base64") });
    }
    const unsigned = { assessment, renderHandle, svgSha256, pngSha256, metadataSha256, tokenURI: `${this.options.origin}/artifacts/${metadataSha256}.json` };
    const artifact: SignatureArtifact = { ...unsigned, digest: artifactDigest(unsigned) };
    await this.options.store.put(`artifact:${assessment.handle}`, artifact);
    return artifact;
  }
  async asset(hash: string, extension: string): Promise<Buffer | undefined> {
    if (!/^[a-f0-9]{64}$/.test(hash) || !["svg", "png", "json"].includes(extension)) return undefined;
    const value = await this.options.store.get<{ extension: string; base64: string }>(`asset:${hash}`);
    if (!value || value.extension !== extension) return undefined;
    const bytes = Buffer.from(value.base64, "base64");
    if (sha256Hex(bytes) !== hash) throw new Error("Corrupt artifact bytes.");
    return bytes;
  }
  async state(handle: string): Promise<MintState> {
    if (!this.network) return { state: "unminted" };
    const state = await this.network.state(canonicalHandle(handle));
    if (state.state !== "unminted") {
      const artifact = await this.artifact(handle);
      if (!artifact || state.assessmentDigest !== artifact.assessment.digest || state.artifactDigest !== artifact.digest || state.tokenURIHash !== openMintTokenURIHash(artifact.tokenURI)) throw new Error("On-chain artifact commitment mismatch.");
    }
    return state;
  }
  async authorize(code: unknown, consent: unknown, session: SiteSession) {
    if (consent !== true) throw new PublicError(400, "CONSENT_REQUIRED", "Choose Mint & reveal to confirm that Grok chooses the final artwork and your wallet pays network gas.");
    const request = await this.ownedRequest(code, session);
    if (!await this.walletProved(request.code, session)) throw new PublicError(403, "WALLET_PROOF_REQUIRED", "Connect your wallet for this signature first.");
    if (!this.network) throw new PublicError(503, "MINT_UNAVAILABLE", "Minting is not configured yet.");
    return this.#locks.run(request.handle, async () => {
      // Recheck after lock/IO; logout or a changed challenge must never retain authorization.
      const current = await this.ownedRequest(code, session);
      if (!await this.walletProved(request.code, session) || current.status !== "ready") throw new PublicError(409, "NOT_READY", "Wait for the assessment and reconnect your wallet.");
      const recipient = session.wallet!;
      const generation = session.generation;
      const artifact = await this.artifact(request.handle);
      const assessment = await this.options.assessments?.get(request.handle);
      if (!artifact || !assessment || assessment.id !== current.assessmentId || artifact.assessment.digest !== assessment.digest) throw new Error("Trusted assessment is unavailable.");
      const chainTime = await this.network!.now();
      if (Math.abs(chainTime - nowSeconds(this.now)) > 60) throw new PublicError(503, "CHAIN_CLOCK", "The chain is not synchronized. Please try again shortly.");
      const state = await this.state(request.handle);
      if (state.state !== "unminted") throw new PublicError(409, "ALREADY_MINTED", "This handle has already been minted or is confirming.");
      const key = `issuance:${request.handle}`;
      let issuance = await this.options.store.get<Issuance>(key);
      if (issuance && BigInt(issuance.authorization.deadline) >= BigInt(chainTime)) {
        if (issuance.owner !== ownerKey(session) || issuance.code !== request.code || issuance.authorization.recipient !== recipient) throw new PublicError(409, "MINT_RESERVED", "A mint authorization for this handle is still active. Please try after its window expires.");
      } else {
        const issuedAt = chainTime;
        const deadline = Math.min(Math.floor(request.expiresAt / 1000), issuedAt + 600);
        if (deadline <= issuedAt + 15) throw new PublicError(410, "REQUEST_EXPIRED", "Start a new request to get a fresh mint window.");
        issuance = { code: request.code, owner: ownerKey(session), handle: request.handle, tokenURI: artifact.tokenURI,
          authorization: { handleKey: handleDigest(request.handle), assessmentDigest: assessment.digest, artifactDigest: artifact.digest, recipient,
            tokenURIHash: openMintTokenURIHash(artifact.tokenURI), nonce: `0x${randomBytes(32).toString("hex")}`, issuedAt: String(issuedAt), deadline: String(deadline) } };
        // Persist the reservation BEFORE signing, including exact nonce and recipient.
        await this.options.store.put(key, issuance);
      }
      const a = normalizeOpenMintAuthorization(issuance.authorization);
      if (a.handleKey !== handleDigest(request.handle) || a.assessmentDigest !== assessment.digest || a.artifactDigest !== artifact.digest || a.tokenURIHash !== openMintTokenURIHash(artifact.tokenURI) || issuance.tokenURI !== artifact.tokenURI) throw new Error("Stored issuance commitment mismatch.");
      if (!await this.walletProved(request.code, session) || session.wallet !== recipient || session.generation !== generation) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Connect it again before continuing.");
      if (!issuance.signature) { issuance.signature = await this.network!.sign(a); await this.options.store.put(key, issuance); }
      const transaction = await this.network!.transaction(request.handle, a, artifact.tokenURI, issuance.signature);
      const network = await this.walletContext(recipient);
      if (network.nonce === undefined) throw new PublicError(503, "MINT_NETWORK_UNAVAILABLE", "The wallet nonce cannot be verified. No transaction was sent.");
      if (!await this.walletProved(request.code, session) || session.wallet !== recipient || session.generation !== generation) throw new PublicError(409, "WALLET_CHANGED", "Your wallet changed. Start a new request after this authorization expires.");
      return { code: request.code, handle: request.handle, tokenId: BigInt(a.handleKey).toString(), transaction: { ...transaction, nonce: network.nonce }, network, expiresAt: new Date(Number(a.deadline) * 1000).toISOString() };
    });
  }
  async report(code: unknown, transactionHash: unknown, session: SiteSession): Promise<void> {
    const request = await this.sessionRequest(code, session);
    if (typeof transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new PublicError(400, "INVALID_TRANSACTION", "Invalid transaction hash.");
    // A hash is only a hint. The UI and collection exclusively use verified chain state.
    await this.options.store.put(`hint:${request.code}`, { transactionHash: transactionHash.toLowerCase() });
  }
  async gallery(wallet?: Address): Promise<Array<{ artifact: SignatureArtifact; mint: MintState }>> {
    const result: Array<{ artifact: SignatureArtifact; mint: MintState }> = [];
    for (const [, value] of await this.options.store.entries<SignatureArtifact>("artifact:")) {
      const artifact = await this.artifact(value.assessment.handle);
      if (!artifact) continue;
      const mint = await this.state(artifact.assessment.handle);
      if (mint.state === "minted" && (!wallet || mint.wallet?.toLowerCase() === wallet.toLowerCase())) result.push({ artifact, mint });
    }
    return result;
  }
}
