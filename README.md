# signatures.gallery

An Agent Art work. Each X account has one canonical signature — a deterministic
abstract mark derived from the handle alone. Each mention of the agent on X
produces an instance: the same signature, slightly off, where the deviation is
determined by the agent's reading of that participant's recent public posts.

The accumulated instances for one handle form a cluster. The cluster is the
work; a single instance is a sample of it.

See [HANDOFF.md](./HANDOFF.md) for the full implementation spec. The
signature generation algorithm itself is out of scope for this repo and is
supplied separately as a black-box module (§6 of the handoff).

## Status

Stack: TypeScript / Node.

- [`src/reading.ts`](./src/reading.ts) — implemented. The reading contract
  from handoff §4: the 4-axis vocabulary, the 4-character URL code, and
  validation (out-of-vocabulary codes are rejected, not coerced).
- [`src/algorithm.ts`](./src/algorithm.ts) — deliberately blank. Pins the
  interface from §6 (`renderCanonical`, `renderInstance`, `OffsetVector`,
  `ENVELOPE`, `SPEC_VERSION`) so the rest of the service can be built against
  it; the real implementation is supplied separately and replaces this file
  wholesale.
- [`src/mapping.ts`](./src/mapping.ts) — **placeholder**. A structurally
  valid `readings.map.v0-placeholder`: additive per-axis offsets, `xxxx` ->
  zero vector, deterministic within-cell jitter from the source post ID, and
  an envelope assertion that activates once `algorithm.ENVELOPE` is
  supplied. The real table's contents are an aesthetic decision that ships
  with the algorithm (§5) — swap the whole file, keep the function
  signatures.
- [`src/store/`](./src/store/) — data model (§7): `schema.sql` is the
  Postgres DDL (append-only `instances`, idempotency key on
  `(seed_handle, source_post_id)`); `types.ts` defines the `Store`
  interface; `memoryStore.ts` is a placeholder in-memory implementation used
  for tests until a Postgres-backed `Store` is wired up.
- [`src/api/`](./src/api/) — HTTP API (§9): `GET /s/{handle}/{code}/{post_id}`
  (mint or fetch, idempotent), `GET /c/{handle}` (cluster), `GET /v/{id}`
  (verification data). The mint path validates, checks idempotency, and
  derives the offset vector — then calls the algorithm's `renderInstance`,
  which throws until the real algorithm lands, so new mints currently 501.
  Existing instances still fetch correctly. X OAuth claiming (§10) not yet
  started.

```bash
npm install
npm test        # vitest
npm run typecheck
```
