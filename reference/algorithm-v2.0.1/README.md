# Signature v2.0.1 — slogan-only adoption

Upstream: [agent-art-Signature-prototype, tag v2.0.1](https://github.com/inshell-art/agent-art-Signature-prototype/tree/v2.0.1).

- Commit: `d00c018d1a740a5807480126d1f1bd0c620fb96d`
- Annotated tag object: `5c68785c9723cd2cd9175d0283ee22d7cfcd6fc3`
- Python SHA-256: `bfa7ebdfb6e5ced7ddc0b92c3facb3709863ee6c6d10cf9a2f1596c018ecb896`
- JSON SHA-256: `c305da7492b26749e9d4e88c4b0cb4de4deb1f654f334a6aaa6abe367078faa6`

Python and JSON are verbatim upstream files. The complete upstream
`SHA256SUMS` is retained for provenance; entries for old renderers and design
panels do not imply those files are copied into this directory.

This patch supplies `reusable_text_curve_layout(character_count)` for separate
non-handle consumers. Signature input remains 1–15 ASCII letters, digits or
underscores. It does **not** add a general long-text Signature endpoint.

The gallery adopts this policy only for its fixed 23-character brand phrase,
`The_First_Agent_Artwork`, preserving all three underscores and four capital
initials. The offline capture sets the upstream profile's
curve span to `(300 / 14) × 31`, uses the unmodified geometry/outline functions,
and translates the centered geometry to the widened canvas center. This keeps
the original vertical geometry, handle lengths and stroke weights: no finished
path is stretched. Canvas width is `span + 120`, giving a size of approximately
`591.429 × 420`, exported at `1521 × 1080`.

The checked-in eight-frame snapshot records its source and layout. The homepage
uses a shared, tighter presentation crop with uniform responsive scaling and
the approved authored Rebalanced ink hook. The hero presentation is `sg-slogan-mbti-1.2.6`;
its eight-shape order, playback timing, and theme remain unchanged; the question mark is removed.
The supporting sentence is “Choose any X handle. Grok interprets it. Mint to
reveal the signature.” It is centered on one line, using 16px where it fits and
scaling down on narrow screens. The primary mint CTA remains 16px.
Capture verification:

```sh
python3 scripts/capture-slogan-v2.py --check
npm run renderer:verify
```

The source/snapshot lock is not an assertion of owner visual approval. New
signature previews, assessments and mints remain `sg-renderer-2.0.0`; their
renderer implementation and old locks are unchanged. No saved artwork,
metadata, commitments, token identities or mint eligibility are migrated.
