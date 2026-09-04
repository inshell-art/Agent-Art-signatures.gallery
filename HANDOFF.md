# signatures.gallery — V1 Implementation Handoff

**Status:** implementation-ready
**Audience:** the agent or engineer updating the already-implemented `signatures.gallery` service
**Implementation target:** **V1 only**
**V2:** **TBD — do not implement**
**Supersedes:** `signatures-gallery-handoff.md` for all new development

The previous handoff described canonical signatures, instances, readings, offsets, clusters, source Posts, and creation during a `GET`. That implementation is now the legacy design. Refactor it to the model below without deleting legacy data.

---

## 0. Primary directive

Implement this complete V1 and stop.

V1 includes the private-Grok handoff, deterministic preview rendering, X OAuth, explicit owner claim, account collection, and stable signature pages. It does **not** include wallets, Ethereum, minting, tokens, or a minted-signature feed.

Do not anticipate V2 with placeholder contract code, wallet libraries, mint fields, fake buttons, or speculative schemas. V2 is deliberately TBD.

---

## 1. Product model

Each claimed signature is a complete, equal-status work:

```text
signature_artifact = F(handle_normalized_at_claim, gr0k_raw, renderer_version)
```

- `handle_normalized_at_claim` gives the signature its account-specific basis.
- `gr0k` is a scalar selected in the intended private Grok workflow.
- `renderer_version` freezes the exact transformation from those inputs to SVG bytes.

There is no canonical signature, instance, cluster, offset, source-Post index, or artistic sequence number.

One numeric X account ID may claim any number of signatures. A different `gr0k` produces a different, equal-status signature. Repeating the exact same claim is idempotent and returns the existing signature.

### Meaning of `gr0k`

`gr0k` is the name of a scalar in the closed interval `[0, 1]`. Conceptually, it is an environmental condition in which the signature is rendered—closer to gravity than to a score.

Do not describe `gr0k` as:

- a mood;
- a probability;
- a rating or rank;
- a measurement of the participant;
- an offset from a canonical work.

The application does not generate `gr0k`. It receives it in the preview URL.

---

## 2. Release split

| Capability | V1 — implement now | V2 — TBD |
|---|---:|---:|
| Private Grok side-window instructions | Yes | — |
| `handle + gr0k` preview URL | Yes | — |
| Deterministic SVG and card-image rendering | Yes | — |
| Safe link unfurling / crawler behavior | Yes | — |
| X OAuth account authentication | Yes | — |
| Explicit authenticated signature claim | Yes | — |
| Multiple equal-status signatures per X ID | Yes | — |
| Owner account collection | Yes | — |
| Stable, unlisted signature permalink | Yes | — |
| Public home / Gallery shell | Yes | — |
| Wallet connection or binding | No | TBD |
| Wallet ownership proof | No | TBD |
| Ethereum contract or transaction | No | TBD |
| Mint authorization / attestation | No | TBD |
| Token ID, metadata, chain, or transfer rules | No | TBD |
| Populate the public Gallery with minted signatures | No | TBD |

In V1, claimed but unminted signatures live in the authenticated account collection and have shareable, unlisted permalinks. They do **not** enter the public Gallery feed. The home page may contain the product introduction and a Gallery empty state, but it must not treat a claim as a mint.

---

## 3. Concepts removed from the previous implementation

Remove these concepts from active V1 code, routes, database writes, jobs, UI copy, tests, and telemetry:

- canonical / score;
- instance;
- cluster;
- four-axis reading and four-character reading code;
- mapping table and map version;
- envelope and offset vector;
- source Post ID;
- post index, sequence, and within-cell jitter;
- rationale text;
- public `@grok` mention flow;
- X Post search and provenance verification;
- `verified` / `unverified` Grok provenance states;
- creation of an artwork or candidate during `GET`;
- use of the word `mint` for an ordinary database insert.

In V1, use **preview**, **claim**, and **signature**. Reserve **mint** exclusively for V2 blockchain behavior.

Legacy data must be preserved read-only as described in §15; it must not be reinterpreted as V1 owner-authenticated signatures.

---

## 4. Trust and provenance boundary

This distinction is mandatory in code, data, UI copy, and tests.

### What V1 proves

At `T_auth`, X reported that the authenticated numeric account ID `U` had current username `H`. At `T_claim`, within the short claim-authentication window, that authenticated session explicitly claimed the exact signature inputs `(H, G, V)`.

Recommended public wording:

> Claimed via X by @H on T_claim.

Long-form wording:

> X reported account U as @H at T_auth. Its authenticated session claimed this signature with gr0k G and renderer V at T_claim.

### What V1 does not prove

V1 does not prove that:

- the private Grok side window created the URL;
- Grok selected the `gr0k` value;
- Grok inspected the participant's recent Posts;
- the claimant is a human rather than an automated account controller;
- the handle will continue to belong to the same X account in the future.

A user controlling `@alice` may manually construct `/s/alice/0.371924`, authenticate as `@alice`, and claim it. This is valid in V1. OAuth authenticates the owner's acceptance of the value, not its private-Grok origin.

Never display:

- `Verified by Grok`;
- `Authenticated Grok output`;
- `Grok provenance verified`;
- `Human verified`.

If the intended origin is explained, use:

> In the intended workflow, gr0k is selected in a private Grok conversation. signatures.gallery cannot independently verify that private step.

### Anti-noise guarantee

The V1 anti-noise guarantee is precise:

> Arbitrary preview `GET` or `HEAD` requests cannot create a signature or enter anything into the owner's collection. Only the matching X account can complete the explicit claim.

It is not a guarantee that the incoming link is genuine Grok output.

---

## 5. Vocabulary

