# Low-cost Grok assessments for Signatures Gallery

**Historical research, September 14, 2026; implementation status corrected September 19.** Use [the current one-attempt runbook](grok-pilot.md) for operator settings and approvals. The code now implements the attempt/receipt/admission controls, explicit abstention and saved-result access described as gaps below. The real launcher selects `grok-4.3`/low/1024 output tokens/three assistant turns. No live account access or paid response has been validated. Historical comparisons, ten-per-day settings and 24-call evaluation proposals in this report are not the active pilot or permission to run them.

## Recommendation at the research date

Use the direct, gallery-funded xAI API for one independently researched assessment per new handle, then reuse the accepted assessment permanently. Evaluate `grok-4.3` with native X Search and minimal reasoning before changing the current model. Put most cost-control work into avoiding unnecessary generations, duplicate attempts, and uncontrolled search—not into shaving words from the final MBTI answer.

The proposed sequence was: validate the handle, look for an existing assessment, admit a new paid job only after an explicit generation action, let Grok research and decide, durably save the result, then render and mint without another model call. Wallet proof was a separate recommendation at that date and is now implemented before mint preparation; it does not require ownership of the target X account.

The original report is a design and cost analysis, not a live-validated configuration. Prices and documentation were checked on September 14, 2026; the runbook separately rechecks the chosen profile on September 19. All dollar examples below are constructed xAI-only scenarios, not measured costs, forecasts or maximum charges. They exclude the subsequently implemented authenticated X lookup, taxes, hosting, storage and blockchain gas. The runbook includes a separate X-lookup planning allowance without treating it as an observed charge.

## 1. Authority and cost boundaries

The backend controls the question and authenticates the provider response; Grok controls the artistic MBTI selection and researches through its native X tools. Public input remains a handle, not a proposed MBTI, a prompt, selected posts, or a pasted chat response. Private consumer Grok conversations can still introduce the project and produce its request link, but their answers are not imported as authoritative assessments.

Use a fresh assessment context without consumer chat history. Treat X posts and profiles as evidence, not instructions. Do not provide signing secrets to Grok. After validation, the application signs the accepted assessment for its contract; the contract verifies the application's attestation, not an xAI-issued signature. These boundaries prevent direct client substitution, but do not prove objective psychological truth, perfect prompt-injection resistance, or intrinsic model determinism.

Persistence supplies product stability: one accepted result becomes canonical for the lowercase handle. Exact-case artwork spelling is frozen separately at first admission/publication and must survive crashes. A different wallet, letter case, expired mint permit, browser session, or renderer deployment must not create an automatic opportunity to choose another MBTI. A renderer update can render the same accepted assessment without another research charge unless a separately approved product version explicitly changes that policy.

These requirements favor direct native search over cheaper-looking alternatives that change the authorship boundary. xAI distinguishes its managed server-side tools from custom functions executed by the application; the former allow Grok to retrieve and interpret evidence without the gallery assembling a dossier.[^1]

## 2. Model selection

Short-context prices are USD per million tokens. Model cards provide the following comparison.[^2][^3][^4]

| Model | Uncached input | Cached input | Output | Decision |
| --- | ---: | ---: | ---: | --- |
| `grok-4.6` | $2.00 | $0.50 | $6.00 | Local default at the September 14 audit; retained as a historical evaluation reference |
| `grok-4.3` | $1.25 | $0.20 | $2.50 | Recommended lower-cost candidate with documented native-search examples |
| `grok-build-0.1` | $1.00 | $0.20 | $2.00 | Nominally cheaper, but native X Search support for this route was not established; do not choose on price alone |

The 4.3 model card permits `none` reasoning and defaults to `low`. The 4.6 reasoning guide specifies a `high` default and does not allow reasoning to be disabled. Consequently, merely leaving reasoning unspecified is not a conservative cost policy for the current implementation.[^2][^5]

