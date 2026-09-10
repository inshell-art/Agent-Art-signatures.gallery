export type MintState =
  | "unminted"
  | "authorized"
  | "submitted"
  | "included_unfinalized"
  | "finalized"
  | "validation_pending"
  | "quarantined"
  | "finality_revoked";

export const MINT_STATE_LABELS: Record<MintState, string> = {
  unminted: "Not minted",
  authorized: "Ready for wallet confirmation",
  submitted: "Transaction submitted",
  included_unfinalized: "Included; awaiting Ethereum finality",
  finalized: "Minted on Ethereum",
  validation_pending: "Mint verification is temporarily pending",
  quarantined: "Mint verification requires review",
  finality_revoked: "Ethereum finality incident",
};

export type WalletBindingStatus = "active" | "replaced" | "revoked";
export type ChallengeStatus = "pending" | "processing" | "consumed" | "failed";
export type AuthorizationStatus =
  | "prepared"
  | "signing_unknown"
  | "signing_failed"
  | "issued"
  | "expired"
  | "revoked"
  | "consumed";

export interface WalletBindingChallenge {
  challengeId: string;
  sessionIdDigest: string;
  xUserId: string;
  publicAccountId: string;
  address: `0x${string}`;
  chainId: bigint;
  nonce: string;
  message: string;
  issuedAt: Date;
  expiresAt: Date;
  status: ChallengeStatus;
}

export interface WalletBinding {
  walletBindingId: `0x${string}`;
  xUserId: string;
  publicAccountId: string;
  chainId: bigint;
  address: `0x${string}`;
  siweMessage: string;
  walletProof: `0x${string}`;
  verificationScheme: "eip191_eoa_65byte_low_s" | "fixture_seed";
  verificationBlockNumber: bigint;
  verificationBlockHash: `0x${string}`;
  provedAt: Date;
  status: WalletBindingStatus;
  version: number;
}

export interface FrozenTokenMetadata {
  signatureId: string;
  metadataVersion: "sg-nft-metadata-1.0.0";
  importerProfile: "sg-ipfs-unixfs-1.0.0";
  svgCid: string;
  pngCid: string;
  metadataCid: string;
  svgSha256: `0x${string}`;
  pngSha256: `0x${string}`;
  metadataSha256: `0x${string}`;
  tokenUri: string;
  tokenUriHash: `0x${string}`;
  canonicalJson: string;
  verifiedAt: Date;
}

export interface MintAuthorizationRecord {
  authorizationId: `0x${string}`;
  signatureId: string;
  signatureDigest: `0x${string}`;
  walletBindingId: `0x${string}`;
  mintWallet: `0x${string}`;
  svgSha256: `0x${string}`;
  pngSha256: `0x${string}`;
  metadataSha256: `0x${string}`;
  tokenUriHash: `0x${string}`;
  validAfter: bigint;
  deadline: bigint;
  authorizerEpoch: number;
  tokenUri: string;
  authorizer: `0x${string}`;
  galleryAttestation: `0x${string}` | null;
  typedDataDigest: `0x${string}`;
  status: AuthorizationStatus;
  createdAt: Date;
}

export interface MintAttempt {
  /** Set only after the guarded local TEST wallet broadcasts; browser reports cannot set this. */
  localWalletBroadcast?: true;
  authorizationId: `0x${string}`;
  txHash: `0x${string}`;
  state: "reported" | "observed" | "reverted" | "stale_unknown" | "included";
  reportedAt: Date;
}

export interface MintProjection {
  signatureId: string;
  state: MintState;
  authorizationId: `0x${string}` | null;
  txHash: `0x${string}` | null;
  contract: `0x${string}` | null;
  chainId: bigint | null;
  tokenId: bigint | null;
  mintWallet: `0x${string}` | null;
  currentTokenHolder: `0x${string}` | null;
  blockNumber: bigint | null;
  transactionIndex: number | null;
  logIndex: number | null;
  finalizedAt: Date | null;
  finalityLabel: string | null;
}

export interface GalleryEntry extends MintProjection {
  state: "finalized";
  signatureId: string;
  txHash: `0x${string}`;
  contract: `0x${string}`;
  chainId: bigint;
  tokenId: bigint;
  mintWallet: `0x${string}`;
  currentTokenHolder: `0x${string}`;
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  finalizedAt: Date;
}

export interface MintStatusView {
  projection: MintProjection;
  label: string;
  authorization: MintAuthorizationRecord | null;
  attempts: MintAttempt[];
  metadata: FrozenTokenMetadata | null;
}

export function unmintedProjection(signatureId: string): MintProjection {
  return {
    signatureId,
    state: "unminted",
    authorizationId: null,
    txHash: null,
    contract: null,
    chainId: null,
    tokenId: null,
    mintWallet: null,
    currentTokenHolder: null,
    blockNumber: null,
    transactionIndex: null,
    logIndex: null,
    finalizedAt: null,
    finalityLabel: null,
  };
}
