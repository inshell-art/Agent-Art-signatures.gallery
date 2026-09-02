# signatures.gallery

An Agent Art work. Each X account has one canonical signature — a deterministic
abstract mark derived from the handle alone. Each mention of the agent on X
produces an instance: the same signature, slightly off, where the deviation is
determined by the agent's reading of that participant's recent public posts.

The accumulated instances for one handle form a cluster. The cluster is the
work; a single instance is a sample of it.

See [HANDOFF.md](./HANDOFF.md) for the full implementation spec. The
signature generation algorithm (§6 of the handoff) is ported from
[inshell-art/agent-art-Signature-prototype](https://github.com/inshell-art/agent-art-Signature-prototype)
— see [`src/algorithm/`](./src/algorithm/).

## Status

Stack: TypeScript / Node.

- [`src/reading.ts`](./src/reading.ts) — implemented. The reading contract
  from handoff §4: the 4-axis vocabulary, the 4-character URL code, and
  validation (out-of-vocabulary codes are rejected, not coerced).
- [`src/algorithm/`](./src/algorithm/) — implements §6, ported from the
  prototype: `hash.ts` (the SHA-256-labeled deterministic randomness — via
  Node's `crypto`, byte-identical to the prototype's hand-rolled digest
  since both implement the same standard), `geometry.ts` (character-seeded
  Bézier anchors, outline/centerline path construction), `settings.ts` (the
  prototype's frozen default parameters — path mode "Variable outline ·
  Bézier C", both randomness toggles On), `svg.ts` (serialization), and
  `offsets.ts` — **not** part of the prototype, which has no notion of an
  instance. This is the bridge that lets `renderInstance`'s `OffsetVector`
  perturb the canonical along four axes reusing the reading axis names
  (`tempo` → rotation range, `weight` → stroke weight, `steadiness` →
  Y-shift range, `reach` → handle-length range), sized so every combination
  stays structurally inside `ENVELOPE` and offset zero reproduces the
  canonical exactly. Treat that specific mapping as a first pass — the
  handoff reserves the aesthetic call for whoever supplies "the algorithm"
  (§5); [`src/algorithm.ts`](./src/algorithm.ts) is now the real
  `renderCanonical`/`renderInstance`/`SPEC_VERSION`/`ENVELOPE` implementation,
  not a stub.
- [`src/mapping.ts`](./src/mapping.ts) — **placeholder**. A structurally
  valid `readings.map.v0-placeholder`: additive per-axis offsets, `xxxx` ->
  zero vector, deterministic within-cell jitter from the source post ID,
  asserted inside `algorithm.ENVELOPE`. The real table's contents are still
  an aesthetic decision reserved for later (§5) — swap the whole file, keep
  the function signatures.
- [`src/store/`](./src/store/) — data model (§7): `schema.sql` is the
  Postgres DDL (append-only `instances`, idempotency key on
  `(seed_handle, source_post_id)`); `types.ts` defines the `Store`
  interface; `memoryStore.ts` is a placeholder in-memory implementation used
  for tests until a Postgres-backed `Store` is wired up.
- [`src/raster.ts`](./src/raster.ts) — real, not a placeholder: SVG -> PNG
  via `sharp`, since X only accepts raster for `og:image` (§9.1). Doesn't
  depend on the algorithm's contents, only on it producing valid SVG.
- [`src/assets/`](./src/assets/) — asset storage for rendered marks: SVG
  kept as source of truth, PNG for the card (§9.1). `memoryAssetStore.ts` is
  a placeholder in-memory implementation, same swap-out story as
  `MemoryStore`.
- [`src/rateLimit.ts`](./src/rateLimit.ts) — real sliding-window limiter,
  per handle and per source IP (§9.1: "unbounded minting is a
  denial-of-wallet vector"). In-memory; would need a shared backend (e.g.
  Redis) behind a multi-instance deployment.
- [`src/claim/`](./src/claim/) — X OAuth 2.0 + PKCE claiming (§10).
  `xOAuthClient.ts` is a real client against X's public OAuth endpoints
  (untested against the live API here — needs a registered app's
  credentials); `pendingClaims.ts` binds callback `state` to its PKCE
  verifier with a 5-minute TTL. Binds `x_user_id` (never the handle
  string) and freezes `seed_handle` on first claim only, per §10.
- [`src/verification/`](./src/verification/) — async, post-mint provenance
  verification (§9.3). `xApiClient.ts` is a real client against X API v2
  (app-only bearer auth; untested against the live API here, same caveat as
  the OAuth client — needs a registered app's credentials); `verify.ts` is
  the fire-and-forget call the mint route makes *after* responding, so a
  slow or down X API can never delay the card unfurl. Flips an instance's
  `provenance` from `unverified` to `verified` — the one column the
  append-only data model (§7) allows to change post-insert, since it's a
  trust status, not generative content (see the note in `schema.sql`).
  Skipped entirely if no `xApiClient`/`agentHandle` is configured.
- [`src/api/pages.ts`](./src/api/pages.ts) — HTML templates for `/c/{handle}`
  (cluster: canonical + every instance, reading code, rationale, provenance)
  and `/v/{id}` (verification: every field §9.4 requires, including the new
  `spec_hash`). `algorithm.SPEC_HASH` (in `algorithm.ts`) is a content hash
  of the exact settings that determine every rendered byte — what §9.4
  calls "the published spec hash."
- [`src/api/`](./src/api/) — HTTP API (§9), now end-to-end:
  `GET /s/{handle}/{code}/{post_id}` (mint or fetch, idempotent,
  rate-limited — validates, checks idempotency, derives the offset vector,
  renders, persists, rasterizes, stores SVG+PNG, kicks off provenance
  verification), `GET /c/{handle}` and `GET /v/{id}` (HTML by default, JSON
  when the request sends `Accept: application/json`), `GET /i/instance/{id}.png`
  and `GET /i/canonical/{handle}.png` (serve the stored/lazily-rendered
  PNGs), `GET /claim/start` + `GET /claim/callback` (OAuth claim flow, 501
  if no `oauthClient` is configured).

```bash
npm install
npm test        # vitest
npm run typecheck
npm run dev      # http://localhost:3000, in-memory Store/AssetStore, hot reload
npm run build && npm start   # compiled, same in-memory backing
```

`npm run dev` ([`src/main.ts`](./src/main.ts)) needs no database or credentials to
try the full mint -> render -> rasterize -> serve pipeline; data resets on
restart. Set `X_CLIENT_ID`/`X_CLIENT_SECRET`/`X_REDIRECT_URI` to enable
`/claim/*`, or `X_BEARER_TOKEN`/`AGENT_HANDLE` to enable provenance
verification — both stay off (claiming 501s, instances stay `unverified`)
without them.
