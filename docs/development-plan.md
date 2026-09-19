# Development execution plan

Evaluated: 2026-09-19. Source: the consolidated Inbox, current active code, focused tests and three independent read-only subsystem reviews.

This is the task table extracted from `INBOX.md`, not another handoff. The Inbox returns to collecting new, untriaged items. Update task status and evidence here as work lands; moving an item here does not complete it. The previous token-saving/lightweight-night limit is superseded. This planning pass does not itself implement the tasks or authorize paid calls, provisioning, public transactions or deployment.

Execution authorized: 2026-09-19. The user requested the current checkpoint be committed and pushed, followed by continued implementation on a new branch. Checkpoint `16fff22` is on `origin/main`; implementation continues on `codex/execution-table`. Paid calls, public deployment and other approval gates below remain separate.

## Target and scope

Deliver the active open-mint product through three distinct milestones:

1. **M1 — Safe real local flow:** one approved X lookup + backend Grok assessment + user-approved Anvil mint, with recoverable UI, measured spending and immutable result reuse.
2. **M2 — Public-testnet release candidate:** durable state, public immutable artifacts, reviewed OpenSignatures deployment, reliable galleries/ownership, supported wallets and complete product content.
3. **M3 — Launch decision:** security/operations/content evidence and explicit user authorization. This is not implied by passing M1 or M2.

Development can proceed locally before external choices are supplied. No new renderer, return to X OAuth claims, rewrite of the existing contract's identity, broad model benchmark, or distributed platform is required by this plan.

## Current evidence and newly identified work

| Check or finding | Evidence and disposition |
| --- | --- |
| Active app | `src/main.ts` starts `src/openMint/main.ts`. Legacy claim/OAuth code is not the active architecture. |
| TypeScript | `npm run typecheck` passed in this evaluation. |
| Renderer locks | `npm run renderer:verify` passed for signature v1.0.0, signature v2.0.0 and the slogan-only v2.0.1 capture. |
| Active app tests | After allowing isolated loopback sockets, `npm run test:open -- --reporter=dot`: **881 passed, 3 failed, 884 total**. All three failures in `src/openMint/server.test.ts` assert retired question-mark/tooltip content. Fix expectations against the approved slogan, not by restoring the old UI. |
| Test environment | The first sandboxed run also had three `listen EPERM` failures; those passed with loopback permission. They are not application defects. Full coverage/build/contracts and browser QA were not rerun in this planning pass. |
| Paid integration | The provider path and conservative attempt guards exist. Live paid-provider compatibility, observed costs and a real-assessment mint remain unverified. |
| Newly confirmed dependencies | Usage is discarded by the Grok adapter; the refusal instruction conflicts with a success-only MBTI schema; saved-assessment access depends on provider configuration; public metadata needs a new URI/version policy; deployment tooling targets the legacy contract. These are explicit tasks below. |
| Worktree | Existing UI/slogan/docs edits and the previously removed handoff are uncommitted. Preserve them; do not reset, bulk-stage or claim they were introduced by this evaluation. |

## Non-negotiable invariants

- Preview GETs stay free of paid calls, wallet requirements and mint authority. Only an explicit wallet-proved mint request may admit paid work; the request accepts only a handle, never a preview MBTI, custom model, prompt or alleged Grok response.
- One token per lowercase literal handle per contract. The exact verified X username, preparation-time identity snapshot, first accepted assessment and rendered artwork remain frozen. A cancelled transaction, expired request, reconnect, model change or renderer upgrade does not allow a reroll.
- Existing attempt guards, daily limits, coalescing, nonce/context checks and duplicate-submission guards are already implemented. Extend and regression-test them; do not recreate fixed historical bugs as new work.
- A timed-out/disconnected request may still have cost money or submitted a transaction. Unknown does not mean failed, free, dropped or safe to repeat. Do not automatically fill nonce gaps, replace transactions, clear wallet history or reset a chain.
- Operational receipts and billing data are private, versioned records separate from immutable assessment/artifact digests. No retroactive rationale, inferred source identity, fabricated usage or rewritten historical hashes.
- Reveal is a UI experience after canonical confirmation, not cryptographic secrecy. The backend attests its workflow; Grok does not issue the on-chain signature, nor does MBTI claim objective psychological truth.
- Signature renderer v2.0.0 and slogan v2.0.1 are intentionally separate. Keep `The_First_Agent_Artwork`, its approved motion, shared caption/link rules and existing caveat style unless a scoped design change is explicitly agreed.
- Local/staging isolation and today's production refusal remain until reviewed replacements exist. No public test keys, dev mutation routes, fixture masquerading as real Grok, or silent local-to-public artifact migration.