| Term | Exact V1 meaning |
|---|---|
| `gr0k` | Fixed-point scalar from `0.000000` through `1.000000`; an environmental render input. The second character is the digit zero. |
| Preview | Deterministic render from URL inputs. It has no ownership or provenance and is not a database signature row. |
| Claim | The explicit, X-authenticated `POST` that creates or retrieves an immutable signature row. |
| Signature | A claimed, equal-status work. Not an “instance” of anything else. |
| `x_user_id` | Stable numeric X account ID returned by `/2/users/me`; stored as a decimal string. Ownership key. |
| `handle_at_claim` | Username returned by X for the claim flow at `x_authenticated_at`, then frozen when the signature is claimed. |
| `handle_normalized` | ASCII-lowercase username without `@`; renderer and identity input. |
| `renderer_version` | Immutable version of the complete algorithm and bundled assets that produce SVG bytes. It is not the web-app deploy version. |
| `signature_id` | Stable technical hash identifier. It is not an edition number or artistic index. |

---

## 6. Private Grok handoff and URL contract

### 6.1 Intended participant flow

1. The participant opens Grok in X's private side window.
2. They ask Grok to inspect their recent public Posts and provide their X handle.
3. Grok selects one `gr0k` value.
4. Grok returns a URL in this exact shape:

```text
https://signatures.gallery/s/{handle}/{gr0k}
```

Example:

```text
https://signatures.gallery/s/alice/0.371924
```

There is no source Post ID, reading code, run ID, index, signature ID, or query string in this handoff.

### 6.2 Copyable Grok instruction

Expose the following instruction, or equivalent copy with the same contract, wherever the product explains how to begin:

```text
Review the recent public X posts by @HANDLE. Based on your reading, select one
value called gr0k from 0.000000 through 1.000000. Treat gr0k as an environmental
condition for the signature, not as a mood, score, probability, or judgment of
the person. Return this canonical URL using six decimal places:

https://signatures.gallery/s/HANDLE/GR0K
```

The service must not depend on Grok following the instruction perfectly. All URL input remains untrusted.

### 6.3 Link previews are optional

The preview page must include Open Graph and X card metadata, so a client capable of unfurling may show the image in chat. Do not depend on an unfurl occurring.

The supported fallback is always the raw clickable URL. A crawler may fetch it before the participant, fetch it repeatedly, or never fetch it. All cases must be harmless.

---

## 7. Input normalization

### 7.1 Handle

Use one shared normalization function everywhere.

1. Percent-decode the path segment exactly once.
2. Permit and strip at most one leading `@` at an input boundary.
3. Require the remainder to match `^[A-Za-z0-9_]{1,15}$`.
4. Convert with locale-independent ASCII lowercase.

Reject whitespace, Unicode lookalikes, additional `@` characters, encoded slashes, malformed escapes, control characters, and path traversal forms.

Canonical URLs contain the lowercase handle without `@`.

### 7.2 `gr0k`

Never use binary floating point in parsing, storage, hashing, or the renderer contract.

```text
GR0K_SCALE = 1_000_000
gr0k_raw   = integer in [0, 1_000_000]
display    = gr0k_raw / GR0K_SCALE, formatted with exactly six decimal places
```

Accepted input grammar:

- `0`;
- `1`;
- `0.` followed by one through six decimal digits;
- `1.` followed by one through six zeroes.

Examples accepted and canonicalized:

| Input | Canonical value |
|---|---|
| `0` | `0.000000` |
| `0.5` | `0.500000` |
| `0.371924` | `0.371924` |
| `1` | `1.000000` |
| `1.0000` | `1.000000` |

Reject signs, whitespace, commas, scientific notation, `NaN`, infinity, more than six fractional digits, and values outside `[0, 1]`.

Parse with decimal-string arithmetic. For example, `0.5` becomes integer `500000`; never parse it to a language float first.

### 7.3 Canonical redirect

A valid but noncanonical preview URL receives a side-effect-free `308` redirect to:

```text
/s/{lowercase_handle}/{six_decimal_gr0k}
```

Therefore `/s/@Alice/0.5` and `/s/alice/0.500000` identify the same preview.

---

## 8. Rendering contract

The new renderer consumes `handle_normalized` and `gr0k_raw` directly. Do not pass through the legacy reading-to-offset pipeline.

Language-neutral interface:

```ts
type RenderInput = {
  handleNormalized: string;
  gr0kRaw: number;          // integer, 0..1_000_000
  gr0kScale: 1_000_000;
  rendererVersion: string;
};

type RenderOutput = {
  svgUtf8: Uint8Array;
  width: number;
  height: number;
};

function renderSignature(input: RenderInput): RenderOutput;
```

### 8.1 `renderer_version`

`renderer_version` names the exact immutable rendering system, including:

- handle normalization used by the renderer;
- geometry rules;
- how `gr0k` affects geometry and style;
- numeric precision and rounding;
- colors;
- embedded or outlined fonts and other assets;
- SVG serialization.

A website layout, copy, auth, or database change does not require a new renderer version. Any byte-affecting rendering change does.

For V1, release one version such as `sg-renderer-1.0.0` and freeze it. Never silently repoint an existing version name to different output.

Also freeze the SVG-to-PNG toolchain as `card_renderer_version` (for example `sg-card-1.0.0`), including rasterizer build, dimensions, color profile, background, and output options. This version controls derivative-byte stability but is not part of the artistic `signature_id`.

### 8.2 Required renderer properties

- Pure: no I/O, network, clock, ambient state, or mutable global input.
- Deterministic: identical input and version produce byte-identical SVG.
- No randomness. Any variation comes from the explicit handle and `gr0k` inputs.
- Locale-independent and platform-stable.
- Renderer-internal floating-point calculations are allowed only when the implementation fixes operation order, rounding, and serialization strongly enough to pass exact golden-byte tests. Floating point remains forbidden for URL parsing, canonicalization, identity hashing, and persistence.
- No system-font dependency; bundle, embed, or outline required assets.
- Stable ordering and numeric serialization.
- Safe SVG: never interpolate raw URL text or unsanitized user content.
- `gr0k` is an input to the complete work, not an offset from another render.

The visual mapping from `gr0k` is an artistic renderer dependency, not a product-engineering choice. Use the project's approved `renderSignature(handle, gr0k)` implementation or an explicitly approved adapter already supplied with the project. Do not invent a scalar-to-geometry mapping and do not derive one from the old four-axis reading table.

