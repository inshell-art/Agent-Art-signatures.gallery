import { createHash, randomBytes } from "node:crypto";
import canonicalize from "canonicalize";
import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BrowserSession } from "../v1/authState.js";
import { consumeActionApproval, hasMintRecipient, MINT_RECIPIENT_REVIEW_TTL_MS, requireSessionIdentity } from "../v1/authPolicy.js";
import type { ArtifactStore } from "../v1/artifacts.js";
import { signatureIdentityPayload } from "../v1/identity.js";
import { sha256Hex as v1Sha256Hex } from "../v1/renderer.js";
import type { Signature, SignatureStore, XAccount } from "../v1/store.js";
import { assertLocalChainRehearsalConfig, type MintConfig } from "./config.js";
import {
  backendAuthorizationTimes,
  buildExactSiweMessage,
  deterministicUnixfsCid,
  generateSiweNonce,
  mintAuthorizationDigest,
  mintAuthorizationTypedData,
  prepareTokenMetadata,
  randomNonzeroBytes32,
  signatureDigestHex,
  signatureTokenId,
  siweChallengeExpiry,
  tokenUriHash,
  verifyExactSiweProof,
  verifyGalleryAttestation,
  verifyImmutableV1Artifacts,
  V2_CARD_RENDERER_VERSION,
  V2_RENDERER_VERSION,
  type MintAuthorization,
} from "./core/index.js";
import { V2Error, v2Error } from "./errors.js";
import { MemoryMintStore } from "./memoryStore.js";
import type {
  FrozenTokenMetadata,
  MintAttempt,
  MintAuthorizationRecord,
  WalletBinding,
  WalletBindingChallenge,
} from "./model.js";

const FIXTURE_GALLERY_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
export const FIXTURE_WALLET = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const ZERO_TX_VALUE = "0x0" as const;

const MINT_ABI = parseAbi([
  "function mintAuthorized((bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch) a,string tokenURI,bytes galleryAttestation)",
]);

export interface EoaVerification {
  blockNumber: bigint;
  blockHash: Hex;
}

export interface EoaVerifier {
  verify(address: Address, chainId: bigint): Promise<EoaVerification>;
}

export interface GallerySigner {
  readonly address: Address;
  sign(authorizationId: Hex, digest: Hex, authorization: MintAuthorization, config: MintConfig): Promise<Hex>;
}

export interface MintAuthorizationResponse {
  authorization: {
    signatureDigest: Hex;
    walletBindingId: Hex;
    mintWallet: Address;
    svgSha256: Hex;
    pngSha256: Hex;
    metadataSha256: Hex;
    tokenURIHash: Hex;
    authorizationId: Hex;
    validAfter: string;
    deadline: string;
    authorizerEpoch: number;
  };
  tokenURI: string;
  authorizer: Address;
  galleryAttestation: Hex;
  chainId: string;
  contract: Address;
  transaction: { to: Address; data: Hex; value: typeof ZERO_TX_VALUE };
  fixture?: true;
  localChainRehearsal?: true;
}

export interface ReviewedMintRecipient { walletBindingId: string; recipient: string }

export interface MintServiceAdapters {
  eoaVerifier?: EoaVerifier;
  signer?: GallerySigner;
  clock?: () => Date;
  /** Anvil authorization windows follow chain time, never the OAuth wall clock. */
  latestCanonicalTimestamp?: () => Promise<bigint>;
  /** Durably commit the current mint + indexer snapshot before releasing authority. */
  checkpoint?: () => Promise<void>;
}

class FixtureEoaVerifier implements EoaVerifier {
  async verify(_address: Address, chainId: bigint): Promise<EoaVerification> {
    if (chainId !== 11155111n) throw v2Error(400, "WRONG_CHAIN", "This rehearsal is pinned to its configured chain.");
    return { blockNumber: 6_820_000n, blockHash: `0x${"ab".repeat(32)}` };
  }
}

class FixtureGallerySigner implements GallerySigner {
  private readonly account = privateKeyToAccount(FIXTURE_GALLERY_PRIVATE_KEY);
  readonly address = this.account.address;

