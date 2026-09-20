# Open-mint security review scope

Status: preparation for E21/E24, **not a completed independent review or launch approval**. The current executable service remains local-only. New PostgreSQL/public-chain/publication/projection modules are being integrated separately; passing their unit tests does not make them a public deployment.

## Assets and trust boundaries

| Asset / boundary | Required guarantee | Relevant implementation / review |
| --- | --- | --- |
| Free editable preview → paid preparation | A preview MBTI, URL, prompt or alleged Grok result cannot become mint authority. | Strict request fields, session wallet proof, `service.ts`; durable `requests.ts` integration. |
| X / Grok → first accepted result | Fixed server-owned policy, verified subject, bounded transport, honest refusal/uncertainty, no reroll of accepted result. | `xIdentity.ts`, `grok.ts`, assessment validators, immutable attempt/receipt/assessment repository. Live X compatibility is still blocked by HTTP 402. |
| Budget → provider dispatch | Reserve before dispatch, one active paid job, durable per-leg marker, no automatic replay after uncertainty. | File-ledger tests; PostgreSQL writer/repository fault and real-database tests. Provider-side hard limits remain necessary. |
| Browser cookie/proof → private request | Exact origin/CSRF, expiring one-use challenge, generation checks through asynchronous work, session-bound hashed code lookup. | `security.ts`, durable sessions/requests. Audit the final async HTTP integration, not just repository methods. |
| Database writer → external work | One writer, durable commit, monotonically fenced ownership, no automatic reconnect/retry on ambiguous commit. | `persistence/writer.ts`; independent owner role, fsync, replica/failover and runtime grants need operating review. |
| Accepted assessment → public artwork | Native frozen render spelling/MBTI, exact stored bytes/CIDs, allowlisted public metadata, one immutable artifact per handle. | `publicArtifacts.ts`, publication journal; original local artifacts are not silently migrated. |
| Publication → signer | All exact blobs independently retrieved and verified, durable completion, private backup integrity and accepted-assessment binding before reservation. | `publicPublication.ts`, `publicIpfsReader.ts`, PostgreSQL journal and issuance integration. Actual pin retention/provider independence remains unverified. |
| RPC → eligibility / gallery | Pinned chain/genesis/deployment/code/domain/signer, nonce and recipient checks; finality-aware reads; unavailable is not unminted. | `publicChain*`, projection adapter. Two labels do not prove independent operators. RPC/log/finality acquisition requires review. |
| Signer → browser transaction | Exact domain, nonce, recipient, accepted commitments and immutable URI; reserve before signing; no backend mint broadcast. | Authorization primitives, durable issuance, contract tests. No custody mechanism or public key has been provisioned. |
| Indexer → public collection | Unique handle/token, immutable mint recipient, owner-at-snapshot, bounded cursors, shallow rollback and deep contradiction halt. | Projection model/database tests; raw event authenticity, source agreement and freshness integration remain required. |

## Known residual risks and mandatory deployment checks

1. **Provider authority is an application attestation.** Grok does not sign the on-chain authorization. Review prompts, search scope, source injection handling, subject validation and the supported model profile. A successful fixture test is not live-provider evidence.
2. **Spending remains uncertain after dispatch.** Application reservations are not provider billing ceilings. Unknown receipts cannot be relabeled zero, deleted or resolved by restarting. Any subsequent paid attempt must use its reviewed authorization and audit trail. Provider account limits, pricing expiry and operator reconciliation need concrete owners.
3. **No public egress default exists.** Read transports require operator-supplied fetch with DNS/egress restrictions. Before wiring, verify resolved-IP policy, DNS rebinding behavior, redirects, allowed origins/ports, TLS, bounded connection/header/body lifetimes, cancellation and proxy behavior. Never expose arbitrary URL fetch as a user endpoint.
4. **Operational secrets stay out of the repository and public responses.** API keys, signing material, provider response IDs, request codes, cookie tokens and private receipts must not enter HTML metadata, logs, diagnostics, manifests or monitoring labels. Exact stored wallet challenge messages may contain private request URLs; protect their database/backups accordingly.
5. **Database ownership is not safe disaster recovery by itself.** Use a non-owner runtime role with no trigger/migration/truncate privileges; separate environments. Record backup position and reconcile external calls/transactions after restore. Never run both original and restored writers against one deployment. Durable local commit does not guarantee lossless asynchronous-replica failover.
6. **Account support is deliberately narrow.** Only EOA recipients without deployed/delegated code are supported. A wallet extension's identity label is not authentication. Actual Rabby/MetaMask/device compatibility needs observation; synthetic injection/dialog tests do not substitute for it.
7. **Reveal is not cryptographic secrecy.** Artwork is prepared before minting; transaction data and public storage can expose it. The site must not imply otherwise. Public metadata proves immutable bytes and backend workflow, not psychological truth or account ownership.
8. **The worldwide “First” claim is unresolved.** Existing evidence includes prior autonomous/agent-art projects. Keep research and the approved slogan distinct; the user must decide an evidence-supported claim scope before publication of a factual priority claim.

## Release evidence package

E23/E24 should review one pinned revision containing: observed hosted CI; reproducible renderer/build/contract evidence; explicit runtime profile and dependency versions; deployed manifest and independent canonical observations; signer/admin role ownership; public artifact retrieval and backup/restore results; live provider receipts with billing uncertainty stated; actual wallet approve/reject/reconnect/transfer tests; reorg and lost-writer fault tests; rate-limit/proxy/body-bound tests; redacted incident diagnostics; support/retention policy; About/claim approval; and recorded remaining findings with owners.

Generation kill switch, application signing stop, and on-chain pause are distinct controls. The first two can stop new work; they cannot revoke already issued authorizations or undo an already submitted mint. On-chain pause, nonce revocation and signer rotation require separately authorized transactions and canonical confirmation. A timeout must not be treated as successful emergency action.

An independent reviewer must examine the actual integrated release, not infer safety from this checklist. Public testnet deployment and production launch remain separate explicit approvals.