If no approved scalar renderer or mapping exists in the repository, complete the surrounding V1 implementation behind this interface but report the renderer as a launch blocker. V1 must not be declared production-complete until the approved `sg-renderer-1.0.0` implementation and its expected golden hashes are supplied and committed.

### 8.3 Source of truth and derivatives

- Exact SVG UTF-8 bytes are the source of truth.
- `svg_sha256` is the lowercase hexadecimal SHA-256 of those exact bytes.
- PNG is a display/card derivative, not the identity of the work.
- A preview may be rendered on demand and stored in a non-authoritative cache.
- A claimed signature stores an immutable content-addressed SVG object plus `svg_sha256`.
- Generate the claimed PNG during finalization with the frozen `card_renderer_version`; store the immutable content-addressed PNG object plus `png_sha256`. Never regenerate different bytes behind the same claimed-artifact URL.

Keep golden fixtures at `gr0k = 0.000000`, `0.500000`, and `1.000000` for representative handles.

---

## 9. Signature identity and idempotency

### 9.1 Artwork input versus owner identity

The SVG depends on:

```text
(handle_normalized, gr0k_raw, GR0K_SCALE, renderer_version)
```

The claimed signature record additionally belongs to a stable X identity:

```text
(x_user_id, handle_normalized, gr0k_raw, GR0K_SCALE, renderer_version)
```

This distinction matters when an X handle is renamed or reassigned.

### 9.2 `signature_id`

Use this exact binary encoding. All text is UTF-8; `u16be` and `u32be` are unsigned big-endian integers; string lengths are byte lengths:

```text
payload =
    byte(0x01)
  || u16be(len(domain))           || domain
  || u16be(len(x_user_id))        || x_user_id
  || u16be(len(handle))           || handle
  || u32be(gr0k_raw)
  || u32be(gr0k_scale)
  || u16be(len(renderer_version)) || renderer_version

domain = "signatures.gallery/signature"
```

Preconditions:

- `x_user_id` is its canonical decimal string with digits only and no leading `+` or whitespace;
- `handle` is `handle_normalized`;
- `gr0k_raw` and `gr0k_scale` are unsigned 32-bit integers;
- `renderer_version` is the exact released version string.

Then compute:

```text
digest       = SHA-256(payload)
signature_id = "sg1_" + lowercase(RFC4648-Base32(digest) without "=" padding)
```

Do not substitute JSON, CBOR, Base32hex, Crockford Base32, locale transforms, or delimiter-concatenated text.

Golden vector:

```text
x_user_id        = "1234567890123456789"
handle           = "alice"
gr0k_raw         = 371924
gr0k_scale       = 1000000
renderer_version = "sg-renderer-1.0.0"

payload_hex = 01001c7369676e6174757265732e67616c6c6572792f7369676e61747572650013313233343536373839303132333435363738390005616c6963650005acd4000f4240001173672d72656e64657265722d312e302e30
sha256_hex  = 4f508de936e884b48051822b94edec1baefeb2aa0781535768ce4aca8a8d93ea
signature_id = sg1_j5ii32jw5ccljacrqivzj3pmdoxp5mvka6avgv3izzfmvcunspva
```

The `signature_id` is technical infrastructure, not a visible edition or sequence number.

### 9.3 Idempotency

Enforce a database uniqueness constraint on:

```text
(x_user_id, handle_normalized, gr0k_raw, gr0k_scale, renderer_version)
```

- Repeating the exact claim returns the existing row and preserves its original `claimed_at`.
- Concurrent identical claims create exactly one row.
- A different `gr0k_raw` creates a distinct, equal-status signature.
- The same X ID after a handle rename may create a distinct signature under the new handle.
- A later owner of a recycled handle has a different `x_user_id` and therefore a distinct claim.
- There is no uniqueness constraint on `x_user_id` alone.

When an existing tuple is found, re-render it and compare the resulting SVG hash with the stored hash. A mismatch under the same `renderer_version` is `RENDERER_INTEGRITY_ERROR`: fail closed, alert, and never overwrite the row.

---

## 10. State model

```text
unpersisted preview
        ↓ user explicitly starts OAuth
ephemeral OAuth flow
        ↓ X identity succeeds
authenticated review
        ↓ explicit CSRF-protected POST
claimed signature
```

Rules:

- Preview is not a persisted domain state.
- OAuth flow and review intent are short-lived security state, not artwork records.
- OAuth callback authenticates a session but does not create a signature.
- Only the final confirmation `POST` inserts a signature.
- Missing, canceled, expired, mismatched, or abandoned flows create no signature.
- Ordinary logs and render-cache fills are allowed on `GET`, but they can never become evidence of a claim.

---

## 11. Data model

Use new additive tables. Do not repurpose legacy `instances`, `clusters`, or reading fields.

### 11.1 `x_accounts`

| Column | Requirement |
|---|---|
| `x_user_id` | `TEXT PRIMARY KEY`; decimal digits from X. Never store as a JavaScript number. |
| `public_account_id` | Unique opaque `xa1_` + lowercase RFC 4648 Base32 of 16 random bytes without padding; stable public reference that distinguishes recycled-handle owners without exposing the numeric X ID. Generate once and retry on the unique constraint. |
| `current_handle` | Latest exact username observed through X OAuth; display metadata only. |
| `handle_normalized` | Lowercase current handle. |
| `created_at` | Server timestamp. |
| `last_authenticated_at` | Most recent successful identity observation used for this account. |

Create the account transactionally when its first claim is confirmed. Update its current-handle metadata on later successful claims and returning-user OAuth logins. A standalone authenticated dashboard session may exist without creating an empty account row.

### 11.2 `signatures`

