import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signInRequiredPage } from "./pages.js";
import { SITE_CSS, SITE_CSS_URL } from "./siteCss.js";

describe("compact Hairline buttons and home-style tags", () => {
  it("anchors every collection state to the gallery edge without widening other auth pages", () => {
    const signedOut = signInRequiredPage(false);
    expect(signedOut).toContain('class="auth-sheet collection-sheet"');
    expect(signedOut).toContain('<div class="collection-intro"><div class="signature-heading"><h1>My Collection</h1>');
    expect(SITE_CSS).toContain('.auth-sheet.collection-sheet{max-width:none}');
    expect(SITE_CSS).toContain('.collection-intro .signature-heading{line-height:1.5}');
    expect(SITE_CSS).toContain('.collection-sheet .signature-heading h1{line-height:1.5}');
    expect(SITE_CSS).toContain('.collection-empty{width:100%;max-width:42rem;margin-inline:0;padding:0}');
    expect(SITE_CSS).toContain('.participation{width:100%;max-width:42rem;margin-inline:0;line-height:1.6}');
    expect(SITE_CSS).toContain('.signed-out-participation{padding:2rem 0}');
    expect(SITE_CSS).toContain('.auth-sheet{width:100%;max-width:42rem;margin-inline:auto;');
  });
  const rules = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const css = SITE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    return css.match(new RegExp(`(?:^|[},])\\s*${escaped}\\{([^}]*)\\}`))?.[1] ?? "";
  };

  it("tightens tag padding while keeping buttons and hit targets unchanged", () => {
    expect(SITE_CSS).toContain("--control-padding:3px 7px;--control-line-height:1.35");
    expect(SITE_CSS).toContain("--tag-padding:1px 3px;");
    for (const selector of [".auth-action>span:first-child", ".button"]) {
      expect(rules(selector)).toContain("padding:var(--control-padding)");
    }
    for (const selector of [".signature-tag", ".gallery-tabs a>span", ".auth-account-handle"]) {
      expect(rules(selector)).toContain("padding:var(--tag-padding)");
    }
    for (const selector of [".auth-action>span:first-child", ".button", ".signature-tag", ".gallery-tabs a>span", ".auth-account-handle"]) {
      expect(rules(selector)).toContain("line-height:var(--control-line-height)");
      expect(rules(selector)).not.toContain("min-height:44px");
    }
    expect(rules(".gallery-tabs a")).toContain("min-height:44px");
    expect(rules(".auth-action")).toContain("min-height:44px");
  });

  it("rounds tag backgrounds subtly without changing button corners", () => {
    expect(SITE_CSS).toContain("--tag-radius:4px;");
    for (const selector of [".signature-tag", ".gallery-tabs a>span", ".auth-account-handle"]) {
      expect(rules(selector)).toContain("border-radius:var(--tag-radius)");
      expect(rules(selector)).toContain("padding:var(--tag-padding)");
    }
    for (const selector of [".auth-action>span:first-child", ".button"]) {
      expect(rules(selector)).toContain("border-radius:2px");
    }
  });

  it("separates outlined actions from soft-filled, borderless status tags", () => {
    for (const selector of [".auth-action>span:first-child", ".button"]) {
      expect(rules(selector)).toContain("background:transparent");
      expect(rules(selector)).toContain("color:var(--ink)");
      expect(rules(selector)).toContain("border:1px solid var(--ink)");
    }
    expect(rules(".signature-tag")).toContain("background:var(--paper-2)");
    expect(rules(".signature-tag")).toContain("border:0");
    expect(rules(".signature-tag")).toContain("color:var(--ink)");
    expect(rules(".signature-tag")).not.toContain("cursor:pointer");
    expect(SITE_CSS).not.toMatch(/\.signature-tag:(hover|active|focus)/);
  });

  it("styles secondary CTA buttons consistently and keeps external arrows outside the outline", () => {
    expect(rules(".auth-action")).toContain("background:transparent");
    expect(rules(".grok-step-copy .grok-step-arrow")).toContain("background:transparent");
    expect(SITE_CSS).not.toContain(".auth-action-quiet>span");
    expect(rules(".auth-action")).toContain("min-height:44px");
    expect(rules(".auth-action")).toContain("min-width:44px");
    expect(rules(".auth-action:not(:disabled):hover>span:first-child")).toContain("background:var(--ink);color:var(--paper)");
    expect(SITE_CSS).not.toContain(".auth-action>span{");
  });

  it("defines accessible focus, disabled, working and reduced-motion states", () => {
    expect(SITE_CSS).toContain(".auth-action:focus-visible,.button:focus-visible{outline:2px solid var(--ink);outline-offset:4px}");
    expect(SITE_CSS).toContain(".auth-action:disabled,.button:disabled{opacity:.4;cursor:not-allowed}");
    expect(SITE_CSS).toContain('.auth-action[aria-busy="true"],.button[aria-busy="true"]{opacity:.6;cursor:progress}');
    expect(SITE_CSS).toContain("@media(prefers-reduced-motion:reduce){.auth-action,.auth-action>span:first-child,.button{transition:none}");
    expect(SITE_CSS).toContain("gap:8px 1rem");
  });
});

describe("stylesheet cache version", () => {
  it("derives the stylesheet URL from the complete CSS content", () => {
    const version = createHash("sha256").update(SITE_CSS).digest("hex").slice(0, 16);
    expect(SITE_CSS_URL).toBe(`/assets/site.css?v=${version}`);
  });

  it.each([true, false])("includes the content-versioned URL in the shared layout (fixture=%s)", fixture => {
    expect(signInRequiredPage(fixture)).toContain(`<link rel="stylesheet" href="${SITE_CSS_URL}">`);
    expect(signInRequiredPage(fixture)).not.toContain('href="/assets/site.css"');
  });
});
