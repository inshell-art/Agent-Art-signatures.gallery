# Authentication and sensitive-action policy

Approved policy, 2026-09-10: no account-wide 15-minute reauthentication timer. An active app session remains signed in for browsing and My Collection. X confirmation belongs to a particular sensitive action, not to every operation performed after an identity-age deadline.

Mint-only recipient model, 2026-09-11: X is the app identity for claims, My Collection, and withdrawals. Wallet connection and recipient verification belong to an exact mint, not to global account setup. The active app session establishes the original claimant's stable numeric X account ID; minting does not routinely repeat X OAuth. Each new mint still freshly proves control of its Ethereum recipient. Existing internal binding/proof records and historical provenance are retained, but a saved address never silently authorizes another mint.

## Separate lifetimes

| State | Lifetime | Meaning |
| --- | --- | --- |
| App session | Seven days of inactivity | Server session activity renews the idle deadline. Logout, missing cookies, or an app restart can also end the current in-memory session. This is independent of X token expiry. |
| X OAuth access token | X documents a two-hour default | Used only in the callback to read `/2/users/me`, then discarded. The app does not retain the token, request a refresh token, or use its expiry to expire an established app session. |
| OAuth flow | 15 minutes from starting the flow | One-time state, browser/session binding, PKCE, and the exact requested intent must remain valid. Expired flow state requires restarting that flow, not logging out of the app. |
| Sensitive-action approval | One use, no later than the originating OAuth flow's deadline | An action callback grants only its bound action and target in the rotated session. It does not start another 15-minute identity-freshness window or authorize unrelated actions. |
| SIWE wallet proof | 10 minutes from challenge issuance | A distinct, exact, one-time recipient-control challenge bound to the active claimant session, signature, claim instance, chain, selected address, and previous binding state. No mint-specific X approval is required. |
| Verified recipient review draft | 15 minutes from proof completion | Bound to the session, stable X account ID, exact signature/claim instance, chain, recipient, and proof/binding record. It cannot approve another signature or new authorization. |
| Mint authorization | 900 seconds, measured against the chain's time | The signed transaction capability has its own on-chain validity window. It is not an X session timeout; unused expiry still needs the existing chain-reconciliation evidence before release. |

X's documented token behavior is a provider policy, not our app-session policy. See [X OAuth 2.0 Authorization Code Flow with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code). Scopes stay exactly `users.read tweet.read`; no `offline.access`, write permissions, or additional identity fields are introduced.

## Action requirements

| Action | Required authority |
| --- | --- |
| Browse / My Collection | Active app session for private data; no age-only X prompt. Public browsing remains public. |
| Connect wallet / Change recipient for a mint | Active app session whose stable numeric X account ID matches the original claimant, same-origin/CSRF-protected explicit recipient consent, unchanged previous binding state, then a new exact SIWE recipient-control proof. No routine X OAuth round trip. |
| Authorize a new mint | Active original-claimant session, unexpired exact-mint recipient draft, matching active proof/binding, unchanged reviewed recipient and work, permanence consent, all existing mint-safety checks, and explicit wallet transaction approval. A previous address or proof alone is insufficient. |
| Resume an issued authorization | Preserve the already signed exact work/recipient capability and its existing safety checks. Do not issue replacement authority or permit recipient changes while it is live or unresolved. |
| Transfer a minted token | Ethereum token-owner authority. X does not authorize later transfers; original claimant credit and the initial recipient remain historical provenance. |
| Withdraw a claim | Start `purpose=sensitive_action`, `action=claim_withdraw`; confirm with the claimant's X account for the exact signature and claim-instance ID, then explicitly confirm withdrawal. Mint/chain-history guards still apply. |
| Claim a new signature | The existing combined claim CTA binds explicit consent to an exact preview and uses its own unexpired claim OAuth flow. Ordinary account sign-in creates no claim and grants no wallet/withdrawal authority. |

