import { describe, expect, it } from "vitest";
import { developmentWalletControls } from "./accountPanel.js";
import { collectionPage, errorPage, layout, localOAuthAuthorizePage, mintReviewPage, type SignatureView } from "./pages.js";
import { COLLECTION_STATE_FIXTURES, collectionStatePage } from "./collectionStateFixtures.js";
import { LOCAL_TEST_WALLET } from "../local/wallet.js";

const main = (html: string) => html.match(/<main>[\s\S]*?<\/main>/)![0];
const dev = (html: string) => html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
const privateAccount = { fixtureMode: true, mintEnabled: true, mintChainId: "31337", currentHandle: "alice", csrfToken: "private-csrf" };
const signature: SignatureView = { signatureId: `sg1_${"a".repeat(52)}`, handleAtClaim: "alice", gr0kRaw: 371924, rendererVersion: "art/1", cardRendererVersion: "card/1", svgSha256: "a".repeat(64), pngSha256: "b".repeat(64), claimedAt: new Date("2026-09-01"), xAuthenticatedAt: new Date("2026-09-01"), publicAccountId: "public-reference" };

describe("development tools stay outside the product", () => {
  it.each(COLLECTION_STATE_FIXTURES)("keeps $key free of developer controls", ({ key }) => {
    expect(main(collectionStatePage(key, "http://127.0.0.1:3000")!)).not.toMatch(/data-advance-rehearsal|data-local-transfer|data-wallet-provider="(?:local|fixture)"|grok-local-sample|Use local OAuth|Rehearse local claim|Refresh local rehearsal|Simulate account/);
  });

  it.each(["authorized", "submitted", "included_unfinalized"])("moves %s lifecycle advancement to DEV with its original CSRF binding", state => {
    const html = collectionPage({ ...privateAccount, signatures: [signature], mintBySignature: new Map([[signature.signatureId, { state, label: state }]]) });
    expect(main(html)).not.toContain("Advance rehearsal");
    expect(dev(html)).toContain("Advance rehearsal");
    expect(dev(html)).toContain('data-csrf="private-csrf"');
    expect(dev(html)).toContain(`data-signature-id="${signature.signatureId}"`);
  });

  it.each([{}, { mintEnabled: false }, { reauthRequired: true }, { previewOnly: true }, { currentHandle: undefined }, { csrfToken: undefined }])("does not offer tools without a fresh authorized private account (%j)", override => {
    const params = Object.keys(override).length ? { ...privateAccount, ...override } : { ...privateAccount, fixtureMode: false };
    expect(developmentWalletControls(params)).toBe("");
  });

  it.each([false, true])("keeps local=%s test wallet controls in DEV only", local => {
    const html = collectionPage({ ...privateAccount, signatures: [], localChainRehearsal: local });
    expect(main(html)).toContain("Link wallet");
    expect(main(html)).not.toMatch(/Use local TEST wallet|Use simulated wallet|data-wallet-provider="(?:local|fixture)"/);
    expect(dev(html)).toContain(local ? "Use local TEST wallet" : "Use simulated wallet");
  });

  it("keeps local mint submission tied to the real consent form but outside the product", () => {
    const html = mintReviewPage({ signature, currentHandle: "alice", wallet: { address: LOCAL_TEST_WALLET, chainId: "31337", chainName: "Anvil", provedAt: new Date() }, csrfToken: "private-csrf", chainName: "Anvil", metadataUri: "ipfs://test", metadataSha256: "hash", signatureDigest: "digest", tokenUriHash: "hash", contract: "0xcontract", fixtureMode: true, localChainRehearsal: true });
    expect(main(html)).toContain('id="mint-authorization"');
    expect(main(html)).toContain('required type="checkbox" name="permanence_acknowledged"');
    expect(main(html)).not.toContain('data-wallet-provider="local"');
    expect(dev(html)).toContain('type="submit" form="mint-authorization" data-wallet-provider="local"');
    expect(dev(html)).toContain('data-dev-mint-controls');
  });

  it("puts the whole provider simulator in an explicitly open DEV panel", () => {
    const html = localOAuthAuthorizePage({ requestId: "test", accounts: [{ key: "alice", username: "alice", displayName: "Test Alice" }] });
    expect(main(html)).not.toContain('action="/dev/oauth/x/authorize"');
    expect(dev(html)).toContain('<details class="rehearsal-disclosure" open>');
    for (const decision of ["approve", "deny", "provider_error"]) expect(dev(html)).toContain(`value="${decision}"`);
  });

  it("shows clear error recovery while keeping emulator diagnostics in DEV", () => {
    const html = errorPage(503, "LOCAL_OAUTH_UNAVAILABLE", "The local provider simulated an error.", true, true);
    expect(main(html)).toContain("Sign-in could not be completed. Please try again.");
    expect(main(html)).not.toContain("provider simulated");
    expect(main(html)).not.toContain("LOCAL_OAUTH_UNAVAILABLE");
    expect(dev(html)).toContain("The local provider simulated an error.");
    expect(dev(html)).toContain("LOCAL_OAUTH_UNAVAILABLE");
  });

  it("never publishes injected developer tools in a production layout", () => {
    const html = layout({ title: "Test", description: "Test", body: "Product", developmentTools: '<button data-csrf="private-token">Test action</button>', developmentOpen: true });
    expect(html).not.toMatch(/private-token|Test action|rehearsal-disclosure/);
  });
});
