import { createPublicAccountId, deriveSignatureId } from "./identity.js";
import { GR0K_SCALE } from "./input.js";

export interface XAccount {
  xUserId: string;
  publicAccountId: string;
  currentHandle: string;
  handleNormalized: string;
  createdAt: Date;
  lastAuthenticatedAt: Date;
}

export interface Signature {
  signatureId: string;
  xUserId: string;
  handleAtClaim: string;
  handleNormalized: string;
  gr0kRaw: number;
  gr0kScale: typeof GR0K_SCALE;
  rendererVersion: string;
  svgSha256: string;
  svgStorageKey: string;
  cardRendererVersion: string;
  pngSha256: string;
  cardStorageKey: string;
  claimMethod: "x_oauth_v1";
  xAuthenticatedAt: Date;
  claimedAt: Date;
}

export interface ClaimRecordInput {
  xUserId: string;
  handleAtClaim: string;
  handleNormalized: string;
  gr0kRaw: number;
  rendererVersion: string;
  svgSha256: string;
  svgStorageKey: string;
  cardRendererVersion: string;
  pngSha256: string;
  cardStorageKey: string;
  xAuthenticatedAt: Date;
  claimedAt?: Date;
}

export class RendererIntegrityError extends Error {
  readonly code = "RENDERER_INTEGRITY_ERROR";
  constructor() {
    super("The recorded renderer version produced different bytes for the same immutable input.");
    this.name = "RendererIntegrityError";
  }
}

export interface SignatureStore {
  claim(input: ClaimRecordInput): Promise<{ signature: Signature; account: XAccount; existing: boolean }>;
  getSignature(signatureId: string): Promise<Signature | null>;
  listSignaturesForAccount(xUserId: string): Promise<Signature[]>;
  getAccount(xUserId: string): Promise<XAccount | null>;
  updateExistingAccountLogin(xUserId: string, currentHandle: string, handleNormalized: string, authenticatedAt: Date): Promise<void>;
}

function tupleKey(input: Pick<ClaimRecordInput, "xUserId" | "handleNormalized" | "gr0kRaw" | "rendererVersion">): string {
  return `${input.xUserId}\u0000${input.handleNormalized}\u0000${input.gr0kRaw}\u0000${GR0K_SCALE}\u0000${input.rendererVersion}`;
}

export class MemorySignatureStore implements SignatureStore {
  private readonly accounts = new Map<string, XAccount>();
  private readonly signatures = new Map<string, Signature>();
  private readonly tuples = new Map<string, string>();
  private readonly publicAccountIds = new Set<string>();

  async claim(input: ClaimRecordInput): Promise<{ signature: Signature; account: XAccount; existing: boolean }> {
    const key = tupleKey(input);
    const existingId = this.tuples.get(key);
    if (existingId) {
      const existing = this.signatures.get(existingId);
      if (!existing) throw new Error("Signature tuple index is corrupt.");
      if (existing.svgSha256 !== input.svgSha256 || existing.pngSha256 !== input.pngSha256) {
        throw new RendererIntegrityError();
      }
      const account = this.accounts.get(input.xUserId);
      if (!account) throw new Error("Signature account index is corrupt.");
      const updatedAccount = { ...account, currentHandle: input.handleAtClaim, handleNormalized: input.handleNormalized, lastAuthenticatedAt: input.xAuthenticatedAt };
      this.accounts.set(input.xUserId, updatedAccount);
      return { signature: existing, account: updatedAccount, existing: true };
    }

    const now = input.claimedAt ?? new Date();
    let account = this.accounts.get(input.xUserId);
    if (!account) {
      let publicAccountId = createPublicAccountId();
      while (this.publicAccountIds.has(publicAccountId)) publicAccountId = createPublicAccountId();
      account = { xUserId: input.xUserId, publicAccountId, currentHandle: input.handleAtClaim, handleNormalized: input.handleNormalized, createdAt: now, lastAuthenticatedAt: input.xAuthenticatedAt };
      this.publicAccountIds.add(publicAccountId);
    }
    const updatedAccount: XAccount = {
      ...account,
      currentHandle: input.handleAtClaim,
      handleNormalized: input.handleNormalized,
      lastAuthenticatedAt: input.xAuthenticatedAt,
    };
    const signatureId = deriveSignatureId({
      xUserId: input.xUserId,
      handleNormalized: input.handleNormalized,
      gr0kRaw: input.gr0kRaw,
      rendererVersion: input.rendererVersion,
    });
    const collision = this.signatures.get(signatureId);
    if (collision) throw new RendererIntegrityError();
    const signature: Signature = {
      signatureId,
      xUserId: input.xUserId,
      handleAtClaim: input.handleAtClaim,
      handleNormalized: input.handleNormalized,
      gr0kRaw: input.gr0kRaw,
      gr0kScale: GR0K_SCALE,
      rendererVersion: input.rendererVersion,
      svgSha256: input.svgSha256,
      svgStorageKey: input.svgStorageKey,
      cardRendererVersion: input.cardRendererVersion,
      pngSha256: input.pngSha256,
      cardStorageKey: input.cardStorageKey,
      claimMethod: "x_oauth_v1",
      xAuthenticatedAt: input.xAuthenticatedAt,
      claimedAt: now,
    };
    this.accounts.set(input.xUserId, updatedAccount);
    this.signatures.set(signatureId, signature);
    this.tuples.set(key, signatureId);
    return { signature, account: updatedAccount, existing: false };
  }

  async getSignature(signatureId: string): Promise<Signature | null> {
    return this.signatures.get(signatureId) ?? null;
  }

  async listSignaturesForAccount(xUserId: string): Promise<Signature[]> {
    return [...this.signatures.values()]
      .filter((signature) => signature.xUserId === xUserId)
      .sort((a, b) => b.claimedAt.getTime() - a.claimedAt.getTime());
  }

  async getAccount(xUserId: string): Promise<XAccount | null> {
    return this.accounts.get(xUserId) ?? null;
  }

  async updateExistingAccountLogin(xUserId: string, currentHandle: string, handleNormalized: string, authenticatedAt: Date): Promise<void> {
    const existing = this.accounts.get(xUserId);
    if (!existing) return;
    this.accounts.set(xUserId, { ...existing, currentHandle, handleNormalized, lastAuthenticatedAt: authenticatedAt });
  }
}
