# Signature Field v1.0.0 — frozen source of truth

The Python generator, JSON specification and checksum list are unmodified from
[`inshell-art/agent-art-Signature-prototype`, tag `v1.0.0`](https://github.com/inshell-art/agent-art-Signature-prototype/tree/v1.0.0),
commit `1e1dab4ec093261006feb7879c109413c0b3ac6d`.

The gallery's renderer was visually approved and locked on **2026-09-10**.
`renderer-lock.json` is a gallery-owned approval manifest, not an upstream file.
It freezes the validated port/adapter/input source hashes and complete SVG
goldens without altering the vendored release. Run `npm run renderer:verify`;
normal dev, test and build commands run the same guard automatically. There is
no automatic lock-update command. See [the change policy](../../docs/formal-algorithm-v1.md#approved-and-locked).

`src/algorithmV1/index.ts` ports this generator. Tests verify the upstream file
checksums and compare complete SVG bytes against the Python oracle over all 100
seeds, mixed-case handles, digit placement, underscore weights and output sizes.

The formal handle entry point accepts exact-case ASCII X handles of 1–15
characters, without `@`, and integer `gr0k_raw` values from 1 to 100. It preserves
the release's path, background, ink, displayed handle and default 1080px output.

The separate `renderTextSvg` entry point is branding reuse, not a Signature or
claim. For more than 15 characters it applies the release's
`reusable_text_curve_layout` policy: retain the reference segment width and
expand the canvas instead of compressing additional anchors into 420 units.

Do not replace these reference files when changing the TypeScript port. A new
upstream release requires a separately versioned source and explicit adoption.