Run a small isolated comparison of 4.3 `none` and `low`. Select the cheapest profile that reliably researches the correct account, returns usable source evidence, declines unavailable accounts, and follows the output contract. Do not equate agreement with 4.6 to a scientifically correct MBTI; different artistic interpretations are possible. Likewise, a cheaper model that causes more rejected paid responses may cost more per accepted artwork.

Do not use obsolete Grok Fast prices in the budget. xAI's May 15 retirement notice says the retired Fast slugs redirect to 4.3 and incur its pricing.[^6] Pin the configured model name and assessment-policy version; never silently switch a failed request to another model. A model name is not a guarantee that the provider's internal weights will never change, which is another reason to preserve accepted results.

## 3. Search economics and the September change

Until September 21, 2026 at noon Pacific, X Search is priced at $0.005 per successful call. The announced replacement is $0.005 per fetched post plus $0.01 per fetched profile. Returned parent and quoted posts also count. The transition is September 22 at 03:00 in Shanghai. Budget a launch around the new basis, not the outgoing call price.[^7]

This is the largest immediate economic issue. A short four-letter answer does not imply a cheap research request. Internal search can retrieve many items and require multiple model passes. The following equations expose the useful levers:

```text
Token cost = (uncached input × input rate
              + cached input × cached rate
              + billable output × output rate) / 1,000,000

Current search cost = successful calls × $0.005
Announced search cost = fetched posts × $0.005 + fetched profiles × $0.01

Ordinary assessment cost = token cost + search cost
```

This estimates ordinary successful work. Exceptional provider fees can apply; reconcile the actual bill even for rejected or unsuccessful requests.

For the current Responses usage shape, reasoning is detailed inside output-token usage; do not add it twice. Older SDK examples separate final completion tokens from reasoning, so accounting must normalize the actual response format. Reasoning is billed at the output rate.[^8][^9]

### Illustrative small workload

Assume **5,000 aggregate uncached input tokens, no cached input, and 300 total billable output tokens including any reasoning**. The aggregate input includes internal processing, not just the initial handle and instructions. This workload is an assumption for arithmetic, not a claim about the proposed profile.

The token component is $0.007 with 4.3 versus $0.0118 with 4.6. Two successful searches under the outgoing tariff bring those totals to $0.017 and $0.0218 respectively: about a 22% reduction at identical usage. Under the announced tariff, 20 posts plus one profile bring the same totals to $0.117 and $0.1218: only about a 4% reduction. Real models may use different amounts of reasoning and search, so actual savings can differ materially.

Holding that token workload constant isolates the new search-volume sensitivity:

| Billable posts fetched | Billable profiles fetched | 4.3 cost per new assessment | Cost for 1,000 such assessments |
| ---: | ---: | ---: | ---: |
| 10 | 1 | $0.067 | $67 |
| 20 | 1 | $0.117 | $117 |
| 50 | 1 | $0.267 | $267 |
| 100 | 1 | $0.517 | $517 |

These rows are not limits or predictions. More retrieved content can also increase token usage; holding it constant understates that additional effect. One requested handle does not guarantee that only one profile is fetched, and a small citation list is not a billable-resource count.

### Cost per mint, not just per request

The gallery pays when it assesses a new handle even if nobody eventually mints it. Let `a` be average cost across all paid attempts, `s` the accepted-assessment fraction, and `m` the fraction of accepted assessments that become mints. A planning approximation is `a / (s × m)` per mint, excluding other infrastructure costs.

For example, $0.117 per attempt, 90% acceptance, and 30% mint conversion imply approximately **$0.433 of assessment spend per mint**. This is why avoiding speculative generation and measuring abandonment matter more than optimizing only the displayed answer length. Keep the actual denominators in the ledger; do not hide failed or abandoned work from unit economics.

## 4. Savings ranked by impact

### First: eliminate repeat research

Use a durable, global result cache keyed by canonical handle. This is an application record, not xAI prompt caching. Once accepted, every subsequent viewer or requester receives the same record without contacting the model. Preserve it when permits expire or a mint fails. Coalesce concurrent requests into one durable job before dispatch; only the job, not each subscriber, consumes allowance.

