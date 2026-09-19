# Slogan signature composition

## Current homepage: eight v2 shapes

The open-mint homepage now uses `sloganMbtiHero.ts`, not the historical v1
composition below. The exact case-sensitive literal is
`The_First_Agent_Artwork`: 23 characters, three underscores, four capital
initials, and no punctuation. Its supporting sentence is
“Choose any X handle. Grok interprets it. Mint to reveal the signature.”
The guidance stays on one line at up to 16px, scaling down with its intro
container on narrow screens to avoid overflow. The primary mint CTA stays
16px on desktop and mobile. Guidance, the mint CTA, and the
"Preview with Grok" disclosure form one centered stack. The expanded preview
instructions stay left-aligned; this layout is scoped to the homepage.
No single MBTI is assigned to the brand:
the hero loops through ISTJ, ISFJ, INFJ, INTJ, ISTP, ISFP, INFP, and INTP. Each
frame also represents its E twin; v2 uses I/E only for the two palettes. The hero
uses `currentColor` on the existing site background, following the light/dark
theme rather than flashing between palettes.

`scripts/capture-slogan-v2.py` captures the eight outlines from the unchanged,
hash-pinned v2.0.1 Python reference at upstream commit
`d00c018d1a740a5807480126d1f1bd0c620fb96d`. Its brand-only adapter accepts only the
fixed 23-character slogan. The upstream `reusable_text_curve_layout` policy
expands the curve span to `(300 / 14) × 22 = 471.428…` and the canonical canvas
to `(span + 120) × 420`, or `591.428… × 420`, with an exported size of
`1521 × 1080`. It supplies the expanded span before
geometry generation and translates the outlined geometry to the new horizontal center; it never
stretches a finished path or changes vertical geometry or stroke weight.
This is not a valid account handle: public rendering and route validation still
enforce the original 1–15 character limit. Signature artwork remains on the
unchanged `sg-renderer-2.0.0` implementation; this adoption is brand-only.
The snapshot records the adapter identity and renderer source hash honestly;
it does not describe the slogan as a Grok assessment or mintable artwork.

`sloganMbtiFrames.ts` stores eight frozen paths and SHA-256 hashes. Runtime uses
only these checked-in paths, with no Python, model calls, randomness, or renderer
execution. Verify the capture with `python3 scripts/capture-slogan-v2.py --check`;
`--emit` prints a candidate for an explicit reviewed snapshot update. Tests
reproduce all eight paths, verify E-twin geometry equality, and keep public input
validation strict. The old v1 renderer and snapshot remain intact for historical
legacy pages and study tests; the favicon is unchanged.

The hero uses one responsive SVG with a common viewport for all frames, with no question mark or period. A 16-second loop gives each frame two
seconds: a 1000ms hold followed by a 1000ms crossfade. On initial load, all frames
start 1000ms into the cycle, so ISTJ immediately crossfades to ISFJ instead of
waiting through the first hold. ISFJ then holds for 1000ms, and the regular cadence
continues. This is an opacity transition between exact
locked paths, not path interpolation that invents new renderer geometry. There
is no visible playback control. Hover, keyboard focus, hidden tabs, and an
offscreen hero pause playback; reduced motion and no JavaScript show a static
first frame. The tooltip and accessible heading preserve the exact new literal;
their behavior is unchanged.

## Current title and historical punctuation

The approved title is `The_First_Agent_Artwork`, selected from the three
spellings on `/dev/slogan-wording`. The hero version is `sg-slogan-mbti-1.3.0`.
The question mark is removed; its authored outlines remain available to historical
studies. Frame order, theme, 1000ms fade / 1000ms hold, and hover/focus tooltip
are unchanged. Account renderer locks and minted artwork are untouched.
The definition and supporting evidence for “First” belong in About the work;
see MEMO.md for that pending documentation work.

## Historical v1 composition boundary

The following records the retained v1 presentation and its original review flow.
References to its homepage describe the legacy homepage, not the current v2 hero.

