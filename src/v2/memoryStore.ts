import type {
  FrozenTokenMetadata,
  GalleryEntry,
  MintAttempt,
  MintAuthorizationRecord,
  MintProjection,
  MintState,
  MintStatusView,
  WalletBinding,
  WalletBindingChallenge,
} from "./model.js";
import { MINT_STATE_LABELS, unmintedProjection } from "./model.js";

function bindingKey(xUserId: string, chainId: bigint): string {
  return `${xUserId}\u0000${chainId}`;
}

function unresolvedAuthorization(authorization: MintAuthorizationRecord): boolean {
  // Passing the wall-clock deadline is not enough to release this guard. The
  // durable design moves an issued row to a terminal state only after
  // contiguous finalized-chain coverage and a pinned unused/revoked check.
  return authorization.status === "prepared"
    || authorization.status === "signing_unknown"
    || authorization.status === "issued";
}

const OBSERVATION_TRANSITIONS: Record<MintState, ReadonlySet<MintState>> = {
  unminted: new Set(["authorized", "submitted", "included_unfinalized", "validation_pending", "quarantined"]),
  authorized: new Set(["submitted", "included_unfinalized", "validation_pending", "quarantined", "unminted"]),
  submitted: new Set(["included_unfinalized", "validation_pending", "quarantined", "authorized", "unminted"]),
  included_unfinalized: new Set(["finalized", "validation_pending", "quarantined", "submitted", "authorized", "unminted"]),
  finalized: new Set(["finality_revoked"]),
  validation_pending: new Set(["included_unfinalized", "finalized", "quarantined", "submitted", "authorized", "unminted"]),
  quarantined: new Set(["validation_pending", "finalized", "finality_revoked"]),
  finality_revoked: new Set(["finalized"]),
};

/**
 * In-memory development projection for V2. It deliberately models the same
 * authority boundaries as the durable design: client transaction reports are
 * attempts only, while Gallery rows can be created only by finalizeMint().
 */
export class MemoryMintStore {
  private readonly challenges = new Map<string, WalletBindingChallenge>();
  private readonly bindingsById = new Map<string, WalletBinding>();
  private readonly activeBindingIds = new Map<string, string>();
  private readonly metadata = new Map<string, FrozenTokenMetadata>();
  private readonly authorizations = new Map<string, MintAuthorizationRecord>();
  private readonly authorizationBySignatureBinding = new Map<string, string>();
  private readonly attempts = new Map<string, MintAttempt[]>();
  private readonly projections = new Map<string, MintProjection>();
  private readonly gallery = new Map<string, GalleryEntry>();
  private readonly suppressions = new Set<string>();

  /**
   * Local-rehearsal persistence hook. This is a complete logical snapshot of
   * the in-memory reference model, not the normalized production repository.
   */
  exportSnapshot(): MemoryMintStoreSnapshot {
    return structuredClone({
      schemaVersion: 1,
      challenges: [...this.challenges.entries()],
      bindingsById: [...this.bindingsById.entries()],
      activeBindingIds: [...this.activeBindingIds.entries()],
      metadata: [...this.metadata.entries()],
      authorizations: [...this.authorizations.entries()],
      authorizationBySignatureBinding: [...this.authorizationBySignatureBinding.entries()],
      attempts: [...this.attempts.entries()],
      projections: [...this.projections.entries()],
      gallery: [...this.gallery.entries()],
      suppressions: [...this.suppressions],
    });
  }

