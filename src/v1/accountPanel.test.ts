import { describe, expect, it } from "vitest";
import { accountPanelContent, accountPanelShell } from "./accountPanel.js";
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

  it.each([undefined, base, signedIn, { ...signedIn, wallet }])("uses the panel heading instead of a competing native tooltip (account=%s)", initial => {
    const html = accountPanelShell(initial);
    const dot = html.match(/<a class="collection-shortcut"[^>]*>/)![0];
    expect(dot).toContain('href="/me"');
    expect(dot).toContain('aria-label="My Collection"');
    expect(dot).not.toMatch(/\btitle=|\brole="button"|\bonclick=/);
    expect(html.match(/id="account-panel-heading"/g)).toHaveLength(1);
    expect(html).toContain('<h2 class="account-panel-heading" id="account-panel-heading">My Collection</h2><div data-account-panel-body>');
    // Refresh replaces only the body: the heading survives loading and errors.
    expect(accountPanelContent(initial ?? base)).not.toContain('id="account-panel-heading"');
    expect(accountPanelContent(initial ?? base)).toContain("<h3>X</h3>");
    expect(accountPanelContent(initial ?? base)).toContain("<h3>Wallet</h3>");
    expect(SITE_CSS).toContain('.account-panel-heading{margin:0 0 .75rem;line-height:1.5}');
  });

  it("never puts account-specific credentials or logout into the public page shell", () => {
    const html = homePage(false);
    expect(html).not.toContain("data-csrf");
    expect(html).not.toContain('action="/auth/logout"');
    expect(html).toContain('src="/assets/account-panel.js?v=');
  });

  it("exposes Link wallet before sign-in, routing to X before any wallet proof", () => {
    const html = accountPanelContent({ ...base, wallet });
    expect(html).toContain("Sign in with X");
    expect(html).toContain("Sign in with X first");
    expect(html).toContain('<span>Link wallet</span></button></form>');
    expect(html).not.toContain(wallet.address);
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain('action="/auth/logout"');
  });

  it("keeps the next wallet action visible when X needs refreshing", () => {
    for (const binding of [null, wallet]) {
      const html = accountPanelContent({ ...signedIn, wallet: binding, reauthRequired: true });
      expect(html).toContain(`<span>${binding ? "Replace wallet" : "Link wallet"}</span></button></form>`);
      expect(html).toContain('name="purpose" value="account_login"');
      expect(html).not.toContain("data-link-wallet");
      expect(html).not.toContain("data-revoke-wallet");
    }
  });

  it("keeps the product sign-in label the same across environments", () => {
    expect(accountPanelContent({ ...base, fixtureMode: true, localOAuthMode: false })).toContain("Sign in with X");
    expect(accountPanelContent({ ...base, localOAuthMode: true })).toContain("Sign in with X");
    expect(accountPanelContent({ ...base, localOAuthMode: true })).not.toContain("emulator");
  });

  it("keeps ownership-proof and revocation hooks in the panel, not in the artwork collection", () => {
    const html = collectionPage({ ...signedIn, signatures: [], wallet });
    const page = html.slice(html.indexOf('<section class="collection-page"'));
    for (const hook of ["data-link-wallet", "data-revoke-wallet", 'action="/auth/logout"']) {
      expect(html).toContain(hook);
      expect(page).not.toContain(hook);
    }
    expect(html).toContain('data-wallet-provider="injected"');
    expect(html).toContain('data-mode="replace"');
    expect(html).toContain('data-csrf="private-csrf"');
    expect(html).toContain("Connecting alone creates no binding");
  });

  it.each([false, true])("offers no binding mutation while minting is paused (linked=%s)", (linked) => {
    const html = accountPanelContent({ ...signedIn, wallet: linked ? wallet : null, mintEnabled: false });
    expect(html).toContain("Minting paused");
    expect(html).not.toContain("data-link-wallet");
    expect(html).not.toContain("data-revoke-wallet");
  });

  it("escapes account data and CSRF values before returning first-party HTML", () => {
    const unsafe = '<img src=x onerror="bad">';
    const html = accountPanelContent({ ...signedIn, currentHandle: unsafe, csrfToken: unsafe, wallet: { ...wallet, chainName: unsafe } });
    expect(html).not.toContain(unsafe);
    expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
  });
});