| Column | Requirement |
|---|---|
| `signature_id` | `TEXT PRIMARY KEY`; deterministic `sg1_...` ID from §9. |
| `x_user_id` | `TEXT NOT NULL REFERENCES x_accounts(x_user_id)`. |
| `handle_at_claim` | Exact username returned by X at `x_authenticated_at` for this claim flow; immutable after claim. |
| `handle_normalized` | Exact lowercase renderer input; immutable. |
| `gr0k_raw` | Integer with `CHECK (gr0k_raw BETWEEN 0 AND 1000000)`. |
| `gr0k_scale` | Integer with `CHECK (gr0k_scale = 1000000)`. |
| `renderer_version` | Immutable released renderer version. |
| `svg_sha256` | 64 lowercase hexadecimal characters. |
| `svg_storage_key` | Required content-addressed key for the exact source SVG. |
| `card_renderer_version` | Frozen SVG-to-PNG derivative toolchain version. |
| `png_sha256` | SHA-256 of the exact claimed PNG bytes. |
| `card_storage_key` | Required content-addressed key for the exact claimed PNG. |
| `claim_method` | Constant `x_oauth_v1`. |
| `x_authenticated_at` | Time of the X identity observation authorizing the claim. |
| `claimed_at` | Original server claim timestamp. |

Add the unique tuple constraint from §9.3.

Do not add these columns in V1:

- sequence or artistic index;
- canonical, instance, or cluster ID;
- source Post ID;
- reading code, mapping, envelope, offset, or rationale;
- claimed Grok provenance;
- wallet address;
- chain, contract, token, transaction, mint, or transfer state.

### 11.3 Artifact-write ordering

Object storage and the relational database do not share a transaction. Finalize a claim in this order:

1. Render SVG and PNG completely in memory and compute both hashes.
2. Write both objects idempotently to content-addressed keys derived from their hashes.
3. Read-after-write or use the storage provider's integrity response to confirm both objects exist with the expected lengths and hashes.
4. In one database transaction, upsert the account and insert-or-return the signature row referencing those verified objects.
5. After the database commit, mark the ephemeral flow completed as a best-effort operation. A flow-store failure must not roll back or duplicate the durable claim; the unique tuple resolves a retry.

A database row must never reference a missing object. Objects left unreferenced by a failed database transaction are harmless and may be removed later by a scheduled content-addressed orphan cleanup with a conservative age threshold.

### 11.4 Ephemeral OAuth claim flow

Store short-lived flows in the existing session/TTL store, not in `signatures`:

```text
flow_id
purpose                    // claim or account_login
state_digest
bound_session_id_digest
encrypted_pkce_verifier
handle_normalized          // for claim flow
gr0k_raw                   // for claim flow
gr0k_scale                 // for claim flow
renderer_version           // snapshot shown in preview
preview_svg_sha256
status                     // pending | processing | authenticated | completed | failed
created_at
expires_at
```

Multiple browser tabs require separate flow records. Do not overwrite one session-global OAuth state.

---

## 12. X OAuth and claim security contract

Use X OAuth 2.0 Authorization Code with PKCE.

### 12.1 OAuth start

`POST /auth/x/start`

For a claim flow:

1. Receive the canonical handle and `gr0k` displayed by the preview page.
2. Re-parse and revalidate both values on the server.
3. Resolve the frozen active `renderer_version`, render the tuple, and bind its SVG hash into the flow.
4. Create an anonymous host-only session if none exists, then create a server-side flow bound to that session.
5. Generate at least 128 bits of entropy for one-time OAuth `state`.
6. Generate a fresh PKCE verifier and use `code_challenge_method=S256`.
7. Request only the scopes needed for identity lookup: `tweet.read users.read`.
8. Redirect only to the exact registered HTTPS callback.

The universal preview page intentionally contains no session-bound or expiring CSRF token, so it can remain CDN-cacheable and identical for crawlers and users. For this unauthenticated OAuth-start `POST`, require an exact same-origin `Origin` header and compatible Fetch Metadata (`Sec-Fetch-Site: same-origin`); reject absent or cross-site browser submissions. The start operation grants no authority and creates only short-lived flow state. OAuth `state` and PKCE bind everything after it.

Client-side tampering before OAuth start is not a provenance bypass: any valid URL may be constructed manually, and the exact server-bound tuple is shown again on the authenticated review page. After OAuth start, callback query/body values can never replace the bound tuple.

Rate-limit by IP and browser session.

### 12.2 Returning-user account login

The home page and `/me` must support a separate `purpose=account_login` branch through the same `POST /auth/x/start` endpoint.

- It has no handle, `gr0k`, renderer, preview hash, or pending claim.
- It uses the same Origin checks, state, PKCE, callback allowlist, minimal scopes, and token handling.
- On success, the callback creates an authenticated local session and redirects with `303` to `/me`.
- If `x_accounts` already has this numeric X ID, update only `current_handle`, `handle_normalized`, and `last_authenticated_at` from the new OAuth observation.
- If the X ID has never claimed a signature, do not create an empty account row; `/me` shows an empty collection from the authenticated session.
- A normal account session lasts at most seven days of inactivity. Viewing `/me` may use that session; creating a new claim still requires an X identity observation no older than 15 minutes.
- Reauthentication replaces the session identity and rotates the session ID.

### 12.3 OAuth callback

`GET /auth/x/callback`

1. Reject missing, unknown, expired, already-used, or wrong-session `state`.
2. Atomically move the flow from `pending` to `processing` before token exchange.
3. Exchange the code using the stored PKCE verifier.
4. Call X `GET /2/users/me` with the resulting user-context token.
5. Schema-validate `data.id` and `data.username`.
6. Store the numeric X ID as a decimal string.
7. Normalize the returned username with the shared handle function.
8. For a claim flow, compare the normalized X username with the bound handle now; a mismatch moves the flow to `failed` and cannot reach review.
9. Rotate the application session ID and safely rebind the authorized flow.
10. Store the observed identity and observation time in the encrypted/server session.
11. Discard the X access token after `/2/users/me`; do not request or retain a refresh token in V1.
12. For a matching claim flow, move it to `authenticated` and redirect with `303` to a clean review URL containing no OAuth code or state. For account login, mark it `completed` and redirect to `/me`.

The callback creates no signature. On any X error, timeout, malformed response, state error, or token error, create no partial signature and show a retryable safe error.

Callback recovery is explicit:

