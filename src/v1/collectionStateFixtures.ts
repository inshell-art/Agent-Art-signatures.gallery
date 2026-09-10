import { collectionPage, homePage, mintEntryPage, signInRequiredPage, type CollectionMintView, type MintEntryStage, type SignatureView } from "./pages.js";
import { DEV_CARD_RENDERER_VERSION, DEV_RENDERER_VERSION, developmentFixtureRenderer } from "./renderer.js";
import { GR0K_SCALE } from "./input.js";
import { MINT_STATE_LABELS } from "../v2/model.js";
import { COLLECTION_STATE_FIXTURES } from "./collectionStateCatalog.js";

export { COLLECTION_STATE_FIXTURES } from "./collectionStateCatalog.js";

const fixtureSignature: SignatureView = {
  signatureId: `sg1_${"c".repeat(52)}`, handleAtClaim: "alice", gr0kRaw: 371924,
  rendererVersion: DEV_RENDERER_VERSION, cardRendererVersion: DEV_CARD_RENDERER_VERSION,
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
    const stages: Record<string, MintEntryStage> = { "signed-out": "sign-in", claimed: "wallet", "wallet-linked": "ready", authorized: "ready", "mint-paused": "paused", reauthenticate: "reauthenticate", renamed: "ready" };
    const stage = stages[key];
    if (!stage) return null;
    return mintEntryPage({ signature: fixtureSignature, stage, preview, account: {
      currentHandle: key === "signed-out" ? undefined : key === "renamed" ? "alice_studio" : "alice",
      csrfToken: key === "signed-out" ? undefined : "ui-fixture-not-a-session-token",
      fixtureMode: true, localOAuthMode: true, mintEnabled: key !== "mint-paused", mintChainId: "1",
      wallet: ["claimed", "signed-out"].includes(key) ? null : { address: initialWallet, chainId: "1", chainName: "Ethereum · UI fixture", provedAt: new Date("2026-09-01T10:02:00Z") },
      reauthRequired: key === "reauthenticate", previewOnly: true,
    } });
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
    currentHandle: key === "empty" ? "newcomer" : key === "renamed" ? "alice_studio" : "alice",
    signatures: key === "empty" ? [] : [fixtureSignature], csrfToken: "ui-fixture-not-a-session-token",
    fixtureMode: true, localOAuthMode: true, mintEnabled: key !== "mint-paused", mintChainId: "1",
    wallet: ["empty", "claimed"].includes(key) ? null : { address: initialWallet, chainId: "1", chainName: "Ethereum · UI fixture", provedAt: new Date("2026-09-01T10:02:00Z") },
    reauthRequired: key === "reauthenticate", mintBySignature: new Map([[fixtureSignature.signatureId, status]]),
    publicOrigin, preview,
  });
}

let artwork: Buffer | undefined;
export function collectionStateArtwork(): Buffer {
  // Fixed literal/input only. No arbitrary render endpoint and no artifact persistence.
  artwork ??= Buffer.from(developmentFixtureRenderer.render({ handleNormalized: fixtureSignature.handleAtClaim, gr0kRaw: fixtureSignature.gr0kRaw, gr0kScale: GR0K_SCALE, rendererVersion: DEV_RENDERER_VERSION }).svgUtf8);
  return artwork;
}
