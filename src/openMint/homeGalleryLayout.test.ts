import { describe, expect, it } from "vitest";
import { SITE_CSS } from "../v1/siteCss.js";
import { collectionPage, homePage, mbtiGalleryPage, OPEN_MINT_CSS, type GalleryEntry } from "./pages.js";

const entry: GalleryEntry = {
  handle: "alice", renderHandle: "Alice", code: "code", mbti: "INTJ",
  imageUrl: "/art/alice.svg", mint: { state: "minted" },
};

function rules(css: string): { selector: string; declarations: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, declarations]) => ({ selector: selector!.trim(), declarations: declarations! }));
}

describe("home gallery width", () => {
  it("enlarges only the current homepage slogan while preserving responsive width and intro size", () => {
    const currentRules = rules(OPEN_MINT_CSS);
    expect(currentRules.filter(rule => rule.selector.includes(".slogan-lockup")))
      .toEqual([{
        selector: ".open-mint .home-grid .slogan-lockup",
        declarations: "max-width:56rem",
      }]);
    expect(rules(SITE_CSS).find(rule => rule.selector === ".slogan-lockup")?.declarations)
      .toBe("width:100%;max-width:42rem");
    expect(currentRules.find(rule => rule.selector === ".open-mint .open-intro")?.declarations)
      .toBe("width:100%;max-width:42rem;margin-inline:auto");
  });

  it("lowers only the current homepage slogan by 24px while preserving its padded height and 896px width", () => {
    const currentRules = rules(OPEN_MINT_CSS);
    expect(currentRules.filter(rule => /\.intro-panel\b/.test(rule.selector)))
      .toEqual([{
        selector: ".open-mint .home-grid .intro-panel",
        declarations: "padding-block-start:7rem;padding-block-end:clamp(2.5rem,4vw,4rem)",
      }]);
    expect(rules(SITE_CSS).find(rule => rule.selector === ".intro-panel")?.declarations)
      .toContain("padding:clamp(2.5rem,4vw,4rem) var(--page-gutter,32px);padding-block-start:4rem");
    expect(currentRules.find(rule => rule.selector === ".open-mint .home-grid .slogan-lockup")?.declarations)
      .toBe("max-width:56rem");
  });

  it("cancels the current page gutter only on the home artwork grid", () => {
    const gutterCancellation = rules(OPEN_MINT_CSS)
      .filter(rule => /margin-inline:\s*calc\(-1 \* var\(--page-gutter,\s*32px\)\)/.test(rule.declarations));

    expect(gutterCancellation).toEqual([{
      selector: ".open-mint .home-grid .public-gallery-grid",
      declarations: "margin-inline:calc(-1 * var(--page-gutter,32px))",
    }]);
    expect(rules(SITE_CSS).find(rule => rule.selector === ".public-gallery-grid")?.declarations)
      .toContain("margin:auto 0");
  });

  it("retains the 1024px page, responsive gutters, and inset slogan and introduction", () => {
    const sharedRules = rules(SITE_CSS);
    expect(sharedRules.find(rule => rule.selector === ".book-page")?.declarations)
      .toContain("width:100%;max-width:1024px;margin-inline:auto;--page-gutter:32px");
    expect(SITE_CSS).toContain("@media(max-width:600px){.book-page{--page-gutter:20px}");
    expect(sharedRules.find(rule => rule.selector === ".gallery-shell")?.declarations)
      .toContain("padding:2rem var(--page-gutter,32px)");
    expect(sharedRules.find(rule => rule.selector === ".intro-panel")?.declarations)
      .toContain("padding:clamp(2.5rem,4vw,4rem) var(--page-gutter,32px)");
    expect(sharedRules.find(rule => rule.selector === ".slogan-lockup")?.declarations)
      .toBe("width:100%;max-width:42rem");
    expect(rules(OPEN_MINT_CSS).find(rule => rule.selector === ".open-mint .open-intro")?.declarations)
      .toBe("width:100%;max-width:42rem;margin-inline:auto");
  });

  it("keeps the expanded grid scoped out of MBTI and wallet collection pages", () => {
    const home = homePage({}, [entry]);
    expect(home).toContain('<section class="home-grid"><div class="intro-panel">');
    expect(home).toContain('<div class="gallery-shell"><section class="open-intro"');
    expect(home).toContain('</section><div class="public-gallery-grid">');
    for (const html of [mbtiGalleryPage("INTJ", [entry]), collectionPage([entry])]) {
      expect(html).toContain('<section class="collection-page"');
      expect(html).toContain('<div class="public-gallery-grid">');
      expect(html).not.toContain('class="home-grid"');
    }
  });

  it("scopes both navigation insets to the home gallery with viewport and safe-area bounds", () => {
    const navigationRules = rules(OPEN_MINT_CSS).filter(rule =>
      rule.declarations.includes("--home-nav-inset")
      || /\.(?:gallery-return|home-return|home-icon|collection-shortcut(?:-dot)?)\b/.test(rule.selector));

    expect(navigationRules).toEqual([
      {
        selector: ".open-mint:has(.home-grid)",
        declarations: "--home-nav-inset:clamp(-22px,calc((1024px - 100vw)/2 + 20px),12px)",
      },
      {
        selector: ".open-mint:has(.home-grid) .home-return",
        declarations: "inset-inline-start:max(var(--home-nav-inset),calc(env(safe-area-inset-left) - 22px))",
      },
      {
        selector: ".open-mint:has(.home-grid) .collection-shortcut",
        declarations: "inset-inline-end:max(var(--home-nav-inset),calc(env(safe-area-inset-right) - 22px))",
      },
    ]);
  });

  it("preserves centered 44px navigation targets and the existing 11px grid and 10px dot", () => {
    const sharedRules = rules(SITE_CSS);
    for (const selector of [".gallery-return", ".collection-shortcut"]) {
      expect(sharedRules.find(rule => rule.selector === selector)?.declarations)
        .toContain("place-items:center;width:44px;height:44px");
    }
    expect(sharedRules.find(rule => rule.selector === ".home-icon")?.declarations)
      .toBe("display:block;width:11px;height:11px;flex:none");
    expect(sharedRules.find(rule => rule.selector === ".collection-shortcut-dot")?.declarations)
      .toBe("display:block;width:10px;height:10px;border-radius:50%;background:currentColor");
  });
});
