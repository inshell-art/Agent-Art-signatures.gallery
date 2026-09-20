# Wallet support and verification

Updated 2026-09-20. The implemented scope is an injected Ethereum provider with a signing account that has no on-chain code. This document distinguishes implementation evidence from real extension/browser certification. E13 remains open for the actual wallet matrix; these checks do not complete E14.

## Support boundary

| Wallet/account path | Implemented behavior | Evidence / remaining gate |
| --- | --- | --- |
| EIP-6963 injected wallets | Explicit choice when multiple providers are discovered; selected object used for proof, reads and sends | Synthetic providers and browser selector checked; actual extension versions pending |
| Legacy Rabby / MetaMask injection | Brand labels, `ethereum.providers` discovery, unique saved selection | Mocked flags only; neither brand is declared verified by these tests |
| Unidentified legacy injected provider | Explicit connect supported; no automatic provider restoration after navigation | Reconnect required because a stable provider label is unavailable |
| Account without code | Existing EOA signature/nonce/network path retained | Mocked client, server proof and network transport checks pass |
| Contract account or delegated/code-bearing EOA | Rejected; UI explains selecting an account without code | Client tests cover ordinary bytecode and delegation designation; existing server code checks remain authoritative |
| WalletConnect, external mobile handoff, smart-account signing | Outside this scope | No transport or account-support claim |
| In-wallet mobile browser | Candidate for evaluation before adding transport | No device testing performed |

The discovery flow follows [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963), and provider calls/events follow [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193). Wallet names, RDNS values and legacy flags are self-reported, not authenticated identities. They never grant account authority. Provider icons are not loaded or inserted; names are bounded and rendered as text.

## Selection and recovery

- Connect opens a labelled native dialog when several providers are available. No account request occurs before a choice; Cancel/Escape/page exit do not request proof or send a transaction.
- The chosen provider object is retained. Replacing `window.ethereum` cannot redirect proof, mint, inspection, or listener cleanup. Changing the selected provider requires explicit reconnection.
- Account, chain, and disconnect events invalidate local proof/intent. Listeners belong only to the selected object and are removed on switching/page exit. An unresolved transaction guard and canonical confirmation polling survive wallet invalidation.
- Reload restores only one matching saved discovery identity. Missing, unidentified or ambiguous selection clears automatic mint intent and requires explicit reconnection. Existing sessions without a saved provider selection also reconnect once. Wallet UUIDs distinguish discoveries within a page; saved EIP-6963 selection uses unique RDNS because UUIDs are not persistent identifiers.
- Rejection, unauthorized access, unsupported wallet methods and empty/invalid account responses leave connection recoverable. Wallet/account/chain checks still precede preparation and sending. Client account-code checks improve the explanation; trusted server checks are unchanged.
- Multi-wallet legacy aggregators that expose no individual providers cannot provide reliable explicit discovery. Such a setup is not a verified multi-extension configuration; prefer EIP-6963 or an exposed provider list.

## Recorded verification

`npx vitest run src/openMint/clientScript.test.ts src/openMint/walletProviders.test.ts src/openMint/network.test.ts src/openMint/network.transport.test.ts src/openMint/security.test.ts`: **355 passing tests** (225 client, 14 discovery, 93 network, 10 transport, 13 session/security). `npm run typecheck` passed. The discovery tests include the actual `tsx` development-runtime serialization path, added after browser QA found and fixed a helper dependency that VM tests alone missed.

Visual DOM CDP checks used fresh headless Chrome profiles, the actual mint page/CSS/client/font modules, and an isolated read-only synthetic server at `127.0.0.1:18661`. It had no store, secrets, RPC transport or live wallet. The synthetic providers throw if called; browser results recorded **zero provider calls**, only local GET requests, and no failing asset requests.

| Viewport | Themes | Dialog width | Horizontal overflow | Smallest choice target |
| --- | --- | --- | --- | --- |
| 320×900 | Light and dark | 286px | 0px | 44px |
| 390×900 | Light and dark | 356px | 0px | 44px |
| 1280×900 | Light and dark | 448px | 0px | 44px |

All six screenshots and DOM geometries were inspected. Long provider names and RDNS labels wrap without clipping; the page width equals the viewport; dialog colors follow existing theme variables. Real CDP Tab advances through both provider choices to Cancel; Escape and Enter-on-Cancel close the dialog and restore focus to Connect. Enter on Connect reopens it with focus on the first choice. No provider call occurs during these keyboard checks.

Temporary evidence is in `/private/tmp/wallet-selector-qa.ZqX4WX/`: `selector-{320,390,1280}-{light,dark}.png`, `screenshots.json`, and `keyboard.json`. The isolated server is stopped after validation. This verifies selector behavior in headless Chrome, not an installed extension or physical mobile browser.

## Actual wallet/browser matrix still required

Before declaring a wallet/browser combination supported, record OS/browser/extension version and date, then exercise connect, correct challenge signing, rejected account access/signing/send, mismatched chain/RPC, explicit switch with another extension installed, account/chain changes during preparation, disconnect, refresh/reconnect, and submitted/uncertain transaction recovery. Test code-bearing restrictions independently of brand. Start with desktop Rabby and MetaMask candidates; evaluate one in-wallet mobile browser separately. Use an approved isolated fixture/local-chain environment and separately authorize any real signing or transaction exercise.

E14 still needs the broader page matrix, 375px, 200% zoom, reduced motion, screen-reader announcement review and actual devices. The intentionally single-line homepage guidance and approved artwork animation were not changed.
