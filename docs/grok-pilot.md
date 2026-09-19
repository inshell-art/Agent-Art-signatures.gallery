# One-attempt paid Grok pilot

Prepared and documentation checked: **2026-09-19**. This is the E09 operator handoff for E10. The implementation and mocked checks exist; no live X lookup, xAI inference, account entitlement check, credit purchase or billing change has been performed. No paid call or wallet transaction is authorized by this document.

The local read-only preflight on this date reported `xaiConfigured:false`, `xConfigured:false`, generation disabled and no record files in the default real namespace. The user delegated target selection; **`@karpathy` (canonical `karpathy`)** was selected, and the user replied “nice, pls keep going.” Both server credentials remain absent, so no paid dispatch can proceed. The target is recorded here, not enabled in runtime configuration. An absent credential is a configuration finding; it says nothing about whether the user's accounts have access. Apply the exact spending envelope below at the launch gate; target approval is not a guarantee of a $1 bill cap.

## Approval envelope

Approve **one named canonical handle**, one authenticated X username lookup, and at most one xAI Responses request after successful identity verification. The fixed profile is `sg-grok-mbti-2026-09-19-v1`. One total attempt and one active attempt are permitted in this pilot namespace; the daily allowance is one. There are no automatic retries, model fallbacks, user rerolls or repeat calls after an unsuccessful attempt. A successful result is reused for later requests, case variants and sessions.

The illustrative proposal is a **$1 combined application reservation and $1 exposure-admission threshold**, both represented as `10000000000` USD ticks. This is a conservative admission choice, not a measured estimate or provider-enforced price ceiling. The user must accept the possibility that the one request costs more than the reservation or completes remotely after the local timeout. If a guaranteed $1 maximum is required, this implementation does not establish it; do not run under that assumption.

The user separately approves the intended mint in their wallet on an isolated Anvil chain. The envelope includes no public-chain transaction, deployment, extra paid comparison, key creation, credit purchase or billing-setting change. A failed attempt stops the pilot; changing directories or deleting records to obtain another call is not recovery authorization.

## Request and pricing profile

The real launcher passes the server-owned [profile](../src/openMint/providerProfile.ts) to the [Grok adapter](../src/openMint/grok.ts). The adapter's standalone legacy default remains `grok-4.6`/4096 for compatibility; it is not the application's pilot configuration. Conflicting `OPEN_MINT_GROK_MODEL` overrides are rejected while paid generation is enabled. Disabled or pricing-expired generation ignores an old model override so saved-result recovery can still start without credentials.

| Setting | Implemented pilot value |
| --- | --- |
| xAI endpoint | `https://api.x.ai/v1/responses` |
| Model and reasoning | `grok-4.3`, `reasoning.effort: low` |
| Output | `max_output_tokens: 1024`; strict accepted/abstained JSON schema |
| Research | Only native `x_search`, one `allowed_x_handles` value; image/video understanding both `false` |
| Turns | `max_turns: 3`; no explicit parallel-call or `tool_choice` override |
| Time and body bounds | 90 seconds for transport plus complete body read; 1 MiB response limit |
| Storage | `store:false`; no response-retrieval integration |
| X identity leg | Fixed `GET https://api.x.com/2/users/by/username/<handle>`; 15-second timeout; 64 KiB body limit |

