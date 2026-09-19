# E11 provenance validation

Checked 2026-09-19 on `codex/execution-table`, following `3d840c9`. This is offline implementation evidence, not a live Grok result.

## Boundaries verified

- Provenance stays in the collapsed confirmed-mint detail view, grouped as Assessment, Artwork and Mint with one combined Caveat.
- Assessor and model come from the saved assessment, not current runtime configuration. Missing source is “Not recorded”; development data is explicitly a fixture inside provenance only.
- All 16 MBTI types expand their actual four letters, without adding personality stereotypes, confidence or invented rationale.
- Source links are bounded, escaped, deduplicated HTTPS links without embedded credentials, unsafe schemes or remote content. They use `noopener noreferrer` and `no-referrer`. Current live contents are not guaranteed by historical citations.
- Numeric account links require the recorded X-verified preparation snapshot. Artwork `@handle` links still go to `/p/<case-preserved-handle>/variations`; MBTI and Minted retain their gallery destinations.
- Pending/preparing/ready/failed pages and progress JSON do not disclose assessment evidence. Confirmed HTML/status JSON adds no provider response ID, raw response, private receipt or spending data.
- Existing immutable metadata already includes its original assessment/provider response ID. This change does not redact/rewrite historical metadata or change any digest; stronger future public-metadata minimization belongs to E18's explicit versioned schema decision.
- HTTP tests compare exact SVG, PNG, metadata and assessment bytes/hashes before/after browsing, and assert zero provider, signer and persistence calls.

## Automated checks

- `OPEN_MINT_TEST_HTTP=1 npm run test:coverage -- --reporter=dot`: **3,651 passing tests in 122 files**. The initial run found an old exact fixture-model expectation; updated it to require explicit fixture provenance without inventing model/time/identity evidence, then reran the full suite.
- Coverage: **95.04% statements, 91.17% branches, 98.04% functions**. Existing global thresholds unchanged. New provenance module: **100% statements/functions, 98.11% branches**.
- `npm run typecheck`, `npm run build` (including all renderer locks), `git diff --check`: passed.
- Server suite: **78 tests**, verified with both stream-backed and actual loopback HTTP transport. Providers remained mocked.

## Browser evidence

Used the visual-DOM CDP skill with fresh headless Chrome profiles, real page/client/CSS/font modules, and a temporary read-only loopback server. The visual models are explicit test data. No application store, provider credential, wallet or chain was used. No user's dev server was restarted.

| Case | Viewport / theme | Result |
| --- | --- | --- |
| Saved Grok evidence, verified ID, long source URL | 390×844 light | Closed initially; opens normally; no horizontal overflow or off-screen provenance element |
| Saved Grok evidence | 1280×1400 dark | Assessment/Artwork/Mint hierarchy and one amber Caveat; long sources and hashes wrap |
| Fixture evidence | 390×844 dark | Explicit sample/non-Grok explanation; no research links or verified-identity claim |
| Missing assessor/model | 320×844 light | Not recorded; no inferred Grok; long timestamp/hash/token wraps |
| Legacy renderer, no identity snapshot | 1280×1400 dark | Recorded renderer kept; no fabricated X verification; stored source links remain |

All cases: Instrument Sans loaded; observed assets returned HTTP 200; only local GET requests; no external-source fetching, POST, wallet prompt or provider call. DOM geometry and screenshots were both inspected. Browser review led to keeping each MBTI letter/meaning pair together when wrapping.

Temporary screenshots are under `/private/tmp/sg-provenance-qa.AkQWtH/` (`mobile-final-light.png`, `desktop-dark.png`, `fixture-mobile-dark.png`, `unknown-320-light.png`, `legacy-desktop-dark.png`). They are local verification artifacts, not public assets or claimed provider evidence. The temporary server is stopped after verification.

## Remaining gates

E10 still needs private X/xAI credentials and the approved one-attempt execution envelope; @karpathy is the selected target. E11's live evidence check is not complete until that pilot succeeds. E12's First claim decision and broader E13/E14 device/accessibility scope remain separate from these provenance checks.