At a hypothetical 90% result-reuse rate, 10,000 visits that would otherwise trigger identical $0.117 requests fall from $1,170 to $117 in inference/search spend. Actual traffic may contain many new handles, so this is conditional, not a projected saving. It also excludes storage and serving costs.

Do not implement a short TTL that automatically regenerates accepted artwork assessments. Treat temporary failures separately from accepted results. If current content must eventually be reassessed, define that as an explicit versioning/product decision rather than an invisible cache refresh.

### Second: avoid generating work nobody intends to mint

GET requests, link previews, hover, browser prefetch, page refresh, and opening a Grok handoff must be free of paid inference. Existing artwork remains publicly viewable. Only an explicit server-authorized generation action can admit a new job.

For a public pilot, add a generation-purpose wallet proof and abuse checks before that paid action. Any wallet remains eligible; this is not X authentication or proof of account ownership. Reuse a suitably scoped session proof where appropriate instead of asking for unnecessary repeated signatures. Bind the authorization to the handle, preserved spelling, session, nonce and expiry. Do not repurpose a proof whose text only authorizes viewing a collection.

Wallets are inexpensive to create, so proof is friction, not a defense against unlimited fake identities. Use a global spend controller, a low worker concurrency, per-wallet/session throttling, and additional challenge/rate controls. Avoid requiring a token purchase, deposit, or public-chain transaction merely to generate unless the product deliberately changes from gallery-funded access.

### Third: constrain unnecessary native research

The X Search interface supports handle filters, dates, and media-understanding switches. It does not document a maximum number of posts or profiles returned. Date and author filters restrict scope, not the bill. Disabling media analysis removes that optional work, but does not stop text search.[^10]

Start with one allowed handle and no image/video analysis. Ask Grok to examine a compact, diverse sample of the account's own public writing and stop when evidence is sufficient. Avoid unnecessary biography lookups, repeated equivalent searches, broad searches for other people's opinions, and long thread expansion. These are prompt preferences, not enforceable resource caps.

Do not initially impose a narrow date window just to improve the bill: sparse or seasonal accounts can become falsely unassessable. Benchmark a fixed 180-day window as a separate policy candidate if unrestricted searches prove expensive. Persist the chosen cutoff with the job so retries cannot quietly change the evidence window. Grok still selects the evidence; the backend does not choose posts. If this scope restriction damages the intended artwork, retain wider research and control cost through admission and reuse instead.

`max_turns` constrains iterations, not individual parallel calls. The SDK also exposes `parallel_tool_calls: false`; its documentation says this restricts each response to at most one call. Test a small turn budget plus parallel calls disabled on the exact transport used. Neither setting caps posts returned by an individual search.[^11][^12]

### Fourth: reduce model work and final output

Return a small typed result, not an essay, explanation, SVG, or contract payload. Rendering, hashing, signing and ordinary validation belong in application code. Keep the model request to one independent research-and-classification operation; do not routinely add a second LLM to check, translate, repair or beautify its answer.

A typed insufficient-evidence outcome is essential. Forcing every valid JSON response to contain an MBTI encourages guessing or schema failures. A compact result can contain `handle`, `status`, and a nullable `mbti`, with strict cross-field validation in code. An unavailable/insufficient response cannot create an artwork or mint permit. JSON-schema conformance alone does not prove correct account research or truthful evidence.[^13]

### Fifth: accept prompt caching as a bonus

xAI prompt caching discounts repeated input prefixes; it does not reuse the completed assessment. Stable instructions should precede variable content, and a stable `prompt_cache_key` can improve routing. Evictions remain possible, so budget cold-cache requests. Variable tool filters and schema content may limit shared-prefix reuse; measure `cached_tokens` rather than assuming a hit.[^14]

Under the 4.3 rates, caching a hypothetical 400-token static prefix saves only $0.00042 on an invocation. Increasing the prompt solely to qualify for more cached text is not a sensible saving. Never insert earlier accounts' results into a shared conversation just to improve cache hits: that adds context, privacy exposure and an unwanted influence on independent assessment.

### Sixth: batch only when waiting is acceptable

