import { VALID_PROTOTYPE_PRESET_HANDLES, type PROTOTYPE_PRESET_HANDLES } from "../v2/prototypePresetHandles.js";
import { canonicalHandle, MBTI_TYPES, RENDERER_VERSION, type MBTI } from "./identity.js";
import type { AssessmentPageModel, GalleryEntry } from "./pages.js";

/** Exact prototype spellings paired with sample MBTI inputs for visual review. */
const INPUTS = [
  ["grok", "ISTJ"],
  ["MegaDeFi", "ISFJ"],
  ["RikOostenbroek", "INFJ"],
  ["philmo_mu", "INTJ"],
  ["jackbutcher", "ISTP"],
  ["92digitalArt", "ISFP"],
  ["Otter805", "INFP"],
  ["tylerxhobbs", "INTP"],
  ["Synth_Taxon", "ESTP"],
  ["ALCrego_", "ESFP"],
  ["AlphaVerse", "ENFP"],
  ["Zangetsu_Soul", "ENTP"],
  ["Omme_82", "ESTJ"],
  ["0xCryptoWizzy", "ESFJ"],
  ["inshell_art", "ENFJ"],
  ["AuraMetaX", "ENTJ"],
] as const satisfies readonly (readonly [(typeof PROTOTYPE_PRESET_HANDLES)[number], MBTI])[];

// Keep the original samples and their artwork stable, then fill out every type
// evenly from the richer preset catalog and three existing legacy gallery inputs.
// These strings are visual test inputs, not verified account identities.
const initialHandles = new Set(INPUTS.map(([handle]) => canonicalHandle(handle)));
const additionalHandles = [...VALID_PROTOTYPE_PRESET_HANDLES, "beeple", "xcopyart", "refikanadol"]
  .filter(handle => !initialHandles.has(canonicalHandle(handle)));
const galleryInputs: readonly (readonly [string, MBTI])[] = [
  ...INPUTS,
  ...additionalHandles.map((handle, index) => [handle, MBTI_TYPES[index % MBTI_TYPES.length]!] as const),
];

/** Presentation data only: this catalog never creates assessments or mint records. */
export const OPEN_MINT_GALLERY_FIXTURES = Object.freeze(galleryInputs.map(([renderHandle, mbti]) => {
  const handle = canonicalHandle(renderHandle);
  return Object.freeze({
    handle,
    renderHandle,
    mbti,
    imageUrl: `/preview/${renderHandle}/${mbti}.svg?renderer=${RENDERER_VERSION}`,
    url: `/signatures/${handle}`,
    code: "",
    mint: Object.freeze({ state: "minted" as const }),
  } satisfies GalleryEntry);
}));

export function galleryFixtureModel(handle: string): AssessmentPageModel | undefined {
  let canonical: string;
  try { canonical = canonicalHandle(handle); } catch { return undefined; }
  const fixture = OPEN_MINT_GALLERY_FIXTURES.find(entry => entry.handle === canonical);
  if (!fixture) return undefined;
  return {
    handle: fixture.handle,
    renderHandle: fixture.renderHandle,
    code: fixture.code,
    mbti: fixture.mbti,
    imageUrl: fixture.imageUrl,
    svgUrl: fixture.imageUrl,
    mint: fixture.mint,
    status: "ready",
    canMint: false,
    galleryFixture: true,
    rendererVersion: RENDERER_VERSION,
    assessmentProvenance: "development-fixture",
  };
}
