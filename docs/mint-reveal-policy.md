# Early reveal and terminal confirmation

Selected by the user on September 20, 2026: **reveal earlier with a “Confirming” label**. This replaces the earlier proposal to wait for finality before revealing. It does not authorize public deployment, provider spending, or signing/broadcasting on Sepolia.

## Product contract

| Evidence | Detail / selected variation | Gallery, collection and minted sharing | Allowed automated action |
| --- | --- | --- | --- |
| Preparation or submitted hash only | Result hidden; progress remains pending | Excluded | Read-only reconciliation |
| Backend-verified canonical inclusion and matching saved commitments | Reveal saved artwork; amber **Confirming** | Excluded | Read-only confidence monitoring |
| Terminal confirmation boundary | **Minted** | Eligible; ownership uses the same confidence boundary | Normal reads |
| Inclusion lost after early reveal | **Rechecking mint**; hide artwork/provenance, preserve saved bytes | Excluded | Read-only reconciliation; never automatically assess, authorize, sign or resubmit |
| Read failure / inconsistent evidence | **Confirmation unavailable** and the shared lightweight warning | No new admission | Bounded reads with backoff; never infer unminted |

A hash, wallet success message, wallet receipt, preview MBTI, saved projection row or client parameter alone is not authority to reveal. Early disclosure cannot be undone: hiding an orphaned reveal avoids presenting it as canonical; it does not restore secrecy. Assessments and artifact bytes are never rerolled or rewritten by a reorg.

## Implemented local behavior

The existing Anvil adapter now returns `confirming` after its complete canonical block/event, deployment/code/signer, token provenance/URI and saved-artifact verification succeeds, but before its configured confirmation count. `minted` still means the existing local threshold (two confirmations by default). **This is single-node local confidence, not Ethereum finality.** No local chain, wallet history, existing artifact or running service is reset by this change.

The private progress flow redirects at either revealable state. A provisional reveal preserves its submission guard in session storage. Direct `/signatures/<canonical-handle>` access uses the same backend checks; previews/variations use the same Confirming label and saved asset for the chosen type. Home, MBTI and owner collections remain minted-only. Confirming is denied by the separate sharing policy.

The revealed page uses a new read-only `GET /api/signatures/<canonical-handle>/status`. It accepts no query parameters or client confidence, returns only handle/token/confidence and verified commitment/hash fields, and is no-store/noindex. Its browser monitor has an eight-second whole-read deadline, 16 KiB body bound, five-second normal polling and failure backoff capped at 30 seconds. It verifies the original handle/token/artifact binding before promoting/reloading. Page navigation aborts polling; stale responses cannot mutate the page. It never calls a wallet, assessment provider or mutation endpoint.

## Sepolia implementation boundary

The approved target is Ethereum Sepolia (`11155111`) at `https://staging.signatures.gallery`. Implement early reveal as a distinct verified-inclusion observation; **do not relax the terminal gallery/ownership boundary**. The design retains Ethereum `finalized`-boundary promotion with independent RPC agreement rather than treating Anvil's two-block count as public finality. Missing/disagreeing finality evidence must not promote a work.

This checkpoint does not implement that RPC/finality coordinator or activate the PostgreSQL projection in public pages. E19/E20 must still authenticate complete event/receipt/header evidence, verify saved authority/publication commitments, enforce source independence/freshness/lag and rollback bounds, then expose provisional artwork through an explicit read boundary. The existing projection's pending lookup intentionally discloses no artwork until that integration exists. Finality-policy constants, operating accounts, independent RPC sources and halt recovery remain explicit reviewed deployment configuration; no silent fallback or default endpoint is introduced.

## Verification

- Real loopback HTTP tests exercise early reveal, one Confirming + fifteen Preview tiles, private progress redirect, gallery exclusion, eventual gallery admission, commitment corruption, reorg withdrawal and read failure; they assert one saved assessment and no regeneration.
- Browser-script tests exercise deadline/size limits, late responses, wrong artifact/handle/token bindings, reorg recovery, page navigation/restoration, and no wallet/mutation calls.
- Headless Chrome/CDP checked the actual server-rendered fixture at 390×844 in both themes: rendered SVG loaded, amber label visible, no horizontal overflow, every request GET/200 and no wallet controls. The visual fixture is separate and memory-only; no paid provider or real chain was used.
- A separate actual Anvil rehearsal on disposable ports 3038/18579 verified `submitted-hidden → confirming-revealed/gallery-excluded → minted/gallery-admitted`, with interval mining stopped and blocks advanced explicitly. One fixture assessment was reused byte-for-byte; zero paid calls. Test handle `confirming_test`, transaction `0xf6384f6c61833bb950f23831766ba8897fe48820e0232be056df81f50a8a6988`. Both disposable services were stopped after verification; the user's chain was untouched.
- Full HTTP/PostgreSQL-enabled suite: **4,585 tests / 149 files passed**, **95.81% statements/lines, 92.09% branches, 98.39% functions**. Typecheck/build, renderer locks, 75 contract tests and 80 OpenSignatures manifest tests passed. Coverage thresholds unchanged. Hosted CI is a separate checkpoint.