  async sign(_authorizationId: Hex, digest: Hex, authorization: MintAuthorization, config: MintConfig): Promise<Hex> {
    const typedData = mintAuthorizationTypedData({ chainId: config.chainId, verifyingContract: config.contract }, authorization);
    const signature = await this.account.signTypedData(typedData);
    await verifyGalleryAttestation(
      { chainId: config.chainId, verifyingContract: config.contract },
      authorization,
      signature,
      config.authorizer,
    );
    if (mintAuthorizationDigest({ chainId: config.chainId, verifyingContract: config.contract }, authorization) !== digest) {
      throw v2Error(503, "SIGNER_UNAVAILABLE", "The rehearsal signer returned a mismatched digest.");
    }
    return signature;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function opaqueId(prefix: string, byteLength = 18): string {
  return `${prefix}${randomBytes(byteLength).toString("base64url")}`;
}

function hexSha256(value: string): Hex {
  if (!/^[0-9a-f]{64}$/.test(value)) throw v2Error(422, "ARTIFACT_INTEGRITY_ERROR", "The stored artifact hash is invalid.");
  return `0x${value}`;
}

function asHex(value: string): Hex {
  return value as Hex;
}

function throwStateBoundaryError(error: unknown): never {
  if (error instanceof V2Error) throw error;
  if (error instanceof Error) {
    switch (error.message) {
      case "METADATA_INTEGRITY_ERROR":
        throw v2Error(422, "METADATA_INTEGRITY_ERROR", "The frozen metadata conflicts with the existing signature commitment.");
      case "ALREADY_MINTED":
        throw v2Error(409, "ALREADY_MINTED", "This signature is already minted in the canonical collection.");
      case "LIVE_AUTHORIZATION_EXISTS":
        throw v2Error(409, "LIVE_AUTHORIZATION_EXISTS", "A live or unreconciled authorization already exists for this signature.");
      case "AUTHORIZATION_UNAVAILABLE":
        throw v2Error(409, "AUTHORIZATION_UNAVAILABLE", "This mint authorization is not available in its expected state.");
      case "TRANSACTION_MISMATCH":
        throw v2Error(422, "TRANSACTION_MISMATCH", "The observed transaction does not match this mint authorization.");
    }
  }
  throw error;
}

function fixtureMetadataDocument(input: {
  signature: Signature;
  account: XAccount;
  svgCid: string;
  pngCid: string;
  publicArtifactOrigin: string;
  localChainRehearsal?: true;
}) {
  const { signature, account, svgCid, pngCid } = input;
  const gr0k = String(signature.gr0kRaw);
  return {
    name: `@${signature.handleAtClaim} — Signature — gr0k ${gr0k}`,
    description: input.localChainRehearsal
      ? "A local Anvil rehearsal token using Signature Algorithm v1.0.0. IPFS identifiers are computed locally and not published or pinned. It is not a public Ethereum mint or production provenance record."
      : "A development-rehearsal signature. It is not an Ethereum mint or production provenance record.",
    image: `ipfs://${svgCid}`,
    external_url: `${input.publicArtifactOrigin}/signatures/${signature.signatureId}`,
    attributes: [
      { trait_type: "Handle at Claim", value: `@${signature.handleAtClaim}` },
      { trait_type: "gr0k", value: gr0k },
      { trait_type: "Renderer", value: signature.rendererVersion },
      { trait_type: "Claim Method", value: "X OAuth" },
    ],
    properties: {
      metadata_version: "sg-nft-metadata-1.0.0",
      signature_id: signature.signatureId,
      account_ref: account.publicAccountId,
      handle_at_claim: signature.handleAtClaim,
      gr0k_raw: signature.gr0kRaw,
      gr0k_scale: signature.gr0kScale,
      renderer_version: signature.rendererVersion,
      card_renderer_version: signature.cardRendererVersion,
      svg_sha256: signature.svgSha256,
      png_sha256: signature.pngSha256,
      svg_uri: `ipfs://${svgCid}`,
      png_uri: `ipfs://${pngCid}`,
      claim_method: "x_oauth_v1",
      claimed_at: signature.claimedAt.toISOString(),
      fixture: true,
      ...(input.localChainRehearsal ? { local_chain_rehearsal: true, ipfs_publication: "not_published" } : {}),
    },
  };
}

export class V2MintService {
  readonly config: MintConfig;
  readonly state: MemoryMintStore;
  private readonly eoaVerifier: EoaVerifier;
  private readonly signer: GallerySigner;
  private readonly clock: () => Date;
  private readonly checkpoint: () => Promise<void>;
  private readonly chainTimestamp: (() => Promise<bigint>) | undefined;

  constructor(
    config: MintConfig,
    state: MemoryMintStore,
    private readonly signatures: SignatureStore,
    private readonly artifacts: ArtifactStore,
    adapters: MintServiceAdapters = {},
  ) {
    this.config = config;
    this.state = state;
    this.clock = adapters.clock ?? (() => new Date());
    assertLocalChainRehearsalConfig(config);
    this.checkpoint = adapters.checkpoint ?? (async () => undefined);
    this.chainTimestamp = adapters.latestCanonicalTimestamp;
    if (config.localChainRehearsal && (!adapters.eoaVerifier || !adapters.signer || !adapters.checkpoint || !adapters.latestCanonicalTimestamp)) {
      throw new Error("Local chain rehearsal requires explicit RPC, signer, chain clock, and durable checkpoint adapters.");
    }
    if (!config.enabled) {
      this.eoaVerifier = adapters.eoaVerifier ?? {
        async verify() {
          throw v2Error(503, "MINT_PAUSED", "Minting is disabled.");
        },
      };
      this.signer = adapters.signer ?? {
        address: config.authorizer,
        async sign() {
          throw v2Error(503, "MINT_PAUSED", "Minting is disabled.");
        },
      };
      return;
    }
    if (!config.fixtureMode && (!adapters.eoaVerifier || !adapters.signer)) {
      throw new Error("Production V2 requires explicit RPC and protected signer adapters.");
    }
    this.eoaVerifier = adapters.eoaVerifier ?? new FixtureEoaVerifier();
    this.signer = adapters.signer ?? new FixtureGallerySigner();
    if (getAddress(this.signer.address) !== getAddress(config.authorizer)) {
      throw new Error("Configured mint authorizer does not match the signing adapter.");
    }
  }

  private requireEnabled(): void {
    if (!this.config.enabled) throw v2Error(503, "MINT_PAUSED", "Minting is disabled.");
  }

  async createChallenge(params: {
    session: BrowserSession;
    account: XAccount;
    walletAddress: string;
    chainId: string;
    signature?: Signature;
    recipientConsent?: unknown;
    previousBindingId?: unknown;
    now?: Date;
  }): Promise<{ challengeId: string; message: string; expiresAt: string; chainId: string; walletAddress: Address }> {
    this.requireEnabled();
    const now = params.now ?? this.clock();
    const identity = requireSessionIdentity(params.session, params.account.xUserId, now);
    if (identity.xUserId !== params.account.xUserId || params.account.publicAccountId.length === 0) {
      throw v2Error(403, "NOT_CLAIMANT", "Only the authenticated X account can link its mint wallet.");
    }
    if (params.chainId !== this.config.chainId.toString()) {
      throw v2Error(400, "WRONG_CHAIN", `Use ${this.config.chainName}.`);
    }
    let walletAddress: Address;
    try {
      walletAddress = getAddress(params.walletAddress);
    } catch {
      throw v2Error(400, "INVALID_WALLET_ADDRESS", "Enter one exact 20-byte Ethereum address.");
    }
    const expiresAt = siweChallengeExpiry(now);
    const previousWalletBindingId = this.state.getActiveBinding(identity.xUserId, this.config.chainId)?.walletBindingId ?? null;
    if (params.signature) {
      this.requireRecipientConsent(params, previousWalletBindingId);
      if (this.state.hasUnresolvedBindingAuthorization(identity.xUserId, this.config.chainId)) {
        throw v2Error(409, "LIVE_AUTHORIZATION_EXISTS", "Finish or reconcile the pending mint before choosing a recipient.");
      }
      await this.requireMintTarget(params.signature, identity.xUserId);
      requireSessionIdentity(params.session, identity.xUserId, params.now ?? this.clock());
      if (this.state.hasUnresolvedBindingAuthorization(identity.xUserId, this.config.chainId)) {
        throw v2Error(409, "LIVE_AUTHORIZATION_EXISTS", "Finish or reconcile the pending mint before choosing a recipient.");
      }
      if ((this.state.getActiveBinding(identity.xUserId, this.config.chainId)?.walletBindingId ?? null) !== previousWalletBindingId) {
        throw v2Error(409, "BINDING_TRANSITION", "The recipient changed. Start again.");
      }
    }
    const mintTarget = params.signature ? { signatureId: params.signature.signatureId, claimInstanceId: params.signature.claimInstanceId } : undefined;
    const challengeId = opaqueId("wc1_");
    const nonce = generateSiweNonce();
    const message = buildExactSiweMessage({
      appHost: this.config.appHost,
      appOrigin: this.config.appOrigin,
      walletAddress,
      chainId: this.config.chainId,
      nonce,
      issuedAt: now,
      expirationTime: expiresAt,
      challengeId,
      publicAccountId: params.account.publicAccountId,
      ...(mintTarget ? { mintTarget } : {}),
    });
    const challenge: WalletBindingChallenge = {
      challengeId,
      sessionIdDigest: sha256(params.session.id),
      xUserId: params.account.xUserId,
      publicAccountId: params.account.publicAccountId,
      address: walletAddress,
      chainId: this.config.chainId,
      previousWalletBindingId,
      ...(mintTarget ? { mintTarget } : {}),
      nonce,
      message,
      issuedAt: now,
      expiresAt,
      status: "pending",
    };
    // Mint setup is an explicit same-origin, CSRF-protected session action.
    // Generic wallet management still requires its separate X action grant.
    if (!mintTarget) consumeActionApproval(params.session, {
      kind: "wallet_link",
      chainId: this.config.chainId.toString(),
      previousBindingId: previousWalletBindingId,
    }, params.now ?? this.clock());
    delete params.session.mintRecipient;
    if (mintTarget) params.session.mintRecipientChallengeId = challengeId;
    this.state.putChallenge(challenge);
    return { challengeId, message, expiresAt: expiresAt.toISOString(), chainId: this.config.chainId.toString(), walletAddress };
  }

  async confirmChallenge(params: {
    session: BrowserSession;
    challengeId: string;
    walletProof: string;
    now?: Date;
  }): Promise<WalletBinding> {
    this.requireEnabled();
    const now = params.now ?? this.clock();
    const identity = params.session.identity;
    if (!identity) throw v2Error(401, "AUTH_REQUIRED", "Sign in with X before confirming a wallet.");
    requireSessionIdentity(params.session, identity.xUserId, now);
    const xUserId = identity.xUserId;
    const candidate = this.state.getChallenge(params.challengeId);
    if (candidate?.mintTarget && params.session.mintRecipientChallengeId !== candidate.challengeId) {
      throw v2Error(409, "WALLET_CHALLENGE_INVALID", "This recipient selection was replaced. Use the latest wallet request.");
    }
    const challenge = this.state.beginChallenge(params.challengeId, sha256(params.session.id), xUserId, now);
    if (!challenge) throw v2Error(409, "WALLET_CHALLENGE_INVALID", "The wallet challenge expired, was replayed, or belongs to another session.");
    const confirm = async () => {
      try {
        this.requireChallengeBinding(challenge);
        await verifyExactSiweProof(challenge.message, params.walletProof, {
          appHost: this.config.appHost,
          appOrigin: this.config.appOrigin,
          walletAddress: challenge.address,
          chainId: challenge.chainId,
          nonce: challenge.nonce,
          issuedAt: challenge.issuedAt,
          expirationTime: challenge.expiresAt,
          challengeId: challenge.challengeId,
          publicAccountId: challenge.publicAccountId,
          ...(challenge.mintTarget ? { mintTarget: challenge.mintTarget } : {}),
        });
        const verification = await this.eoaVerifier.verify(challenge.address, challenge.chainId);
        if (challenge.mintTarget) await this.requireMintTarget(challenge.mintTarget, challenge.xUserId);
        const completedAt = params.now ?? this.clock();
        requireSessionIdentity(params.session, challenge.xUserId, completedAt);
        if (challenge.mintTarget && params.session.mintRecipientChallengeId !== challenge.challengeId) {
          throw v2Error(409, "WALLET_CHALLENGE_INVALID", "This recipient selection was replaced. Use the latest wallet request.");
        }
        this.requireChallengeBinding(challenge);
        if (challenge.expiresAt <= completedAt) {
          throw v2Error(409, "WALLET_CHALLENGE_INVALID", "The wallet challenge expired before verification completed.");
        }
        const binding: WalletBinding = {
          walletBindingId: randomNonzeroBytes32(),
          xUserId,
          publicAccountId: challenge.publicAccountId,
          chainId: challenge.chainId,
          address: challenge.address,
          siweMessage: challenge.message,
          walletProof: asHex(params.walletProof),
          verificationScheme: "eip191_eoa_65byte_low_s",
          verificationBlockNumber: verification.blockNumber,
          verificationBlockHash: verification.blockHash,
          provedAt: completedAt,
          status: "active",
          version: (this.state.getActiveBinding(xUserId, challenge.chainId)?.version ?? 0) + 1,
        };
        const activated = this.state.activateBinding(challenge.challengeId, binding, completedAt);
        if (challenge.mintTarget) {
          delete params.session.mintRecipientChallengeId;
          this.setMintRecipient(params.session, challenge.mintTarget, activated, completedAt);
        }
        return activated;
      } catch (error) {
        if (params.session.mintRecipientChallengeId === challenge.challengeId) delete params.session.mintRecipientChallengeId;
        this.state.failChallenge(challenge.challengeId);
        if (error instanceof V2Error) throw error;
        if (error instanceof Error && error.message === "LIVE_AUTHORIZATION_EXISTS") {
          throw v2Error(409, "LIVE_AUTHORIZATION_EXISTS", "Wait for the current mint authorization to finish before changing wallets.");
        }
        throw v2Error(422, "WALLET_UNSUPPORTED", "The wallet proof is invalid or the address is not a supported EOA.");
      }
    };
    // Serialize the existence check and proof activation with claim withdrawal.
    return challenge.mintTarget && this.signatures.withClaimLock
      ? this.signatures.withClaimLock(challenge.mintTarget.signatureId, confirm) : confirm();
  }

  private async requireMintTarget(target: { signatureId: string; claimInstanceId: string }, xUserId: string): Promise<Signature> {
    const current = await this.signatures.getSignature(target.signatureId);
    if (!current || current.claimInstanceId !== target.claimInstanceId || this.state.isSuppressed(target.signatureId)) {
      throw v2Error(409, "MINT_INELIGIBLE", "This claim changed. Return to the signature and start again.");
    }
    if (current.xUserId !== xUserId) throw v2Error(403, "NOT_CLAIMANT", "Only the original X claimant can mint this signature.");
    if (this.state.getProjection(target.signatureId).state !== "unminted") {
      throw v2Error(409, "LIVE_AUTHORIZATION_EXISTS", "Finish or reconcile the current mint before choosing a recipient.");
    }
    return current;
  }

  private setMintRecipient(session: BrowserSession, target: { signatureId: string; claimInstanceId: string }, binding: WalletBinding, now: Date): void {
    session.mintRecipient = {
      ...target, sessionId: session.id, xUserId: binding.xUserId,
      walletBindingId: binding.walletBindingId, address: binding.address, chainId: binding.chainId.toString(),
      provedAt: now, expiresAt: new Date(now.getTime() + MINT_RECIPIENT_REVIEW_TTL_MS),
    };
  }

  private requireRecipientConsent(consent: { recipientConsent?: unknown; previousBindingId?: unknown } | undefined, previousBindingId: string | null): void {
    if (consent?.recipientConsent !== true) {
      throw v2Error(400, "REQUEST_CONFIRMATION_INVALID", "Choose a wallet for this exact mint before requesting a proof.");
    }
    if (consent.previousBindingId !== previousBindingId) {
      throw v2Error(409, "BINDING_TRANSITION", "The recipient changed. Reload the mint page before choosing a wallet.");
    }
  }

  /** Dev fixture proof only; never available for actual local-chain or production mints. */
  async seedFixtureMintRecipient(session: BrowserSession, signature: Signature, account: XAccount, now = new Date(), consent?: { recipientConsent?: unknown; previousBindingId?: unknown }): Promise<WalletBinding> {
    this.requireEnabled();
    if (!this.config.fixtureMode || this.config.localChainRehearsal) throw new Error("Fixture recipients are disabled.");
    requireSessionIdentity(session, account.xUserId, now);
    if (this.state.hasUnresolvedBindingAuthorization(account.xUserId, this.config.chainId)) {
      throw v2Error(409, "LIVE_AUTHORIZATION_EXISTS", "Finish or reconcile the pending mint before choosing a recipient.");
    }
    await this.requireMintTarget(signature, account.xUserId);
    requireSessionIdentity(session, account.xUserId, now);
    if (this.state.hasUnresolvedBindingAuthorization(account.xUserId, this.config.chainId)) {
      throw v2Error(409, "LIVE_AUTHORIZATION_EXISTS", "Finish or reconcile the pending mint before choosing a recipient.");
    }
    const prior = this.state.getActiveBinding(account.xUserId, this.config.chainId);
    this.requireRecipientConsent(consent, prior?.walletBindingId ?? null);
    delete session.mintRecipientChallengeId;
    const binding = this.seedFixtureBinding(account.xUserId, account.publicAccountId, now);
    this.setMintRecipient(session, signature, binding, now);
    return binding;
  }

  private requireChallengeBinding(challenge: WalletBindingChallenge): void {
    const currentBindingId = this.state.getActiveBinding(challenge.xUserId, challenge.chainId)?.walletBindingId ?? null;
    // A missing snapshot identifies a legacy challenge that never received
    // action-specific consent. It must also be restarted, not silently upgraded.
    if (challenge.previousWalletBindingId === undefined || challenge.previousWalletBindingId !== currentBindingId) {
      throw v2Error(409, "BINDING_TRANSITION", "The recipient changed. Choose and verify it again.");
    }
  }

  seedFixtureBinding(xUserId: string, publicAccountId: string, now = new Date()): WalletBinding {
    this.requireEnabled();
    if (!this.config.fixtureMode || this.config.localChainRehearsal) throw new Error("Fixture bindings are disabled.");
    const current = this.state.getActiveBinding(xUserId, this.config.chainId);
    if (current) return current;
    const binding: WalletBinding = {
      walletBindingId: randomNonzeroBytes32(),
      xUserId,
      publicAccountId,
      chainId: this.config.chainId,
      address: FIXTURE_WALLET,
      siweMessage: "Development fixture: no SIWE authority was created.",
      walletProof: `0x${"00".repeat(65)}`,
      verificationScheme: "fixture_seed",
      verificationBlockNumber: 6_820_000n,
      verificationBlockHash: `0x${"ab".repeat(32)}`,
      provedAt: now,
      status: "active",
      version: 1,
    };
    this.state.seedBinding(binding);
    return binding;
  }

  revokeBinding(xUserId: string, now = new Date(), session?: BrowserSession): void {
    this.requireEnabled();
    if (session) {
      requireSessionIdentity(session, xUserId, now);
      const binding = this.state.getActiveBinding(xUserId, this.config.chainId);
      if (!binding) throw v2Error(403, "WALLET_NOT_LINKED", "There is no linked wallet to revoke.");
      consumeActionApproval(session, {
        kind: "wallet_revoke",
        chainId: this.config.chainId.toString(),
        previousBindingId: binding.walletBindingId,
      }, now);
    } else if (!this.config.fixtureMode) {
      throw v2Error(401, "AUTH_REQUIRED", "Sign in with X before revoking a wallet.");
    }
    try {
      this.state.revokeBinding(xUserId, this.config.chainId, now);
    } catch (error) {
      if (error instanceof Error && error.message === "LIVE_AUTHORIZATION_EXISTS") {
        throw v2Error(409, "LIVE_AUTHORIZATION_EXISTS", "A live or unreconciled authorization blocks wallet revocation.");
      }
      throw error;
    }
  }

  async previewMetadata(signature: Signature, account: XAccount): Promise<FrozenTokenMetadata> {
    const svgBytes = await this.artifacts.get(signature.svgStorageKey);
    const pngBytes = await this.artifacts.get(signature.cardStorageKey);
    if (!svgBytes || !pngBytes) throw v2Error(422, "ARTIFACT_INTEGRITY_ERROR", "The exact claimed artwork is unavailable.");
    try {
      verifyImmutableV1Artifacts({ svgBytes, pngBytes, svgSha256: signature.svgSha256, pngSha256: signature.pngSha256 });
    } catch {
      throw v2Error(422, "ARTIFACT_INTEGRITY_ERROR", "The exact claimed artwork failed its frozen hash check.");
    }
    const svgCid = await deterministicUnixfsCid(svgBytes);
    const pngCid = await deterministicUnixfsCid(pngBytes);
    let canonicalJson: string;
    let metadataSha256: string;
    let metadataCid: string;
    let tokenUri: string;
    let uriHash: Hex;
    if (!this.config.fixtureMode && !this.config.localChainRehearsal && signature.rendererVersion === V2_RENDERER_VERSION && signature.cardRendererVersion === V2_CARD_RENDERER_VERSION) {
      const prepared = await prepareTokenMetadata({
        signatureId: signature.signatureId,
        publicAccountId: account.publicAccountId,
        handleAtClaim: signature.handleAtClaim,
        gr0kRaw: signature.gr0kRaw,
        gr0kScale: signature.gr0kScale,
        rendererVersion: V2_RENDERER_VERSION,
        cardRendererVersion: V2_CARD_RENDERER_VERSION,
        svgSha256: signature.svgSha256,
        pngSha256: signature.pngSha256,
        svgCid,
        pngCid,
        claimedAt: signature.claimedAt,
        publicArtifactOrigin: this.config.publicArtifactOrigin,
      });
      canonicalJson = prepared.canonicalJson;
      metadataSha256 = prepared.sha256;
      metadataCid = prepared.cid;
      tokenUri = prepared.tokenUri;
      uriHash = prepared.tokenUriHash;
    } else if (this.config.fixtureMode || this.config.localChainRehearsal) {
      const serialized = canonicalize(fixtureMetadataDocument({ signature, account, svgCid, pngCid, publicArtifactOrigin: this.config.publicArtifactOrigin, ...(this.config.localChainRehearsal ? { localChainRehearsal: true as const } : {}) }));
      if (!serialized) throw new Error("Fixture metadata cannot be canonicalized.");
      canonicalJson = serialized;
      const bytes = Buffer.from(serialized, "utf8");
      metadataSha256 = v1Sha256Hex(bytes);
      metadataCid = await deterministicUnixfsCid(bytes);
      tokenUri = `ipfs://${metadataCid}`;
      uriHash = tokenUriHash(tokenUri);
    } else {
      throw v2Error(409, "MINT_INELIGIBLE", "This claim was not created by the frozen V1 production renderer.");
    }
    return {
      signatureId: signature.signatureId,
      metadataVersion: "sg-nft-metadata-1.0.0",
      importerProfile: "sg-ipfs-unixfs-1.0.0",
      svgCid,
      pngCid,
      metadataCid,
      svgSha256: hexSha256(signature.svgSha256),
      pngSha256: hexSha256(signature.pngSha256),
      metadataSha256: hexSha256(metadataSha256),
      tokenUri,
      tokenUriHash: uriHash,
      canonicalJson,
      verifiedAt: new Date(),
    };
  }

  async issueAuthorization(
    signature: Signature,
    account: XAccount,
    now?: Date,
    session?: BrowserSession,
    reviewedRecipient?: ReviewedMintRecipient,
  ): Promise<MintAuthorizationResponse> {
    const issue = async () => {
      const current = await this.signatures.getSignature(signature.signatureId);
      if (!current || current.claimInstanceId !== signature.claimInstanceId) {
        throw v2Error(409, "MINT_INELIGIBLE", "This claim no longer exists. Open the current signature before minting.");
      }
      return this.issueAuthorizationLocked(current, account, now, session, reviewedRecipient);
    };
    return this.signatures.withClaimLock ? this.signatures.withClaimLock(signature.signatureId, issue) : issue();
  }

  private async issueAuthorizationLocked(
    signature: Signature,
    account: XAccount,
    now?: Date,
    session?: BrowserSession,
    reviewedRecipient?: ReviewedMintRecipient,
  ): Promise<MintAuthorizationResponse> {
    this.requireEnabled();
    const startedAt = now ?? this.clock();
    if (account.xUserId !== signature.xUserId) {
      throw v2Error(403, "NOT_CLAIMANT", "Only the stable numeric X claimant can authorize this signature.");
    }
    if (session) requireSessionIdentity(session, account.xUserId, startedAt);
    else if (!this.config.fixtureMode) throw v2Error(401, "AUTH_REQUIRED", "Sign in with X before minting.");
    if (this.state.isSuppressed(signature.signatureId)) {
      throw v2Error(409, "MINT_INELIGIBLE", "This signature is unavailable for mint authorization.");
    }
    const binding = this.state.getActiveBinding(account.xUserId, this.config.chainId);
    if (!binding) throw v2Error(403, "WALLET_NOT_LINKED", "Connect a wallet and prove control of this mint's recipient.");
    if (this.config.localChainRehearsal && binding.verificationScheme !== "eip191_eoa_65byte_low_s") {
      throw v2Error(403, "WALLET_NOT_LINKED", "This local mint requires a real SIWE wallet proof; a seeded fixture binding is not authority.");
    }
    const initialAuthorization = this.state.getLiveAuthorization(signature.signatureId, binding.walletBindingId, startedAt);
    const resumingIssued = initialAuthorization?.status === "issued" && !!initialAuthorization.galleryAttestation;
    const recipientDraft = session && !resumingIssued ? session.mintRecipient : undefined;
    if (reviewedRecipient && (reviewedRecipient.walletBindingId !== binding.walletBindingId
      || reviewedRecipient.recipient.toLowerCase() !== binding.address.toLowerCase())) {
      throw v2Error(409, "BINDING_TRANSITION", "The recipient changed after review. Review the mint again.");
    }
    if (session && !resumingIssued) {
      if (!hasMintRecipient(session, signature, binding, startedAt, initialAuthorization?.authorizationId)) {
        throw v2Error(401, "MINT_RECIPIENT_REQUIRED", "Choose and verify a wallet for this signature before minting.");
      }
      if (!reviewedRecipient) throw v2Error(409, "REQUEST_CONFIRMATION_INVALID", "Review the exact recipient before authorizing this mint.");
    }
    const initialProjection = this.state.getProjection(signature.signatureId);
    if (initialProjection.state === "finalized") throw v2Error(409, "ALREADY_MINTED", "This signature is already minted in the canonical collection.");
    if (initialProjection.state === "included_unfinalized") {
      throw v2Error(503, "CHAIN_UNAVAILABLE", "A canonical mint is awaiting finality; another authorization cannot be issued.");
    }
    if (["validation_pending", "quarantined", "finality_revoked"].includes(initialProjection.state)) {
      throw v2Error(503, "CHAIN_SAFETY_HALT", "Mint verification is not safe enough to issue another authorization.");
    }

    try {
      const digest = signatureDigestHex(signature.signatureId);
      const payload = signatureIdentityPayload({
        xUserId: signature.xUserId,
        handleAtClaim: signature.handleAtClaim,
        gr0kRaw: signature.gr0kRaw,
        gr0kScale: signature.gr0kScale,
        rendererVersion: signature.rendererVersion,
      });
      const recomputed = `0x${createHash("sha256").update(payload).digest("hex")}`;
      if (digest !== recomputed) throw v2Error(409, "MINT_INELIGIBLE", "The V1 signature digest no longer matches its immutable claim payload.");
    } catch (error) {
      if (error instanceof V2Error) throw error;
      throw v2Error(409, "MINT_INELIGIBLE", "This record is not an eligible V1 signature.");
    }

    let metadata: FrozenTokenMetadata;
    try {
      metadata = this.state.putMetadata(await this.previewMetadata(signature, account));
    } catch (error) {
      throwStateBoundaryError(error);
    }
    const revalidatedAt = now ?? this.clock();
    if (session) requireSessionIdentity(session, account.xUserId, revalidatedAt);
    if (session && recipientDraft && (session.mintRecipient !== recipientDraft
      || !hasMintRecipient(session, signature, binding, revalidatedAt, initialAuthorization?.authorizationId))) {
      throw v2Error(409, "BINDING_TRANSITION", "The recipient review expired or changed. Start this mint again.");
    }
    if (this.state.isSuppressed(signature.signatureId)) {
      throw v2Error(409, "MINT_INELIGIBLE", "This signature became unavailable while the authorization was being prepared.");
    }
    const currentBinding = this.state.getActiveBinding(account.xUserId, this.config.chainId);
    if (
      !currentBinding
      || currentBinding.walletBindingId !== binding.walletBindingId
      || getAddress(currentBinding.address) !== getAddress(binding.address)
      || currentBinding.version !== binding.version
    ) {
      throw v2Error(409, "BINDING_TRANSITION", "The active wallet changed while the authorization was being prepared. Review it again.");
    }
    const projection = this.state.getProjection(signature.signatureId);
    if (projection.state === "finalized") throw v2Error(409, "ALREADY_MINTED", "This signature is already minted in the canonical collection.");
    if (projection.state === "included_unfinalized") {
      throw v2Error(503, "CHAIN_UNAVAILABLE", "A canonical mint is awaiting finality; another authorization cannot be issued.");
    }
    if (["validation_pending", "quarantined", "finality_revoked"].includes(projection.state)) {
      throw v2Error(503, "CHAIN_SAFETY_HALT", "Mint verification is not safe enough to issue another authorization.");
    }
    const existing = this.state.getLiveAuthorization(signature.signatureId, currentBinding.walletBindingId, revalidatedAt);
    if ((projection.state === "authorized" || projection.state === "submitted") && !existing) {
      throw v2Error(409, "AUTHORIZATION_UNAVAILABLE", "The existing mint state must be reconciled before another authorization can be prepared.");
    }
    if (!this.config.fixtureMode && !this.config.localChainRehearsal) {
      // The durable pin/reservation adapter is intentionally mandatory. Local
      // computation above is safe, but production must not sign before two
      // independent pins and gateway verification have completed.
      throw v2Error(503, "METADATA_UNAVAILABLE", "Production IPFS publication and redundant pin verification are not configured.");
    }
    if (existing) {
      if (
        existing.mintWallet !== currentBinding.address ||
        existing.svgSha256 !== metadata.svgSha256 ||
        existing.pngSha256 !== metadata.pngSha256 ||
        existing.metadataSha256 !== metadata.metadataSha256 ||
        existing.tokenUriHash !== metadata.tokenUriHash ||
        existing.tokenUri !== metadata.tokenUri
      ) {
        throw v2Error(422, "METADATA_INTEGRITY_ERROR", "The live authorization no longer matches the frozen metadata.");
      }
      if (existing.status === "issued" && existing.galleryAttestation) {
        if (existing.deadline < await this.authorizationTimestamp(revalidatedAt)) {
          throw v2Error(410, "AUTHORIZATION_EXPIRED", "The prior authorization is past its deadline and remains locked until finalized-chain reconciliation.");
        }
        await this.checkpoint();
        await this.assertPostSignBoundary({
          issued: existing,
          signatureId: signature.signatureId,
          expectedBinding: currentBinding,
          expectedXUserId: account.xUserId,
          claimInstanceId: signature.claimInstanceId,
          expectedRecipientDraft: recipientDraft,
          session,
          now,
        });
        return this.authorizationResponse(existing);
      }
      return this.signAndIssue(existing, (issued) => this.assertPostSignBoundary({
        issued,
        signatureId: signature.signatureId,
        expectedBinding: currentBinding,
        expectedXUserId: account.xUserId,
        claimInstanceId: signature.claimInstanceId,
        expectedRecipientDraft: recipientDraft,
        session,
        now,
      }));
    }
    const latestCanonicalTimestamp = await this.authorizationTimestamp(revalidatedAt);
    if (session) requireSessionIdentity(session, account.xUserId, now ?? this.clock());
    if (session && (session.mintRecipient !== recipientDraft
      || !hasMintRecipient(session, signature, currentBinding, now ?? this.clock()))) {
      throw v2Error(409, "BINDING_TRANSITION", "The recipient review expired or changed. Start this mint again.");
    }
    if (this.state.getActiveBinding(account.xUserId, this.config.chainId)?.walletBindingId !== currentBinding.walletBindingId) {
      throw v2Error(409, "BINDING_TRANSITION", "The recipient changed before authorization. Review it again.");
    }
    const times = backendAuthorizationTimes(latestCanonicalTimestamp);
    const authorization: MintAuthorization = {
      signatureDigest: signatureDigestHex(signature.signatureId),
      walletBindingId: currentBinding.walletBindingId,
      mintWallet: currentBinding.address,
      svgSha256: metadata.svgSha256,
      pngSha256: metadata.pngSha256,
      metadataSha256: metadata.metadataSha256,
      tokenURIHash: metadata.tokenUriHash,
      authorizationId: randomNonzeroBytes32(),
      validAfter: times.validAfter,
      deadline: times.deadline,
      authorizerEpoch: this.config.authorizerEpoch,
    };
    const digest = mintAuthorizationDigest({ chainId: this.config.chainId, verifyingContract: this.config.contract }, authorization);
    const record: MintAuthorizationRecord = {
      ...authorization,
      signatureId: signature.signatureId,
      tokenUriHash: authorization.tokenURIHash,
      tokenUri: metadata.tokenUri,
      authorizer: this.config.authorizer,
      galleryAttestation: null,
      typedDataDigest: digest,
      status: "prepared",
      createdAt: revalidatedAt,
    };
    let prepared: MintAuthorizationRecord;
    try {
      prepared = this.state.putPreparedAuthorization(record, revalidatedAt);
    } catch (error) {
      throwStateBoundaryError(error);
    }
    if (recipientDraft) recipientDraft.authorizationId = prepared.authorizationId;
    return this.signAndIssue(prepared, (issued) => this.assertPostSignBoundary({
      issued,
      signatureId: signature.signatureId,
      expectedBinding: currentBinding,
      expectedXUserId: account.xUserId,
      claimInstanceId: signature.claimInstanceId,
      expectedRecipientDraft: recipientDraft,
      session,
      now,
    }));
  }

  private async authorizationTimestamp(wallClock: Date): Promise<bigint> {
    if (!this.config.localChainRehearsal) return BigInt(Math.floor(wallClock.getTime() / 1_000));
    let timestamp: bigint;
    try {
      timestamp = await this.chainTimestamp!();
    } catch (error) {
      if (error instanceof V2Error) throw error;
      throw v2Error(503, "CHAIN_UNAVAILABLE", "The local chain timestamp is unavailable.");
    }
    if (typeof timestamp !== "bigint" || timestamp < 60n) {
      throw v2Error(503, "CHAIN_UNAVAILABLE", "The local chain timestamp is unavailable.");
    }
    return timestamp;
  }

  private async assertPostSignBoundary(params: {
    issued: MintAuthorizationRecord;
    signatureId: string;
    expectedBinding: WalletBinding;
    expectedXUserId: string;
    claimInstanceId: string;
    expectedRecipientDraft?: BrowserSession["mintRecipient"];
    session?: BrowserSession;
    now?: Date;
  }): Promise<void> {
    const completedAt = params.now ?? this.clock();
    if (params.session) requireSessionIdentity(params.session, params.expectedXUserId, completedAt);
    const latestCanonicalTimestamp = await this.authorizationTimestamp(completedAt);
    if (params.session) requireSessionIdentity(params.session, params.expectedXUserId, params.now ?? this.clock());
    if (this.state.isSuppressed(params.signatureId)) {
      throw v2Error(409, "MINT_INELIGIBLE", "This signature became unavailable while its authorization was being signed.");
    }
    const binding = this.state.getActiveBinding(params.expectedXUserId, this.config.chainId);
    if (
      !binding
      || binding.walletBindingId !== params.expectedBinding.walletBindingId
      || getAddress(binding.address) !== getAddress(params.expectedBinding.address)
      || binding.version !== params.expectedBinding.version
      || params.issued.walletBindingId !== binding.walletBindingId
    ) {
      throw v2Error(409, "BINDING_TRANSITION", "The active wallet changed while the authorization was being signed. Review it again.");
    }
    if (params.session && params.expectedRecipientDraft && (params.session.mintRecipient !== params.expectedRecipientDraft
      || !hasMintRecipient(params.session, { signatureId: params.signatureId, claimInstanceId: params.claimInstanceId, xUserId: params.expectedXUserId },
        binding, params.now ?? this.clock(), params.issued.authorizationId))) {
      throw v2Error(409, "BINDING_TRANSITION", "The recipient review changed while authorization was being signed. Nothing further was submitted.");
    }
    if (latestCanonicalTimestamp > params.issued.deadline) {
      throw v2Error(410, "AUTHORIZATION_EXPIRED", "The authorization expired before signing completed and remains locked until finalized-chain reconciliation.");
    }
    const projection = this.state.getProjection(params.signatureId);
    if (projection.state === "finalized") {
      throw v2Error(409, "ALREADY_MINTED", "This signature finalized while its authorization was being signed.");
    }
    if (projection.state === "included_unfinalized") {
      throw v2Error(503, "CHAIN_UNAVAILABLE", "A canonical mint was included while its authorization was being signed.");
    }
    if (["validation_pending", "quarantined", "finality_revoked"].includes(projection.state)) {
      throw v2Error(503, "CHAIN_SAFETY_HALT", "Mint verification changed while the authorization was being signed.");
    }
  }

  private async signAndIssue(
    record: MintAuthorizationRecord,
    postIssueGuard: (issued: MintAuthorizationRecord) => void | Promise<void> = () => undefined,
  ): Promise<MintAuthorizationResponse> {
    if (record.status === "issued" && record.galleryAttestation) {
      await this.checkpoint();
      await postIssueGuard(record);
      return this.authorizationResponse(record);
    }
    if (record.status !== "prepared" && record.status !== "signing_unknown") {
      throw v2Error(409, "AUTHORIZATION_UNAVAILABLE", "This authorization cannot be signed in its current state.");
    }
    if (record.authorizerEpoch !== this.config.authorizerEpoch || getAddress(record.authorizer) !== getAddress(this.config.authorizer)) {
      throw v2Error(503, "SIGNER_UNAVAILABLE", "The prepared authorization belongs to another signer epoch and requires reconciliation.");
    }
    const authorization: MintAuthorization = {
      signatureDigest: record.signatureDigest,
      walletBindingId: record.walletBindingId,
      mintWallet: getAddress(record.mintWallet),
      svgSha256: record.svgSha256,
      pngSha256: record.pngSha256,
      metadataSha256: record.metadataSha256,
      tokenURIHash: record.tokenUriHash,
      authorizationId: record.authorizationId,
      validAfter: record.validAfter,
      deadline: record.deadline,
      authorizerEpoch: record.authorizerEpoch,
    };
    const digest = mintAuthorizationDigest(
      { chainId: this.config.chainId, verifyingContract: this.config.contract },
      authorization,
    );
    if (digest !== record.typedDataDigest) {
      throw v2Error(409, "AUTHORIZATION_UNAVAILABLE", "The stored authorization digest failed deterministic reconstruction.");
    }
    if (this.config.localChainRehearsal && await this.authorizationTimestamp(this.clock()) > record.deadline) {
      throw v2Error(410, "AUTHORIZATION_EXPIRED", "The prior authorization is past its deadline and remains locked until local-chain reconciliation.");
    }
    let attestation: Hex;
    // The unsigned intent must survive a crash before the signer is invoked.
    // A failed checkpoint never reaches the signing adapter.
    await this.checkpoint();
    try {
      attestation = await this.signer.sign(record.authorizationId, digest, authorization, this.config);
      await verifyGalleryAttestation(
        { chainId: this.config.chainId, verifyingContract: this.config.contract },
        authorization,
        attestation,
        this.config.authorizer,
      );
    } catch {
      const reconciled = this.state.getAuthorization(record.authorizationId);
      if (reconciled?.status === "issued" && reconciled.galleryAttestation) {
        await this.checkpoint();
        await postIssueGuard(reconciled);
        return this.authorizationResponse(reconciled);
      }
      try {
        this.state.markSigningUnknown(record.authorizationId);
      } catch (error) {
        throwStateBoundaryError(error);
      }
      await this.checkpoint();
      throw v2Error(503, "SIGNER_UNAVAILABLE", "The gallery signer outcome is uncertain; conflicting actions are blocked until reconciliation.");
    }
    let issued: MintAuthorizationRecord;
    try {
      issued = this.state.issueAuthorization(record.authorizationId, attestation);
    } catch (error) {
      throwStateBoundaryError(error);
    }
    // Persist the signature before a caller can submit it to the chain.
    await this.checkpoint();
    await postIssueGuard(issued);
    return this.authorizationResponse(issued);
  }

  reportTransaction(xUserId: string, authorizationId: string, txHash: string, now = new Date()): MintAttempt {
    this.requireEnabled();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw v2Error(400, "INVALID_TRANSACTION_HASH", "Transaction hash must be exactly 32 bytes.");
    const authorization = this.state.getAuthorization(authorizationId);
    if (!authorization) throw v2Error(409, "AUTHORIZATION_UNAVAILABLE", "This mint authorization is not available.");
    const binding = this.state.getActiveBinding(xUserId, this.config.chainId);
    if (!binding || binding.walletBindingId !== authorization.walletBindingId) throw v2Error(403, "NOT_CLAIMANT", "This authorization belongs to another claimant.");
    return this.state.reportAttempt({ authorizationId: authorization.authorizationId, txHash: txHash.toLowerCase() as Hex, state: "reported", reportedAt: now });
  }

  advanceFixture(signatureId: string, xUserId: string, now = new Date()): void {
    this.requireEnabled();
    if (!this.config.fixtureMode || this.config.localChainRehearsal) throw new Error("Fixture chain advancement is disabled.");
    const projection = this.state.getProjection(signatureId);
    const authorization = projection.authorizationId ? this.state.getAuthorization(projection.authorizationId) : null;
    if (!authorization) throw v2Error(409, "AUTHORIZATION_UNAVAILABLE", "Authorize this fixture mint first.");
    const binding = this.state.getActiveBinding(xUserId, this.config.chainId);
    if (!binding || binding.walletBindingId !== authorization.walletBindingId) throw v2Error(403, "NOT_CLAIMANT", "This fixture belongs to another claimant.");
    const txHash = (`0x${sha256(`fixture-tx:${authorization.authorizationId}`)}`) as Hex;
    if (projection.state === "authorized") {
      this.state.observeSubmitted(signatureId, authorization.authorizationId, txHash);
      return;
    }
    if (projection.state === "submitted") {
      this.state.observeIncluded({
        signatureId,
        authorizationId: authorization.authorizationId,
        txHash,
        contract: this.config.contract,
        chainId: this.config.chainId,
        tokenId: signatureTokenId(signatureId),
        mintWallet: authorization.mintWallet,
        blockNumber: 6_820_240n,
        transactionIndex: 4,
        logIndex: 11,
      });
      return;
    }
    if (projection.state === "included_unfinalized") {
      this.state.finalizeMint(signatureId, now, "Fixture dual-provider finality");
      return;
    }
    throw v2Error(409, "AUTHORIZATION_UNAVAILABLE", "This fixture mint cannot advance from its current state.");
  }

  private authorizationResponse(record: MintAuthorizationRecord): MintAuthorizationResponse {
    if (!record.galleryAttestation) throw new Error("Issued authorization is missing its attestation.");
    const authorization: MintAuthorization = {
      signatureDigest: record.signatureDigest,
      walletBindingId: record.walletBindingId,
      mintWallet: getAddress(record.mintWallet),
      svgSha256: record.svgSha256,
      pngSha256: record.pngSha256,
      metadataSha256: record.metadataSha256,
      tokenURIHash: record.tokenUriHash,
      authorizationId: record.authorizationId,
      validAfter: record.validAfter,
      deadline: record.deadline,
      authorizerEpoch: record.authorizerEpoch,
    };
    const data = encodeFunctionData({ abi: MINT_ABI, functionName: "mintAuthorized", args: [authorization, record.tokenUri, record.galleryAttestation] });
    return {
      authorization: {
        signatureDigest: authorization.signatureDigest,
        walletBindingId: authorization.walletBindingId,
        mintWallet: authorization.mintWallet,
        svgSha256: authorization.svgSha256,
        pngSha256: authorization.pngSha256,
        metadataSha256: authorization.metadataSha256,
        tokenURIHash: authorization.tokenURIHash,
        authorizationId: authorization.authorizationId,
        validAfter: authorization.validAfter.toString(),
        deadline: authorization.deadline.toString(),
        authorizerEpoch: authorization.authorizerEpoch,
      },
      tokenURI: record.tokenUri,
      authorizer: record.authorizer,
      galleryAttestation: record.galleryAttestation,
      chainId: this.config.chainId.toString(),
      contract: this.config.contract,
      transaction: { to: this.config.contract, data, value: ZERO_TX_VALUE },
      ...(this.config.fixtureMode ? { fixture: true as const } : {}),
      ...(this.config.localChainRehearsal ? { localChainRehearsal: true as const } : {}),
    };
  }
}
