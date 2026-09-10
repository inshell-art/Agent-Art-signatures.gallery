# Formal Signature Algorithm v1.0.0

Source of truth: the prototype's `v1.0.0` Git tag, commit `1e1dab4ec093261006feb7879c109413c0b3ac6d`. The reference Python implementation, JSON specification, and SHA256 checksums are vendored under `reference/algorithm-v1.0.0`. The TypeScript port lives in `src/algorithmV1`; it is used by previews, claimed SVG/PNG assets, metadata, and renderer-derived branding.

## Approved and locked

The project owner visually validated the expanded preset gallery and approved this renderer on **2026-09-10**. The repository lock is [renderer-lock.json](../reference/algorithm-v1.0.0/renderer-lock.json). Locking did not change or regenerate any artwork, claim, permalink, or branding snapshot.

The lock checks SHA-256 hashes of the upstream Python, JSON and checksum list, the exact TypeScript port, the renderer adapter and the input boundary. Seventeen fixed **complete SVG** hashes cover case differences, digits, underscores, short/max-length handles, boundary seeds, custom dimensions and expanded branding text. The existing Python oracle tests remain independent of these goldens. Fixture handles and gallery ordering are deliberately outside the lock.

Run `npm run renderer:verify` for the fast check. `npm run dev`, `npm run local:serve` (including its real-X and emulator wrappers), `npm test` and `npm run build` run this gate automatically; the test suite also exercises tamper failures without editing the repository. This is a source/build regression guard, not a runtime signature or a production-readiness claim. Low-level direct entrypoint commands do not run npm lifecycle hooks.

Do not update hashes or snapshots just to make a renderer change pass. A deliberate artwork change requires a new versioned implementation and reference directory, new renderer/card IDs as applicable, independent parity checks, and explicit visual approval. Preserve the old implementation and all already-claimed stored bytes; never replace artwork behind an existing signature ID. A newer tag or default branch in the prototype repository does not update this lock automatically.

Canonical reproducibility applies to SVG bytes, including the formal handle label. Sharp is exactly pinned at `0.35.4`, with its resolved native dependencies in `package-lock.json`; use `npm ci`. PNG cards are derived: native rasterization libraries and the reference SVG's system-font fallback can differ across platforms. PNG checks cover local repeatability, dimensions and colors, not a false guarantee of identical cross-platform bytes. Existing claimed PNGs remain stored and hash-addressed, never rerendered in place.

## Input and output

- Artwork handle:1–15 ASCII letters, digits, or underscores, preserving exact case. `Alice` and `alice` draw different works. The public URL/form boundary accepts a leading `@` and redirects to the exact spelling without it; the renderer itself accepts only the formal handle grammar.
- `gr0k_raw`:integer1–100, default22. It is a labeled deterministic random seed, not a percentage, fixed-point decimal, score, or linear deformation amount.
- Example:`/s/TimD1919027/22`. Old decimal URLs are rejected, not silently converted.
- Renderer:`sg-renderer-1.0.0`; PNG card:`sg-card-1.0.0`.
- Standard SVG and PNG:1080×1080. Canonical geometry:420×420. Background:`#f4e7c7`; ink:`#000000`. The formal SVG's handle label is retained.
- The wider branding-text adapter follows the reference's reusable long-text layout; it does not compress long phrases into the standard handle canvas.

OAuth compares the normalized account handle, but the frozen claim stores the exact preview spelling as `handleAtClaim`. Signature IDs and tuple uniqueness include that exact case, seed, X account ID, and renderer version. The account's current OAuth spelling is stored separately. An OAuth callback must not replace the preview spelling or change the consented artwork bytes.

The existing storage/API field `gr0k_scale` is retained as **1**, meaning an unscaled integer. No division by100 or1,000,000 occurs. Metadata displays the exact-case handle and integer seed.

## Intentional breaking cutover

Old decimal-seed claims, content references, and associated local chain history are retired together. Their `/signatures/…` and `/artifacts/…` endpoints no longer resolve. No aliases, automatic seed conversion, or artwork replacement at old IDs are provided. New claims use new IDs.

Migration004 refuses to reinterpret existing old claims. Back up and explicitly retire the obsolete local state before initializing a fresh rehearsal. A code update or routine `local:up` never silently deletes a database. Keep `.env.local` and its OAuth credentials outside the reset. Do not reset another project's Anvil or any public network.

Local rehearsal tokens remain explicitly local/unpublished even though their artwork uses the formal renderer. Formal algorithm adoption does not authorize or enable a mainnet deployment.

## Verification

Parity tests execute the pinned Python reference and compare complete SVG bytes against TypeScript for all100 seeds across mixed-case, digit, underscore, short, and maximum-length handles, plus square and non-square exports. Additional tests cover input rejection, case-sensitive claim identity, OAuth preview binding, SQL constraints, metadata, branding snapshots, and PNG output.