The boundary between word rendering and homepage layout is the **Signature Composition Adapter**. Its reviewed artifact is the **shape-lock snapshot**.

The separation is intentional:

1. `src/brand/sloganCompositionSpec.ts` states the readable slogan and one fixed presentation condition.
2. `captureSignatureComposition` tokenizes the copy and calls a `SignatureTextRenderer.renderText({ text, ... })` once per distinct **case-sensitive** input. It does not call account-handle normalization. Underscore-joined phrases remain one input, with an optional trailing question mark retained. Existing composition syntax/length guards reject unsupported input rather than changing its case. The algorithm—not the adapter—owns how characters affect geometry and stroke weight.
3. `src/brand/sloganShapeLock.ts` stores the reviewed word drawings, renderer/source hashes, and semantic shape hashes. Homepage runtime restores and validates this snapshot without calling a mutable renderer.
4. `src/brand/sloganSignature.ts` places those locked drawings. Its API permits translation plus one uniform scale only, so layout cannot stretch a word away from the renderer result.

The selected homepage literal and recorded renderer input are now identical:

```text
What_shape_do_you_go_by?
```

The user selected the sentence-case rendering for the homepage, replacing the previous title-case selection. Its snapshot uses `signature-composition/2`, preserving the capital W, five underscores, and the trailing question mark. The frozen Signature Algorithm v1.0.0 deliberately hashes exact characters and gives ASCII capitals an extra stroke weight of 10 canonical units; the adapter must not erase this behavior. The old lowercase-rendered snapshot is retained only as a historical rejection fixture in `src/brand/fixtures/sloganShapeLock.v1.ts`, not imported by the homepage. This sentence-case selection was recaptured from the formal algorithm on 2026-09-10, not relabelled from the old drawing.

The five underscores and trailing question mark still enter the geometry as one connected phrase. This 24-character presentation phrase exceeds the 15-character X-handle limit. The extension applies only to brand composition; preview, identity, and claim validation retain the 1–15 ASCII letters, numbers, or underscores restriction. It follows the release's reusable-text layout policy: the reference segment width remains `300 / 14` canonical units, so this phrase uses a `612.8571428571429 × 420` canonical canvas instead of being squeezed into 420 units. The composition adapter records that canonical viewport independently of the exported pixel dimensions. The current presentation seed is the integer `22` on the approved `sg-renderer-1.0.0`, with an unscaled seed (`gr0kScale: 1`). The formal algorithm's approval does not imply production infrastructure readiness or claim provenance for branding. See [formal algorithm adoption](formal-algorithm-v1.md).

## Iteration workflow

Edit the intent in `sloganCompositionSpec.ts` or change the renderer, then inspect—do not silently overwrite—the candidate:

```bash
npm run slogan:inspect
npm run slogan:inspect -- --json
```

The first command reports added, removed, changed, and unchanged literal inputs, plus the candidate and locked schema versions. The JSON form emits the complete candidate snapshot for review. The selected sentence-case snapshot currently reports **EXACT MATCH**, and `--check` exits 0. A later renderer or slogan change still requires deliberate replacement of the checked-in snapshot and, when token count or grouping changes, updating the independent desktop/mobile placements. Tests compare the selected capture directly against the formal algorithm using its exact spelling and verify that retired scalar-based snapshots are rejected.

The adapter still recognizes the historical `signature-composition/1` token schema for read-only validation, but all snapshots must now satisfy the formal integer-seed contract. The retired fixture's decimal-scale seed fails this validation; changing its schema cannot promote it into the current formal lock. New captures always use the exact-case `signature-composition/2` schema.

Both current presentations preserve word geometry exactly:

- the homepage is centered and capped at 1024px including 32px inner gutters (20px at widths up to 600px), with three signatures per gallery row, two at widths up to 820px, and one at widths up to 600px; it has natural scrolling height, its footer and collection shortcut align to the same page boundary, and other screens retain their existing layouts;
- the centered slogan sits above the gallery; both sections share the page's system-themed background without a divider, while artwork cards retain their paper color;
- desktop and narrow screens: the same intact connected path;
- the exact authored literal, `What_shape_do_you_go_by?`, is visually hidden but remains the accessible heading and signature label. A small pointer-adjacent tooltip shows after 120ms of hover, with an I-beam (`cursor:text`). It follows 12px beside the pointer, flips/clamps at viewport edges, shows immediately on keyboard focus, and dismisses on Escape, blur, or scroll. The tooltip can itself be hovered. Touch hover is ignored. Its visual duplicate is hidden from assistive technology because the figure is already labelled by the heading. `sloganTooltipScript.ts` removes the browser's native `title` only after installing the enhancement, leaving the native tip as a no-JS fallback. The tooltip and manifest both preserve the exact captured input;
- transparent SVG using `currentColor`, with neutral ink on home (black in light mode, light ink in dark mode);
- the enhanced hover target follows the visible curve and question mark's combined screen-space bounds, plus an 8px buffer, rather than the full SVG canvas. Blank margins keep the arrow cursor and do not start the tooltip timer; the I-beam appears only near the artwork. Geometry is measured from the active responsive SVG, so future approved shapes need no hand-tuned hover coordinates. Artwork, spacing, and shape-lock hashes remain unchanged;
- the presentation viewport is `35 145 562.8571428571429 120`, shared by desktop and mobile, with enough margin for the complete formal curve;
- the approved, font-free **Open flow** `?` follows the curve at `translate(565.8571428571429 169)`, derived from the wider canonical canvas. Its tapered hook and detached dot use authored SVG outlines. It scales with the composition but remains a presentation annotation, not generated geometry or part of the shape lock;
- no path matrices, non-uniform scaling, source text from the renderer, external references, or renderer calls at request time.

## Accepted study and retained comparisons

The user selected **Open flow** with **`What_shape_do_you_go_by?`** from the case-preserving design study. The homepage retains that exact pairing, recaptured with formal v1.0.0 as `sg-slogan-composition-8.0.0`, with composition ID `agent-art-slogan-v8` and unchanged punctuation version `sg-question-mark-open-flow-1`.

The selected drawing's semantic SHA-256 is `cc0e4cea391e4f44e2d9f3fd4f4aeed8ad722ff40e9a8b2274c308ac24cd178f`. Its composite SVG hash is `c914e3aa9c71c28e7298693ae1fd7b78a533ff20597367640592c2b31d7a0e44`, frozen separately in `sloganSignature.test.ts` to cover the punctuation as well as the generated shape. The shared `OPEN_FLOW_QUESTION_MARK` export prevents the homepage and study from drifting into different versions of the selected outline.

In fixture mode, `/dev/slogan-study` retains the two question marks, 54px and 24px specimens, and alternative wordings for comparison. Its punctuation section uses the locked homepage drawing. Its language and letter-case sections preserve each literal at integer `gr0k 22`; sentence case is labelled as selected and matches the homepage lock. Both letter-case rows keep their own fixed spelling rather than inheriting the active homepage copy. A collapsed reference shows the current homepage artwork and its literal input. Neither this page nor its stylesheet is served outside fixture mode; both are uncached, and the page is marked noindex. The homepage does not import the study or invoke a renderer.

Any later wording or renderer change still requires a new capture and explicit snapshot acceptance. Visiting the study does not modify the accepted homepage artwork.

The `#letter-case` section still compares `What_shape_do_you_go_by?` with `What_Shape_Do_You_Go_By?`. Their semantic hashes are respectively `cc0e4cea391e4f44e2d9f3fd4f4aeed8ad722ff40e9a8b2274c308ac24cd178f` and `5b2248bddd9ead57149779ea7c60b55cc6328dbf047998e107b6f674cc0a38a4`. The specimens retain the same question mark, scale, and gr0k. Sentence case is selected; title case remains available for comparison. Visiting the study never promotes a candidate automatically.