The Batch API explicitly supports 4.3 with native X Search. The current discount is 20% of token charges; most jobs complete within 24 hours. A tool-fee discount is not established.[^15] With the small-workload example, batching saves $0.0014, taking the post-change $0.117 total to $0.1156—about 1.2% overall.

That saving does not justify putting the main interactive flow on an overnight queue. Batch can help a deliberately scheduled, finite catalogue or an opt-in deferred queue, but generating a large unused catalogue destroys the benefit. If introduced, preserve the same global job/result deduplication and issue the short-lived mint permit after completion, not at batch submission.

## 5. Concrete candidate configuration

The following is the **historical September 14 candidate specification**, not the implemented pilot profile or an applied environment file. The current runbook supersedes it with low reasoning, 1024 output tokens, three turns, no tool-choice/parallel-call override and one total attempt. None of these combinations has been exercised against the live API in this work.

| Setting | Candidate A | Purpose / qualification |
| --- | --- | --- |
| Endpoint | Direct xAI Responses | Keep provider receipt server-authenticated |
| Model | `grok-4.3` | Lower-cost documented native-search candidate |
| Reasoning | `none` | Compare with `low` before selecting the production policy |
| Tools | Only `x_search` | No ordinary web, code, image generation or extra tools |
| Allowed author | One canonical handle | Server-controlled; no user-selected query or posts |
| Image/video understanding | Both explicitly `false` | Text-only research |
| Tool choice | `required`, subject to native-tool compatibility check | At least one tool invocation; not exactly one |
| Assistant/tool turns | Start with `2` | Limited room for research; verify exact Responses support |
| Parallel tool calls | `false` | Avoid parallel expansion; does not cap fetched resources |
| Output | Strict small result; `max_output_tokens: 1024` | Verify behavior across internal agentic passes; reduce only after measuring truncation |
| Research period | No narrow date cutoff initially | Avoid silently excluding sparse-account evidence |
| Response storage | Retain current `store:false` for pilot | Unknown outcomes block retry; recovery tradeoff described below |
| Service priority | Standard/default | Do not enable priority processing for a cost pilot |
| Application automatic paid retries | `0` | A new HTTP POST is another potential charge |
| Paid worker concurrency | `1` | Limit simultaneous exposure and simplify reconciliation |

Candidate B changes reasoning to `low` and allows an output cap of `2048`. Keep other policy inputs identical in the evaluation namespace. These token caps are safety settings, not expected output lengths or complete dollar limits. The lowest-turn setting can be tested after the initial compatibility check; if it causes refusals or incomplete research, choose the successful fixed policy instead of repeatedly escalating individual user requests.

`required` is a minimum-tool-use instruction, not a single-call budget.[^16] Do not copy an unverified `max_tool_calls` field or legacy Live Search result limit into production and assume it works. Public Responses examples contain compatibility fields that do not all represent implemented behavior.[^9]

## 6. Spending and failure architecture

### Durable job and accounting records

Create a private paid-attempt record before the provider request. It needs: canonical handle, frozen rendering spelling, attempt ID, provider/model/policy, relevant request settings, admission time, budget reservation, dispatch state, provider response ID, response/validation outcome, bounded allowlisted usage metadata, final integer cost, and a safe error category. Credentials, raw bodies/posts, hidden reasoning and private browser messages do not belong in this record. The implemented version keeps provider receipts separate from the attempt and immutable assessment.

Separate paid attempts from consumer request links and from immutable artwork provenance. Many request links can subscribe to one attempt. A permit can be replaced without replacing the assessment. A model-call error can consume money even when it produces no valid artwork.

Use a durable uniqueness constraint for the active job and an insert-only accepted-assessment record. Within one local process, the existing exclusive writer lock can support this design; a later multi-instance deployment needs transactional shared storage, not just an in-memory map. Persist a usable provider result before exposing it or constructing downstream assets.