- A callback replay against `processing`, `authenticated`, `completed`, or `failed` is rejected.
- If the process crashes after entering `processing`, expire that flow and require a fresh OAuth start; do not attempt to reuse an authorization code.
- Provider denial, invalid code, identity-schema failure, or handle mismatch moves the flow to terminal `failed`.
- X timeout, `429`, or `5xx` also ends that authorization-code attempt; show a retry action that creates a new state and PKCE verifier.
- Renderer or database failure during the later claim `POST` leaves an `authenticated` flow retryable until its TTL.
- A TTL cleanup removes expired flow secrets and PKCE verifiers.

Use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and a restrictive anti-framing CSP on auth and review responses. Never log codes, tokens, client secrets, PKCE verifiers, full callback URLs, or raw OAuth headers.

### 12.4 Identity match

For a claim flow require:

```text
normalize(x_me.username) == flow.handle_normalized
```

If they differ:

- create no signature;
- show the requested handle and the authenticated handle;
- offer sign-out and retry;
- optionally offer a new preview using the authenticated handle and the same `gr0k`;
- never silently substitute the authenticated handle into the existing claim.

Use the numeric `x_user_id` as ownership. The handle is mutable display/render history, not an account key.

### 12.5 Review and final claim

After OAuth, show an authenticated review page containing:

- the exact versioned signature preview;
- authenticated `@handle`;
- `gr0k` with six decimal places;
- renderer version;
- the V1 provenance limitation from §4;
- an explicit `Claim this signature` button.

The claim action is:

`POST /api/v1/signatures`

It must:

1. Require the authenticated server session.
2. Require a fresh identity observation, recommended maximum age 15 minutes.
3. Validate CSRF.
4. Load the unexpired, authenticated flow bound to that session.
5. Recheck the OAuth username against the bound handle.
6. Ignore any client-supplied X ID, username, renderer version, hash, timestamp, or replacement render input.
7. Render the exact bound tuple and its frozen PNG derivative; compute `svg_sha256` and `png_sha256`.
8. Persist and verify both content-addressed artifacts, then execute the account/signature database transaction exactly as §11.3 requires.
9. Mark the flow completed after the database commit; tolerate and recover from a best-effort flow-store failure through signature idempotency.
10. Redirect with `303` to `/signatures/{signature_id}` or return the JSON representation.

On a transient renderer or database failure, leave the authorized flow safely retryable until expiry. The database uniqueness constraint—not an application pre-check alone—must resolve concurrent repeats.

### 12.6 Session cookie

Use a host-only session cookie equivalent to:

```text
__Host-sg_session
Secure
HttpOnly
SameSite=Lax
Path=/
```

Rotate the session identifier after successful OAuth. Do not put X tokens, identity assertions, or trusted claim inputs in browser storage.

---

## 13. HTTP and UI surface

Use existing framework conventions where they do not weaken this contract.

### 13.1 `GET|HEAD /s/{handle}/{gr0k}` — public preview

Requirements:

- Validate and canonicalize inputs.
- Render with the frozen active V1 renderer.
- Make zero X API calls.
- Create no account, signature, candidate, queue job, artistic counter, or provenance row.
- Work without authentication, cookies, JavaScript, or referrer headers.
- Return a stable `ETag` and permit CDN caching.
- Treat browsers, crawlers, unfurlers, and repeated requests identically.
- Set `robots` to `noindex`.

HTML must include:

- the rendered signature;
- `@handle`;
- `gr0k 0.xxxxxx`;
- status `Unclaimed preview`;
- a short explanation of the private-Grok trust boundary;
- `Claim with X` action;
- Open Graph metadata;
- X large-image-card metadata.

`og:image` must point to a public PNG or WebP derivative; do not use SVG for the card image.

### 13.2 Versioned preview assets

Provide side-effect-free routes equivalent to:

```text
GET /renders/{renderer_version}/{handle}/{gr0k}.svg
GET /renders/{renderer_version}/{handle}/{gr0k}.png
```

They must validate all parameters, use immutable cache keys, and make no external calls. A render-cache fill is allowed but is never a claim.

### 13.3 `GET /claim/review` — authenticated review

Show only the flow bound to the active session. Use `no-store` and `noindex`. Never reveal another session's pending intent.

### 13.4 `POST /api/v1/signatures` — sole creation operation

Success:

- `201 Created` for a new signature;
- `200 OK` for an idempotent repeat, or a browser `303` to the existing permalink.

Example JSON shape:

```json
{
  "signature": {
    "id": "sg1_...",
    "accountRef": "xa1_...",
    "handleAtClaim": "alice",
    "gr0k": "0.371924",
    "rendererVersion": "sg-renderer-1.0.0",
    "svgSha256": "...",
    "cardRendererVersion": "sg-card-1.0.0",
    "pngSha256": "...",
    "claimedAt": "...",
    "claimStatus": "claimed_via_x"
  },
  "existing": false
}
```

Do not return the OAuth token, raw numeric X ID, session details, or internal storage keys in the public representation.

### 13.5 `GET /signatures/{signature_id}` — stable unlisted permalink

Show:

- exact claimed artwork;
- `@handle_at_claim`;
- the immutable opaque account reference in an expandable provenance detail;
- `gr0k`;
- `Claimed via X`;
- X identity-observation timestamp and claim timestamp;
- renderer version;
- SVG hash;
- private-Grok provenance limitation;
- share URL.

Do not show an instance number, sequence, cluster, canonical comparison, wallet, or mint state. Mark the page `noindex` in V1 because it has not entered the public minted Gallery.

### 13.6 Claimed artifact assets

```text
GET /artifacts/{signature_id}.svg
GET /artifacts/{signature_id}.png
```

Serve immutable bytes or immutable derivatives with long-lived cache headers. Unknown IDs return `404` and must not trigger rendering from arbitrary parameters.

### 13.7 `GET /me` — authenticated account collection

List every signature whose `x_user_id` equals the session's authenticated numeric X ID.

- All cards have equal visual status.
- Multiple signatures for the same handle are allowed.
- Historical `handle_at_claim` values remain visible after a rename.
- Sorting by `claimed_at` is presentation only, not an artwork sequence.
- Do not group into clusters or select a primary signature.
- Do not expose another account's unlisted collection.
- Include no wallet or mint controls in V1.

