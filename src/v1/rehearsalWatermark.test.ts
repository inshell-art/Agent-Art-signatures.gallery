import { describe, expect, it } from "vitest";
import { collectionPage, homePage, layout, signInRequiredPage } from "./pages.js";
import { COLLECTION_STATE_FIXTURES, collectionStatePage } from "./collectionStateFixtures.js";
import { SITE_CSS } from "./siteCss.js";

describe("global rehearsal watermark", () => {
  it.each([
    [false, false, false], [true, false, true], [false, true, true], [true, true, true],
  ])("marks only development environments (fixture=%s, Anvil=%s)", (fixtureMode, localChainRehearsal, marked) => {
    const html = layout({ title: "Test", description: "Test", body: "<p>Work</p>", fixtureMode, localChainRehearsal });
    expect(html.match(/class="rehearsal-watermark"/g) ?? []).toHaveLength(marked ? 1 : 0);
    expect(html.includes('src="/assets/rehearsal-overlay.js?v=')).toBe(marked);
    expect(html).not.toContain('class="rehearsal-footer"');
    if (!marked) expect(html).not.toContain("Local rehearsal");
  });

  it("uses a native disclosure outside the page flow without claiming real X login is always emulated", () => {
    const html = layout({ title: "Test", description: "Test", body: "", localChainRehearsal: true });
    expect(html).toContain('</footer><aside class="rehearsal-watermark" aria-label="Developer overlay">');
    expect(html).toContain('<details class="rehearsal-disclosure"><summary aria-controls="rehearsal-context" aria-label="Local rehearsal · developer notes">');
    expect(html).toContain('<span class="rehearsal-dev-badge">DEV</span><span>Local rehearsal</span>');
    expect(html).toContain('id="rehearsal-context"');
    expect(html).toContain("Developer overlay · not part of the gallery");
    expect(html).toContain("Local promotion is not Ethereum finality");
    expect(html).toContain("Interactive sign-in uses the configured provider");
    expect(html).toContain("Public test keys. Never send real funds.");
    expect(SITE_CSS).toContain(".rehearsal-disclosure>summary:focus-visible");
    expect(SITE_CSS).toMatch(/\.rehearsal-watermark\{[^}]*position:fixed/);
    expect(SITE_CSS).toMatch(/\.rehearsal-context\{[^}]*position:absolute/);
    expect(SITE_CSS).toMatch(/\.rehearsal-disclosure>summary\{[^}]*border:1px dashed var\(--dev-border\)/);
    expect(SITE_CSS).not.toContain(".rehearsal-footer");
    expect(SITE_CSS).not.toContain("body[data-state-preview]");
    expect(SITE_CSS).not.toContain(".collection-state-nav");
    expect(SITE_CSS).not.toContain(".fixture-links");
  });

  it("keeps fixture links and context entirely inside the developer overlay", () => {
    const html = collectionStatePage("transferred", "http://127.0.0.1:3000")!;
    const main = html.match(/<main>[\s\S]*?<\/main>/)![0];
    expect(main).not.toMatch(/Collection states|Read-only UI fixture|URL override|Choose a collection state/);
    expect(html).not.toMatch(/class="(?:collection-state-nav|fixture-links)"/);
    expect(main).not.toContain('href="/dev/collection-states');
    const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
    expect(overlay).toContain('<span>UI fixture</span>');
    expect(overlay).toContain('data-fixture-state="transferred"');
    expect(overlay).toContain("Fixture · Transferred");
    expect(overlay).toContain("same page components with simulated data");
    expect(overlay).toContain("This status is forced by the URL, not your live collection.");
    expect(overlay).toContain("Account and mint actions are disabled.");
    expect(overlay).toContain("state=transferred");
    expect(overlay).toContain('<nav class="rehearsal-fixture-links" aria-label="Switch fixture">');
    expect(overlay.match(/href="\/dev\/collection-states\?state=/g)).toHaveLength(COLLECTION_STATE_FIXTURES.length);
    expect(overlay.match(/aria-current="page"/g)).toHaveLength(1);
    expect(overlay).toContain('href="/dev/collection-states?state=transferred" aria-current="page"');
    expect(overlay).not.toMatch(/<select\b|<form\b|<button\b/);
  });

  it("offers the shared fixture catalog only when fixture endpoints are enabled", () => {
    const liveDev = homePage(true);
    const overlay = liveDev.slice(liveDev.indexOf('<aside class="rehearsal-watermark"'));
    for (const state of COLLECTION_STATE_FIXTURES) {
      expect(overlay).toContain(`href="/dev/collection-states?state=${state.key}"`);
      expect(overlay).toContain(`<span>${state.label}</span>`);
    }
    expect(overlay).not.toContain('aria-current="page"');
    expect(homePage(false)).not.toContain('href="/dev/collection-states');
    expect(homePage(false, [], null, true)).not.toContain('href="/dev/collection-states');
  });

  it("preserves the product landmarks exactly when developer context is enabled", () => {
    const landmarks = (html: string) => html.match(/<main>[\s\S]*?<\/footer>/)![0];
    const options = { title: "Test", description: "Test", body: "<p>Work</p>", bookPage: true };
    const formal = layout(options);
    expect(landmarks(layout({ ...options, fixtureMode: true }))).toBe(landmarks(formal));
    expect(landmarks(layout({ ...options, preview: { state: "empty", label: "No claims", description: "Forced data only." } }))).toBe(landmarks(formal));
  });

  it("escapes fixture metadata and never treats it as markup", () => {
    const html = layout({ title: "Test", description: "Test", body: "", preview: { state: '"><script>alert(1)</script>', label: "<b>Fixture</b>", description: "<img src=x onerror=alert(1)>" } });
    expect(html).toContain("&lt;b&gt;Fixture&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('name="robots" content="noindex"');
  });

  it("places escaped page-specific notes only inside DEV and omits them in production", () => {
    const options = { title: "Work", description: "Work", body: "<p>Product content</p>", developmentNotes: [{ title: "<b>Rehearsal</b>", paragraphs: ['<script>alert("x")</script>', "No real account authenticated."] }] };
    const html = layout({ ...options, fixtureMode: true });
    expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toContain("No real account");
    const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
    expect(overlay).toContain("&lt;b&gt;Rehearsal&lt;/b&gt;");
    expect(overlay).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(overlay).toContain("No real account authenticated.");
    expect(overlay.indexOf("No real account")).toBeLessThan(overlay.indexOf("Switch fixture"));
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(layout(options)).not.toMatch(/rehearsal-page-note|No real account|alert/);
  });

  it.each([false, true])("removes repeated gallery notices without removing fixture qualification (Anvil=%s)", (localChain) => {
    const entries = ["alice", "bob"].map((handleAtClaim) => ({
      signatureId: handleAtClaim, handleAtClaim, gr0kRaw: 37,
      claimedAt: new Date("2026-09-01"), finalizedAt: new Date("2026-09-02"),
      mintWallet: "0x123", currentTokenHolder: "0x123",
    }));
    for (const tab of ["claimed", "minted"] as const) {
      const html = homePage(true, entries, null, localChain, tab);
      expect(html.match(/class="rehearsal-watermark"/g)).toHaveLength(1);
      expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toMatch(/fixture-links|href="\/dev\/collection-states|Try the development flow/);
      for (const card of html.match(/<a class="gallery-card"[\s\S]*?<\/a>/g) ?? []) {
        expect(card).not.toMatch(/Fictional demo|Local claim rehearsal|Local Anvil mint wallet|Fixture mint wallet/);
      }
      expect(html).toContain('name="robots" content="noindex"');
    }
  });

  it("keeps a single watermark on both /me authentication states", () => {
    const signedIn = collectionPage({ currentHandle: "alice", signatures: [], csrfToken: "csrf", fixtureMode: true, mintEnabled: true, mintChainId: "31337", localChainRehearsal: true });
    for (const html of [signedIn, signInRequiredPage(true, true, true)]) {
      expect(html.match(/class="rehearsal-watermark"/g)).toHaveLength(1);
      expect(html).toContain('aria-label="Gallery"');
    }
  });
});