| Job outcome | May dispatch another paid call automatically? | Budget treatment |
| --- | --- | --- |
| Validated accepted assessment | No; serve saved result | Reconcile actual cost once |
| Result received, publication failed | No; retry local persistence/publication | Retain the same attempt and charge |
| Definite failure before dispatch | No in the one-attempt pilot; future recovery needs evidence and explicit approval | Keep reservation until an audited recovery mechanism proves and records resolution |
| Completed insufficient evidence | No on refresh or new session | Save outcome and charge; require a controlled retry policy |
| Timeout, disconnect, crash after dispatch | No | Mark unknown, retain reservation, investigate/reconcile |
| Missing or invalid usage telemetry | No blind continuation | Accounting unknown; stop new paid work pending review |

The original research suggested a 24-hour cooldown before operator review. The implemented one-attempt pilot has no timer-based reopening and no retry/release command. Any later recovery must prove the relevant phases and billing, link to the original attempt and carry explicit authorization for new paid dispatch; it cannot replace an already accepted result. Unknown transport outcomes are not resolved merely because time passed.

### Actual charges and reservations

Use `usage.cost_in_usd_ticks` as the primary bill record; xAI documents it as the actual request charge including internal model work, tools and discounts. Store integer ticks and divide by `10^10` only for display. Preserve usage details for analysis, but do not calculate total spend from citation counts.[^17]

Implement admission as `spent + unresolved reservations + next reservation <= configured budget`, alongside an attempt-count limit. Include unresolved work across day boundaries and restarts. Validate persisted budget fields at runtime; a negative, non-numeric or corrupt counter must stop new paid work, not grant extra allowance. Actual cost can exceed a reservation because native search lacks a documented per-request resource ceiling; stop admissions when it does and keep the overrun visible.

The historical scaling proposal was one worker, ten new attempts per day, a $2 admission budget and a $1 provisional reservation, with review for a charge above $0.25 or unknown cost. **Those are not current runtime settings.** The implemented pilot allows one active and one total attempt, with a proposed $1 combined reservation/exposure threshold requiring explicit acceptance of possible overruns. It does not authorize extra attempts after the first, even on a new day. Recalibrate only after separately approved live evidence; neither proposal creates a provider price cap.

### Provider billing backstop

Use an isolated xAI team if practical, a dedicated server key, prepaid credits, invoice limit `$0`, and auto top-up disabled. xAI says prepaid-only requests are rejected when credits are depleted. A positive postpaid limit governs invoiced usage after prepaid consumption, not a smaller sub-budget inside a large prepaid balance.[^18][^19]

A dedicated key alone does not create a separate team credit balance. Account settings must be verified by the account owner before a pilot; this plan does not change them. No documented per-request dollar ceiling or precise in-flight overrun guarantee was established, so retain application controls as well. Do not promise an arbitrary hard cents-per-artwork limit from a prompt or timeout.

The kill switch should stop **new paid generation only**. Already accepted artworks must stay viewable and mintable. Do not implement the switch by making the existing assessment repository inaccessible when an API key is removed.

### Timeout recovery and storage tradeoff

No general inference-POST idempotency guarantee was established. A local idempotency key prevents the gallery from intentionally dispatching duplicates; it does not prove that a remote provider did no work before a lost response. Holding uncertain jobs avoids automatic double-spending, at the cost of some requests requiring operator recovery.

The Responses API supports retrieving a known stored response by ID, with documented retention up to 30 days. `store:false`, as currently configured, does not provide that recovery path. Opting into provider storage and persisting the response ID early could reduce some duplicate-charge risks, but changes retention and still cannot solve a crash before the ID is received.[^9]

Do not treat the async-client guide as a recoverable background-job API; it describes concurrent client requests.[^20] Keep the pilot conservative: no automatic replay of uncertain POSTs, no generation retry merely because a user refreshed, and no deletion of a previously accepted result to repair an operational problem.

## 7. Historical repository findings and resolution

At the September 14 audit, fixed server-owned requests, handle-only input, native X Search/citation checks, bounded responses, separate fixtures and durable accepted assessments already existed.[^21] The following findings are retained as history with their current resolution; production startup remains refused.