## Task table

**Status:** Ready = can start locally; After = dependency first; Approval = local preparation is possible, external action needs approval; External = waiting on another party; Deferred = deliberately outside the minimum release. Local verification and hosted CI are recorded separately.

**Size:** S = focused change; M = connected module/test changes; L = subsystem requiring several reviewable increments. These are relative scopes, not calendar promises. Each row's check below is its definition of done.

| ID | Task and deliverable | Status | Depends on | Size / milestone |
| --- | --- | --- | --- | --- |
| E00 | Restore the approved baseline; add repeatable offline CI | Locally verified; hosted CI pending | — | M / M1 |
| E01 | Define the mint state contract; repair live request expiry | In progress | E00 baseline | M / M1 |
| E02 | Bound session/assessment status reads and stale responses | After | E01 state contract | M / M1 |
| E03 | Make wallet/reservation/error recovery actionable | After | E01–E02; E04 diagnostic IDs | M / M1 |
| E04 | Persist a versioned attempt lifecycle and safe operator report | Ready | Existing guard tests | M / M1 |
| E05 | Capture provider receipts and usage, including unsuccessful calls | After | E04 | M / M1 |
| E06 | Represent abstention and insufficient evidence explicitly | Ready | Coordinate outcome types with E04 | M / M1 |
| E07 | Add spend admission, bounded concurrency and a generation kill switch | After | E04–E05 | M / M1 |
| E08 | Decouple saved-result recovery from generation credentials | Ready | Existing assessment invariants | M / M1 |
| E09 | Verify a supported economical provider profile and prepare the pilot | After | E04–E08 for executable preflight | S–M / M1 |
| E10 | Run one measured real X → Grok → Anvil pilot | Approval | E00–E09; paid envelope + user wallet approval | M / M1 |
| E11 | Expose factual Grok/MBTI provenance | Ready | Existing stored fields; E10 for real evidence | M / M2, early delivery |
| E12 | Refine About and substantiate the “First” proposition | Ready | Evidence research; user approves claim scope | M–L / M2 |
| E13 | Define and implement the supported wallet matrix | Ready to design | User scope; E01–E03 for flow QA | M / M2; mobile expansion conditional |
| E14 | Complete mobile, accessibility and theme QA | Ready to audit | User approves mobile guidance change; final check after E03/E11/E13 | M / M2 |
| E15 | Audit remaining external X links without changing artwork navigation | Ready | Verified IDs only if available | S / M2 |
| E16 | Record the minimum public deployment architecture and URI policy | Ready to design | User environment decisions before provisioning | M / M2 |
| E17 | Add transactional open-mint persistence, jobs and sessions | After | E04–E08 interfaces; E16 | L / M2 |
| E18 | Implement versioned immutable public artifact publication | After | E16 URI policy; E17 publication records | L / M2 |
| E19 | Add public-chain adapter and OpenSignatures deployment tooling | After | E16; E18 before issuing public artifact authority | L / M2 |
| E20 | Build durable chain projection and bounded paginated galleries | After | E17; E19 event/chain contract | L / M2 |
| E21 | Harden public admission, diagnostics, secrets and operations | After | E07/E17–E20; support/operating owner | L / M2 |
| E22 | Add environment-aware sharing, canonical URLs and indexing policy | After | E16/E18 public URL decisions; E20 gallery interface | M / M2 |
| E23 | Rehearse a pinned release candidate on approved public testnet | Approval | E00–E22; deployment/funds approval | L / M2 |
| E24 | Complete security review, resolve findings and decide launch | Approval / external review | E23; reviewer and operator sign-off | L / M3 |
| D01 | Track xAI subscription-funded integration eligibility | External | Authoritative human response | S per update / nonblocking |
| D02 | Compare model quality/cost across a representative sample | Deferred / approval | E10 results; separate sample/spend approval | M / optional optimization |

## Execution batches and parallel lanes