Signed-out mint entry uses ordinary **Sign in with X** and returns to the mint page. An active original-claimant session proceeds directly to wallet connection, including after that login; a wrong account first switches to the original claimant. Ordinary account login creates neither a wallet proof nor mint authorization and never approves withdrawal. The server checks the original numeric X account ID, not a mutable handle, at protected transitions. Another account, another signature, a new claim instance, changed binding state, logout/session rotation, or expiry invalidates stale mint proof/review context.

For recipient verification, the user's wallet-control click submits explicit consent through a CSRF-protected POST bound to the exact signature, claim instance, chain, and expected previous binding. The selected address must prove control through the exact SIWE message. Connecting alone is not proof. A rejected or expired challenge can restart under the still-valid claimant session without another X trip. **Change recipient** only navigates back to wallet selection; it does not itself change any binding. Selecting a recipient requires a new consent POST and proof, and stale review forms cannot authorize the changed recipient. Live, prepared, submitted, or unresolved authority blocks recipient changes until safely resolved.

Only the latest mint-recipient challenge issued in a session may complete. Starting another challenge supersedes the earlier one; an older signed response cannot overwrite the newer selection or restore an old review. The session's `mintRecipientChallengeId` is checked before and after asynchronous proof verification and cleared on completion, logout, or invalidation. This is challenge supersession, not a new time-based expiry policy.

## Session-theft trade-off

This intentionally trusts the active seven-day-idle app session as X identity authority for minting. Someone who steals a valid session can attempt to mint an unminted claimed signature to a wallet they control; a fresh wallet proof proves that wallet, not that the session holder is the legitimate X user. CSRF protections stop cross-site request forgery, not misuse of an already stolen session. There is no added shorter session TTL or hidden periodic X check. Protect session cookies, invalidate sessions on logout/rotation, preserve strict same-origin/CSRF checks, and require fresh exact wallet proof and reviewed-work/recipient matching. Claim withdrawal still has its separate action-bound X confirmation.

## User-facing behavior

- The account panel contains only X sign-in/logout controls. The dot remains a direct link to My Collection. Minting exposes concise “Connect wallet” and “Change recipient” actions without an X confirmation detour for active sessions. Withdrawal retains its transient “Opening X to confirm your identity…” notice during the required OAuth handoff.
- Withdrawal retains its closed disclosure and warning on ordinary page visits. X returns to `#withdraw`, revealing that disclosure and its CTA without opening the final dialog. The user still explicitly opens and confirms the dialog; merely returning from X does not delete the claim.
- Expired or missing app sessions use sign-in recovery. An expired OAuth request is described as an expired request. Missing action approval names the action rather than sending users into a generic account-login loop.
- Mint entry retains sign-in and wrong-account recovery for direct/private links, per-mint wallet proof, and pending/paused states. It has no identity-age reauthentication stage. Cancel is navigation, not deletion of an issued authorization. Returning to an issued mint resumes that exact authorization; a new mint requires fresh explicit wallet proof and review.
- The legacy development URLs `state=reauthenticate` and `state=wallet-linked` remain available as read-only **Active session · connect wallet** and **Previous recipient** fixtures, not global account states. `state=recipient-verified&view=mint` and `state=wrong-claimant&view=mint` cover verified and wrong-account entries.

This changes neither price nor issuance limits: the project fee remains **None**, wallet-estimated network gas is separate, and no one-token-per-user limit is introduced. One token per signature does not prevent one user claiming and minting multiple signatures. Removing global wallet UI does not delete internal verification records or weaken mint/provenance safeguards.

Same-origin/Fetch Metadata checks, CSRF, one-time OAuth state, PKCE, ownership checks, wallet proof, mint publication consent, and withdrawal's claim-instance protection remain in force. X controls its own authentication/consent interaction; even the action-bound OAuth identity check retained for withdrawal does not guarantee a fresh password prompt. The existing session, challenge, review, and authorization lifetimes are unchanged.

Implementation: `src/v1/authPolicy.ts`, `src/v1/authState.ts`, `src/api/server.ts`, `src/v2/service.ts`, and `src/v2/core/siwe.ts`. The current local runtime keeps sessions/flows/approvals in memory; durable production session adapters remain a deployment prerequisite.