| September 14 finding | Resolution as of September 19 and regression evidence |
| --- | --- |
| A stored pending request bypassed allowance after terminal-status write failure; the mocked reproduction produced two provider calls with budget one | Resolved. Durable admission/dispatch guards and live sharing prevent the second call. [Service tests](../src/openMint/service.test.ts): “does not repeat an uncertain paid attempt when both terminal status writes fail, including after restart.” |
| Interrupted requests could lose durable dispatch uncertainty and allow a repeat | Resolved. Versioned attempts preserve dispatched/unknown state; legacy ambiguity is blocked. [Lifecycle tests](../src/openMint/assessmentOperations.test.ts) cover fault injection and restart. No repeat-dispatch recovery operation is enabled. |
| Provider usage was discarded; count alone did not control concurrent paid exposure | Resolved locally. [Receipt tests](../src/openMint/providerReceipt.test.ts) validate allowlisted usage and exact integer billing; lifecycle tests cover one active/total attempt, reservations, corruption and cross-day uncertainty. Unknown X billing remains explicitly unresolved. |
| Instructions permitted refusal while the JSON schema required an MBTI | Resolved. Typed abstention has nullable MBTI, a bounded reason and no artifact/authority. [Grok tests](../src/openMint/grok.test.ts) cover abstention, mismatch, invalid output and paid receipts. |
| A crash between assessment persistence and first artifact publication could change spelling through later case-variant input | Resolved for new real assessments. The authenticated X spelling/account snapshot is part of the persisted assessment and is used for artifact rendering. [Coordinator tests](../src/openMint/assessment.test.ts) cover durable identity reuse; service tests cover X-returned case and unchanged artifact/snapshot after restart and expiry. Historical bytes remain unchanged. |
| Saved-result access depended on generation availability | Resolved. Service tests cover “reuses saved artwork and mint authority after restart with all generation credentials removed.” New generation remains disabled when credentials or admission are unavailable. |

The original 119-test audit record is retained in [paid-grok-fallback.md](paid-grok-fallback.md); it is not the current test count. Neither that record nor the new mocked regressions establish live account entitlement, actual unit cost, broad model quality or public-launch readiness. Current preflight reports both provider credentials absent and generation disabled.

## 8. Historical evaluation sequence

The sequence below records the original research proposal. Phase A is now implemented for the local one-attempt scope; the [current E09/E10 runbook](grok-pilot.md) controls the next live step. The later comparison phases remain separate, unapproved work and must not be used to expand the one-call envelope.

### Phase A: protect spending without paying

Implement the durable attempt state machine, runtime-validated count/USD accounting, one-worker dispatch, and a generation-only kill switch. Add regression tests for the confirmed allowance bypass, concurrent case variants, corrupt budgets, crashes before/after dispatch and publication, missing usage, and known-result persistence retries. Assert that no GET, refresh, public preview or cached request invokes the paid provider.

Keep the provider key out of tests. Use mocked complete, declined, malformed, timed-out, and contradictory responses. Assert that a valid accepted result survives policy changes and permit expiry without another provider call. Test frozen rendering spelling across publication recovery. Any wallet-proof admission change needs its own explicit UX selection and purpose-bound replay tests.

### Phase B: one guarded live compatibility check

After the owner approves a spend envelope and configures billing/key access, authorize one handle and one attempt. Verify actual support for the proposed model, reasoning, native tool controls and structured schema. Capture response type, citations, actual usage/cost, latency and provider ID; a structurally rejected response may still have consumed credits and must be accounted for.

Repeat the same handle, including a case variant and a fresh session, against the application cache. This should produce no further inference request. Rehearse the accepted assessment through isolated Anvil minting. Do not use a public chain or imply that a fixture-only rehearsal proves the live path.

### Phase C: small isolated quality/cost comparison

Use a fixed evaluation set of twelve handles: four active public accounts, three sparse accounts, three multilingual accounts, and two unavailable/protected/nonexistent cases. Include varied spelling and public-account writing styles. Approve the evaluation scope and spend envelope once, then run at most one attempt per handle under candidate A and one under candidate B, with automatic budget admission for every dispatch; stop on accounting or transport uncertainty. This is up to 24 paid attempts spread over the approved daily allowance, not 24 separate permission prompts or an unlimited benchmark.