1. **Batch A — Establish a trustworthy baseline.** E00 fixes the three obsolete assertions and checks the full baseline without lowering thresholds. At the same time, specify E01's state contract and E04's attempt/outcome/receipt interfaces. Start E12's evidence outline. These are not reasons to change the approved UI.
2. **Batch B — Close local failure paths.** A UI lane implements E01 → E02 → E03. A backend lane implements E04 → E05 → E07 and E08, with E06 integrated against the same outcome types. A presentation/content lane handles E11/E12/E15. Avoid simultaneous edits to the same service/page/client files; parallelize design/tests or use bounded file ownership.
3. **Batch C — Validate the real provider.** Finish E09, present the exact paid envelope, then execute E10 once approved. Stop and reconcile on uncertainty. Complete the live portion of E11 with observed fields, not assumptions. M1 is now provable.
4. **Batch D — Prepare public infrastructure.** E16's design can start during B/C; implementation E17 follows the stabilized state/receipt interfaces. Then E18 and E19 can proceed in parallel after their shared URI/chain decisions. Build E20 on that foundation. Independently finish E13/E14/E12.
5. **Batch E — Release-candidate hardening.** Integrate E21 and E22, repeat E00's clean-checkout checks and browser matrix, then seek E23 approval. Content, wallet support and operations must not be left as unspecified post-launch work.
6. **Batch F — External review and launch.** Review preparation starts once the architecture exists; final sign-off is against the tested release. E24 resolves findings, exercises recovery, and records an explicit go/no-go. D01 never blocks the API-key path. D02 is not required to call the single pilot successful.

## Explicit designs and acceptance checks

### E00–E03: baseline and mint experience

- **E00:** Update stale slogan expectations in `src/openMint/server.test.ts` to the approved no-question-mark slogan, while retaining tests that study pages do not mutate home and tooltip/CSP behavior remains correct. Then run typecheck, renderer locks, full tests/coverage, build and contracts. Add a checked-in CI workflow using the existing scripts and required toolchain; provider transports remain mocked and use no billing credentials. **Done:** clean-checkout checks pass, coverage thresholds remain unchanged, failures cannot be hidden by skipping assertions, and active HTTP/entrypoint tests have the permissions/environment they need. Hosted execution must be observed later after an authorized push; a local pass is not a hosted CI pass.
- **E01:** Write a transition table for assessment pending/ready/failed/abstained, request/proof/voucher expiry, reservation, wallet change, intent, awaiting approval, submitted hash, confirmation and reveal. Use a shared status/view-model contract rather than growing independent browser conditions. Consume `requestExpired` and also handle ready pages becoming expired while idle. **Done:** expiry while preparing or ready offers an explicit safe return with preserved spelling and saved-result reuse; stale auto-intent is removed. A submitted/unknown transaction continues reconciliation even if its request expires. No automatic new assessment, voucher or wallet request.
- **E02:** Apply read-only deadlines to session boot and assessment polling, including body reads; reuse the existing mint polling deadline pattern. Bound retry delay/attempt bursts and provide visible recovery, cancellation on pagehide and generation guards for late responses. **Done:** hung fetch/body, failure/recovery, stale completion, page exit and stalled `/api/session` tests pass; a timeout cannot stop canonical monitoring, reveal a result, or trigger POST/sign/send operations. Do not time out a user's approval as though it failed on chain.
- **E03:** Extend—not replace—existing nonce-gap/missing-transaction/revert protection. Return safe reservation expiry and sanitized error category/reference in structured responses; show known hash and verified network, and distinguish transient read, expired proof/session, funds/network problem, blocked paid attempt and operator review. **Done:** every blocked surface gives an accurate next action; no timer unlocks an unresolved submission; local Rabby instructions stay local; diagnostic references expose neither secrets nor private mint codes. Prepare a configurable support route but publish a contact only after approval.

### E04–E09: paid assessment and recovery

