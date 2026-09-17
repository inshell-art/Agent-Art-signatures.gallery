import { describe, expect, it } from "vitest";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { VALID_PROTOTYPE_PRESET_HANDLES } from "../v2/prototypePresetHandles.js";
import { canonicalHandle, MBTI_TYPES, RENDERER_VERSION } from "./identity.js";
import { galleryFixtureModel, OPEN_MINT_GALLERY_FIXTURES } from "./galleryFixtures.js";

describe("open mint presentation gallery fixtures", () => {
  it("preserves the original 16 artwork spellings, MBTI mappings, and display order", () => {
    expect(OPEN_MINT_GALLERY_FIXTURES.slice(0, 16).map(entry => [entry.renderHandle, entry.mbti])).toEqual([
      ["grok", "ISTJ"], ["MegaDeFi", "ISFJ"], ["RikOostenbroek", "INFJ"], ["philmo_mu", "INTJ"],
      ["jackbutcher", "ISTP"], ["92digitalArt", "ISFP"], ["Otter805", "INFP"], ["tylerxhobbs", "INTP"],
      ["Synth_Taxon", "ESTP"], ["ALCrego_", "ESFP"], ["AlphaVerse", "ENFP"], ["Zangetsu_Soul", "ENTP"],
      ["Omme_82", "ESTJ"], ["0xCryptoWizzy", "ESFJ"], ["inshell_art", "ENFJ"], ["AuraMetaX", "ENTJ"],
    ]);
  });

  it("contains 80 distinct canonical handles with all 77 valid presets and five works per MBTI", () => {
    expect(VALID_PROTOTYPE_PRESET_HANDLES).toHaveLength(77);
    expect(OPEN_MINT_GALLERY_FIXTURES).toHaveLength(80);
    expect(new Set(OPEN_MINT_GALLERY_FIXTURES.map(entry => entry.handle)).size).toBe(80);
    expect(new Set(OPEN_MINT_GALLERY_FIXTURES.map(entry => entry.renderHandle))).toEqual(new Set([
      ...VALID_PROTOTYPE_PRESET_HANDLES, "beeple", "xcopyart", "refikanadol",
    ]));
    for (const mbti of MBTI_TYPES) {
      expect(OPEN_MINT_GALLERY_FIXTURES.filter(entry => entry.mbti === mbti), mbti).toHaveLength(5);
    }
    for (const fixture of OPEN_MINT_GALLERY_FIXTURES) {
      expect(fixture.handle).toBe(canonicalHandle(fixture.renderHandle));
    }
  });

  it("appends the remaining presets and extra examples in stable order across every MBTI", () => {
    const originalHandles = new Set(OPEN_MINT_GALLERY_FIXTURES.slice(0, 16).map(entry => entry.renderHandle));
    const additions = OPEN_MINT_GALLERY_FIXTURES.slice(16);
    expect(additions.map(entry => entry.renderHandle)).toEqual([
      ...VALID_PROTOTYPE_PRESET_HANDLES.filter(handle => !originalHandles.has(handle)),
      "beeple", "xcopyart", "refikanadol",
    ]);
    expect(additions.map(entry => entry.mbti)).toEqual([...MBTI_TYPES, ...MBTI_TYPES, ...MBTI_TYPES, ...MBTI_TYPES]);
  });

  it("freezes the catalog, entries, and their presentation mint states", () => {
    expect(Object.isFrozen(OPEN_MINT_GALLERY_FIXTURES)).toBe(true);
    for (const fixture of OPEN_MINT_GALLERY_FIXTURES) {
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(Object.isFrozen(fixture.mint)).toBe(true);
    }
  });

  it.each(OPEN_MINT_GALLERY_FIXTURES)("renders $renderHandle through the v2 preview route without changing its spelling", fixture => {
    const image = new URL(fixture.imageUrl, "https://signatures.example");
    expect(image.pathname).toBe(`/preview/${fixture.renderHandle}/${fixture.mbti}.svg`);
    expect(image.searchParams.get("renderer")).toBe(RENDERER_VERSION);
    expect(fixture.url).toBe(`/signatures/${fixture.handle}`);
    const svg = renderSignatureSvg(fixture.renderHandle, fixture.mbti);
    expect(svg).toContain(`<svg `);
    expect(svg).toContain(`>@${fixture.renderHandle}</text>`);
    expect(svg).toContain('<path d="');
    if (fixture.renderHandle !== fixture.handle) {
      expect(svg).not.toBe(renderSignatureSvg(fixture.handle, fixture.mbti));
    }
  });

  it("looks up canonical identities while retaining the catalog's original artwork spelling", () => {
    const expected = OPEN_MINT_GALLERY_FIXTURES.find(fixture => fixture.renderHandle === "MegaDeFi")!;
    for (const handle of ["megadefi", "MegaDeFi", "@MEGADEFI"]) {
      expect(galleryFixtureModel(handle)).toEqual({
        handle: "megadefi", renderHandle: "MegaDeFi", code: "", mbti: expected.mbti,
        imageUrl: expected.imageUrl, svgUrl: expected.imageUrl, mint: { state: "minted" },
        status: "ready", canMint: false, galleryFixture: true, rendererVersion: RENDERER_VERSION,
      });
    }
  });

  it.each(["unknown_handle", "", "@", "@@grok", "grok/../", " grok", "grok ", "a".repeat(16), "署名"])(
    "returns no fixture for missing or invalid lookup %j", handle => {
      expect(galleryFixtureModel(handle)).toBeUndefined();
    },
  );

  it("preserves internal sample state without inventing token, wallet, transaction, or assessment facts", () => {
    for (const fixture of OPEN_MINT_GALLERY_FIXTURES) {
      expect(fixture.code).toBe("");
      expect(fixture.mint).toEqual({ state: "minted" });
      const model = galleryFixtureModel(fixture.handle)!;
      expect(model.canMint).toBe(false);
      expect(model.galleryFixture).toBe(true);
      for (const field of ["tokenId", "transactionHash", "wallet", "explorerUrl", "assessment", "assessedAt", "sourceLabel", "svgSha256", "pngSha256"]) {
        expect(fixture).not.toHaveProperty(field);
        expect(model).not.toHaveProperty(field);
        expect(model.mint).not.toHaveProperty(field);
      }
    }
  });
});
