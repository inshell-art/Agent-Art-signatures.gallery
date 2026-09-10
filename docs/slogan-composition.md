# Slogan signature composition

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

The user selected the sentence-case rendering for the homepage, replacing the previous title-case selection. Its snapshot uses `signature-composition/2`, preserving the capital W, five underscores, and the trailing question mark. The algorithm deliberately hashes exact characters and gives ASCII capitals an extra stroke weight (8px in the current settings); the adapter must not erase this behavior. The old lowercase-rendered v1 snapshot is retained only as a historical test fixture in `src/brand/fixtures/sloganShapeLock.v1.ts`, not imported by the homepage. This sentence-case selection is a new literal capture, not a restoration of the old case-folded drawing.

The five underscores and trailing question mark still enter the geometry as one connected phrase. This 24-character presentation phrase exceeds the 15-character X-handle limit. The adapter's extension applies only to brand composition; preview, identity, and claim validation retain their existing character and length restrictions. The current review condition is `gr0k 0.500000` on `sg-renderer-dev-fixture`; that renderer is explicitly unapproved and remains a local-development dependency, not a production provenance claim.

## Iteration workflow

Edit the intent in `sloganCompositionSpec.ts` or change the renderer, then inspect—do not silently overwrite—the candidate:

```bash
npm run slogan:inspect
npm run slogan:inspect -- --json
```

The first command reports added, removed, changed, and unchanged literal inputs, plus the candidate and locked schema versions. The JSON form emits the complete candidate snapshot for review. The selected sentence-case snapshot currently reports **EXACT MATCH**, and `--check` exits 0. A later renderer or slogan change still requires deliberate replacement of the checked-in snapshot and, when token count or grouping changes, updating the independent desktop/mobile placements. Tests compare the selected capture directly against the algorithm using its exact spelling and retain separate coverage for historical v1 restoration.

Snapshot restoration supports `signature-composition/1` only as a read-only historical format. Its old lowercase mapping is checked while restoring stored bytes, never used for a new capture. A v1 snapshot cannot be relabelled as v2 to bypass literal-input validation. Descriptions retain the snapshot's actual schema version.

Both current presentations preserve word geometry exactly:

- the homepage is centered and capped at 1024px including 32px inner gutters (20px at widths up to 600px), with three signatures per gallery row, two at widths up to 820px, and one at widths up to 600px; it has natural scrolling height, its footer and collection shortcut align to the same page boundary, and other screens retain their existing layouts;
- the centered slogan sits above the gallery; both sections share the page's system-themed background without a divider, while artwork cards retain their paper color;
- desktop and narrow screens: the same intact connected path;
- the exact authored literal, `What_shape_do_you_go_by?`, is visually hidden but remains the accessible heading and signature label. A small pointer-adjacent tooltip shows after 120ms of hover, with an I-beam (`cursor:text`). It follows 12px beside the pointer, flips/clamps at viewport edges, shows immediately on keyboard focus, and dismisses on Escape, blur, or scroll. The tooltip can itself be hovered. Touch hover is ignored. Its visual duplicate is hidden from assistive technology because the figure is already labelled by the heading. `sloganTooltipScript.ts` removes the browser's native `title` only after installing the enhancement, leaving the native tip as a no-JS fallback. The tooltip and manifest both preserve the exact captured input;
- transparent SVG using `currentColor`, with neutral ink on home (black in light mode, light ink in dark mode);
- the enhanced hover target follows the visible curve and question mark's combined screen-space bounds, plus an 8px buffer, rather than the full SVG canvas. Blank margins keep the arrow cursor and do not start the tooltip timer; the I-beam appears only near the artwork. Geometry is measured from the active responsive SVG, so future approved shapes need no hand-tuned hover coordinates. Artwork, spacing, and shape-lock hashes remain unchanged;
- the approved, font-free **Open flow** `?` follows the curve at `translate(373 169)`, exactly as shown in the selected study. Its tapered hook and detached dot use authored SVG outlines. It scales with the composition but remains a presentation annotation, not generated geometry or part of the shape lock;
- no path matrices, non-uniform scaling, source text from the renderer, external references, or renderer calls at request time.

## Accepted study and retained comparisons

The user selected **Open flow** with **`What_shape_do_you_go_by?`** from the case-preserving design study. The homepage now uses that exact pairing as `sg-slogan-composition-7.0.0`, with composition ID `agent-art-slogan-v7` and punctuation version `sg-question-mark-open-flow-1`.

The selected drawing's semantic SHA-256 is `142988f78977033590a0bd286f08e46392e99ef86e8da23aa80702304f883f4b`. Its composite SVG hash is `7cb8550c8f14a0c3a7f3de24874a18b0bc21ba2716781d61e85e33871903afee`, frozen separately in `sloganSignature.test.ts` to cover the punctuation as well as the generated shape. The shared `OPEN_FLOW_QUESTION_MARK` export prevents the homepage and study from drifting into different versions of the selected outline.

In fixture mode, `/dev/slogan-study` retains the two question marks, 54px and 24px specimens, and alternative wordings for comparison. Its punctuation section uses the locked homepage drawing. Its language and letter-case sections preserve each literal at `gr0k 0.500000`; sentence case is labelled as selected and matches the homepage lock. Both letter-case rows keep their own fixed spelling rather than inheriting the active homepage copy. A collapsed reference shows the current homepage artwork and its literal input. Neither this page nor its stylesheet is served outside fixture mode; both are uncached, and the page is marked noindex. The homepage does not import the study or invoke a renderer.

Any later wording or renderer change still requires a new capture and explicit snapshot acceptance. Visiting the study does not modify the accepted homepage artwork.

The `#letter-case` section still compares `What_shape_do_you_go_by?` with `What_Shape_Do_You_Go_By?`. Their semantic hashes are respectively `142988f78977033590a0bd286f08e46392e99ef86e8da23aa80702304f883f4b` and `ec359c61fb03ada7cf98e2e77451e1234ff27475b69cd3ca546a0265a11cf741`. The specimens retain the same question mark, scale, and gr0k. Sentence case is now selected; title case remains available for comparison. Visiting the study never promotes a candidate automatically.