- **E04:** Introduce a private versioned attempt record with stable ID, canonical handle, immutable admission time, profile version, phase timestamps, sanitized outcome, accepted-assessment reference and reconciliation status. Persist markers before X and Grok dispatch. Model admitted → X dispatched/verified → Grok dispatched → response received → accepted/abstained/invalid, with failed-before-dispatch and uncertain-after-dispatch states. Artifact preparation has its own outcome. Existing ambiguous records migrate conservatively as blocked/unknown, never as permission to retry. Add read-only operator inspection keyed by safe reference, and specify an audited reconciliation/recovery operation for proven pre-Grok failures: required phase/billing evidence, original-attempt linkage, idempotency and explicit approval for any further paid dispatch. Keep repeat dispatch disabled during the one-attempt pilot; implement the reviewed recovery operation in E21. **Done:** fault injection at each durable write cannot cause an unrecorded outbound call or automatic replay; restart preserves uncertainty and the accepted result. Mark the old stale-pending bypass and spelling findings resolved in historical cost docs with current regression references.
- **E05:** Capture a separate private receipt per provider leg before semantic validation where a response is available. Store bounded allowlisted response/request references, timing, actual returned model, HTTP/result category, validated usage and cost evidence with `actual`, `estimated` or `unknown` status. Use integer monetary units/explicit currency; keep a dated pricing/profile reference for estimates. Do not store raw posts, credentials, hidden reasoning or arbitrary response dumps. **Done:** accepted, abstained, invalid-schema, non-2xx, malformed usage, oversized/truncated body, timeout and receipt-write failure have honest accounting. Citations are not a billing meter; missing X or xAI costs never become zero.
- **E06:** Use a discriminated accepted/abstained provider outcome with a bounded refusal reason. Keep X identity lookup failure, semantic invalidity and transport uncertainty distinct. Only accepted outcomes enter the current immutable `Assessment` schema and artifact generation. Keep accepted-result native-search, subject ID/handle and citation validation. No rationale field is required for the first pilot. **Done:** insufficient evidence, inaccessible subject, mismatch, injected source instructions and malformed output fail safely without fabricated MBTI, artifact or authority. Record abstention spend; do not enable user-triggered rerolls of unsuccessful calls.
- **E07:** Preserve count limits and handle guards; validate persisted counters and reservation schemas. Add one total allowlisted paid attempt and one active attempt for the pilot, conservative spend admission, generation kill switch and unresolved exposure accounting across restart/day changes. Keep the single-writer file store for M1. **Done:** concurrent different handles, corrupt/negative counters, limit exhaustion, switch activation and restart cannot bypass admission; a missing receipt does not release spend automatically. Unknown/in-flight exposure and provider cap limitations are explicit. A software threshold is not falsely advertised as a guaranteed per-call dollar ceiling.
- **E08:** Create assessment read/reuse access independently from the xAI transport or generation switch. Missing credentials should block new generation, not valid saved-result recovery/authorization. Persist validated results before downstream artifact steps; never rewrite existing assessment or artifact commitments. **Done:** saved result survives refresh, case variants, new sessions, expired requests and restart; key removal/kill switch still allows appropriate read/reuse operations with zero provider calls. Missing authority or a legacy unverified record remains blocked by its existing policy. If result persistence is uncertain, stop rather than re-assess.
- **E09:** Recheck official X/xAI API capability and account access, select one server-owned versioned request profile, and verify its response parser with representative mocked fixtures. The current `grok-4.6`/4096-token configuration is a repository fact, not a newly verified compatibility or cost recommendation. Do not assume older model/pricing notes remain valid. Produce an operator preflight/report covering keys present without their values, target handle, isolated data/RPC ports, admission settings, estimate/unknowns and stop conditions. **Done:** all paid-path mock checks pass and one explicit envelope is ready for user approval. No provider-storage retention change or response-retrieval integration is needed by default.

### E10: one real local pilot

1. Obtain approval for the exact handle/profile, both providers' maximum accepted exposure or clearly described uncertainty, one total attempt and no retries. Use a distinct real namespace and Anvil state, not the current fixture data. Credentials stay in ignored configuration.
2. Call X once, then Grok once only if identity verification succeeds. Record bounded operational receipts, validated subject/evidence and actual/estimated/unknown usage. On timeout, refusal, incompatibility or uncertainty, stop and report; do not fall back to fixtures or try another model automatically.
3. On success, let the user approve the local mint. Check canonical confirmation, reveal, gallery, collection and variations. Reopen after restart with generation disabled and verify exact assessment/artifact bytes plus zero additional paid calls.
4. Save a compact validation report tied to the tested revision/profile, costs/latency and limitations. **Done:** observed live compatibility and result reuse, not a claim of broad assessment quality, perfect determinism or public readiness. If the attempt fails, the pilot remains failed/blocked until a separately approved recovery—not marked complete because one call occurred.

