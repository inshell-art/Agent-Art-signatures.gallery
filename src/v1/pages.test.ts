import { describe, expect, it } from "vitest";
import { MINT_STATE_LABELS } from "../v2/model.js";
import { collectionPage, homePage, mintEntryPage, mintReviewPage, signaturePage, type SignatureMintView, type SignatureView } from "./pages.js";
import { LOCAL_TEST_RECIPIENT, LOCAL_TEST_WALLET } from "../local/wallet.js";
import { SITE_CSS } from "./siteCss.js";
import { xProfileLink } from "./xProfile.js";

const signature: SignatureView = {
  signatureId: `sg1_${"a".repeat(52)}`,
  handleAtClaim: "historical_name",
  gr0kRaw: 37,
  rendererVersion: "artwork/1",
  svgSha256: "b".repeat(64),
  pngSha256: "c".repeat(64),
  cardRendererVersion: "social-card/1",
  xAuthenticatedAt: new Date("2026-08-25T08:58:00.000Z"),
  claimedAt: new Date("2026-08-25T09:00:00.000Z"),
  publicAccountId: "public-account-reference",
};
const finalized: SignatureMintView = {
  state: "finalized",
  label: "Minted on Ethereum",
  mintWallet: `0x${"1".repeat(40)}`,
  currentTokenHolder: `0x${"2".repeat(40)}`,
  txHash: `0x${"3".repeat(64)}`,
  contract: `0x${"4".repeat(40)}`,
  chainName: "Ethereum mainnet",
  tokenId: "12345678901234567890123456789012345678901234567890",
  tokenUri: `ipfs://bafy${"d".repeat(55)}`,
  metadataSha256: `0x${"e".repeat(64)}`,
  finalizedAt: new Date("2026-09-06T00:00:00.000Z"),
  finalityLabel: "Finalized",
  explorerTransactionUrl: `https://etherscan.io/tx/0x${"3".repeat(64)}`,
  explorerContractUrl: `https://etherscan.io/address/0x${"4".repeat(40)}`,
};