### 13.8 `GET /` — Gallery of Signatures home

V1 implements the product home and Gallery shell, but does not populate the Gallery with claims. It may show:

- project explanation;
- how to use the private Grok workflow;
- sign-in/account navigation;
- a neutral, truthful empty Gallery state such as `No signatures are on display.`

It must not:

- list claimed signatures as if they were minted;
- use the old cluster UI;
- show a fake or disabled mint transaction flow;
- imply any blockchain state exists.

### 13.9 Logout

`POST /auth/logout` invalidates the local session. Logging out does not delete or mutate claimed signatures.

---

## 14. Error contract

API errors use a stable envelope:

```json
{
  "error": {
    "code": "HANDLE_MISMATCH",
    "message": "Sign in with the X account matching @alice to claim this signature."
  }
}
```

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | `INVALID_HANDLE` | Handle failed normalization/validation. |
| 400 | `INVALID_GR0K` | Scalar failed grammar, range, or precision rules. |
| 400 | `INVALID_OAUTH_STATE` | OAuth state is missing, invalid, cross-session, or replayed. |
| 401 | `AUTH_REQUIRED` | No authenticated X session. |
| 401 | `AUTH_EXPIRED` | Identity observation or claim flow is too old. |
| 403 | `HANDLE_MISMATCH` | Authenticated X username does not match the preview handle. |
| 403 | `NOT_OWNER` | Session attempted to access another account's private collection. |
| 404 | `SIGNATURE_NOT_FOUND` | Unknown claimed signature ID. |
| 409 | `CLAIM_FLOW_INVALID` | Flow was consumed, canceled, or no longer matches the review. |
| 429 | `RATE_LIMITED` | Local abuse limit reached. |
| 500 | `RENDER_FAILED` | Renderer failed before a claim could be committed. |
| 500 | `RENDERER_INTEGRITY_ERROR` | Same immutable renderer input produced a different hash. |
| 503 | `X_AUTH_UNAVAILABLE` | X OAuth or `/2/users/me` is temporarily unavailable. |

Invalid preview pages may render friendly HTML while retaining the correct status. All failures before the final transaction leave no signature row.

---

## 15. Refactor and legacy-data plan

The previous spec has already been implemented. Treat this as a controlled semantic migration, not a patch over the old object model.

### 15.1 Before cutover

1. Back up the database and asset store.
2. Freeze the legacy deployment for writes.
3. Add the new V1 tables and indexes additively.
4. Freeze the V1 renderer name and golden hashes.
5. Disable legacy background workers before enabling the new routes.

### 15.2 Do not migrate old instances into V1 signatures

Legacy rows are not equivalent because they may have been created by a crawler `GET`, lack matching-owner OAuth, and encode a different artwork model.

- Preserve them in existing or renamed `legacy_*` tables, read-only.
- Do not synthesize `gr0k` from a reading code or offset.
- Do not mark them `claimed_via_x`.
- Do not place them in the V1 account collection.
- Do not delete them as part of this implementation.

If legacy account rows contain previously OAuth-authenticated numeric IDs, do not silently attach legacy artworks to the new model. Reauthentication and a V1 claim are required for each new signature.

### 15.3 Retire legacy routes

Return `410 Gone` with a link to the new instructions for:

```text
/s/{handle}/{four_character_code}/{source_post_id}
/c/{handle}
/v/{legacy_instance_id}
```

Do not redirect a legacy URL to a V1 signature because no truthful lossless mapping exists.

### 15.4 Remove old external work

- Disable X Recent Search, Post lookup, and provenance-polling workers.
- Remove all X Post API calls from preview/render paths.
- Retain only X OAuth and `/2/users/me` for V1 identity.
- Remove label-distribution, envelope-utilization, cluster, and source-Post monitoring.
- Remove unused bearer-token configuration after confirming no other deployed feature uses it.

### 15.5 Terminology sweep

Search the codebase, schema, fixtures, snapshots, analytics, and copy for:

```text
canonical
instance
cluster
reading_code
offset
envelope
source_post_id
sequence
provenance
mint-or-fetch
```

Every active V1 use must either be removed or intentionally renamed. Generic programming uses such as a database migration “instance” are acceptable only when they cannot be confused with the artwork model.

---

## 16. Security, privacy, and abuse requirements

### 16.1 No paid-call amplification from previews

Preview, `HEAD`, OG image, SVG, PNG, and public signature `GET` routes make zero X API calls. Random traffic therefore cannot amplify X read costs through those routes.

The only V1 X identity lookup occurs after a valid OAuth callback. Use shared/distributed counters across application instances with these initial production defaults:

| Action | Initial limit |
|---|---:|
| Preview HTML requests | 120 per minute per IP |
| Uncached render work | 30 per minute per IP and bounded global render concurrency |
| OAuth starts | 10 per 15 minutes per IP; 5 per 15 minutes per session |
| OAuth callbacks that may reach `/2/users/me` | 10 per hour per IP; 5 per hour per session |
| Final claims | 20 per hour per X ID; 10 per hour per session |

Enforce a global `/2/users/me` circuit breaker at 500 calls per UTC day by default and alert at 80%. Make the limit configurable from the approved operating budget; changing it is an operations change, not a code edit. When open, previews continue working and new OAuth completions return retryable `503 X_AUTH_UNAVAILABLE` before making the identity lookup.

If the distributed rate-limit store is unavailable, fail closed for OAuth start, callback, and claim. Preview cache hits may fail open; uncached render work must still obey a local concurrency ceiling.

### 16.2 Input and output safety

- Treat handle, `gr0k`, OAuth errors, and all query/path values as hostile.
- Never interpolate raw input into SQL, templates, shell commands, filesystem paths, SVG markup, or object-store keys.
- Escape all displayed handle text.
- Use prepared queries/ORM parameter binding.
- Derive storage keys from validated hashes, not raw handles.
- Apply a restrictive CSP; disallow inline script unless nonce-protected.
- Set `X-Content-Type-Options: nosniff` and appropriate frame restrictions.