### E11–E15: complete the product without changing its identity

- **E11 Provenance:** Project saved assessor/provenance, actual model, assessment time, source URLs and preparation-time X verification into the collapsed detail view. Explain the MBTI letters. Remove the current assumption that missing source means Grok; show fixture/unknown truthfully inside provenance while retaining the absence of dev banners on normal pages. Show a rationale only if genuinely recorded under a future approved schema. **Done:** real/fixture/legacy/missing-field fixtures and safe-link tests pass; no extra calls, no pre-confirmation disclosure and unchanged assessment/artifact hashes. Preserve shared `@handle × MBTI`, handle → variations, MBTI → collective page, Minted → home, and one combined Caveat.
- **E12 About:** Define the scope/date and meaning of “Agent Artwork” and “First,” document the roles of artist/system, Grok and collector, and research attributable prior work. Refine the existing About page around preview/mint, frozen assessment, handle identity/renames, gas/permanence, account non-ownership and reveal limits. **Done:** cited evidence supports the agreed claim; unresolved contrary evidence is presented to the user. The wording is not silently changed, but an unsupported worldwide first claim is not signed off for public launch. Pilot facts are added only once observed.
- **E13 Wallets:** Recommended initial scope is injected wallets using EOAs without code, explicit multi-extension selection and a tested supported-browser list. Preserve provider identity across listeners/reconnect and explain unsupported accounts; current checks reject any code-bearing recipient, including delegated/code-bearing EOAs, not only contract wallets. Evaluate an in-wallet mobile browser before adding another transport. **Done:** Rabby/other declared providers pass connect, proof, chain mismatch, rejection, switch and recovery tests; account-type restrictions are tested independently of wallet brand, and the chosen provider cannot silently change. WalletConnect or smart-account support is a separate scope choice, not assumed unfinished core work.
- **E14 Mobile/accessibility:** Audit 320/375/390px and desktop, keyboard, focus, screen-reader statuses, 200% zoom, reduced motion, long hashes/URLs and light/dark themes. Recommend preserving one-line 16px guidance on desktop but allowing readable wrapping on small screens; user approval is needed because the single line was deliberate. **Done:** real browser screenshots/geometry and interaction evidence, no horizontal clipping, readable typography and correct status announcements across declared devices. Preserve approved artwork animation and existing accessibility features.
- **E15 X links:** Inventory appropriate external publisher/source/account links. Use a verified stable account-ID URL only where available and suitable; never invent an ID or spend on lookup merely for navigation. **Done:** all artwork handles still link to variations, remaining external links have correct destinations/rel attributes and regression tests. If no applicable verified-ID change exists, close with that evidence rather than force a change.

### E16–E22: minimum public architecture