  static fromSnapshot(snapshot: MemoryMintStoreSnapshot): MemoryMintStore {
    if (snapshot.schemaVersion !== 1) throw new Error("Unsupported local mint snapshot version.");
    const store = new MemoryMintStore();
    for (const [key, value] of snapshot.challenges) store.challenges.set(key, structuredClone(value));
    for (const [key, value] of snapshot.bindingsById) store.bindingsById.set(key, structuredClone(value));
    for (const [key, value] of snapshot.activeBindingIds) store.activeBindingIds.set(key, value);
    for (const [key, value] of snapshot.metadata) store.metadata.set(key, structuredClone(value));
    for (const [key, value] of snapshot.authorizations) store.authorizations.set(key, structuredClone(value));
    for (const [key, value] of snapshot.authorizationBySignatureBinding) store.authorizationBySignatureBinding.set(key, value);
    for (const [key, value] of snapshot.attempts) store.attempts.set(key, structuredClone(value));
    for (const [key, value] of snapshot.projections) store.projections.set(key, structuredClone(value));
    for (const [key, value] of snapshot.gallery) store.gallery.set(key, structuredClone(value));
    snapshot.suppressions.forEach((signatureId) => store.suppressions.add(signatureId));
    return store;
  }

  /** Install an already-persisted local reconciliation result without changing store identity. */
  replaceSnapshot(snapshot: MemoryMintStoreSnapshot): void {
    const restored = MemoryMintStore.fromSnapshot(snapshot);
    const maps = ["challenges", "bindingsById", "activeBindingIds", "metadata", "authorizations",
      "authorizationBySignatureBinding", "attempts", "projections", "gallery"] as const;
    for (const name of maps) {
      // Each source/destination pair is the same private map type.
      const destination = this[name] as Map<string, unknown>;
      destination.clear();
      for (const [key, value] of restored[name]) destination.set(key, value);
    }
    this.suppressions.clear();
    for (const signatureId of restored.suppressions) this.suppressions.add(signatureId);
  }

  putChallenge(challenge: WalletBindingChallenge): void {
    if (this.challenges.has(challenge.challengeId)) throw new Error("Duplicate wallet challenge ID.");
    this.challenges.set(challenge.challengeId, challenge);
  }

  getChallenge(challengeId: string): WalletBindingChallenge | null {
    return this.challenges.get(challengeId) ?? null;
  }

  beginChallenge(challengeId: string, sessionIdDigest: string, xUserId: string, now = new Date()): WalletBindingChallenge | null {
    const challenge = this.challenges.get(challengeId);
    if (
      !challenge ||
      challenge.status !== "pending" ||
      challenge.sessionIdDigest !== sessionIdDigest ||
      challenge.xUserId !== xUserId ||
      challenge.expiresAt <= now
    ) return null;
    challenge.status = "processing";
    return challenge;
  }

  failChallenge(challengeId: string): void {
    const challenge = this.challenges.get(challengeId);
    if (challenge && challenge.status !== "consumed") challenge.status = "failed";
  }

