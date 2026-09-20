# Open-mint public artifact preparation

Status: E18 local format, publication core and PostgreSQL journal; not active public infrastructure. The current local artifact scheme, historical bytes and commitments remain unchanged. No pinning account, paid upload, approved public origin, live migration, signing permission or public startup is introduced here.

`src/openMint/publicArtifacts.ts` prepares a new `sg-open-mint-metadata-1.0.0` document and `signatures.gallery/open-artifact/v2` commitment, as proposed in the public architecture. Only native renderer v2.0.0 assessments with recorded Grok and verified-X provenance are eligible. Schema validation detects corruption; it does **not** authenticate Grok, authorize publication, or establish that a caller has permission to import historical local assessments. The eventual durable coordinator must establish those facts from its trusted namespace/attempt records.

## Bytes and privacy

Preparation renders the exact frozen X username and MBTI, makes SVG/PNG CIDs using the pinned `sg-ipfs-unixfs-1.0.0` importer, and constructs canonical JSON metadata with immutable image URIs. Metadata contains an explicit allowlist projection: handle, MBTI, renderer, assessment digest/date/model/policy, preparation-time public X identity and X source URLs with query/fragment removed. Non-X citations remain in the private assessment only. The full private assessment, internal ID, provider response ID, attempts, billing, wallet sessions and capability URLs are never spread into public metadata.

The assessment digest commits to more than the public projection. Readers cannot reconstruct that complete private digest from the published subset alone. No public artifact digest or metadata's own URI/hash is embedded into that metadata, avoiding circular commitments.

Verification compares saved SVG bytes with the pinned immutable renderer's exact output for the accepted username and MBTI. Self-consistent replacement SVGs are rejected even if their descriptors, metadata and artifact digest are recomputed. PNG creation remains a trusted initial renderer/encoder boundary: size/hash/CID checks prove exact-byte integrity, not that arbitrary supplied PNG pixels represent the assessment or SVG. Historical PNGs are never regenerated to establish parity. Only the trusted preparation path may introduce new image bytes; this is not an arbitrary artifact-import API.

Commitment tuple, ABI encoded then Keccak-256:

```text
(string domain, bytes32 assessmentDigest, string canonicalHandle,
 string renderHandle, string rendererVersion, string metadataVersion,
 bytes32 svgSha256, bytes32 pngSha256, bytes32 metadataSha256,
 bytes32 tokenURIHash)
```

The origin is explicit, exact HTTPS and syntactically nonlocal. That validation performs no DNS lookup and does not constitute domain ownership/deployment approval. Changing it creates different metadata and a different artifact binding; it must never rewrite a frozen record. Only a new approved namespace or explicit reviewed import may introduce such a binding.

## Publication boundary

`publicPublication.ts` accepts no default publisher, reader or journal. The injected journal must atomically stage an insert-only bundle and exact backup bytes, refuse conflicting bindings, retain upload/retrieval evidence, and commit completion only after all three objects pass. `persistence/publication.ts` supplies this implementation through E17's exclusive writer. The uploader must be content-addressed/idempotent; its independent reader must use a genuinely independent retrieval path, not echo its upload buffer. Distinct adapter IDs are a configuration check, not proof of operational independence.

One explicit pass performs: validate bundle → persist stage → recheck writer ownership → upload each exact object → persist upload observation → independently retrieve and verify size/hash/CID → persist retrieval observation → commit completion. Deadlines and abort signals bound each upload/read; adapters must enforce streaming size limits before buffering. A timeout or any journal failure returns no completion result, and late results cannot commit. Caller/adapter buffer mutation cannot change the snapshot being published; transport references, validated identities and deadline are captured before asynchronous work. There are no automatic retries, providers, signers or chain broadcasts here. An explicit replay may only repeat identical saved bytes.

## Durable publication and recovery

Apply `persistence/publication-schema.sql` only after E17's initial schema using the reviewed migration role. It provisions no environment, profile, credentials or remote publisher. An immutable publication profile binds a namespace to its exact origin, uploader ID and independent reader ID. Only a current-policy real-provenance namespace and its exact accepted assessment may stage public artwork. Both ingestion and recovery revalidate the assessment's indexed ID/digest/handle, namespace policy/provenance, accepted state and payload binding.

One transaction stores the canonical private header plus exact SVG, PNG and metadata bytes. Each is bounded, and one handle cannot acquire a second artifact binding. Upload and retrieval observations are separate immutable rows; retrieval requires its upload observation. Completion requires all six configured observations. A complete load rechecks those observations and the exact byte/hash/CID/metadata bindings. Missing completion is not permission to sign. Writer loss or ambiguous commit aborts the operation; it cannot erase progress or rewrite artwork.

The entire bundle is a **private backup**, not a public response: its header includes the private assessment evidence. Recovery loads the saved bytes, never re-renders historical PNGs. PostgreSQL backup/restore tests preserve bytes, receipts and immutability triggers. Public operation still needs encrypted/access-controlled off-host backups, restore-point recording, retention, replica guarantees, and a restore runbook that keeps generation/signing disabled until chain/provider reconciliation. Never run an old and restored writer against the same external deployment concurrently. A database restore does not undo provider calls or chain transactions made after the backup.

`publicIpfsReader.ts` is the separate read-only HTTPS gateway adapter. It uses only a configured origin plus canonical `/ipfs/<CID>`, no credentials or redirects, and bounded streamed body reads. It rejects wrong size/hash/CID, failed HTTP, missing/mismatched bodies and late completion. It supplies no default network transport: the operator must provide an egress/DNS-restricted fetch and select a genuinely independent gateway. Mocked transport tests are not evidence of that operational independence or pin retention.

Before authority can use this core, remaining E17/E18/E21 work is mandatory: selected pin/storage adapters and retention/replication policy, upload-independent bounded retrieval, operational backup/restore review, namespace/permission integration, signer gating against durable verified state, and active service integration. Public startup remains refused.

## Offline validation

The format golden uses real SVG and a fixed PNG test buffer to keep the metadata/CID/commitment oracle independent of platform raster libraries. Publication and journal tests render real SVG/PNG. They use synthetic assessments and mocked remote transports, inject faults at every journal boundary, wrong retrieved bytes, hung uploads/reads, late completion and concurrent configuration/buffer mutation. Disposable PostgreSQL tests exercise exact-byte restart, immutable constraints, corrupted accepted-result/receipt recovery, incomplete publication and backup/restore. They do not establish public pin durability or real provider provenance.