- **E16 Architecture decision:** Recommend one application/writer process, PostgreSQL for transactional operational state, an in-process bounded runner/indexer and immutable public artifact storage. No Redis, Kafka, multi-region or distributed workers by default. Record durability, load/recovery assumptions, network/finality, origins, signer custody, artifact URI policy and supported-device scope before implementation. Existing legacy PostgreSQL/indexer/CID helpers are adaptation candidates, not drop-in modules. **Done:** one reviewed architecture record plus interface/schema boundaries; unresolved hosting/network decisions are named, not guessed. Prefer a fresh public deployment/data namespace and preserve existing local works.
- **E17 Persistence:** Add open-mint-specific schema/repositories for canonical assessments, artifacts, requests, attempts/receipts/budget, authorization reservations, sessions and jobs. Use atomic constraints for canonical handle/result and reserve-before-signing semantics. Adapt only compatible legacy primitives. Retain explicit single-writer enforcement initially. **Done:** critical-write crash tests, duplicate requests, worker restart, session continuity and a second unsupported writer cannot duplicate paid dispatch/authority or alter frozen results. Any import is explicit, backed up and hash-verified; no mandatory conversion of old claim data.
- **E18 Publication:** Version public artifact metadata before preparing public records. Current metadata embeds localhost URLs and `tokenURI` contributes to the digest; uploading or changing its hostname is not a safe migration. Publish SVG/PNG, construct exact public metadata, publish/pin it and verify retrieved bytes before authority. Persist receipts and backup/restore instructions. **Done:** failed publication blocks issuance, restart reuses identical bytes, independent retrieval matches commitments and public metadata contains no private capability. Default is fresh public artifacts; any reuse of local assessments/images needs an explicit version/provenance decision, never replacement of an existing frozen artifact.
- **E19 Chain/deployment:** Build a separate public adapter preserving chain/code/domain/signer verification and add an **OpenSignatures** deployment script/manifest/validator. The existing script targets GalleryOfSignatures with a different domain. Retain the current contract's one-handle identity, immutable commitments, roles and nonpayable mint; redesign only if a specific review finds a gap. Define an explicit allowlisted-testnet staging profile with E21's reviewed startup checks before E23; hosted staging must not work around production refusal by setting `NODE_ENV=development`. Mainnet/live-launch admission stays separately disabled until E24. **Done:** wrong chain/code/domain/signer fail closed; pause, role rotation and nonce revocation tests pass; public configuration rejects test keys/dev endpoints. Write tooling locally first; actual public deployment requires approval and E18-ready publication.
- **E20 Projection/galleries:** First persist OpenSignatureMinted/Transfer logs with checkpoints/block hashes, bounded backfill and chosen finality/reorg behavior. Then expose stable cursor queries for home, MBTI and current-owner collections. Existing direct `ownerOf` already sees transfers; the work is a durable consistent read model, not inventing transfer support. Separate original recipient/current owner, and use the same confidence policy for both. **Done:** inserts/pagination/filter cursors, restart, transfers, competing mints, shallow reorg rollback and deep contradiction halt are tested. Work per page is bounded; one corrupt/unavailable record does not break unrelated works; unavailable never means unminted. Avoid mutable ordering keys that invalidate cursors.
- **E21 Operations/security:** Carry paid admission into durable storage; implement restart-safe rate limits, trusted-proxy policy, bounded request/job queues, safe server/RPC deadlines and environment-based secret handling. Implement E04's narrowly scoped operator reconciliation/recovery operation with dry-run, evidence checks, linked audit history and explicit paid authorization; no record deletion, blanket budget reset, release of ambiguous calls or reroll of accepted assessments. Add redacted diagnostic IDs and metrics for spend uncertainty, stuck work, provider/RPC/signer/publication errors and index lag. Configure the user-selected support/escalation destination. Exercise backups, restore, deployment rollback and stop/recover procedures. Review the staging startup profile before E23; keep live-launch admission separate. **Done:** session churn/restart/proxy spoofing cannot evade admission; disabled generation retains safe reads/recovery; no credential/private code is logged; restoring does not erase history or rewrite commitments. Unsupported multi-instance startup fails closed.
- **E22 Sharing/indexing:** Add canonical URLs and per-preview/per-minted OG/X cards after public origins/artifacts are fixed. Recommend indexing confirmed works/galleries, leaving the effectively unbounded editable preview space unindexed unless deliberately chosen otherwise. Local/staging/private collection/mint capability routes remain noindex and private responses remain no-store; public cache policy must respect finality/integrity. **Done:** cards use the correct preview or saved minted asset, pending results never leak through metadata, sitemap excludes private/unapproved routes and environment-switch tests pass.

### E23–E24: acceptance and release

- **E23 Testnet:** Recommend Sepolia for the first public rehearsal, subject to explicit network/deployment approval. Use a fresh namespace and OpenSignatures manifest. If test fixtures are used, they stay staging-only and provenance identifies them; do not relabel them as real Grok. Additional paid assessment is separately approved. **Done:** record a pinned revision, manifest and browser evidence for wallet approve/reject, expiry, reload/reconnect, interrupted reporting, pending nonce, competing minters, transfers/current-owner collections and public artifact retrieval. Reorg/recovery fault tests run in an isolated controllable environment, not by pretending to control Sepolia. Observe hosted CI, archive results, and list unresolved risks.
- **E24 Review/launch:** Prepare the threat model and review scope during E16–E21; obtain independent security review of the exact service/contract release, fix findings and retest. Confirm key/operational owners, emergency pause, backup restore, support, retention obligations and evidence for the public claim. **Done:** recorded go/no-go and explicit user authorization; only then admit live launch through the reviewed fail-closed configuration gates. E19/E21's earlier staging exception is limited to the approved testnet profile and is not launch authorization. Actual launch, funding, key custody changes and public transactions are separate actions, not automatic consequences of a plan or green CI.