Keep evaluation data out of the mintable canonical namespace. Compare correct-account evidence, structured success, appropriate refusal, latency, paid-attempt cost, and cost per accepted assessment. Do not choose whichever per-handle answer looks prettier; select one global policy before admitting production assessments. Inspect the evidence directly for the small evaluation instead of paying an additional grading model for every result.

The sample is a screening exercise, not statistically strong evidence about all X accounts. If `none` reliably clears the same integrity checks and provides adequate evidence at lower cost, adopt it. Otherwise use `low`. Promote neither if native-search or persistence validation fails. An expensive reference-model comparison is optional and should be limited to a few disputed evaluation cases, never an automatic production second opinion.

### Phase D: controlled pilot and price-transition review

Keep the proposed low daily allowance and prepaid-only billing until accepted-result reuse, abandoned-generation rate, refusal rate and unknown-charge handling are observable. Track total provider cost, cost per new accepted handle, cost per eventual mint, cache reuse, and outlier requests. Avoid publishing p95 or firm per-signature prices from a dozen examples.

Recheck the announced search pricing at the transition before continuing a live pilot across September 22 Shanghai time. Recalculate the reservation and admission policy from actual billed data. Increase traffic only after the controls are proven; changing model prices is not sufficient reason to rewrite existing assessments.

## 9. Alternatives not selected

| Alternative | Decision |
| --- | --- |
| User supplies MBTI; paid Grok merely endorses it | Reject. Introduces the user's desired result and still needs independent research to remove that influence |
| Consumer-chat link or encrypted payload becomes proof | Reject. Transport integrity alone does not prove the controlled assessment process produced it |
| Backend downloads selected posts; cheap model classifies | Outside the required native-Grok research model; do not silently substitute it |
| Generate without X Search from model memory | Reject for canonical assessments; fails the independent current-evidence requirement |
| Fine-tune or distil to another model | Changes the artwork's author; no established break-even for this early workload |
| Batch every interactive request | Not justified by the small tool-dominated saving and long possible wait |
| Speculatively pre-generate famous accounts | Only for a deliberately approved finite catalogue; not an automatic cost optimization |
| Another cloud/aggregator because token pricing looks lower | Require evidence of native X Search parity, direct trustworthy receipt, actual tool billing, and retention before considering migration |
| User's own API key | Changes who pays but not total resource use; creates key-custody/support work and is not subscription allowance |
| Subscription OAuth | Keep as a separate pending eligibility track; no dependency for implementing the paid fallback |

## 10. Decision summary

The practical fallback is **one short, independently researched Grok assessment for each new handle; durable reuse everywhere else**. The economical documented candidate is 4.3; the current pilot selects low reasoning, while its live behavior remains unverified. Native-search scope, demand gating, durable deduplication and actual-charge accounting dominate the design.

The next paid milestone is the single separately approved live check in the runbook. The attempt/budget/receipt layer and profile are now implemented, and wallet gating is already part of mint preparation. No purchasing, live inference, account-setting change, wider evaluation or production launch is authorized by this research document. A narrower evidence window remains an unselected policy change.

## Sources

Official documentation is a point-in-time description, not a live entitlement or quality test. Access date for web sources: September 14, 2026. Undated model cards are identified as current cards rather than assigned invented publication dates.

