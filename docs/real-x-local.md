# Real X sign-in + local PostgreSQL and Anvil

Real X authenticates the account; claims/artifacts stay local and minting stays on owned Anvil 31337. No tunnel, public deployment, Sepolia, or mainnet is needed.

## Configure once

1. In the [X Developer Console](https://developer.x.com/), use a **separate development app**. Enable **OAuth 2.0**, app type **Web App** (confidential client).
2. Register this callback exactly: `http://127.0.0.1:3000/auth/x/callback`. X documents `127.0.0.1` for local development, not `localhost`. Scheme, host, port, path and trailing slash must match. If the console requires a Website URL, use the project's real public website; that field is not the callback.
3. Create `.env.local` from `.env.local.example` if needed. Fill `X_OAUTH_CLIENT_ID` and `X_OAUTH_CLIENT_SECRET` using the **OAuth 2.0 Client ID and Client Secret**, not API keys or an app-only bearer token. Keep the file private and git-ignored; do not paste credentials into chat. Shell environment variables take precedence over the file.
4. Run `npm run local:auth:check`. This checks configuration only, without contacting X or the database/chain. It never prints credential values. Present credentials do not prove valid credentials or API entitlement.

## Run

```bash
# If the local infrastructure is stopped, preserve and resume its state:
npm run local:up
# Start after stopping any other foreground app on port 3000:
npm run local:serve:x
```

Do not run `local:up` over an active durable app writer. Do not reset the local database/chain to change authentication modes.

Open <http://127.0.0.1:3000>. Hover the collection dot → **Sign in with X**. You leave the app for consent on **x.com**, then return to `/me`. The callback is opened by your browser, so it can reach your loopback server. The local backend exchanges the code and reads the identity over HTTPS.

For a fresh claim, open `/s/YOUR_HANDLE/37` using your actual X handle (this sample gr0k is not a verified Grok reading). Choose **Claim with X** and authenticate with that matching account. This click authorizes the permanent public claim. X returns you directly to the permanent signature page with a **Claimed** tag and a brief success toast; there is no second confirmation. Use the top four-square icon for the gallery or the collection dot for My Collection; there are no duplicate destination buttons below the artwork. A failed save offers **Retry claim** without another OAuth round trip. Ordinary account sign-in and previews create no claim. Private flow URLs are session-bound and never publicly cached; share the permanent signature link, not a flow URL.

Choose **Mint this signature** → prove a dedicated test wallet, or use **Use local TEST wallet** inside DEV → review the exact work → explicitly authorize minting. Test-wallet keys are public; never send real funds. Real X does not make the Anvil token or unpublished IPFS metadata a production asset.

## Provider modes

| Command | X provider |
| --- | --- |
| `npm run local:serve:x` | Real X; missing or invalid configuration stops startup. No simulator fallback. |
| `npm run local:serve:emulator` | Local simulator, even with real credentials present. |
| `npm run local:serve` | `LOCAL_X_AUTH_MODE`, default `emulator`. Credentials alone never select real X. |

Restart the foreground app to change providers. Sessions/flows are deliberately in memory, so sign in again after a restart; completed claims, artifacts, wallet proofs and chain history remain durable. Existing seeded/emulated records remain local fixtures: changing providers does not upgrade their identity evidence. The current provider and test tools appear only inside the floating DEV overlay.

`npm run local:test -- --execute-local-test-transactions` is an **emulator-mode** test. It must not try to automate real X consent. Its `--verify SIGNATURE_ID` mode remains a read-only chain/projection check usable in either provider mode.

## Security and limits

### Why X asks to read posts and accounts

The gallery needs only the signed-in account's stable ID and handle. However,
[X's endpoint permission mapping](https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping)
requires **both `users.read` and `tweet.read`** for `GET /2/users/me`. The consent
screen describes the full capabilities of those scopes, including protected
posts/accounts the user can access; it does not describe what the gallery
actually fetches. These are the documented minimum scopes for this OAuth 2.0
identity flow, not identity-only permissions. Removing `tweet.read` would depart
from X's documented requirements; changing the app's description cannot narrow
the grant.

The client fixes this exact scope pair (no configurable scope override), calls
only `/2/users/me` after token exchange, and retains only `id` and `username`
from the identity response. It never uses the sign-in token to read posts or
other accounts. It requests no write, DM, email, follow, like, bookmark or
`offline.access` permission. Access tokens are used transiently in the callback,
not saved for later API calls; extra response fields and refresh tokens are not
retained. Not retaining a token is not the same as revoking the X grant.

If OAuth 1.0a is enabled separately in the console, leave its permission level
at **Read** and email collection off. Those settings do not replace the OAuth
2.0 scope request used by this app. Regression tests pin the exact scope pair,
reject widening through legacy configuration, and check the identity-only
request sequence and retained fields.

### Other safeguards

- PKCE S256, single-use browser-bound state and session rotation remain required. The same-origin combined CTA binds explicit claim consent to the exact handle, gr0k, renderer version and preview digest. The callback commits only after matching-account authentication; failed saves require a CSRF-protected retry. Ordinary account sign-in never claims. Cached legacy forms without the versioned combined consent still require a final confirmation.
- Only `users.read tweet.read` are requested for identity lookup. No write permission or `offline.access`; access tokens are used transiently on the server, not stored in sessions, database records, NFT metadata or the browser.
- Real mode disables simulator consent endpoints. Provider errors never become a simulated login.
- Token/identity requests have abortable timeouts, reject redirects, and do not include provider response bodies in error messages. The default local daily identity-call cap is 100.
- X's server-side requests honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (lowercase variants take precedence). An HTTP(S) `ALL_PROXY` is supported as a fallback. The dispatcher is scoped to the X client: Anvil and other local requests keep their existing direct routing. TLS verification remains enabled; SOCKS-only proxy URLs are not supported.
- Authentication failures log only the failed step, a fixed failure category, and an HTTP status when available. Credentials, authorization codes, tokens, identities, callback URLs and provider response bodies are never included in those diagnostics.
- Local navigation is pinned to `127.0.0.1` before sign-in, avoiding split cookies. HTTP session cookies are HttpOnly and SameSite=Lax. Local startup refuses production mode; these are not production session adapters.
- Anvil ownership, chain ID, deployment/code evidence, durable writer lock, wallet proof and mint confirmation remain required regardless of the X provider.

## Troubleshooting

- **Configuration fails:** fix the named keys in `.env.local`. Check for shell values overriding the file. An alternate `LOCAL_APP_PORT` requires matching `APP_ORIGIN` and callback, also registered at X. Do not change ports during an unfinished mint: frozen metadata keeps the original artifact origin.
- **X refuses the app/callback:** check OAuth 2.0, Web App, exact allowlist entry, and the ID/secret from the same development app.
- **Consent works but login fails:** check the app's X API permissions/access/billing or credits. Live API access is an external prerequisite and may require paid access; this build cannot supply it.
- **Browser consent works but the callback times out:** browser networking can differ from Node's server-side networking. Node 22.16 does not apply proxy environment variables to built-in `fetch` automatically; the X client supplies its own scoped dispatcher. Check that the configured HTTP(S) proxy is running and `NO_PROXY` does not accidentally bypass it for `api.x.com`. A `token_exchange` timeout is a connectivity failure, not evidence of an invalid Client Secret. Restart sign-in from `/me` after fixing it; a failed callback cannot be replayed.
- **Missing or expired session:** restart the flow from the canonical app address in the same browser. Do not reuse a callback/code after restarting the server.
- **Denied consent:** nothing is claimed; start again when ready.
- **Logout versus revoke:** gallery logout clears the local session. Revoke the developer app's X grant in X's connected-app settings when desired.

The automated suite intercepts X API responses to check redirects, PKCE, denial, invalid identities, state replay, session rotation and claim consent. It is not a substitute for your first live consent test.

If `local:verify` or the indexer reports missing historical state, an out-of-range block, or RPC timeouts, preserve the existing rehearsal and diagnose it before minting. X configuration does not repair chain history, and switching authentication modes must not silently reset data or waive chain checks.

Local startup/ownership checks allow up to 30 seconds per RPC because large Anvil state snapshots can temporarily stall reads. Indexer readiness is still checked separately and minting remains blocked on failed reconciliation; the longer startup timeout is not a chain repair.

Sources: [X app types and local callbacks](https://docs.x.com/fundamentals/developer-apps), [X OAuth 2.0 flow and endpoints](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token), [X API usage and credits](https://docs.x.com/x-api/getting-started/pricing).