### D01–D02: retained but not launch-critical

- **D01 xAI inquiry:** `docs/xai-integration-request.md` remains the correspondence/status record. The latest confirmed state is a user-reported escalation reply sent to `support@x.ai`, with no confirmed human eligibility decision. The user sends external messages; prepare/record follow-ups when asked, do not send or monitor automatically. Subscription-funded integration stays an optional future path, not an API-key prerequisite.
- **D02 Evaluation:** After the pilot, propose a small representative set and explicit budget to measure evidence quality, abstention, output compatibility, latency and cost. Do not reroll canonical handles or call one sample a quality benchmark. Choose a cheaper profile only when supported by current provider docs and actual measurements. This is a separate experiment, not hidden scope in the first pilot.

## Decisions and approvals, just in time

| Gate | Needed from user | What can proceed beforehand |
| --- | --- | --- |
| Real pilot, E10 | Handle, profile/exposure acceptance, both API credentials/access, one-call spend authorization; user signs wallet operation | All mocked reliability/accounting work and preflight/report code |
| UI scope, E13–E14 | Supported wallets/mobile expectations; approve readable narrow-screen wrapping | Inventory, design proposals and non-mutating browser audit |
| Content, E12 | Definition/scope of “First”; approve evidence-backed wording and any unresolved qualification | Research and About draft; do not assert unproved priority |
| Public environment, E16/E19 | Network, hosting/storage budget/accounts, public origin, support address and operational/key owners | Local adapters, versioned schema, deployment scripts and tests |
| Testnet/launch, E23–E24 | Explicit deployment/funds approval, independent reviewer and launch decision | Local failure tests, threat model, scripts and release checklist |

No need to resolve every decision before E00–E08. Do not repeatedly block local work on an approval relevant only to a later milestone.

## Inbox reconciliation: nothing silently dropped

| Previous Inbox item | New task IDs |
| --- | --- |
| 1.1 state contract; 1.2 expiry/polling | E01–E02 |
| 1.3 wallet/reservation recovery; 1.4 actionable errors | E03, E04 diagnostic report, E21 support/operations |
| 2.1 lifecycle; 2.5 operator controls | E04, E08–E09, E21; general automatic retry remains excluded |
| 2.2 accounting/admission | E05, E07, E17, E21 |
| 2.3 insufficient evidence; 2.4 efficiency | E06, E09, D02 |
| 3 real Grok/Anvil pilot | E10 |
| 4 provenance/presentation/external links | E11, E15 |
| 5.1 architecture; 5.2 durable state; 5.3 publication | E16–E18 |
| 5.4 indexing/gallery; 5.5 abuse/operations | E20–E21 |
| 6 deployment/CI/testnet/security/launch | E00, E19, E23–E24 |
| A About/First; B wallets/mobile/accessibility | E12–E14 |
| C sharing; D xAI inquiry | E22, D01 |
| Newly verified baseline and cache-access gaps | E00, E08 |

## Execution and closure policy

### Execution evidence

- **E00 (2026-09-19):** Updated approved-slogan assertions and historical study labels, without changing rendered artwork or lock files. Added `.github/workflows/verify.yml` with pinned actions, Node 22, Foundry 1.5.1, mocked providers and explicit loopback HTTP testing. Full coverage run: **3,313 tests passed across 115 files**, existing thresholds unchanged. Typecheck, renderer verification/build, 65 contract tests, deployment manifest validation and nine manifest-role tests passed. Hosted execution is not yet claimed.

- Start with **E00's baseline repair, then E01/E02**, while designing E04–E08. This is the first concrete batch, not another round of slogan refinement.
- Keep changes reviewable. Coordinate shared `service.ts`, `pages.ts`, `server.ts` and client files rather than assigning simultaneous broad edits. Reuse existing boundaries and tests.
- A task is done only when its acceptance evidence is recorded: changed files, commands/results, browser proof where relevant, remaining risks and decisions. A static test pass is not visual QA, fixture mint is not real Grok, and local green is not hosted CI.
- Record blocked external actions against their specific task and continue independent local work. Do not mark work complete just because it moved out of Inbox or because only provider approval remains.
- The subsequent execution request authorizes implementation commits and pushes; it does not authorize deployment, paid calls, chain reset or broad worktree cleanup. Do not recreate the retired `HANDOFF.md`.
