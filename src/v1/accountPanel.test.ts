import { describe, expect, it } from "vitest";
import { accountPanelContent, accountPanelShell, developmentWalletControls, walletLinkControls } from "./accountPanel.js";
import { collectionPage, homePage } from "./pages.js";
import { SITE_CSS } from "./siteCss.js";

const base = { fixtureMode: false, mintEnabled: true, mintChainId: "1" };
const signedIn = { ...base, currentHandle: "alice", csrfToken: "private-csrf" };
const wallet = { address: "0x" + "1".repeat(40), chainName: "Ethereum", chainId: "1", provedAt: new Date("2026-09-01") };

describe("account management panel", () => {
  it("keeps the dot a native collection link and provides a separate touch toggle", () => {
    const html = accountPanelShell();
    expect(html).toMatch(/<a class="collection-shortcut" href="\/me"/);
    expect(html).toContain('aria-controls="account-panel" aria-expanded="false"');
    expect(html).toContain('class="account-menu-toggle" type="button" aria-label="Account controls"');
    expect(html).toContain('id="account-panel" aria-labelledby="account-panel-heading"');
    expect(SITE_CSS).toContain(".account-menu:focus-within .account-panel");
    expect(SITE_CSS).toContain("@media(hover:none),(pointer:coarse)");
    expect(SITE_CSS).toContain("max-width:calc(100vw - 32px)");
  });

  it.each([undefined, base, signedIn, { ...signedIn, wallet }, { ...base, fixtureMode: true }, { ...signedIn, fixtureMode: true }])("keeps the panel heading a native collection link without a competing tooltip (account=%s)", initial => {
    const html = accountPanelShell(initial);
    const dot = html.match(/<a class="collection-shortcut"[^>]*>/)![0];
    expect(dot).toContain('href="/me"');
    expect(dot).toContain('aria-label="My Collection"');
    expect(dot).not.toMatch(/\btitle=|\brole="button"|\bonclick=/);
    expect(html.match(/id="account-panel-heading"/g)).toHaveLength(1);
    expect(html).toContain('<h2 class="account-panel-heading" id="account-panel-heading"><a href="/me">My Collection</a></h2><div data-account-panel-body>');
    const heading = html.match(/<h2 class="account-panel-heading"[^>]*>.*?<\/h2>/)![0];
    expect(heading).not.toMatch(/\brole="button"|\bonclick=/);
    // Refresh replaces only the body: the heading survives loading and errors.
    expect(accountPanelContent(initial ?? base)).not.toContain('id="account-panel-heading"');
    expect(accountPanelContent(initial ?? base)).toContain("<h3>X</h3>");
    expect(accountPanelContent(initial ?? base)).not.toContain("<h3>Wallet</h3>");
    expect(SITE_CSS).toContain('.account-panel-heading{margin:0 0 .75rem;line-height:1.5}');
    expect(SITE_CSS).toContain('.account-panel-heading a:focus-visible{outline:2px solid var(--blue);outline-offset:3px}');
  });

  it("never puts account-specific credentials or logout into the public page shell", () => {
    const html = homePage(false);
    expect(html).not.toContain("data-csrf");
    expect(html).not.toContain('action="/auth/logout"');
    expect(html).toContain('src="/assets/account-panel.js?v=');
  });

  it("keeps signed-out global account controls focused on X identity", () => {
    const html = accountPanelContent({ ...base, wallet });
    expect(html).toContain("Sign in with X");
    expect(html).not.toContain("Confirm your X account, then prove wallet ownership");
    expect(html).not.toContain('<span>Link wallet</span></button>');
    expect(html).not.toContain('data-x-action-form');
    expect(html).not.toContain('data-x-action-feedback');
    expect(html).not.toContain("Confirm with X to");
    expect(html).toContain('name="purpose" value="account_login"');
    expect(html).not.toContain('name="action"');
    expect(html).not.toContain(wallet.address);
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain('action="/auth/logout"');
  });

  it("does not expose wallet setup or prior recipient records in signed-in account controls", () => {
    for (const binding of [null, wallet]) {
      const html = accountPanelContent({ ...signedIn, wallet: binding });
      expect(html).not.toMatch(/(?:Replace|Link|Revoke|Connect) wallet|Change recipient|Wallet details/);
      expect(html).not.toContain("Confirm with X to");
      expect(html).not.toContain('data-x-action-form');
      expect(html).not.toContain('name="purpose" value="sensitive_action"');
      expect(html).toContain('name="csrf" value="private-csrf"');
      expect(html).not.toContain(wallet.address);
      expect(html).toContain('action="/auth/logout"');
      expect(html).not.toContain('name="purpose" value="account_login"');
      expect(html).not.toMatch(/Reauthenticate|Refresh your X identity|after reauthentication/);
      expect(html).not.toContain("data-link-wallet");
      expect(html).not.toContain("data-revoke-wallet");
    }
  });

  it("keeps the product sign-in label the same across environments", () => {
    expect(accountPanelContent({ ...base, fixtureMode: true, localOAuthMode: false })).toContain("Sign in with X");
    expect(accountPanelContent({ ...base, localOAuthMode: true })).toContain("Sign in with X");
    expect(accountPanelContent({ ...base, localOAuthMode: true })).not.toContain("emulator");
  });

  it("keeps all wallet setup out of My Collection, including its developer overlay", () => {
    const html = collectionPage({ ...signedIn, signatures: [], wallet, walletLinkConfirmed: true, walletRevokeConfirmed: true });
    const page = html.slice(html.indexOf('<section class="collection-page"'));
    for (const hook of ["data-link-wallet", "data-revoke-wallet", 'name="action" value="wallet_link"']) {
      expect(html).not.toContain(hook);
      expect(page).not.toContain(hook);
    }
    expect(html).toContain('action="/auth/logout"');
    expect(page).not.toContain('action="/auth/logout"');
    expect(html).not.toContain('data-wallet-provider');
    expect(html).not.toContain(wallet.address);
  });

  it.each(["walletLinkConfirmed", "walletRevokeConfirmed"] as const)("does not expose global controls even with legacy %s", confirmed => {
    const html = accountPanelContent({ ...signedIn, wallet, [confirmed]: true });
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain("data-revoke-wallet");
    expect(html).not.toContain('name="action"');
  });

  it.each([false, true])("offers no binding mutation while minting is paused (linked=%s)", (linked) => {
    const html = accountPanelContent({ ...signedIn, wallet: linked ? wallet : null, mintEnabled: false });
    expect(html).not.toContain("Minting paused");
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain("data-revoke-wallet");
  });

  it("requires exact mint context even when an old wallet proof or generic approval exists", () => {
    const account = { ...signedIn, wallet, walletLinkConfirmed: true, fixtureMode: true };
    expect(walletLinkControls(account)).toBe("");
    expect(developmentWalletControls(account)).toBe("");
    const mint = { ...account, mintSignatureId: "sg1_exact", mintClaimInstanceId: "claim-exact" };
    const unconfirmed = walletLinkControls(mint);
    expect(unconfirmed).toBe("");
    expect(developmentWalletControls(mint)).toBe("");
    const confirmed = { ...mint, mintRecipientConfirmed: true, mintPreviousBindingId: 'binding"previous' };
    expect(walletLinkControls(confirmed)).toContain('data-signature-id="sg1_exact" data-claim-instance-id="claim-exact"');
    expect(developmentWalletControls(confirmed)).toContain('data-signature-id="sg1_exact" data-claim-instance-id="claim-exact"');
    expect(walletLinkControls(confirmed)).toContain('data-previous-binding-id="binding&quot;previous"');
    expect(developmentWalletControls(confirmed)).toContain('data-previous-binding-id="binding&quot;previous"');
    expect(walletLinkControls({ ...confirmed, mintPreviousBindingId: null })).toContain('data-previous-binding-id=""');
    expect(walletLinkControls(confirmed)).not.toContain('action="/auth/x/start"');
    expect(walletLinkControls({ ...confirmed, currentHandle: undefined })).toBe("");
    expect(walletLinkControls({ ...confirmed, csrfToken: undefined })).toBe("");
    expect(developmentWalletControls({ ...confirmed, previewOnly: true })).toBe("");
    expect(developmentWalletControls({ ...confirmed, mintEnabled: false })).toBe("");
  });

  it("escapes account data and CSRF values before returning first-party HTML", () => {
    const unsafe = '<img src=x onerror="bad">';
    const html = accountPanelContent({ ...signedIn, currentHandle: unsafe, csrfToken: unsafe, wallet: { ...wallet, chainName: unsafe } });
    expect(html).not.toContain(unsafe);
    expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
  });
});
