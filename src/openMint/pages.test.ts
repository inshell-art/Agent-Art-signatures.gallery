import { describe, expect, it } from "vitest";
import { aboutPage, assessmentPage, canonicalPageHandle, collectionPage, errorPage, handoffPrompt, homePage, mintPage, OPEN_MINT_CSS, previewPage, previewVariationsPage, requestPage, type AssessmentPageModel, type GalleryEntry } from "./pages.js";
import { MBTI_TYPES, RENDERER_VERSION } from "./identity.js";
import { HOME_LINK } from "../v1/navigation.js";
import { SITE_CSS_URL } from "../v1/siteCss.js";

const ready: AssessmentPageModel = { handle: "agent_art", renderHandle: "Agent_Art", code: "opaque-request-code", status: "ready", canMint: true, mbti: "INTJ", imageUrl: "/art/hidden.png", svgUrl: "/art/hidden.svg", tokenId: "123", svgSha256: "secret-svg-digest", pngSha256: "secret-png-digest" };
const minted: AssessmentPageModel = { ...ready, mint: { state: "minted" } };
const entry: GalleryEntry = { handle: "alice_bob_key", renderHandle: "Alice_Bob_Key", code: "code", mbti: "INTJ", imageUrl: "/art/test.svg", mint: { state: "minted" } };

