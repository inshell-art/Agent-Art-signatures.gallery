# Signature renderer v2.0.0 — pinned upstream reference

Source: [agent-art-Signature-prototype, tag v2.0.0](https://github.com/inshell-art/agent-art-Signature-prototype/tree/v2.0.0).

- Commit: `4bcc513b53edac6961e385604cd9fcc3ac913cbb`
- Annotated tag object: `84992e64634ab8d35461122776b53d8da9bd1ccf`
- Python SHA-256: `c589f8ac607104f77a26347e39d19ba684ef5ee92baa3e3093c62a8df6618f26`
- Settings SHA-256: `cea650e1b84486f5313760cf82a886036d448085b3bc5e70f643161ad406b507`

The Python and JSON are verbatim release files. `SHA256SUMS` is the full upstream manifest; its v1 and design-panel entries refer to files outside this directory and are retained as provenance, not claimed to be vendored here. The app executes a TypeScript port in `src/algorithmV2/index.ts`, not Python or the mutable prototype checkout.

`golden-svgs.json` contains 384 complete SVG SHA-256 results generated **from the tagged Python implementation**, not from the TypeScript port: 20 handles × all 16 MBTIs, plus all 16 MBTIs at four additional output sizes (including rectangular outputs). Never regenerate these from application output to make a failing test pass.

`renderer-lock.json` pins these source files, the TypeScript implementation and oracle goldens. `npm run renderer:verify` checks both this version and the unchanged v1.0.0 lock. This is a source/parity pin; it does not assert a new owner visual approval. Future changes require a new renderer version.

## Release behavior

- Exact-case ASCII X handle, 1–15 characters, no `@` inside the renderer.
- Native MBTI, default `INFP`; no numeric `gr0k` adapter and no MBTI in the PRNG hash payload.
- E/I: light/dark field polarity. S/N: handle geometry and digit pulse lengths. T/F: sampled linear/cubic Bézier outline. J/P: X rhythm and Y distribution.
- Uppercase characters carry extra stroke weight; underscores have zero stroke weight with their own spacing/Y scopes. Digits use equal-width pulses.
- Canonical geometry is 420 × 420; default output is 1080 × 1080. Rectangular output scales uniformly and centers the curve without distortion. The handle label sits at 95% of output height.
- SVG bytes are canonical. PNGs are derived with pinned Sharp; system font/native-library differences can still affect rasterization across platforms.

Existing v1 artifacts, assessment digests, token URIs and minted commitments are not rewritten. Saved assessments retain their renderer version; only new assessments and editable previews use v2.