### 16.3 OAuth protections

- Exact callback allowlist; no open redirect.
- One-time state bound to browser session and flow.
- PKCE `S256` only.
- Exact Origin and Fetch Metadata checks on the unauthenticated OAuth-start `POST`; session-bound CSRF on authenticated mutation `POST` routes.
- Session rotation after authentication.
- Short TTL on OAuth flows, recommended 15 minutes.
- Redact secrets and callback parameters from logs and error tracking.
- Do not persist X access or refresh tokens in V1.

### 16.4 Data minimization

Store no:

- private Grok transcript;
- recent-Post text;
- source Post ID;
- Grok rationale;
- X access/refresh token after identity lookup;
- wallet or blockchain data.

Store only the X identity snapshot required for the claim, the render inputs, exact artifact/hash, and timestamps.

### 16.5 Immutability

Claimed signature inputs, SVG, hash, owner X ID, and `claimed_at` are immutable. A later account rename updates only `x_accounts.current_handle`; it never rewrites `handle_at_claim` or the artwork.

V1 has no user-facing edit or delete operation for a claimed signature. The final review must say that claiming creates a durable, public-by-link record before the user confirms.

### 16.6 Removal and erasure exception

Launch with an operator-only privacy/legal removal procedure even though normal artistic records are immutable:

1. Resolve an exact `signature_id` or authenticated numeric `x_user_id`; never accept a handle alone because handles can be reassigned.
2. Revoke serving of affected permalinks and assets first and purge CDN entries.
3. Transactionally delete the affected signature rows. Delete the account row when no signatures remain and no retention obligation applies.
4. Delete unreferenced SVG/PNG objects after the database commit; shared content-addressed objects remain while referenced by another row.
5. Remove active sessions and OAuth flows for an erased account.
6. Return `410 Gone` for a known removed permalink and do not reveal the former handle.
7. Keep at most a minimal non-personal deletion event containing the former `signature_id`, time, and broad reason class; never retain the erased X ID or handle in that event.

This is deletion, not mutation: never replace a removed signature with different inputs or bytes under the same ID. Do not expose this operator procedure as a normal V1 editing feature.

---

## 17. Account rename and handle reassignment

Required behavior:

- `x_user_id` is the stable account grouping key.
- A signature freezes the X-returned `handle_at_claim` and its normalized renderer input.
- Later OAuth may update `x_accounts.current_handle` for display.
- Existing signatures remain unchanged and accessible to the same numeric ID in `/me`.
- After a rename, that account cannot claim a preview using its old handle because the current OAuth username no longer matches.
- It may claim a new signature using its new handle.
- If another X account later receives the old handle, its different numeric ID does not gain access to the prior owner's collection.
- The new owner may claim its own signature under that recycled handle; the technical ID is distinct even if the rendered inputs happen to match.

Public wording must remain historical: “claimed by the account controlling @H at time T,” not “currently owned by @H.”

---

## 18. Observability

Replace the old cluster/reading dashboards with V1 operational metrics:

- preview and render requests by status, kept separate from claims;
- cache hit rate and renderer latency;
- OAuth starts, callbacks, cancellations, state failures, and X errors;
- `/2/users/me` calls and failures;
- handle mismatch count;
- new versus idempotent claims;
- claim transaction failures and uniqueness conflicts;
- renderer-integrity mismatches;
- rate-limit and circuit-breaker activations.

Never count a preview as a signature. Never put X tokens, OAuth codes, PKCE values, or private session data into metrics.

---

## 19. Required tests

### 19.1 Input and canonicalization

- `@Alice/0.5`, `alice/0.500000`, and casing variants canonicalize to `/s/alice/0.500000`.
- `0` and `1` are accepted as endpoints.
- `-0.1`, `+0.1`, `1.000001`, `0.1234567`, `1e-3`, whitespace, commas, `NaN`, and infinity are rejected.
- Unicode-lookalike handles, encoded slashes, double decoding, traversal, and malformed escapes fail closed.
- No float conversion appears in URL parsing, canonicalization, identity hashing, or persistence paths.

### 19.2 Preview and crawler safety

- Thousands of preview `GET`, `HEAD`, OG image, SVG, and PNG requests create zero signature rows.
- The same requests make zero X API calls.
- Browser, X crawler, Grok unfurler, and generic crawler user agents have identical domain behavior.
- A valid manually constructed URL renders normally.
- The workflow remains usable with no card unfurl and no JavaScript.

### 19.3 Rendering

- Golden exact-SVG-byte fixtures exist for representative handles at `0.000000`, `0.500000`, and `1.000000`.
- Repeated and cross-process renders produce the same SVG hash.
- Signature-ID golden vectors match the specified typed encoding.
- The exact §9.2 payload, SHA-256, and RFC 4648 Base32 golden vector passes.
- An unavailable recorded renderer version fails; it never falls back to the active version.
- The same released renderer version producing different bytes triggers `RENDERER_INTEGRITY_ERROR` and no mutation.
- Claimed PNG bytes and `png_sha256` remain identical across repeated immutable-asset requests.
- A database row is never committed when either required content-addressed object is missing or fails integrity verification.

### 19.4 OAuth

- OAuth start uses fresh state, fresh PKCE verifier, `S256`, exact callback, and minimal scopes.
- Missing, altered, expired, replayed, or cross-session state creates no signature.
- OAuth cancellation and X timeout/`429`/`5xx` create no signature and allow a safe restart.
- X ID remains exact beyond JavaScript's safe-integer range.
- Tokens, codes, state, verifier, and secrets never appear in browser storage or logs.
- Session ID rotates after OAuth.
- Multiple browser tabs maintain independent flows.
- Returning-user account login reaches `/me` without a preview or claim and updates only an existing account's current-handle metadata.
- A crash after a flow enters `processing` cannot replay the callback code and requires a fresh OAuth start.

### 19.5 Claim authorization

