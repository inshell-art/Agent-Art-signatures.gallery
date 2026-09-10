import { describe, expect, it } from "vitest";
import { SLOGAN_STUDY_CSS } from "../brand/sloganStudy.js";
import { SITE_FONT_CSS, SITE_FONT_PRELOAD, siteFontAsset } from "./fonts.js";
import { SITE_CSS } from "./siteCss.js";

describe("single-family site typography", () => {
  const paths = [...SITE_FONT_CSS.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]);

  it("sets all HTML text to one 14px regular token without resizing layout or SVG artwork", () => {
    const globalRule = "body,body :not(svg,svg *){font-size:var(--ui-font-size);font-weight:400}";
    expect(SITE_CSS).toContain("--ui-font-size:14px");
    expect(SITE_CSS).toContain(globalRule);
    expect(SITE_CSS).toContain("html{font-size:16px}");
    expect(SITE_CSS).toContain("max-width:1024px");
    expect(SITE_CSS).toContain("max-width:42rem");
    const uiCss = (SITE_CSS.replace(SITE_FONT_CSS, "") + SLOGAN_STUDY_CSS)
      .replace("--ui-font-size:14px;", "").replace("html{font-size:16px}", "").replace(globalRule, "");
    // No competing size, weight, or size-bearing shorthand can silently restore an exception.
    expect(uiCss).not.toMatch(/font-size:|font-weight:|font:(?!inherit)/);
    expect(SLOGAN_STUDY_CSS).toContain(".study-mark-large svg{height:54px;width:30px}");
    expect(SLOGAN_STUDY_CSS).toContain(".study-mark-small svg{height:24px;width:13.333px}");
  });

  it("self-hosts upright and italic variable fonts with Latin and extended-Latin coverage", () => {
    expect(paths).toHaveLength(4);
    expect(new Set(paths).size).toBe(4);
    expect(SITE_FONT_CSS.match(/font-family: 'Instrument Sans';/g)).toHaveLength(4);
    expect(SITE_FONT_CSS.match(/font-weight: 400 700;/g)).toHaveLength(4);
    expect(SITE_FONT_CSS.match(/font-display: swap;/g)).toHaveLength(4);
    expect(SITE_FONT_CSS.match(/font-style: italic;/g)).toHaveLength(2);
    expect(SITE_FONT_CSS.match(/unicode-range:/g)).toHaveLength(4);
  });

  it.each(paths)("resolves versioned WOFF2 bytes for %s", (path) => {
    expect(path).toMatch(/^\/assets\/fonts\/instrument-sans-5\.3\.0\//);
    const asset = siteFontAsset(path)!;
    expect(asset.contentType).toBe("font/woff2");
    expect(asset.bytes.subarray(0, 4).toString()).toBe("wOF2");
    expect(asset.bytes.length).toBeGreaterThan(10_000);
  });

  it("preloads only upright Latin with the same anonymous URL used by CSS", () => {
    const path = SITE_FONT_PRELOAD.match(/href="([^"]+)"/)![1];
    expect(paths).toContain(path);
    expect(path).toMatch(/\/instrument-sans-latin-wght-normal\.woff2$/);
    expect(SITE_FONT_PRELOAD).toContain('as="font" type="font/woff2" crossorigin');
    expect(SITE_FONT_PRELOAD.match(/<link /g)).toHaveLength(1);
  });

  it("ships the license without exposing arbitrary package or filesystem paths", () => {
    const licensePath = paths[0].replace(/[^/]+$/, "LICENSE.txt");
    const license = siteFontAsset(licensePath)!;
    expect(license.bytes.toString()).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(license.bytes.toString()).toContain("Copyright 2022 The Instrument Sans Project Authors");
    expect(siteFontAsset(licensePath.replace("LICENSE.txt", "package.json"))).toBeUndefined();
    expect(siteFontAsset(`${licensePath}/../../package.json`)).toBeUndefined();
  });

  it("removes legacy serif and monospace overrides, including native form and code defaults", () => {
    expect(SITE_CSS).toContain('--font-family:"Instrument Sans",sans-serif');
    expect(SITE_CSS + SLOGAN_STUDY_CSS).not.toMatch(/Georgia|Times New Roman|Inter,|ui-monospace|SFMono|Consolas|font-weight:700/);
    expect(SITE_CSS).toContain("button,input,select,textarea{font:inherit}");
    expect(SITE_CSS).toContain("code,pre,kbd,samp{font-family:var(--font-family)}");
    expect(SITE_CSS).toContain("font-variant-numeric:tabular-nums");
    // Numeric captions and provenance retain tabular alignment at the common size.
    const numericSelectors = SITE_CSS.match(/([^{}]+)\{font-variant-numeric:tabular-nums\}/)![1].trim().split(",");
    expect(numericSelectors).toEqual(expect.arrayContaining([
      ".gallery-card-copy>span", ".signature-card time", ".gr0k-readout strong", ".facts dd",
    ]));
  });
});