[^1]: xAI. [Tools Overview](https://docs.x.ai/developers/tools/overview). Updated July 13, 2026. Native server-side versus client-side tools.
[^2]: xAI. [Grok 4.3 model card](https://docs.x.ai/developers/models/grok-4.3). Undated current card. Model rates, reasoning choices and structured output capability.
[^3]: xAI. [Grok 4.6 model card](https://docs.x.ai/developers/models/grok-4.6). Undated current card. Comparison rates and capabilities.
[^4]: xAI. [Grok Build 0.1 model card](https://docs.x.ai/developers/models/grok-build-0.1). Undated current card. Nominal coding-model rates; native X Search suitability not established.
[^5]: xAI. [Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning). Current guide. 4.6 reasoning defaults and restrictions; 4.3-specific settings taken from its model card.
[^6]: xAI. [May 15, 2026 Model Retirement](https://docs.x.ai/developers/migration/may-15-retirement). Retirement effective May 15, 2026. Fast-model redirects and new rates.
[^7]: xAI. [API Pricing](https://docs.x.ai/developers/pricing). Updated September 7, 2026. Current and announced X Search billing units; effective September 21 noon Pacific. Cost tables are arithmetic scenarios using these rates, not provider estimates.
[^8]: xAI. [Prompt Caching: Usage & Pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing). Updated May 10, 2026. Token accounting and reasoning rate.
[^9]: xAI. [Responses REST Reference](https://docs.x.ai/developers/rest-api-reference/inference/responses). Current reference. Usage shape, retrieval/storage and compatibility-field qualifications.
[^10]: xAI. [X Search](https://docs.x.ai/developers/tools/x-search). Current guide. Scope and media parameters; no documented per-request fetched-resource ceiling.
[^11]: xAI. [Tool Usage Details](https://docs.x.ai/developers/tools/tool-usage-details). Updated May 27, 2026. Turn/call distinction, internal cumulative input, billable usage and response item types. Its older per-call billing discussion must be read with the newer pricing notice.
[^12]: xAI. [Official Python SDK chat implementation](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/chat.py) and [tool definitions](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/tools.py). Mutable main-branch sources inspected September 14, 2026. Parallel-call, turn and X Search parameter contracts; chosen REST combination still needs a live check.
[^13]: xAI. [Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs). Current guide. Supported schema constructs and constraints; semantic validation remains application work.
[^14]: xAI. [Prompt Caching: Best Practices & FAQ](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices). Updated May 10, 2026. Prefix organization, routing, metrics and eviction.
[^15]: xAI. [Batch API](https://docs.x.ai/developers/advanced-api-usage/batch-api). Updated September 8, 2026. Native X Search example, asynchronous processing and token discount. Discount also cross-checked against the pricing table.
[^16]: xAI. [Function Calling](https://docs.x.ai/developers/tools/function-calling). Current guide. Tool-choice and parallel-call controls; native-tool behavior must be validated on the selected route.
[^17]: xAI. [Cost Tracking](https://docs.x.ai/developers/cost-tracking). Current guide. Actual billed integer ticks, unit conversion and inclusion of server-side tool costs.
[^18]: xAI. [Manage Billing](https://docs.x.ai/console/billing). Updated September 11, 2026. Prepaid-only behavior, invoice limit and auto top-up controls.
[^19]: xAI. [Billing Management REST Reference](https://docs.x.ai/developers/rest-api-reference/management/billing). Updated February 13, 2026. Postpaid limit does not constrain prepaid consumption; team-level billing controls.
[^20]: xAI. [Asynchronous Requests](https://docs.x.ai/developers/advanced-api-usage/async). Current guide. Client concurrency, not inference idempotency or a durable job guarantee.
[^21]: Signatures Gallery working tree, inspected September 14, 2026: [provider](/Users/bigu/Projects/Agent-Art-signatures.gallery/src/openMint/grok.ts:4), [coordinator](/Users/bigu/Projects/Agent-Art-signatures.gallery/src/openMint/assessment.ts:110), [assessment store](/Users/bigu/Projects/Agent-Art-signatures.gallery/src/openMint/assessmentStore.ts:48), [request admission/recovery](/Users/bigu/Projects/Agent-Art-signatures.gallery/src/openMint/service.ts:60), [startup](/Users/bigu/Projects/Agent-Art-signatures.gallery/src/openMint/main.ts:28), and [preparation/test record](/Users/bigu/Projects/Agent-Art-signatures.gallery/docs/paid-grok-fallback.md). Local implementation evidence, including the isolated mocked allowance-bypass reproduction; not published provider behavior.
