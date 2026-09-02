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
- Mapping table (§5), data model (§7), and HTTP API (§9) not yet started.

```bash
npm install
npm test        # vitest
npm run typecheck
```