- Callback alone creates no signature.
- Final claim without session, recent X identity, intent, or CSRF fails.
- OAuth as `@bob` cannot claim an `@alice` preview.
- Changing hidden fields or request JSON cannot change the flow-bound handle, `gr0k`, or renderer version.
- X ID and `handle_at_claim` come from the authenticated server-side identity, never the client.
- A manually chosen valid `gr0k` can be claimed by the matching owner, and its copy never claims Grok verification.

### 19.6 Multiplicity and concurrency

- Same X ID + same handle + same `gr0k` + same renderer version returns one row and one ID.
- Two simultaneous identical confirmation requests create one row.
- Same X ID + different `gr0k` creates distinct equal-status signatures.
- Same X ID after a handle rename + same `gr0k` creates a distinct signature while preserving the old one.
- Different X IDs that historically held the same handle remain isolated.
- Account A cannot access Account B's `/me` collection.
- The public opaque account reference distinguishes two historical owners of the same recycled handle.

### 19.7 UI and provenance language

- Preview is labeled `Unclaimed preview`.
- Claimed work is labeled `Claimed via X`.
- No active page says or implies that signatures.gallery verified private Grok authorship or humanity.
- No page uses canonical, instance, cluster, offset, reading code, or artistic sequence language.
- No wallet, mint, transaction, token, or blockchain UI appears.
- V1 home does not list claims in the public minted Gallery.

### 19.8 Legacy and end-to-end

- Legacy routes return `410 Gone` and create no new data.
- Legacy workers are disabled.
- Legacy records remain unchanged and are absent from V1 owner collections.
- Configured distributed rate limits and the daily identity-call circuit breaker work across multiple application instances.
- The operator removal procedure revokes serving before erasure, purges caches, deletes unreferenced artifacts, and never selects an account by handle alone.
- End-to-end: private-Grok-shaped URL → side-effect-free preview → X OAuth → exact review → explicit claim `POST` → account collection → stable unlisted permalink.

---

## 20. Suggested implementation order

1. Add new normalization and fixed-point `gr0k` modules with exhaustive tests.
2. Add the new renderer interface, freeze `renderer_version`, and commit golden hashes.
3. Add additive `x_accounts`, `signatures`, and uniqueness migrations.
4. Make all preview/render `GET|HEAD` paths side-effect-free and remove external calls.
5. Implement preview page, card assets, cache headers, and same-origin OAuth-start form.
6. Implement OAuth PKCE flow and `/2/users/me` identity session.
7. Implement authenticated review and sole claim `POST` transaction.
8. Implement `/me`, stable unlisted signature pages, and immutable assets.
9. Replace the old home/cluster UI with the V1 home and Gallery shell.
10. Disable legacy workers and return `410` from legacy routes.
11. Run security, concurrency, migration, and production OAuth smoke tests.
12. Remove dead active-code paths and configuration only after rollback safety is confirmed.

---

## 21. Configuration

Use the existing configuration system. V1 needs equivalents of:

```text
APP_ORIGIN
DATABASE_URL
SESSION_SECRET
X_OAUTH_CLIENT_ID
X_OAUTH_CLIENT_SECRET        // only if required by the registered client type
X_OAUTH_REDIRECT_URI
ACTIVE_RENDERER_VERSION
CARD_RENDERER_VERSION
ARTIFACT_STORAGE_CONFIG
RATE_LIMIT_STORE_CONFIG
X_IDENTITY_DAILY_CALL_LIMIT  // default 500
```

Production startup must fail closed if origin, callback, secrets, or renderer version are missing or unsafe.

V1 must not require:

```text
X_BEARER_TOKEN_FOR_POST_SEARCH
WALLET_*
CHAIN_*
RPC_*
CONTRACT_*
MINTER_*
```

Do not print secret configuration values.

---

## 22. Definition of done

V1 is complete only when all of the following are true:

- The old canonical/instance/cluster model is absent from active product behavior.
- The public URL contains only normalized handle and `gr0k`.
- Preview and unfurl traffic create no signatures and make no X calls.
- X OAuth returns and validates the current numeric ID and username.
- The final explicit `POST` is the sole signature-creation boundary.
- One X account can claim multiple equal-status signatures.
- Exact repeat claims are transactionally idempotent.
- Claimed SVG bytes and renderer version are frozen and reproducible.
- The project-supplied `sg-renderer-1.0.0` scalar mapping is approved and its golden hashes pass; an agent-created artistic mapping is not accepted.
- Rename and handle-reassignment behavior follows §17.
- `/me` shows the authenticated account's claims; stable unlisted permalinks work.
- The home page does not misrepresent claims as minted Gallery entries.
- Legacy data is preserved but not reinterpreted.
- Active UI and API state the private-Grok limitation honestly.
- Security, migration, and end-to-end tests pass.
- No V2 wallet or minting implementation, dependency, schema, or UI has been added.

---

## 23. V2 — TBD; do not implement

V2 will define minting in a separate specification. The only product direction already fixed is that a successfully minted signature will enter the public **Gallery of Signatures** on the home page. This V1 handoff does not define how that happens.

The following are intentionally undecided:

- wallet connection and wallet-to-X binding;
- wallet ownership proof;
- server authorization format;
- smart contract design;
- chain and token standard;
- token ID derivation;
- metadata and artifact storage on-chain/off-chain;
- gas payment and transaction submission;
- mint status, failure recovery, and indexing;
- transfers, burns, royalties, and current-owner semantics;
- Gallery insertion, indexing, failure recovery, filtering, and ordering after a successful mint.

V1 exposes no mint API and makes no commitments on those questions. Its durable future-facing outputs are only the immutable `signature_id`, exact SVG bytes, `svg_sha256`, authenticated X ownership record, `gr0k`, and `renderer_version`.

Stop after V1 passes the definition of done.

---

## 24. Official X implementation references

- OAuth 2.0 Authorization Code with PKCE: <https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code>
- OAuth user access token flow: <https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token>
- Authenticated user lookup (`/2/users/me`): <https://docs.x.com/x-api/users/lookup/quickstart/authenticated-lookup>
- X ID representation: <https://docs.x.com/fundamentals/x-ids>