describe("compact public gallery captions", () => {
  it.each(["claimed", "minted"] as const)("pairs the handle and gr0k without a date in %s", (tab) => {
    const entry = tab === "minted" ? { ...signature, finalizedAt: finalized.finalizedAt!, mintWallet: finalized.mintWallet!, currentTokenHolder: finalized.currentTokenHolder! } : signature;
    const html = homePage(false, [entry], null, false, tab);
    const card = html.match(/<article class="gallery-item"[\s\S]*?<\/article>/)![0];
    expect(card).toContain(`<strong>${xProfileLink("historical_name")}</strong><span>gr0k 37</span>`);
    expect(card).not.toContain("<time");
    expect(card).not.toContain("2026-08-25");
    expect(card).not.toContain("2026-09-06");
    expect(card).toContain(`/signatures/${signature.signatureId}`);
    expect(card).toContain(`/artifacts/${signature.signatureId}.svg`);
    expect(card).toContain(tab === "minted" ? "Minted by linked wallet" : "Claimed via X");
    expect(SITE_CSS).toMatch(/\.gallery-card-copy\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/);
    expect(SITE_CSS).toMatch(/\.gallery-card-copy>span\{[^}]*grid-column:2;grid-row:1;white-space:nowrap/);
    expect(SITE_CSS).toMatch(/\.gallery-card-copy>strong\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
    expect(SITE_CSS).not.toContain(".gallery-card-copy time");
  });
});

function provenance(html: string): string {
  const disclosure = html.match(/<details class="signature-provenance">([\s\S]*?)<\/details>/)?.[1];
  if (!disclosure) throw new Error("Expected a closed-by-default native provenance disclosure.");
  return disclosure;
}

describe("minimal shared signature detail", () => {
  it.each(["wallet", "reauthenticate", "ready"] as const)("shows only remaining mint steps for %s", stage => {
    for (const linked of [false, true]) {
      const html = mintEntryPage({ signature, stage, account: {
        currentHandle: "historical_name", mintEnabled: true, mintChainId: "31337", fixtureMode: false,
        wallet: linked ? { address: LOCAL_TEST_WALLET, chainId: "31337", chainName: "Anvil", provedAt: new Date() } : null,
      } });
      const steps = html.match(/<ol class="mint-entry-steps"[^>]*>([\s\S]*?)<\/ol>/)![1];
      expect(steps.includes("Link and verify your wallet")).toBe(!linked);
      expect(steps).toContain("<li>Review the mint details</li><li>Confirm the transaction in your wallet</li>");
      expect(steps).not.toContain("Sign in");
      if (stage === "reauthenticate") {
        expect(html).toContain("This security check does not change your claim or wallet.");
        expect(html).toContain(">Confirm X sign-in</span>");
        expect(html).toContain('name="purpose" value="account_login"');
        expect(html).toContain(`name="return_to" value="/signatures/${signature.signatureId}/mint"`);
      }
    }
  });
  it.each(["sign-in", "wrong-account", "paused", "pending"] as const)("does not solicit new mint steps during %s", stage => {
    const html = mintEntryPage({ signature, stage, account: { mintEnabled: true, mintChainId: "31337", fixtureMode: false } });
    expect(html).not.toContain('class="mint-entry-steps"');
    expect(html).not.toContain("Sign in as the claimant");
  });
  it.each([undefined, "unminted", "authorized", "expired"] as const)("places the mint action before provenance with a hidden explanation (%s)", state => {
    const html = signaturePage(signature, false, state ? { state, label: state } : undefined, "", false, {
      csrfToken: "test", claimInstanceId: "test", reauthRequired: false, allowed: true,
    });
    expect(html.indexOf('class="signature-mint-entry"')).toBeLessThan(html.indexOf('class="signature-tools"'));
    expect(html).toContain('data-action-tooltip="mint-tooltip" aria-describedby="mint-tooltip"');
    expect(html).toContain('id="mint-tooltip" role="tooltip" hidden>Link a wallet if needed, then review and confirm the mint in your wallet.</span>');
    expect(html).not.toContain("Sign-in and wallet linking come next.");
    expect(html).not.toContain('<p class="auth-note">Only the original claimant can mint.');
    expect(html).toMatch(/src="\/assets\/action-tooltip.js/);
  });
  it.each([undefined, finalized])("keeps navigation at the top without duplicate destination CTAs below the work (mint=%s)", mint => {
    const html = signaturePage(signature, false, mint);
    expect(html).not.toContain('aria-label="Claim destinations"');
    expect(html).not.toContain("My Collection →");
    expect(html).not.toContain("Claimed gallery →");
    expect(html).toContain('class="collection-shortcut" href="/me"');
    expect(html).toContain(`class="gallery-return" href="/?tab=${mint ? "minted" : "claimed"}"`);
    expect(html).toContain('<div class="signature-tools">');
    expect(html).toContain('data-signature-status="claimed"');
    expect(html).not.toContain("Your signature is not claimed yet");
  });

  it.each([undefined, finalized])("removes the standalone date but retains historical timestamps in provenance (mint=%s)", mint => {
    const html = signaturePage(signature, false, mint);
    const evidence = provenance(html);
    expect(html).not.toContain('class="signature-caption"');
    expect(html).not.toContain("<time");
    expect(evidence).toContain(signature.claimedAt.toISOString());
    expect(evidence).toContain(signature.xAuthenticatedAt.toISOString());
    expect(html.replace(evidence, "")).not.toContain(signature.claimedAt.toISOString().slice(0, 10));
  });
  it("uses the gallery canvas, a single artwork and small milestones without the former split panels", () => {
    const html = signaturePage(signature, false, finalized, "https://signatures.gallery");
    expect(html).toContain('<body class="book-page">');
    expect(html).toContain(`<h1 id="signature-heading">${xProfileLink("historical_name")}</h1>`);
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain(`src="/artifacts/${signature.signatureId}.svg"`);
    expect(html.match(/data-signature-status="claimed"/g)).toHaveLength(1);
    expect(html.match(/data-signature-status="minted"/g)).toHaveLength(1);
    expect(html).toContain('href="/?tab=minted" title="Gallery" aria-label="Gallery"');
    expect(html.match(/class="home-icon"/g)).toHaveLength(1);
    expect(html).not.toContain('class="return-arrow"');
    expect(html).toContain('aria-label="Open canonical SVG"');
    for (const removed of ['class="art-label"', 'class="eyebrow"', 'class="gr0k-readout"', 'class="button secondary"', 'class="mint-provenance"']) {
      expect(html).not.toContain(removed);
    }
  });

  it.each(Object.entries(MINT_STATE_LABELS).filter(([state]) => state !== "finalized"))(
    "never shows a Minted milestone or indexes the page for %s",
    (state, label) => {
      const html = signaturePage(signature, false, { state, label });
      expect(html).toContain('data-signature-status="claimed"');
      expect(html).not.toContain('data-signature-status="minted"');
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(html).toContain('href="/?tab=claimed" title="Gallery" aria-label="Gallery"');
      expect(html.match(/class="home-icon"/g)).toHaveLength(1);
      const displayLabel = state === "included_unfinalized" ? "Confirming" : label;
      expect(provenance(html)).toContain(displayLabel);
      if (state !== "unminted") expect(html).toContain(`<span class="signature-pending">${displayLabel}</span>`);
    },
  );

  it("also renders a committed claim when minting is unavailable", () => {
    const html = signaturePage(signature, false);
    expect(html).toContain('data-signature-status="claimed"');
    expect(html).not.toContain('data-signature-status="minted"');
    expect(html).not.toContain("Mint status</h2>");
    expect(provenance(html)).toContain(signature.publicAccountId);
  });

  it("puts complete historical, artwork and chain evidence inside one closed disclosure", () => {
    const html = signaturePage(signature, false, finalized);
    const evidence = provenance(html);
    const surface = html.replace(evidence, "");
    for (const value of [signature.publicAccountId, signature.rendererVersion, signature.svgSha256, signature.pngSha256, signature.cardRendererVersion, signature.xAuthenticatedAt.toISOString(), finalized.mintWallet!, finalized.currentTokenHolder!, finalized.txHash!, finalized.contract!, finalized.tokenId!, finalized.tokenUri!, finalized.metadataSha256!, finalized.finalizedAt!.toISOString()]) {
      expect(evidence).toContain(value);
      expect(surface).not.toContain(value);
    }
    expect(evidence).toContain("Initially minted to");
    expect(evidence).toContain("Current token holder");
    expect(evidence).toContain("A later token holder is not implied to control the claimant’s X account.");
    expect(evidence).toContain(`href="${finalized.explorerTransactionUrl}"`);
    expect(evidence).toContain(`href="${finalized.explorerContractUrl}"`);
  });

  it("retains canonical SVG display and PNG social previews with production indexing only at finality", () => {
    const html = signaturePage(signature, false, finalized, "https://signatures.gallery/");
    expect(html).toContain('<meta name="robots" content="index">');
    expect(html).toContain(`property="og:image" content="https://signatures.gallery/artifacts/${signature.signatureId}.png"`);
    expect(html).toContain('property="og:image:type" content="image/png"');
    expect(html).toContain(`name="twitter:image" content="https://signatures.gallery/artifacts/${signature.signatureId}.png"`);
    expect(html).not.toContain(`<img src="/artifacts/${signature.signatureId}.png"`);
  });

  it("moves the fictional-account disclaimer to the global watermark and qualifies provenance", () => {
    const html = signaturePage(signature, true, finalized);
    expect(html.replace(provenance(html), "")).toContain('class="rehearsal-watermark"');
    expect(html).not.toContain("Fictional demo</span>");
    expect(html).toContain("No participation or endorsement is implied.");
    const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
    expect(overlay).toContain("Simulated chain provenance");
    expect(overlay).toContain("not production X account provenance");
    expect(provenance(html)).toContain("<h2>Claim</h2>");
    expect(provenance(html)).toContain("<h2>Mint</h2>");
    expect(provenance(html)).not.toMatch(/fixture|simulat|development|not production X/i);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("distinguishes local Anvil events from fabricated mints and Ethereum finality", () => {
    const html = signaturePage(signature, true, { ...finalized, chainName: "Local Anvil", finalityLabel: "Manual local promotion" }, "", true);
    expect(html).toContain('class="rehearsal-watermark"');
    expect(html).toContain("Repo-local Anvil chain, not Ethereum mainnet or Sepolia.");
    expect(html).not.toContain("Fictional demo</span>");
    const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
    expect(overlay).toContain("Local development-chain provenance");
    expect(overlay).toContain("Locally promoted at");
    expect(overlay).toContain("Manual local promotion");
    expect(provenance(html)).toContain("Local Anvil");
    expect(provenance(html)).not.toMatch(/development-chain|Locally promoted|Manual local promotion/);
    expect(provenance(html)).not.toContain("Simulated chain provenance");
  });

  it.each([undefined, finalized])("uses the same product provenance markup with or without fixture context (mint=%s)", mint => {
    const main = (html: string) => html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main(signaturePage(signature, true, mint))).toBe(main(signaturePage(signature, false, mint)));
  });

  it.each([[false, "Awaiting simulated finality"], [true, "Awaiting automatic local promotion"]] as const)(
    "uses truthful pending-state language for local Anvil=%s",
    (localChain, label) => {
      const html = signaturePage(signature, true, { state: "included_unfinalized", label: MINT_STATE_LABELS.included_unfinalized }, "", localChain);
      expect(html).toContain('<span class="signature-pending">Confirming</span>');
      expect(html.slice(html.indexOf('<aside class="rehearsal-watermark"'))).toContain(label);
      expect(html).not.toContain(MINT_STATE_LABELS.included_unfinalized);
      expect(html).not.toContain('data-signature-status="minted"');
    },
  );

  it("escapes dynamic values in the compact heading, tags and disclosure", () => {
    const html = signaturePage({ ...signature, handleAtClaim: '<img src=x onerror="bad">', rendererVersion: "<script>bad</script>" }, false, { state: "quarantined", label: "<script>bad</script>" });
    expect(html).not.toContain('<img src=x onerror="bad">');
    expect(html).not.toContain("<script>bad</script>");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
  });

  it("keeps shared regular typography, borderless artwork and home-style milestone tags", () => {
    expect(SITE_CSS).toContain("body,body :not(svg,svg *){font-size:var(--ui-font-size);font-weight:400}");
    expect(SITE_CSS).toContain(".signature-sheet{width:100%;max-width:42rem;margin-inline:auto}");
    expect(SITE_CSS).toMatch(/\.signature-tag\{[^}]*padding:var\(--tag-padding\)/);
    expect(SITE_CSS).toMatch(/\.signature-tag\{[^}]*border:0/);
    expect(SITE_CSS).toMatch(/\.signature-tag\{[^}]*background:var\(--paper-2\)/);
    const art = SITE_CSS.match(/\.signature-art img\{([^}]*)\}/)![1];
    expect(art).not.toMatch(/border|box-shadow|transform/);
    expect(SITE_CSS).not.toContain(".review-wrap,.signature-page");
    expect(SITE_CSS).not.toContain(".review-copy,.signature-record");
    expect(SITE_CSS).toContain(".signature-provenance>summary:focus-visible");
    expect(SITE_CSS).toMatch(/\.signature-facts dd\{[^}]*overflow-wrap:anywhere/);
  });
});

describe("interactive local rehearsal pages", () => {
  const wallet = { address: LOCAL_TEST_WALLET, chainName: "Local Anvil", chainId: "31337", provedAt: new Date() };
  const collection = { currentHandle: "alice", signatures: [signature], csrfToken: "csrf", fixtureMode: true, mintEnabled: true, mintChainId: "31337", localChainRehearsal: true, wallet };

  it("offers an explicit local TEST wallet separately from an injected wallet", () => {
    const html = collectionPage(collection);
    expect(html).toContain("data-local-chain-rehearsal");
    expect(html).toContain('data-wallet-provider="local"');
    expect(html).toContain('data-wallet-provider="injected"');
    expect(html).toContain("Public test keys. Never send real funds.");
    expect(html).toContain(LOCAL_TEST_WALLET);
    expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toContain("Minting paused");
    expect(html).not.toContain("manually promoted");
  });

  it.each([false, true])("does not offer local controls outside local-chain rehearsal (fixtures=%s)", (fixtureMode) => {
    const html = collectionPage({ ...collection, fixtureMode, localChainRehearsal: false });
    expect(html).not.toContain("data-local-chain-rehearsal");
    expect(html).not.toContain('data-wallet-provider="local"');
    expect(html).not.toContain("data-local-transfer");
  });

  it("allows retry after authorizing but cancelling before submission", () => {
    const authorized = collectionPage({ ...collection, mintBySignature: new Map([[signature.signatureId, { state: "authorized", label: "Authorized" }]]) });
    expect(authorized).toContain(`/signatures/${signature.signatureId}/mint`);
    expect(authorized).toContain('data-local-mint-pending data-signature-id=');
    expect(authorized).toContain('data-mint-state="authorized"');
  });

  it.each(["authorized", "submitted", "included_unfinalized", "validation_pending"])("polls %s so a broadcast redirect before first observation still becomes Minted", (state) => {
    const html = collectionPage({ ...collection, mintBySignature: new Map([[signature.signatureId, { state, label: state }]]) });
    expect(html).toContain('data-local-mint-pending data-signature-id=');
    expect(html).toContain(`data-mint-state="${state}"`);
    expect(html).not.toContain("data-advance-rehearsal");
    expect(collectionPage({ ...collection, localChainRehearsal: false, mintBySignature: new Map([[signature.signatureId, { state, label: state }]]) })).not.toContain("data-local-mint-pending");
  });

  it("offers the fixed-recipient transfer only when the linked local wallet still owns a finalized token", () => {
    const owned = { ...finalized, currentTokenHolder: LOCAL_TEST_WALLET };
    const html = collectionPage({ ...collection, mintBySignature: new Map([[signature.signatureId, owned]]) });
    expect(html).toContain("data-local-transfer");
    expect(html).toContain(LOCAL_TEST_RECIPIENT);
    for (const projection of [{ ...owned, state: "included_unfinalized" }, { ...owned, currentTokenHolder: LOCAL_TEST_RECIPIENT }]) {
      expect(collectionPage({ ...collection, mintBySignature: new Map([[signature.signatureId, projection]]) })).not.toContain("data-local-transfer");
    }
    expect(collectionPage({ ...collection, wallet: { ...wallet, address: LOCAL_TEST_RECIPIENT }, mintBySignature: new Map([[signature.signatureId, owned]]) })).not.toContain("data-local-transfer");
  });

  it("states local limits truthfully and offers both local and injected mint submission", () => {
    const html = mintReviewPage({ signature, currentHandle: "alice", wallet, csrfToken: "csrf", chainName: "Local Anvil", metadataUri: "ipfs://test", metadataSha256: "hash", signatureDigest: "digest", tokenUriHash: "hash", contract: "0xcontract", fixtureMode: true, localChainRehearsal: true });
    expect(html).toContain('data-local-chain-rehearsal="true" data-local-wallet="true"');
    expect(html).toContain("Authorize with local TEST wallet");
    expect(html).toContain('<button class="auth-action" type="submit"><span>Authorize mint</span></button>');
    expect(html).toContain('form="mint-authorization" data-wallet-provider="local"');
    expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toContain("Authorize with local TEST wallet");
    expect(html).toContain("X identity is emulated, IPFS artifacts stay local");
    expect(html).not.toContain("pauses new mint authorization");
  });
});
