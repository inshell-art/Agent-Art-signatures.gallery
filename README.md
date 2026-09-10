# signatures.gallery V2

Signatures Gallery is the inaugural project presented by [Agent Art (@AgentArt_AA)](https://x.com/AgentArt_AA). It operates within [Agent Art](https://inshell.art/docs/agent-art)—the open field of art activity in which an Agent participates. An artist-defined system turns the characters of an X handle into a handwriting-like signature. In the intended private workflow, Grok reads recent public posts and selects `gr0k`, the environmental condition in which that signature is rendered—not a score, mood, probability, or judgment.

The formal renderer follows [Signature Algorithm v1.0.0](https://github.com/inshell-art/agent-art-Signature-prototype/tree/v1.0.0), frozen at commit `1e1dab4ec093261006feb7879c109413c0b3ac6d`. It accepts an exact-case X handle and an integer `gr0k` seed from **1 through 100** (default 22), renders a side-effect-free preview, authenticates the matching account through X OAuth, and saves the exact artwork after explicit claim consent. Account matching remains case-insensitive; artwork input and signature identity preserve case. V2 adds an opt-in Ethereum mint path without changing the artwork.

See [formal algorithm adoption](docs/formal-algorithm-v1.md) for the pinned source, parity checks, output contract, and deliberate retirement of old decimal-seed artwork and permalinks.

**Renderer visually approved and locked: 2026-09-10.** The [lock manifest](reference/algorithm-v1.0.0/renderer-lock.json) pins the validated implementation and complete SVG goldens. `npm run renderer:verify` checks it; normal dev, test and build commands fail on drift. Future artwork changes require a new version and explicit approval, never replacement under an existing signature ID.

The current local build implements the complete V1 product flow plus two clearly labelled V2 rehearsals: the dependency-free in-memory UI fixture and a real repo-local PostgreSQL 16 + Anvil 31337 workflow:

- `GET|HEAD /s/{handle}/{gr0k}` — side-effect-free preview with canonical redirects.
- `GET /renders/{renderer_version}/{handle}/{gr0k}.{svg|png}` — versioned preview assets.
- `POST /auth/x/start` and `GET /auth/x/callback` — session-bound OAuth/PKCE flow.
- “Claim with X” saves the exact signature when the matching OAuth identity returns, then redirects directly to `/signatures/{id}`. A one-time, session-bound success toast appears for five seconds of active viewing, pausing on hover, keyboard focus, or an inactive tab/window; shared links and refreshes do not replay it.
- `GET /s/{handle}/{gr0k}?flow=…#claim` — private retry or legacy confirmation state. Successful flows redirect to the permanent signature page. `POST /api/v1/signatures` handles explicit retries and legacy confirmations. The old `/claim/review` route redirects here.
- `GET /me` — private account collection.
- `POST /signatures/{signature_id}/withdraw` — claimant-only deletion with a fresh X session, same-origin check, CSRF, explicit confirmation, and a per-claim instance token. No withdrawn state or restore view. It removes the claim from Claimed and My Collection; the permalink/artifact endpoints return 404. Claiming the same input later inserts a fresh row/date/instance, although the deterministic artwork ID and URL remain the same. Old forms cannot delete the new claim.
- `GET|HEAD /about` — About the work: the handle, Agent contribution, claiming, minting, and provenance boundaries.
- `GET|HEAD /dev/collection-states?state=empty` — development-only, read-only My Collection state fixtures; never modifies sessions, claims, wallets, or the chain.
- `GET|HEAD /dev/button-study` — the selected compact Hairline button, soft-filled status tags, three alternative button treatments, and a selectable claim-page specimen. Preview only; no authentication, claims, or saved theme/style preferences.
- `GET /signatures/{signature_id}` and `/artifacts/{signature_id}.{svg|png}` — stable claimed record and immutable assets.
- `POST /api/v2/wallet-bindings/challenge` and `/confirm` — exact session-bound SIWE EOA proof.
- `DELETE /api/v2/wallet-bindings/current` — guarded binding revocation.
- `GET /signatures/{signature_id}/mint` — exact-work review, wallet/chain facts, fees, provenance limit, and irreversible-publication consent.
- `POST /api/v2/signatures/{signature_id}/mint-authorizations` — exact EIP-712 authorization; the interactive local entrypoint durably checkpoints intent before signing and the signed authorization before return. Normalized production persistence remains a gate.
- `POST /api/v2/mint-authorizations/{authorization_id}/transactions` — advisory transaction report only.
- `GET /api/v2/signatures/{signature_id}/mint-status` — projection state without a per-request RPC call.
- Home has **Claimed | Minted** galleries. Claimed (the default) lists all successful, explicitly authorized claim commits, including works later minted, independent of the visitor's login. A preview or ordinary account sign-in never creates a claim. The combined **Sign in with X and claim this signature** CTA authorizes saving on the matching OAuth return. Minted lists only finalized mint projections. Both exclude suppressed records. Claimed remains `noindex`; production Minted and finalized permalinks are indexable.
- Legacy three-segment `/s`, `/c`, and `/v` routes return `410 Gone`.

The V2 foundation also includes the strict V1 digest/token-ID bridge, deterministic RFC 8785 NFT metadata and frozen UnixFS CID profile, canonical low-`s` signature validation, dual-RPC EOA checking, additive PostgreSQL migration, a frozen-ABI log decoder with restartable reorg/finality and control-state projections, content-writer fencing, and a non-upgradeable OpenZeppelin ERC-721 contract.

See [V2 implementation status](docs/v2-implementation-status.md) for the exact boundary between executable local behavior, reference-model safeguards, guarded deployment tooling, and work that still depends on real infrastructure or approval. Nothing in the current repository is a production-readiness or deployment claim.

## Local inspection

### Claim withdrawal

On your own signature detail page, expand **Withdraw claim** using its arrow, click the revealed CTA, then choose **Confirm withdrawal** in the dialog. The dialog identifies the exact handle/gr0k; **Cancel** or Escape leaves the claim untouched. Without JavaScript, an inline disclosure still requires an explicit **Confirm withdrawal**. A minted work cannot be withdrawn. Prepared, signed, submitted, uncertain, and unreconciled mint authority blocks deletion even if the visible projection says “Not minted”; only chain-reconciled unused expiry releases that guard in the local runtime. Withdrawal and authorization share the claim lock and local durable operation queue. The database deletion and local mint-snapshot cleanup commit together. Wallet links and other claims are retained. Shared artifact bytes are not destructively deleted; only this claim's references are detached. Previously downloaded copies cannot be recalled.

Migration `003_claim_withdrawal.sql` is additive and applied by the local server and rehearsal setup without resetting data. It adds a random claim-instance ID, preserves the original administrative erasure guard, and permits narrowly checked ordinary withdrawal. Normalized V2 publication/mint records remain conservatively blocked; this does not enable the still-gated production mint repository. Claim routes use `no-store` because deleted records must not be served from a long-lived page/artifact cache.

Never-authorized claims can be withdrawn while local Anvil is unavailable: the check and deletion still run inside the same exclusive, durable database queue as minting. Any mint-authorization history—including expired authority—requires fresh successful chain reconciliation before withdrawal. Mint issuance keeps its existing chain-readiness requirement.

```bash
npm install
npm run dev
```

Open http://localhost:3000. Development fixtures are enabled by default. Claimed contains 90 stored rehearsal claims; Minted contains 88 explicitly simulated finalized works, paginated in groups of 24. Both tabs use the same [fixture library](src/v2/galleryFixtures.ts): the original eleven public X handles from digital art and technology merged with the handle presets from the pinned prototype v1.0.0. Its 80-entry constant contains three overlong handles, excluded by the same 1–15-character validation used by the upstream UI. The 77 valid presets, deduplicating `tylerxhobbs`, produce 87 unique catalog handles, plus Alice's three interactive rehearsal claims. The original eleven retain their varied `gr0k` values; the 76 additions use the formal default of 22 to compare handle shapes, preserving uppercase letters, digits, and underscores exactly. The preset strings are renderer examples, not a fresh verification of live X accounts. All seeded identities, `gr0k` values, claims, wallets, mints and transfers are fictional, with no participation or endorsement implied; this warning stays in the separate DEV overlay. Each library entry records its handle's source. Some show a simulated transfer so claimant, initial recipient, and current holder are visibly distinct. These samples use stored renderer output and working detail pages, not placeholder images. They are seeded only by this in-memory entrypoint; the durable PostgreSQL + Anvil rehearsal retains its separate chain-backed seed. Both tabs use centered, same-color labels with a background box on the selected tab, server-rendered links and stable keyset pagination; switching tabs starts at that gallery's first page and works without JavaScript.

Claimed and Minted link to the same `/signatures/{id}` detail page and stored artwork. Details share home's 1024px canvas, 14px regular typography and system theme: one centered artwork, compact 3px-padded status tags, an 11px four-square Gallery icon balanced against the 10px My Collection dot, both centered in 44px targets. Every committed signature shows Claimed; only a finalized mint adds Minted. Pending or incident states remain explicit. The single native Provenance disclosure contains historical claim evidence, complete artwork hashes and mint/holder records; it works without JavaScript. Canonical SVG display and PNG `og:image` previews are unchanged. Claim consent is disclosed beside the combined sign-in-and-claim CTA; matching OAuth saves it without a second confirmation. Wallet consent and mint review remain separate explicit actions.

All HTML interface text uses Instrument Sans at 14px / 400, including mint review, account controls, tooltips, forms, footers, and development studies. `--ui-font-size` is the single size token. The 16px root remains a layout unit for existing rem-based spacing; SVG artwork geometry and authored SVG text are excluded from the UI type rule.

The local identity flow is a real authorization-code/PKCE rehearsal backed by an in-process provider emulator, not an X login:

1. Open **My Collection** → **Sign in with X**. In this environment the normal action routes to the local simulator, not X.
2. In the automatically opened amber **DEV** panel, choose **@alice** and **Approve local identity**. The browser returns through `/auth/x/callback`, validates one-time state and PKCE, and rotates the session before showing Alice's three seeded claims. The account chooser and failure controls are development tools, not a proposed gallery sign-in page.
3. Open `/s/alice/37` → **Claim with X**. Authentication saves the public claim and returns directly to its detail page. A failed save offers **Retry claim**. Ordinary account sign-in creates no claim.
4. From Alice's collection, use **Mint this signature** to inspect minting. Use **Advance rehearsal** inside DEV to advance an existing simulated authorization. No wallet signature, IPFS publication, Ethereum transaction, or finality observation is real in this in-memory mode.

To inspect failure handling, start again and choose **Simulate account denial** or **Simulate provider error**. To exercise account selection, choose **@newcomer** (no seeded claims), or choose Bob while claiming an Alice preview to see the handle-mismatch stop. Bob may already have claims from earlier rehearsals. Log out and restart the flow to switch accounts. Authorization requests, codes, and callback state are one-time and expire.

Empty Claimed and Minted galleries, an empty private `/me`, and signed-out `/me` share one participation component: **To participate, ask Grok for your signature**, **Step 1: Copy the prompt**, and **Step 2: Paste into Grok ↗**. The prompt is provisional copy centralized in `src/v1/grokPrompt.ts`, ready to replace later. It currently preserves the V1 private-Grok contract, carries the remaining preview/sign-in/explicit-claim instructions, and uses the configured site origin. Anonymous prompts ask for a handle before producing a link; public galleries never personalize this from a private session. Signed-in empty collections use the authenticated handle. Existing collection access stays below the participation steps on signed-out `/me`. A closed **View prompt** disclosure allows manual copying without JavaScript and opens with selected text if clipboard access fails. Both step labels retain the same compact CTA highlight; the external arrow is outside the highlight. No prompt is sent automatically to Grok. Signed-in emulator accounts retain a short, explicitly qualified local-sample link. Populated galleries/collections, errors, and claim/mint authorization screens are not replaced by onboarding.

For repeatable UI inspection, open the amber **DEV** overlay and use **Switch fixture**, or set `/dev/collection-states?state=KEY` directly. All 17 fixture links come from the same catalog used to render the fixture pages; the current state is highlighted. Available keys are `signed-out`, `empty`, `gallery-claimed-empty`, `gallery-minted-empty`, `claimed`, `wallet-linked`, `authorized`, `submitted`, `confirming`, `minted`, `transferred`, `validation-pending`, `quarantined`, `finality-revoked`, `mint-paused`, `reauthenticate`, and `renamed`. For example, [inspect a transferred token](http://127.0.0.1:3000/dev/collection-states?state=transferred). There is no state selector or development-link section inside the page layout. The amber **DEV · UI fixture** disclosure floats above the page and contains the switcher, current override, and notes. **DEV · Local rehearsal** identifies interactive development pages and also offers the switcher when fixture routes are enabled. This developer overlay is separate from the gallery, reserves no layout space, and is absent on production pages. Fixture pages use the same page and account-panel renderers and spacing as normal pages, but force simulated data; their status does not reflect or update your live collection. Account/mint mutation controls are disabled and no live wallet/indexer scripts run. Copying the provisional prompt and viewing it remain available. Use the normal My Collection dot or open `/me` to leave the read-only preview and rehearse the interactive flow.

The DEV panel collapses on an outside click/tap or Escape. Internal fixture links remain usable, and outside page links still navigate normally. Escape returns focus to the DEV trigger only when focus was inside the panel; the native disclosure toggle remains usable without JavaScript.

Rehearsal explanations and controls belong in that overlay, not in the product’s provenance or authentication copy. Page-specific claim, chain, identity, and mint-rehearsal notes appear before the fixture switcher. Local sample previews, simulated wallet linking, lifecycle advancement, and Anvil TEST-wallet mint/transfer tools all live inside DEV. The account panel retains normal X and browser-wallet actions; **Link wallet** never silently falls back to a simulated wallet. Opening DEV refreshes its private wallet controls with the current session and CSRF token. The TEST-wallet mint button remains tied to the actual review form's required publication-consent checkbox. Product sections retain their regular labels and real warnings about public claims, irreversible publication, and unverified Grok origin. Local networks and transaction values are not relabelled as mainnet; local-only controls remain explicitly named. The DEV marker stays visible while its notes are collapsed, and development pages remain noindex. Content-versioned CSS and JavaScript URLs prevent stale presentation or event handlers after a reload.

**Next-step visibility:** unminted claims show **Mint this signature** even before a wallet is linked, X authentication is refreshed, or minting is enabled. Public unminted detail pages expose the same entry point, explicitly limited to the original claimant. The read-only `/signatures/{id}/mint` entry guides sign-in, account correction, reauthentication, and wallet proof before rendering the exact mint review. OAuth return destinations are bound to the one-time flow and allow only a canonical local mint path; wallet linking reloads that same path. Pending/unsafe mint states explain why another mint cannot start, and finalized tokens return to their provenance page. Entry views never prepare metadata, freeze an authorization, or mint; all write endpoints still require their existing identity, claimant, freshness, wallet, CSRF, and permanence checks. The wallet panel similarly keeps Link/Replace wallet discoverable when sign-in or reauthentication is needed. Read-only collection fixtures link to `?state=claimed&view=mint` (and the corresponding wallet-linked, reauthenticate, renamed, and mint-paused views) using the same entry component with mutation controls disabled.

For the default `npm run dev` entrypoint, real X OAuth takes precedence when both `X_OAUTH_CLIENT_ID` and `X_OAUTH_REDIRECT_URI` are configured. The durable launcher makes the provider explicit: `local:serve:x` uses real X, while `local:serve:emulator` always uses the simulator. See [Real X + local app](docs/real-x-local.md).

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run test:contract`, `npm run test:manifest`, and `npm run test:manifest:roles` before committing. The status document includes the scoped V2 checks.

The homepage slogan uses a checked-in shape snapshot; separate words or an underscore-joined phrase can be captured through the composition adapter. Run `npm run slogan:inspect` to compare that lock with the current renderer, or add `-- --json` to emit the complete review candidate. See [the composition boundary](docs/slogan-composition.md) before accepting a renderer or slogan change.

The site uses one type family: **Instrument Sans**, self-hosted from the pinned `@fontsource-variable/instrument-sans` dependency. Regular (400), medium (500), and semibold (600) provide the hierarchy; numeric records use tabular figures. The shared CSS includes upright and true italic Latin/extended-Latin subsets; only upright Latin is preloaded. Font assets and the SIL OFL license are served from versioned `/assets/fonts/instrument-sans-<package-version>/` URLs, with no Google Fonts/CDN request. Keep runtime dependencies in compiled deployments (`npm ci --omit=dev`); font resolution works from both `src` and `dist`. The slogan, question mark, and signature SVG/PNG bytes remain independent of site typography.

The collection dot is always a native, one-click link to `/me`, including while its hover panel is open. There is no separate native tooltip: **My Collection** appears as the panel heading, above the X and wallet quick controls. The heading stays visible while private account content refreshes or fails to load. Keyboard focus can expose the same controls; the existing touch toggle remains separate from the direct collection link.

### Durable PostgreSQL + Anvil rehearsal

The interactive local path supports **claim → real SIWE proof → signed Anvil mint → automatic indexing → transfer**, with PostgreSQL durability. With PostgreSQL 16 and Foundry installed, preserve an existing rehearsal and start its foreground app:

```bash
npm run local:up
npm run local:verify
npm run local:serve
```

On first run, `local:up` initializes the local schemas/chain, deploys the contract to loopback Anvil 31337, and seeds one signed mint using public test keys. Use `npm run local:reset` only to intentionally erase and recreate this repository's ignored `.local/rehearsal` data, with the foreground app stopped.

Open <http://127.0.0.1:3000/s/alice/73> → **Sign in with X and claim this signature** → approve **@alice** in the emulator → **Claimed**, without a second confirmation. In **My collection**, choose **Use local TEST wallet**, explicitly approve its real one-time wallet proof, then **Mint this signature** and confirm the reviewed local transaction. No extension is required: the narrowly scoped local wallet uses public Anvil account index 6. Once indexed, **Transfer local token** sends the token to the fixed second TEST wallet at index 7; the claimant and artwork remain unchanged. Never send real funds to these public-key accounts. A browser-wallet alternative is available for a dedicated local EOA.

The foreground app defaults to the X simulator. To use real X with the same local PostgreSQL and Anvil, fill OAuth 2.0 Web App credentials in git-ignored `.env.local`, run `npm run local:auth:check`, then `npm run local:serve:x`. Real mode validates configuration before touching infrastructure and disables simulator endpoints. Register `http://127.0.0.1:3000/auth/x/callback` exactly in a separate X development app. [Setup and live walkthrough](docs/real-x-local.md). V1 claims and content-addressed artifact references are durable; wallet bindings, authorizations, mint attempts, and indexer state use PostgreSQL snapshots. A single exclusive writer serializes mint operations and atomically commits the indexer cursor with its public projections. Two-second Anvil interval mining plus roughly one-second polling discovers actual mint/transfer logs even if the browser fails to report a transaction. The label **Local Anvil automatic confirmation; single node** explicitly does not mean Ethereum finality. IPFS CIDs are deterministic but remain unpublished/unpinned; development metadata is not production provenance.

App restarts require another login with the selected X provider because browser sessions/flows remain ephemeral. Claims, real SIWE bindings, mints, transfers, and indexing progress persist. The old CLI-seeded wallet binding is revoked at startup and cannot authorize new interactive mints. Keep `http://127.0.0.1:3000` as the app origin throughout a rehearsal: unfinished frozen metadata is not regenerated when a port changes.

With the app running, an explicit local-only test creates a Bob claim, signs a proof, mints, transfers, and verifies unchanged artwork. Save its printed signature ID for a read-only restart check:

```bash
npm run local:test -- --execute-local-test-transactions
# After restarting the app, substitute the signature ID printed above:
npm run local:test -- --verify SIGNATURE_ID
```

Stop the foreground app with Ctrl-C before `npm run local:stop`. `local:up`, `local:reset`, and `local:stop` refuse to run over an active app writer. `local:up` reuses persisted state without redeploying or replaying fixtures over later account metadata, and refuses a mismatched V2 migration checksum. `npm run test:postgres:local` applies every schema/migration to a separate fresh disposable PostgreSQL cluster. Full walkthrough, failure/restart behavior, guards, ports, and limitations are in [the local rehearsal runbook](docs/local-rehearsal.md).

## Production blockers

The renderer is the formal v1.0.0 algorithm. The bundled wallet, signer, chain, IPFS, and finality fixtures remain local inspection tools, not production provenance. Production startup still fails closed for infrastructure reasons. Mainnet deployment is explicitly forbidden without a separate approval.

The project still requires:

- production-grade normalized Postgres repositories, external content-addressed object storage, distributed session/flow and rate-limit adapters, plus staging migration/restore rehearsal (the bundled PostgreSQL/file adapters are local-only);
- production X OAuth credentials and live smoke testing;
- two independent IPFS pin providers and an integrity gateway;
- two independent archive-capable RPC providers, durable finality indexer, protected KMS/HSM signer, and deployment role addresses;
- Sepolia deployment/rehearsal, contract review, deployment manifest, CDN/publication fencing, and the operator erasure runbook.

No private Grok transcript, source Post, rationale, or X token enters V2 metadata or the contract. The finalized public record intentionally links the opaque account reference, historical handle, artwork commitments, linked wallet, and Ethereum transaction.