describe("open mint pages", () => {
  it("preserves navigation, type assets, hairline controls and a wallet collection", () => {
    const html = homePage();
    expect(html).toContain('<title>Signatures Gallery</title>');
    expect(html).toContain(HOME_LINK);
    expect(html).toContain('class="collection-shortcut" href="/me"');
    expect(html).toContain('aria-label="My Collection"');
    expect(html).toContain(SITE_CSS_URL);
    expect(html).toContain('instrument-sans-latin-wght-normal.woff2');
    expect(html).toContain('href="/mint"><span>Mint a signature</span>');
    expect(html).not.toContain('data-assessment-request');
    expect(html).not.toMatch(/Sign in with X|Claim with X|withdraw|\/auth\/x/);
    expect(OPEN_MINT_CSS).not.toMatch(/font-family:|--paper:|--font-family:/);
  });

  it("asks consumer Grok for a handle then an MBTI and a case-preserved letter URL", () => {
    const prompt = handoffPrompt("https://example.com");
    expect(prompt).toContain("First, ask me which X handle");
    expect(prompt).toContain("After I provide a valid handle");
    expect(prompt).toContain("assess an MBTI for that handle in this chat");
    expect(prompt).toContain("Check the signature of @<handle>: https://example.com/s/<handle>/<MBTI>");
    expect(prompt).toContain("Preserve its exact spelling and capitalization; only remove the leading @");
    expect(prompt).toContain("@Alice_Bob_Key must become Alice_Bob_Key, not alice_bob_key");
    expect(prompt).toContain("https://example.com/s/Alice_Bob_Key/ENFP");
    expect(prompt).toContain("Use the letters, not a number");
    expect(prompt).toContain("Do not call the site to request an assessment or ask for a wallet");
    expect(prompt).toContain("editable preview, not a mint authorization");
    expect(prompt).not.toContain("Create signature");
    for (const mbti of MBTI_TYPES) expect(prompt).toContain(mbti);
    expect(homePage()).toContain("Grok on X or Grok.com");
  });

  it("canonicalizes token identity but preserves exact spelling in the mint input", () => {
    expect(canonicalPageHandle(" @Agent_Art ")).toBe("agent_art");
    for (const html of [mintPage(" @Alice_Bob_Key "), requestPage(" @Alice_Bob_Key ")]) {
      expect(html).toContain('value="Alice_Bob_Key"');
      expect(html).toContain('<title>Mint &amp; reveal · Signatures Gallery</title>');
      expect(html).not.toContain('name="mbti"');
    }
    expect(mintPage()).toContain('name="handle" value=""');
    expect(() => mintPage("agent/art")).toThrow();
    expect(() => assessmentPage({ ...ready, handle: '<img src=x>' })).toThrow();
    expect(() => assessmentPage({ ...ready, renderHandle: "Someone_Else" })).toThrow("does not match");
  });

  it("requires wallet proof and explicit Mint & reveal without a separate review checkbox", () => {
    const html = mintPage("Alice_Bob_Key");
    expect(html).toContain('data-mint-entry data-wallet-verified="false"');
    expect(html).toContain('data-connect-wallet');
    expect(html).toContain('data-request-submit disabled');
    expect(html).toContain('data-assessment-request');
    expect(html).toContain('data-request-feedback role="status" aria-live="polite"');
    expect(html).toContain('Grok chooses the final signature. It may differ from your preview. Reveal after minting.');
    expect(html).toContain('No mint fee. You pay network gas. Minting creates a permanent public token.');
    expect(html.indexOf('Grok chooses')).toBeLessThan(html.indexOf('data-request-submit'));
    expect(html).not.toMatch(/checkbox|Create signature|data-mint-review|\/art\//);
    const verified = mintPage("Alice_Bob_Key", { wallet: "0x123", walletVerified: true, chainName: "Local Anvil" });
    expect(verified).toContain('data-wallet-verified="true"');
    expect(verified).toContain('data-request-submit><span>Mint &amp; reveal');
    expect(verified).toContain('data-wallet-label>0x123');
    expect(verified).toContain('data-review-chain>Local Anvil');
    expect(mintPage("", { wallet: "0x123" })).toContain('<span>Verify wallet</span>');
  });

  it.each(MBTI_TYPES)("renders only the chosen %s preview and bridges with handle only", mbti => {
    const html = previewPage("Alice_Bob_Key", mbti);
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    expect(main.match(/<img\b/g)).toHaveLength(1);
    expect(main).toContain(`src="/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}"`);
    expect(main).not.toContain(`src="/preview/Alice_Bob_Key/${mbti}.svg"`);
    expect(main).not.toContain('renderer=sg-renderer-1.0.0');
    expect(main).toContain('href="https://x.com/Alice_Bob_Key"');
    expect(main).toContain('<span class="signature-tag">' + mbti + '</span>');
    expect(main).toContain('href="/mint?handle=Alice_Bob_Key"><span>Mint for this handle →');
    expect(main).toContain('Change the MBTI in the URL to explore');
    expect(main).toContain('href="/s/Alice_Bob_Key/variations">View all 16 variations</a>');
    expect(main).not.toMatch(/data-assessment-request|data-assessment-code|data-mint-form|data-connect-wallet|data-token-id|Provenance/);
    expect(main).not.toContain('href="/mint?handle=Alice_Bob_Key&amp;');
  });

  it("validates preview handles and types even if called outside the router", () => {
    expect(previewPage("@Agent_Art", "ENFP")).toContain('/preview/Agent_Art/ENFP.svg');
    expect(() => previewPage('<img src=x>', "ENFP")).toThrow();
    expect(() => previewPage('Agent_Art', "enfp" as "ENFP")).toThrow();
    expect(() => previewPage('Agent_Art', "17" as "ENFP")).toThrow();
  });

  it("renders exactly 16 named preview variations with case-preserved artwork and detail links", () => {
    const html = previewVariationsPage("Alice_Bob_Key");
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    expect(main).toContain('data-preview-variations');
    expect(main).toContain('class="open-preview-grid"');
    expect(main).toContain('16 variations');
    expect(main).toContain('href="https://x.com/Alice_Bob_Key"');
    expect(main).toContain('<span class="signature-tag">Preview</span>');
    expect(main.match(/<img\b/g)).toHaveLength(16);
    const previewLinks = [...main.matchAll(/href="(\/s\/Alice_Bob_Key\/[A-Z]{4})"/g)].map(match => match[1]);
    expect(previewLinks).toHaveLength(16);
    expect(new Set(previewLinks)).toEqual(new Set(MBTI_TYPES.map(mbti => `/s/Alice_Bob_Key/${mbti}`)));
    for (const mbti of MBTI_TYPES) {
      expect(main).toContain(`src="/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}"`);
      const card = main.match(new RegExp(`<a\\b[^>]*href="/s/Alice_Bob_Key/${mbti}"[^>]*>[\\s\\S]*?</a>`))?.[0];
      expect(card).toBeDefined();
      expect(card).toMatch(/<img\b[^>]*alt="[^"]+"/);
      expect(card!.replace(/<[^>]+>/g, "")).toContain(mbti);
    }
    const imageUrls = [...main.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
    expect(imageUrls).toEqual(MBTI_TYPES.map(mbti => `/preview/Alice_Bob_Key/${mbti}.svg?renderer=${RENDERER_VERSION}`));
    expect(main).not.toMatch(/src="\/preview\/[^"?]+\.svg"/);
    expect(main).not.toContain('renderer=sg-renderer-1.0.0');
    expect(main).not.toMatch(/data-assessment-request|data-assessment-code|data-mint-form|data-connect-wallet|data-token-id|Provenance|\/signatures\//);
    expect(main).not.toContain('mbti=');
  });

  it("validates variations handles and keeps developer wallet actions outside preview exploration", () => {
    const options = { development: { fixture: true, localChain: true } };
    const html = previewVariationsPage("@Agent_Art", options);
    expect(html).toContain('/s/Agent_Art/ENFP');
    expect(html).toContain('/preview/Agent_Art/ENFP.svg');
    expect(html).not.toContain('data-dev-wallet');
    expect(html).not.toContain('data-dev-mint');
    for (const handle of ['', '<img src=x>', 'agent/art', 'a'.repeat(16), 'alice?mbti=ENFP']) {
      expect(() => previewVariationsPage(handle)).toThrow();
    }
  });

  it("shows only minted entries on home and collection, never pending or cancelled attempts", () => {
    const entries: GalleryEntry[] = [entry, { ...entry, handle: "pending", renderHandle: "Pending", imageUrl: "/art/pending.svg", mint: { state: "pending" } }, { ...entry, handle: "cancelled", renderHandle: "Cancelled", imageUrl: "/art/cancelled.svg", mint: { state: "unminted" } }, { ...entry, handle: "unverified", renderHandle: "Unverified", imageUrl: "/art/unverified.svg", mint: undefined }];
    for (const html of [homePage({}, entries), collectionPage(entries)]) {
      expect(html.match(/class="gallery-item"/g)).toHaveLength(1);
      expect(html).toContain('alt="Signature for @Alice_Bob_Key"');
      expect(html).toContain('href="https://x.com/Alice_Bob_Key"');
      expect(html).toContain('href="/signatures/alice_bob_key"');
      expect(html).not.toMatch(/\/art\/(?:pending|cancelled|unverified)\.svg/);
    }
    expect(homePage({}, entries.slice(1))).toContain('No signatures minted yet.');
    const legacy = collectionPage([{ ...entry, renderHandle: undefined }]);
    expect(legacy).toContain('alt="Signature for @alice_bob_key"');
    expect(legacy).toContain('href="/signatures/alice_bob_key"');
  });

  it.each(["pending", "ready", "failed"] as const)("withholds artwork and metadata for %s assessments until confirmed mint", status => {
    const html = assessmentPage({ ...ready, status });
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    expect(main).toContain('data-assessment-handle="agent_art"');
    expect(main).toContain('data-assessment-state="' + status + '"');
    expect(main).toContain('href="https://x.com/Agent_Art"');
    expect(main).toContain('data-assessment-status role="status"');
    expect(main).not.toMatch(/<img\b|<figure\b|signature-provenance|INTJ|\/art\/hidden|secret-svg-digest|secret-png-digest|SVG ↗/);
    expect(html).not.toContain('<title>@Agent_Art · INTJ');
    expect(main).not.toMatch(/checkbox|data-mint-review|exact artwork/);
  });

  it("offers progress and continuation without another artwork-review step", () => {
    const pending = assessmentPage({ ...ready, status: "pending", canMint: false });
    expect(pending).toContain('data-mint-form hidden');
    expect(pending).toContain('Preparing your signature…');
    const html = assessmentPage({ ...ready, walletProvedForCode: true });
    expect(html).toContain('data-wallet-proved="true"');
    expect(html).toContain('<form data-mint-form>');
    expect(html).toContain('data-submit-mint disabled><span>Continue mint');
    expect(html).toContain('Approve the transaction in your wallet to reveal it.');
    const submitted = assessmentPage({ ...ready, mint: { state: "pending" } });
    expect(submitted).toContain('Mint submitted. Waiting to reveal your signature…');
    expect(submitted).not.toContain('data-mint-form');
    expect(submitted).not.toContain('data-connect-wallet');
    expect(submitted).not.toContain('/art/hidden');
  });

  it("does not offer mint for other browser sessions or expired requests", () => {
    const html = assessmentPage({ ...ready, canMint: false });
    expect(html).toContain('This mint request is not available in this browser.');
    expect(html).toContain('href="/mint?handle=Agent_Art"><span>Return to mint');
    expect(html).not.toContain('data-mint-form');
    expect(html).not.toContain('data-connect-wallet');
    expect(assessmentPage({ ...ready, canMint: false, requestExpired: true })).toContain("This mint request has expired.");
  });

  it("shows truthful assessment failure without a retry or reroll promise", () => {
    const html = assessmentPage({ ...ready, status: "failed", canMint: false, error: "The provider response is uncertain. Contact support." });
    expect(html).toContain('The provider response is uncertain. Contact support.');
    expect(html).not.toMatch(/Try again|another assessment|data-mint-form|data-connect-wallet/);
  });

  it("reveals frozen rendering spelling and provenance only after confirmed mint", () => {
    const html = assessmentPage({ ...minted, sourceLabel: 'Grok · independent X Search assessment' });
    expect(html).toContain('alt="Signature for @Agent_Art"');
    expect(html).toContain('<dt>Handle</dt><dd>@Agent_Art</dd>');
    expect(html).toContain('<span class="signature-tag">INTJ</span>');
    expect(html).toContain('<dt>Assessment</dt><dd>Grok · independent X Search assessment</dd>');
    expect(html).toContain('The backend asked Grok to research public X posts');
    expect(html).toContain('class="signature-provenance"');
    expect(html).toContain('SVG ↗');
    expect(html).not.toContain('data-mint-form');
    expect(html).not.toContain('data-assessment-code');
    expect(assessmentPage({ ...minted, handle: "alice_bob_key", renderHandle: undefined })).toContain('alt="Signature for @alice_bob_key"');
  });

  it("escapes external data and does not turn unsafe URL schemes into links", () => {
    const html = assessmentPage({ ...minted, mbti: '<img src=x onerror="boom">', imageUrl: "javascript:boom()", svgUrl: "javascript:boom()", sourceLabel: '<script>boom()</script>' });
    expect(html).not.toContain('<img src=x onerror');
    expect(html).not.toContain('<script>boom()');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;boom()&lt;/script&gt;');
    expect(assessmentPage({ ...ready, status: "failed", error: '<img src=x>' })).toContain('&lt;img src=x&gt;');
    expect(mintPage("", { wallet: '<img src=x>' })).toContain('&lt;img src=x&gt;');
    expect(errorPage('<img src=x>')).toContain('&lt;img src=x&gt;');
  });

  it("keeps fixture explanations and local wallet tools in the separate DEV overlay", () => {
    const options = { development: { fixture: true, localChain: true } };
    const html = assessmentPage(ready, options);
    const main = html.match(/<main>([\s\S]*?)<\/main>/)![1]!;
    expect(main).not.toMatch(/fixture|simulated|<dt>Assessment<\/dt>/i);
    expect(html).toContain('Simulated assessment');
    expect(html).toContain('Grok did not research these handles');
    expect(html.indexOf('data-dev-wallet')).toBeGreaterThan(html.indexOf('</main>'));
    expect(html.indexOf('data-dev-mint')).toBeGreaterThan(html.indexOf('</main>'));
    expect(mintPage("", options)).toContain('data-dev-wallet');
    expect(assessmentPage(ready)).not.toContain('data-dev-wallet');
    expect(previewPage("Agent_Art", "ENFP", options)).not.toContain('data-dev-wallet');
    const revealed = assessmentPage(minted, options);
    expect(revealed).toContain('The MBTI shapes the signature’s expression.');
    expect(revealed).not.toContain('<dt>Assessment</dt>');
  });

  it("shows only the minted tag and an optional actual explorer below minted artwork", () => {
    const html = assessmentPage(minted);
    const artwork = html.match(/<article class="signature-page"[\s\S]*?<\/article>/)![0];
    expect(artwork).toContain('data-mint-state-label>Minted');
    expect(artwork).not.toContain('My Collection');
    expect(artwork).not.toContain('href="/me"');
    expect(assessmentPage({ ...minted, mint: { state: 'minted', explorerUrl: 'https://etherscan.io/token/123' } })).toContain('View token ↗');
    expect(assessmentPage({ ...minted, mint: { state: 'minted', explorerUrl: 'javascript:boom()' } })).not.toContain('View token ↗');
  });

  it("explains independent assessment, durable reuse, gas, and limits of reveal", () => {
    const html = collectionPage([], { wallet: "0x" + "1".repeat(40) });
    expect(html).toContain("My Collection");
    expect(html).toContain("This wallet has no minted signatures yet.");
    expect(html).toContain('href="/mint"><span>Mint a signature');
    expect(html).not.toMatch(/claim|\/auth\/x|Sign in with X/i);
    const about = aboutPage();
    expect(about).toContain("Preview pages do not call our assessment service or authorize a mint.");
    expect(about).toContain("It does not accept the preview’s MBTI.");
    expect(about).toContain("cancelling a transaction does not create another result");
    expect(about).toContain("not cryptographic secrecy");
    expect(about).toContain("one minted token per handle");
  });
});
