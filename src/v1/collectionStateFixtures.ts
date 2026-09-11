import { collectionPage, homePage, mintEntryPage, mintPage, signInRequiredPage, type CollectionMintView, type MintEntryStage, type SignatureView } from "./pages.js";
import { CARD_RENDERER_VERSION, RENDERER_VERSION, formalSignatureRenderer } from "./renderer.js";
import { GR0K_SCALE } from "./input.js";
import { MINT_STATE_LABELS } from "../v2/model.js";
import { COLLECTION_STATE_FIXTURES } from "./collectionStateCatalog.js";

export { COLLECTION_STATE_FIXTURES } from "./collectionStateCatalog.js";

const fixtureSignature: SignatureView = {
  signatureId: `sg1_${"c".repeat(52)}`, handleAtClaim: "alice", gr0kRaw: 37,
  rendererVersion: RENDERER_VERSION, cardRendererVersion: CARD_RENDERER_VERSION,
  svgSha256: "0".repeat(64), pngSha256: "0".repeat(64), publicAccountId: "xa1_ui_fixture_only",
  xAuthenticatedAt: new Date("2026-09-01T10:00:00Z"), claimedAt: new Date("2026-09-01T10:01:00Z"),
};
const initialWallet = "0x1111111111111111111111111111111111111111";
const otherHolder = "0x2222222222222222222222222222222222222222";
const mintStates: Record<string, keyof typeof MINT_STATE_LABELS> = {
  authorized: "authorized", submitted: "submitted", confirming: "included_unfinalized", minted: "finalized",
  transferred: "finalized", "validation-pending": "validation_pending", quarantined: "quarantined", "finality-revoked": "finality_revoked",
};

export function collectionStatePage(key: string, publicOrigin: string, view = "collection"): string | null {
  const fixture = COLLECTION_STATE_FIXTURES.find((state) => state.key === key);
  if (!fixture || !["collection", "mint"].includes(view)) return null;
  const preview = { state: key, label: fixture.label, description: fixture.description };
  if (view === "mint") {
    const gates: Record<string, MintEntryStage> = { "signed-out": "sign-in", authorized: "pending", submitted: "pending", confirming: "pending", "validation-pending": "pending", "mint-paused": "paused", "wrong-claimant": "wrong-account" };
    const mintPageKeys = ["claimed", "wallet-linked", "recipient-verified", "reauthenticate", "renamed"];
    const gate = gates[key];
    if (!gate && !mintPageKeys.includes(key)) return null;
    const currentHandle = key === "signed-out" ? undefined : key === "wrong-claimant" ? "bob" : key === "renamed" ? "alice_studio" : "alice";
    const previousRecipient = ["claimed", "signed-out", "reauthenticate"].includes(key) ? null : "ui-fixture-binding";
    const account = {
      currentHandle,
      csrfToken: key === "signed-out" ? undefined : "ui-fixture-not-a-session-token",
      fixtureMode: true, localOAuthMode: true, mintEnabled: key !== "mint-paused", mintChainId: "1",
      wallet: previousRecipient ? { address: initialWallet, chainId: "1", chainName: "Ethereum · UI fixture", provedAt: new Date("2026-09-01T10:02:00Z") } : null,
      mintSignatureId: fixtureSignature.signatureId, mintClaimInstanceId: "ui-fixture-claim-instance",
      mintPreviousBindingId: previousRecipient,
      mintRecipientConfirmed: !gate, previewOnly: true,
    };
    if (gate) return mintEntryPage({ signature: fixtureSignature, stage: gate, preview, account });
    // Only a fresh proof for this exact mint fills the recipient; a previous
    // recipient stays a convenience and still shows the connect control.
    const verified = key === "recipient-verified";
    return mintPage({
      signature: fixtureSignature, currentHandle: currentHandle!, account, preview,
      wallet: verified ? { address: initialWallet, chainId: "1", chainName: "Ethereum · UI fixture", provedAt: new Date("2026-09-01T10:02:00Z") } : null,
      walletBindingId: verified ? `0x${"b".repeat(64)}` : undefined,
      claimInstanceId: "ui-fixture-claim-instance", csrfToken: "ui-fixture-not-a-session-token",
      chainName: "Ethereum · UI fixture", metadataUri: `ipfs://bafkrei${"a".repeat(52)}`,
      metadataSha256: "0".repeat(64), signatureDigest: `0x${"0".repeat(64)}`, tokenUriHash: `0x${"0".repeat(64)}`,
      contract: `0x${"3".repeat(40)}`, fixtureMode: true,
    });
  }
  if (key === "signed-out") return signInRequiredPage(true, true, false, preview, publicOrigin);
  if (key === "gallery-claimed-empty" || key === "gallery-minted-empty") {
    return homePage(true, [], null, false, key === "gallery-claimed-empty" ? "claimed" : "minted", { publicOrigin, preview });
  }
  const state = mintStates[key] ?? "unminted";
  const status: CollectionMintView = { state, label: MINT_STATE_LABELS[state] };
  if (["submitted", "included_unfinalized", "finalized"].includes(state)) status.txHash = `0x${"a".repeat(64)}`;
  if (state === "finalized") {
    status.tokenId = "42";
    status.currentTokenHolder = key === "transferred" ? otherHolder : initialWallet;
  }
  return collectionPage({
    currentHandle: key === "empty" ? "newcomer" : key === "wrong-claimant" ? "bob" : key === "renamed" ? "alice_studio" : "alice",
    signatures: ["empty", "wrong-claimant"].includes(key) ? [] : [fixtureSignature], csrfToken: "ui-fixture-not-a-session-token",
    fixtureMode: true, localOAuthMode: true, mintEnabled: key !== "mint-paused", mintChainId: "1",
    wallet: ["empty", "claimed"].includes(key) ? null : { address: initialWallet, chainId: "1", chainName: "Ethereum · UI fixture", provedAt: new Date("2026-09-01T10:02:00Z") },
    walletLinkConfirmed: key !== "reauthenticate", mintBySignature: new Map([[fixtureSignature.signatureId, status]]),
    publicOrigin, preview,
  });
}

let artwork: Buffer | undefined;
export function collectionStateArtwork(): Buffer {
  // Fixed literal/input only. No arbitrary render endpoint and no artifact persistence.
  artwork ??= Buffer.from(formalSignatureRenderer.render({ handle: fixtureSignature.handleAtClaim, gr0kRaw: fixtureSignature.gr0kRaw, gr0kScale: GR0K_SCALE, rendererVersion: RENDERER_VERSION }).svgUtf8);
  return artwork;
}