The [Grok 4.3 model card](https://docs.x.ai/developers/models/grok-4.3) documents structured outputs and `low` reasoning. Short-context rates are $1.25 per million input tokens, $0.20 per million cached input tokens and $2.50 per million output tokens. This makes it an economical candidate; it is not live evidence that this account can use the complete request combination or that the resulting assessment will pass validation.

The [Responses schema](https://docs.x.ai/developers/rest-api-reference/inference/responses.md) documents top-level `max_turns`. It bounds assistant/tool-calling turns, not the number of parallel tool calls, fetched posts/profiles or dollars. Output and timeout bounds also do not establish a charge ceiling. See [tool usage details](https://docs.x.ai/developers/tools/tool-usage-details).

As checked on September 19, [xAI pricing](https://docs.x.ai/developers/pricing) lists X Search at $5 per 1,000 calls. The announced transition is **September 21, 2026 at 12:00 PM Pacific = 19:00 UTC = September 22 at 03:00 Shanghai**: $5 per 1,000 posts fetched and $10 per 1,000 profiles fetched, including returned parent/quoted posts. At that instant, runtime policy disables new generation with `pricing-review-required`; preflight reports the same blocker. Admission and each provider dispatch recheck it, so a lookup that crosses the deadline cannot start the Grok leg. Saved-result reuse still works. A reviewed profile/exposure revision is required before later paid work; the gate cannot stop an already dispatched remote call or cap its bill.

The separate authenticated X lookup also has a cost. [X's pricing page](https://docs.x.com/x-api/getting-started/pricing) lists User Read at $0.010 per returned resource and identifies the Developer Console as the current-rate source. Console access, applicable plan, endpoint entitlement, credit balance and account billing settings remain unverified. An xAI key does not establish X API access; X OAuth client credentials are not the required app-only bearer token.

For arithmetic only, 5,000 uncached input tokens plus 300 output tokens cost $0.007 on the stated 4.3 short-context rates. Adding two currently priced search calls and one listed X user read gives $0.027. After the announced change, 20 fetched posts plus one fetched profile and the separate X read give $0.127 with the same token assumption. These constructed examples exclude taxes, hosting/storage and gas. They are neither observed usage nor forecasts, and the profile does not enforce those token/search quantities.

## Safe preflight and local configuration

Run from the repository root:

```sh
npm run open:preflight
```

This command reads ignored `.env.local`, prints credential-presence booleans, profile, handle/admission policy, local directory/ports and stop conditions. It does not fetch either provider, construct a wallet, connect to RPC, create directories or acquire/remove a writer lock. Exit status 1 means a reported blocker remains. It does not prove port availability or account entitlement; an exit status of 0 is not a live compatibility result.

Choose a fresh initial real namespace under `.local/open-mint/`, distinct from all fixture and previous pilot data. An illustrative proposal is `.local/open-mint/grok-pilot-20260919/`, app port `3020`, RPC port `18560`, origin `http://127.0.0.1:3020`. These are proposed values, not a claim that those ports are free. The launcher refuses an occupied RPC port and does not attach to or reset another Anvil. Keep the namespace fixed after the attempt.

| Configuration | Required meaning |
| --- | --- |
| `XAI_API_KEY` | Dedicated server xAI key in ignored local configuration; never paste into a report |
| `OPEN_MINT_X_BEARER_TOKEN` | Server X app-only bearer token; lookup access must be established by its account owner |
| `OPEN_MINT_GENERATION_ENABLED` | Default unset/`0`; set `1` only after the approved envelope is recorded |
| `OPEN_MINT_PILOT_APPROVED` | Default unset/`0`; `1` records the operator's application of that approval, not permission obtained by a script |
| `OPEN_MINT_PILOT_HANDLE` | Exact approved canonical handle; new generation for another handle is refused |
| `OPEN_MINT_DAILY_ASSESSMENT_LIMIT` | `1`; the independent total-attempt limit also remains one across days |
| `OPEN_MINT_RESERVATION_USD_TICKS` | Explicit positive integer; proposed `10000000000` |
| `OPEN_MINT_EXPOSURE_USD_TICKS` | Explicit positive integer at least the reservation; proposed `10000000000` |
| `OPEN_MINT_DATA_DIR`, `PORT`, `OPEN_MINT_RPC_PORT`, `OPEN_MINT_ORIGIN` | Approved isolated namespace and matching literal loopback ports/origin |

Do not add real secret values to tracked examples. After approval and private provisioning, rerun preflight with the exact settings before `npm run dev:open`. Starting the app alone does not initiate research: wallet proof, chain eligibility and explicit **Mint & reveal** are still required. Use the selected handle once. If accepted, verify reuse without another provider call, then obtain the user's Anvil wallet approval and record the observed outcome.

`npm run dev:fixture` uses simulated identity/assessment providers and local Anvil transactions without paid API calls. Defaults are `.local/open-mint/fixture/` and RPC `18547`, versus `.local/open-mint/grok/` and RPC `18546` for real mode. Fixture accounting is explicitly `fixture-not-billed`; it cannot settle real charges. Never copy fixture assessments or billing exemptions into a real namespace. Fixture or mocked success is not live-provider validation.

## Receipts, inspection and stop conditions

The [attempt ledger](../src/openMint/assessmentOperations.ts) persists dispatch markers before each external leg. The transports await a separate private receipt before validating its semantic result. Receipts retain bounded references, returned model, timing, HTTP/result category, validated token/tool counts and integer monetary evidence. Raw bodies, posts, credentials, hidden reasoning and arbitrary error text are excluded.

The xAI [cost contract](https://docs.x.ai/developers/cost-tracking) reports total request cost in `usage.cost_in_usd_ticks`, including its internal tools; one USD is `10^10` ticks. The [Responses schema](https://docs.x.ai/developers/rest-api-reference/inference/responses.md) also permits `cost_in_nano_usd`; the parser multiplies validated integer nano-USD by 10 exactly. Disagreement between both fields is unknown billing. Missing/invalid values never become zero, and citation counts never substitute for a billing meter.

X lookup responses have no implemented authoritative per-request cost field. The X receipt therefore remains `unknown`, even after a successful user lookup; the documented $0.010 rate is planning evidence, not an observed charge. A successful full pilot can consequently remain `unresolved`/`operator-review` in the local accounting report. Consult the provider consoles for reconciliation evidence; the current tooling cannot approve a retry or mutate a receipt to settle it.

Inspect a safe attempt reference without credentials or generation permission:

```sh
node --import tsx scripts/open-mint-attempt.mjs \
  --records /absolute/path/to/.local/open-mint/grok-pilot-20260919/records \
  --reference ATTEMPT_ID
```

Use the UUID diagnostic reference, not a private mint request code. Inspection opens validated records read-only; it creates no store, lock, job or provider request. The report shows phases, sanitized outcome, assessment reference, artifact outcome, receipts and unresolved exposure. An unknown charge holds the conservative reservation across restart and date changes; a known overrun remains visible. Older ambiguous records stay blocked with unknown admission rather than acquiring retry permission.

Stop on X lookup failure, wrong subject/model, abstention, invalid output, malformed/truncated/oversized response, timeout, missing receipt or any durable-write failure. Only accepted results enter the immutable assessment/artifact path. A timeout does not prove cancellation or a zero charge. A late response cannot become an accepted result or a second receipt.

For a generation kill switch, stop the app gracefully and restart with `OPEN_MINT_GENERATION_ENABLED=0`; editing `.env.local` alone does not update a running process's environment. Saved verified assessments and existing artifacts remain readable and eligible for their existing recovery/authorization policy without either generation credential. The switch cannot recall an already dispatched provider request. Do not reset budgets, delete guards, reroll results or create a replacement namespace to bypass a failed attempt.

The deferred E21 recovery operation must require phase and billing evidence proving any pre-Grok failure, linkage to the original attempt, an idempotent audit record and explicit approval for further paid dispatch. This pilot has no recovery command that releases uncertain spending or enables a repeat attempt.

## Local evidence and live report

The provider, receipt and identity suites pass 206 mocked tests as of this handoff. Their measured coverage is 100% statements/functions and 96.35% branches, with TypeScript checking passing. [Provider tests](../src/openMint/grok.test.ts), [X tests](../src/openMint/xIdentity.test.ts) and [receipt tests](../src/openMint/providerReceipt.test.ts) cover accepted/abstained/invalid outcomes, usage and cost validation, body limits, non-2xx responses, receipt-write failure and late timeout completion. [Lifecycle tests](../src/openMint/assessmentOperations.test.ts) and [service tests](../src/openMint/service.test.ts) cover durable dispatch, uncertainty, admission and saved-result recovery.

After the separately approved live attempt, record its tested Git revision, profile, canonical target, namespace/ports, safe attempt reference, observed returned model, per-leg latency/category, cost evidence/unknowns, semantic outcome, reuse check and user-approved Anvil transaction result. Keep public-source references separate from private provider/account evidence. Until that report exists, account access, live wire compatibility, actual costs, assessment quality and a real-assessment mint remain unverified.