  activateBinding(challengeId: string, binding: WalletBinding, now = new Date()): WalletBinding {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.status !== "processing") throw new Error("Wallet challenge is not processing.");
    const key = bindingKey(binding.xUserId, binding.chainId);
    this.assertBindingMayChange(binding.xUserId, binding.chainId, now);
    const priorId = this.activeBindingIds.get(key);
    if (priorId) {
      const prior = this.bindingsById.get(priorId);
      if (!prior) throw new Error("Active wallet binding index is corrupt.");
      prior.status = "replaced";
    }
    this.bindingsById.set(binding.walletBindingId, binding);
    this.activeBindingIds.set(key, binding.walletBindingId);
    challenge.status = "consumed";
    return binding;
  }

  seedBinding(binding: WalletBinding): void {
    const key = bindingKey(binding.xUserId, binding.chainId);
    const prior = this.activeBindingIds.get(key);
    if (prior) throw new Error("A fixture binding already exists for this account and chain.");
    this.bindingsById.set(binding.walletBindingId, binding);
    this.activeBindingIds.set(key, binding.walletBindingId);
  }

  getActiveBinding(xUserId: string, chainId: bigint): WalletBinding | null {
    const id = this.activeBindingIds.get(bindingKey(xUserId, chainId));
    if (!id) return null;
    const binding = this.bindingsById.get(id);
    return binding?.status === "active" ? binding : null;
  }

  revokeBinding(xUserId: string, chainId: bigint, now = new Date()): boolean {
    this.assertBindingMayChange(xUserId, chainId, now);
    const key = bindingKey(xUserId, chainId);
    const id = this.activeBindingIds.get(key);
    if (!id) return false;
    const binding = this.bindingsById.get(id);
    if (!binding) throw new Error("Active wallet binding index is corrupt.");
    binding.status = "revoked";
    this.activeBindingIds.delete(key);
    return true;
  }

  private assertBindingMayChange(xUserId: string, chainId: bigint, now: Date): void {
    if (this.hasUnresolvedBindingAuthorization(xUserId, chainId)) throw new Error("LIVE_AUTHORIZATION_EXISTS");
  }

  /** A prior mint's safety lock remains even after its wall-clock deadline. */
  hasUnresolvedBindingAuthorization(xUserId: string, chainId: bigint): boolean {
    const active = this.getActiveBinding(xUserId, chainId);
    if (!active) return false;
    for (const authorization of this.authorizations.values()) {
      if (authorization.walletBindingId === active.walletBindingId && unresolvedAuthorization(authorization)) {
        return true;
      }
    }
    return false;
  }

  putMetadata(next: FrozenTokenMetadata): FrozenTokenMetadata {
    const current = this.metadata.get(next.signatureId);
    if (current) {
      if (
        current.metadataCid !== next.metadataCid ||
        current.metadataSha256 !== next.metadataSha256 ||
        current.tokenUri !== next.tokenUri ||
        current.tokenUriHash !== next.tokenUriHash
      ) throw new Error("METADATA_INTEGRITY_ERROR");
      return current;
    }
    this.metadata.set(next.signatureId, next);
    return next;
  }

  getMetadata(signatureId: string): FrozenTokenMetadata | null {
    return this.metadata.get(signatureId) ?? null;
  }

  putPreparedAuthorization(next: MintAuthorizationRecord, now = new Date()): MintAuthorizationRecord {
    if (next.deadline - next.validAfter !== 900n) throw new Error("Authorization TTL must be exactly 900 seconds.");
    const projection = this.getProjection(next.signatureId);
    if (projection.state === "finalized") throw new Error("ALREADY_MINTED");
    const idempotencyKey = `${next.signatureId}\u0000${next.walletBindingId}`;
    const existingId = this.authorizationBySignatureBinding.get(idempotencyKey);
    if (existingId) {
      const existing = this.authorizations.get(existingId);
      if (existing && unresolvedAuthorization(existing)) return existing;
    }
    for (const existing of this.authorizations.values()) {
      if (existing.signatureId === next.signatureId && existing.walletBindingId !== next.walletBindingId && unresolvedAuthorization(existing)) {
        throw new Error("LIVE_AUTHORIZATION_EXISTS");
      }
    }
    if (this.authorizations.has(next.authorizationId)) throw new Error("Duplicate authorization ID.");
    this.authorizations.set(next.authorizationId, next);
    this.authorizationBySignatureBinding.set(idempotencyKey, next.authorizationId);
    return next;
  }

  issueAuthorization(authorizationId: `0x${string}`, attestation: `0x${string}`): MintAuthorizationRecord {
    const authorization = this.authorizations.get(authorizationId);
    if (authorization?.status === "issued" && authorization.galleryAttestation) return authorization;
    if (!authorization || (authorization.status !== "prepared" && authorization.status !== "signing_unknown")) {
      throw new Error("AUTHORIZATION_UNAVAILABLE");
    }
    authorization.galleryAttestation = attestation;
    authorization.status = "issued";
    const projection = this.getProjection(authorization.signatureId);
    // Signing completion may race a chain observation. Persist the known
    // attestation, but never regress a submitted/included/finalized or incident
    // projection back to the backend-only authorized state.
    if (projection.state === "unminted" || projection.state === "authorized") {
      this.transitionProjection(authorization.signatureId, "authorized", {
        authorizationId,
        contract: null,
        chainId: null,
        mintWallet: authorization.mintWallet,
      });
    }
    return authorization;
  }

  markSigningUnknown(authorizationId: `0x${string}`): void {
    const authorization = this.authorizations.get(authorizationId);
    if (authorization?.status === "signing_unknown") return;
    if (!authorization || authorization.status !== "prepared") throw new Error("AUTHORIZATION_UNAVAILABLE");
    authorization.status = "signing_unknown";
  }

  getAuthorization(authorizationId: string): MintAuthorizationRecord | null {
    return this.authorizations.get(authorizationId) ?? null;
  }

  getLiveAuthorization(signatureId: string, walletBindingId: string, now = new Date()): MintAuthorizationRecord | null {
    void now;
    const id = this.authorizationBySignatureBinding.get(`${signatureId}\u0000${walletBindingId}`);
    const authorization = id ? this.authorizations.get(id) : undefined;
    return authorization && unresolvedAuthorization(authorization) ? authorization : null;
  }

  reportAttempt(attempt: MintAttempt): MintAttempt {
    const authorization = this.authorizations.get(attempt.authorizationId);
    if (!authorization) throw new Error("AUTHORIZATION_UNAVAILABLE");
    const list = this.attempts.get(attempt.authorizationId) ?? [];
    const existing = list.find((item) => item.txHash === attempt.txHash);
    if (existing) return existing;
    list.push(attempt);
    this.attempts.set(attempt.authorizationId, list);
    // Deliberately do not advance the mint projection. A browser report is a hint.
    return attempt;
  }

  observeSubmitted(signatureId: string, authorizationId: `0x${string}`, txHash: `0x${string}`): MintProjection {
    const authorization = this.authorizations.get(authorizationId);
    if (!authorization || authorization.signatureId !== signatureId) throw new Error("TRANSACTION_MISMATCH");
    return this.transitionProjection(signatureId, "submitted", { authorizationId, txHash, mintWallet: authorization.mintWallet });
  }

  observeIncluded(params: {
    signatureId: string;
    authorizationId: `0x${string}`;
    txHash: `0x${string}`;
    contract: `0x${string}`;
    chainId: bigint;
    tokenId: bigint;
    mintWallet: `0x${string}`;
    blockNumber: bigint;
    transactionIndex: number;
    logIndex: number;
  }): MintProjection {
    const authorization = this.authorizations.get(params.authorizationId);
    if (!authorization || authorization.signatureId !== params.signatureId || authorization.mintWallet !== params.mintWallet) {
      throw new Error("TRANSACTION_MISMATCH");
    }
    return this.transitionProjection(params.signatureId, "included_unfinalized", {
      ...params,
      currentTokenHolder: params.mintWallet,
    });
  }

  finalizeMint(signatureId: string, finalizedAt: Date, finalityLabel: string): GalleryEntry {
    const projection = this.projections.get(signatureId);
    if (
      !projection ||
      projection.state !== "included_unfinalized" ||
      !projection.authorizationId ||
      !projection.txHash ||
      !projection.contract ||
      projection.chainId === null ||
      projection.tokenId === null ||
      !projection.mintWallet ||
      !projection.currentTokenHolder ||
      projection.blockNumber === null ||
      projection.transactionIndex === null ||
      projection.logIndex === null
    ) throw new Error("Only a validated included event may be finalized.");
    const authorization = this.authorizations.get(projection.authorizationId);
    if (authorization) authorization.status = "consumed";
    const entry: GalleryEntry = {
      ...projection,
      state: "finalized",
      finalizedAt,
      finalityLabel,
      authorizationId: projection.authorizationId,
      txHash: projection.txHash,
      contract: projection.contract,
      chainId: projection.chainId,
      tokenId: projection.tokenId,
      mintWallet: projection.mintWallet,
      currentTokenHolder: projection.currentTokenHolder,
      blockNumber: projection.blockNumber,
      transactionIndex: projection.transactionIndex,
      logIndex: projection.logIndex,
    };
    this.projections.set(signatureId, entry);
    this.gallery.set(signatureId, entry);
    return entry;
  }

  updateFinalizedHolder(signatureId: string, holder: `0x${string}`): void {
    const entry = this.gallery.get(signatureId);
    if (!entry) throw new Error("Only a finalized token has a public holder projection.");
    entry.currentTokenHolder = holder;
    this.projections.set(signatureId, entry);
  }

  suppress(signatureId: string): void {
    this.suppressions.add(signatureId);
  }

  isSuppressed(signatureId: string): boolean {
    return this.suppressions.has(signatureId);
  }

  canWithdrawClaim(signatureId: string): boolean {
    if (this.isSuppressed(signatureId) || this.getProjection(signatureId).state !== "unminted" || this.gallery.has(signatureId)) return false;
    // Expired is a reconciler decision backed by chain evidence, never a clock check here.
    // Unknown signing, consumed, and revoked-but-unverified authority remain blocked.
    return [...this.authorizations.values()].every(record => record.signatureId !== signatureId || record.status === "expired");
  }

  /** Even expired authority requires a fresh chain check before deleting its evidence. */
  hasMintAuthorizationHistory(signatureId: string): boolean {
    return [...this.authorizations.values()].some(record => record.signatureId === signatureId);
  }

  forgetWithdrawnClaim(signatureId: string): void {
    if (!this.canWithdrawClaim(signatureId)) throw new Error("CLAIM_WITHDRAWAL_BLOCKED");
    this.metadata.delete(signatureId);
    this.projections.delete(signatureId);
    for (const [id, record] of this.authorizations) {
      if (record.signatureId !== signatureId) continue;
      this.authorizations.delete(id);
      this.attempts.delete(id);
    }
    for (const [key] of this.authorizationBySignatureBinding) {
      if (key.startsWith(`${signatureId}\u0000`)) this.authorizationBySignatureBinding.delete(key);
    }
  }

  getProjection(signatureId: string): MintProjection {
    return this.projections.get(signatureId) ?? unmintedProjection(signatureId);
  }

  getStatus(signatureId: string, includePrivate = false): MintStatusView {
    const projection = this.getProjection(signatureId);
    let authorization = projection.authorizationId ? this.authorizations.get(projection.authorizationId) ?? null : null;
    if (includePrivate && !authorization) {
      authorization = [...this.authorizations.values()]
        .filter((candidate) => candidate.signatureId === signatureId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
    }
    return {
      projection,
      label: MINT_STATE_LABELS[projection.state],
      authorization: includePrivate ? authorization : null,
      attempts: includePrivate && authorization ? [...(this.attempts.get(authorization.authorizationId) ?? [])] : [],
      metadata: this.metadata.get(signatureId) ?? null,
    };
  }

  listGallery(): GalleryEntry[] {
    return [...this.gallery.values()]
      .filter((entry) => !this.suppressions.has(entry.signatureId))
      .sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
        if (a.transactionIndex !== b.transactionIndex) return b.transactionIndex - a.transactionIndex;
        if (a.logIndex !== b.logIndex) return b.logIndex - a.logIndex;
        return a.signatureId < b.signatureId ? -1 : a.signatureId > b.signatureId ? 1 : 0;
      });
  }

  private transitionProjection(signatureId: string, nextState: MintState, patch: Partial<MintProjection>): MintProjection {
    const current = this.getProjection(signatureId);
    if (current.state !== nextState && !OBSERVATION_TRANSITIONS[current.state].has(nextState)) {
      throw new Error(`Invalid mint projection transition ${current.state} → ${nextState}.`);
    }
    const next = { ...current, ...patch, signatureId, state: nextState };
    this.projections.set(signatureId, next);
    return next;
  }
}

export interface MemoryMintStoreSnapshot {
  schemaVersion: 1;
  challenges: Array<[string, WalletBindingChallenge]>;
  bindingsById: Array<[string, WalletBinding]>;
  activeBindingIds: Array<[string, string]>;
  metadata: Array<[string, FrozenTokenMetadata]>;
  authorizations: Array<[string, MintAuthorizationRecord]>;
  authorizationBySignatureBinding: Array<[string, string]>;
  attempts: Array<[string, MintAttempt[]]>;
  projections: Array<[string, MintProjection]>;
  gallery: Array<[string, GalleryEntry]>;
  suppressions: string[];
}
