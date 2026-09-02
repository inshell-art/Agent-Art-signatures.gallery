# signatures.gallery — Implementation Handoff

**Status:** draft for implementation
**Audience:** implementing agents and engineers
**Scope:** the standalone service. The signature generation algorithm is **out of scope** and supplied separately; this document defines the interface it must satisfy.

---

## 1. What this service is

An Agent Art work. Each X account has one **canonical signature** — a deterministic abstract mark derived from the handle alone. Each time the participant mentions the agent on X, they receive an **instance**: the same signature, slightly off, where the deviation is determined by the agent's reading of that participant's recent public posts.

The accumulated instances for one handle form a **cluster**. The cluster is the work; a single instance is a sample of it. X is where instances are performed; signatures.gallery is where clusters live.

### Design commitments (do not violate)

1. **The agent never emits numbers.** It emits discrete labels from a closed vocabulary. This service owns the mapping from labels to geometry.
2. **The envelope is structural.** No valid reading may produce a mark outside the recognizable range. Safety is a property of the mapping table's codomain, not of agent behaviour.
3. **Offsets are always from the canonical**, never from the previous instance. No chaining, no random walk.
4. **The record is append-only.** A mutable instance row is a forgeable signature.
5. **Everything is recomputable** from `(handle, reading, source_post_id)` plus the recorded version tags.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Canonical** (a.k.a. *the score*) | The zero-offset signature for a handle. Pure function of the handle. Recomputable by anyone, forever. |
| **Instance** | One rendered signature with a non-zero offset. Belongs to exactly one cluster. |
| **Cluster** | The ordered set of all instances for one handle, plus its canonical. |
| **Reading** | The agent's structured interpretation of a participant's recent posts. Four axes, one discrete level each. |
| **Offset vector** | The numeric parameters derived from a reading by the mapping table. The only thing the algorithm consumes. |
| **Envelope** | The bounded region of offset space within which a mark remains recognisably the same signature. |

---

## 3. Flow

```
Alice replies "@grok" under the anchor post on X
        │
        ▼
Agent reads Alice's recent public posts, classifies them
into a 4-axis reading, and replies with ONE URL:
        https://signatures.gallery/s/{handle}/{code}/{post_id}
        │
        ▼
X's crawler fetches the URL for card unfurl
        │
        ▼
Service: validate → mint or fetch instance (idempotent)
         → render → store → return HTML with og:image
        │
        ▼
Card renders in-thread. Instance is now in Alice's cluster.
```

The agent's entire output is a URL string. It never calls this service directly, never sees an SVG, and never produces a coordinate.

---

## 4. The reading contract

### 4.1 Axes and levels

Four axes. Each takes exactly one of four levels. Levels describe **the hand**, not the person — this is deliberate: it keeps the public record free of emotional inferences about identifiable people, and it is truer to what the agent is actually doing, which is reading text.

| Axis | Levels | Rubric (observable, not inferred) |
|---|---|---|
| `tempo` | `hurried` · `steady` · `measured` · `insufficient` | Posting cadence in the window. Several posts in quick succession → hurried. Long, even gaps → measured. |
| `weight` | `light` · `even` · `firm` · `insufficient` | Typical post length and density. Short fragments → light. Long, dense posts → firm. |
| `steadiness` | `unbroken` · `wavering` · `broken` · `insufficient` | Variance in cadence and length. Low variance → unbroken. High variance or long silence then a burst → broken. |
| `reach` | `contained` · `neutral` · `open` · `insufficient` | Ratio of replies to original posts; presence of links, media, mentions. Mostly self-contained originals → contained. Mostly outward-facing → open. |

**Rubric anchoring is the primary stability lever.** Each level must be defined by something countable in the visible timeline. A rubric-anchored classification survives model changes far better than a magnitude judgment, because it converts a judgment into an observation.

### 4.2 `insufficient`

If an axis cannot be read — no recent posts, protected account, too little signal — the agent must return `insufficient` for that axis. `insufficient` maps to **zero offset on that axis**.

Never let absence be silently encoded as a mood. An account with nothing to read must produce a mark near the canonical, not a fabricated one.

### 4.3 URL encoding

The reading is encoded as a **4-character code**, one character per axis, in fixed order `tempo · weight · steadiness · reach`:

```
tempo       hurried=h   steady=s    measured=m   insufficient=x
weight      light=l     even=e      firm=f       insufficient=x
steadiness  unbroken=u  wavering=w  broken=b     insufficient=x
reach       contained=c neutral=n   open=o       insufficient=x
```

Example: `hfwo` = hurried, firm, wavering, open. `xxxx` = nothing readable → canonical.

256 distinct readings. Ample for a lifetime cluster; small enough to stay stable across model generations.

### 4.4 Validation

Reject any code that is not exactly 4 characters drawn from the per-position alphabets above. **An out-of-vocabulary reading is a failed read, not a novel value.** Return 400 and mint nothing.

---

## 5. Mapping table

`readings.map.v1` — a static, versioned table from reading code to offset vector.

```
map(code) -> OffsetVector
```

### Rules

- Pure and total over the 256 valid codes. No randomness, no I/O.
- Every output must lie inside the envelope. This is what makes envelope safety structural.
- `xxxx` maps to the zero vector.
- Each axis contributes independently and additively unless a documented interaction is declared.
- Versioned. Changing it creates `readings.map.v2`; existing instances keep their recorded version tag and remain reproducible.

The table's contents are an aesthetic decision and are supplied with the algorithm. This service only needs to load it, validate its bounds at startup, and apply it.

### Within-cell jitter

Two instances with the same reading must still differ. Derive a small deterministic jitter from the source post ID:

```
jitter = hash(spec_version, handle, code, source_post_id) -> bounded displacement within the cell
```

The jitter must not be able to carry the offset outside the envelope. Bound it to the cell, not to the envelope as a whole.

---

## 6. Algorithm interface (supplied separately)

> **The generation algorithm is out of scope for this handoff.** Implement against this interface and treat it as a black box.

```python
SPEC_VERSION: str          # e.g. "aa-curve-2.0.0"
ENVELOPE: dict             # per-axis bounds, used to validate the mapping table

OffsetVector = dict[str, float]   # fixed keys, fixed order, bounded per ENVELOPE

def render_canonical(handle: str) -> str:
    """Return raw SVG for the zero-offset signature. Pure function of handle."""

def render_instance(handle: str, offsets: OffsetVector) -> str:
    """Return raw SVG for an offset signature. Pure function of its arguments."""
```

### Required properties

- **Deterministic.** Same arguments, same bytes, on any machine, forever.
- **`render_instance(h, zero_vector)` is byte-identical to `render_canonical(h)`.**
- **Topological invariants are held fixed by the algorithm**, not by the mapping table: stroke count, number and order of self-crossings, gross direction of travel, which loops close. These constitute identity. Only metric properties vary — handle lengths, angles within a narrow cone, global slant and scale, local smoothness.

### Acceptance test the implementer must wire up

Sample both curves, align, and compute a discrete Fréchet or L2 distance.

- **Intra-cluster spread must stay well below inter-cluster separation.** Run a nearest-canonical classifier over a large generated set; accuracy must stay high. If it degrades, the envelope is too wide.
- Also check inter-writer separation across the whole namespace: if two handles' canonicals hash close together, recognisability fails independently of any reading.

Expose both as a CLI check so the numbers can be re-run after any version bump.

---

## 7. Data model

Append-only. No `UPDATE`, no `DELETE` on instances. Corrections are new rows with a `supersedes` pointer.

### `accounts`

| Column | Notes |
|---|---|
| `x_user_id` | **Primary key. Numeric X account ID, never the handle.** Handles get renamed, released and re-registered; binding to the string would silently reassign a cluster. |
| `seed_handle` | The handle string frozen at claim time. This is what feeds the algorithm. A later rename must not split or reseed the cluster. |
| `current_handle` | Display only. May change. |
| `claimed_at` | Nullable. Set on successful X OAuth claim. |

### `instances`

| Column | Notes |
|---|---|
| `id` | Surrogate key. |
| `x_user_id` | Cluster owner. May be resolved after the fact for unclaimed handles. |
| `seed_handle` | Denormalised; the exact string used for generation. |
| `reading_code` | The 4-character code. |
| `reading_json` | Expanded axis→level object, for querying. |
| `rationale` | The agent's one-line justification. See §8. |
| `source_post_id` | The participant's mention post ID. |
| `offset_vector` | The derived numeric vector, stored explicitly. |
| `spec_version` | Algorithm version. |
| `map_version` | Mapping table version. |
| `schema_version` | Reading vocabulary version. |
| `provenance` | `verified` \| `unverified`. See §9.3. |
| `created_at` | Server timestamp. |
| `sequence` | Monotonic ordinal within the cluster. |

**Idempotency key: `(x_user_id | seed_handle, source_post_id)`.** Critical — X's crawler will fetch the card URL more than once, and a re-fetch must return the existing instance rather than minting a duplicate.

---

## 8. Rationale text

The agent returns, alongside the URL, a short phrase naming why the hand deviated. Store it.

This is not decoration. It is what lets the gallery answer "what did the agent actually contribute?" with evidence rather than assertion, and it gives each cluster a narrative axis alongside the visual one. Cap it at ~80 characters, store verbatim, escape on render, never parse it for control flow.

If the agent's reply contains only the URL and no phrase, store `null` — do not synthesise one.

---

## 9. HTTP API

### 9.1 `GET /s/{handle}/{code}/{post_id}` — mint or fetch instance

The URL the agent emits. Must be safe to fetch repeatedly.

1. Validate `handle` against `^[A-Za-z0-9_]{1,15}$`, `code` against §4.4, `post_id` as digits.
2. Look up by idempotency key. If found, serve the existing instance.
3. Otherwise: `map(code)` → offset vector, add jitter, assert inside envelope, `render_instance`, rasterize to PNG, persist, assign `sequence`.
4. Return HTML with:
   - `og:image` → absolute URL of the PNG
   - `og:title`, `og:description`
   - `twitter:card: summary_large_image`

**`og:image` must be PNG, JPEG, WEBP or GIF. SVG is not accepted by X.** Store both: SVG as the source of truth, PNG for the card.

Rate-limit per `handle` and per source IP. Minting is cheap but unbounded minting is a denial-of-wallet vector.

### 9.2 `GET /c/{handle}` — cluster page

The canonical plus all instances, ordered by `sequence`. Supports frame-by-frame and animated presentation. This is the primary artefact of the work.

### 9.3 Provenance verification

Optionally verify via the X API that `source_post_id` exists, was authored by `handle`, and mentions the agent. Set `provenance` accordingly.

Do this **asynchronously**, after minting — never block the card response on a third-party API, or unfurl will time out and the participant sees nothing. Display the distinction in the gallery; do not delete unverified instances.

### 9.4 `GET /v/{instance_id}` — verification page

Show everything needed to recompute the instance independently: seed handle, reading, post ID, offset vector, all three version tags, and the published spec hash. A stranger must be able to reproduce the exact bytes from public information plus this record.

---

## 10. Claiming

X OAuth. On success, bind `x_user_id` to the account row and set `seed_handle` to the handle at claim time.

- Bind to the **numeric ID**, never the handle string.
- Freeze `seed_handle` at claim; a subsequent rename updates `current_handle` only.
- Unclaimed handles still accumulate instances. Claiming links the existing cluster to the account; it does not create it.
- Claiming confers display control, not generative control. A claimant cannot alter, reorder or delete instances.

---

## 11. Monitoring

Three dashboards. All three exist to make regime change **visible**, since it cannot be prevented.

**Label marginals.** Frequency of each level on each axis over time. A model swap shows up as a step change in the distribution. Alert on distribution shift.

**Envelope utilisation.** Distribution of realised offsets. Clipping at bounds, or collapse toward the centre, both indicate the mapping table needs revisiting.

**Non-substitutability.** Measure the association between readings and observable features of the participant's recent posts. If it approaches zero, the agent has become an expensive random number generator and the work's central claim fails. This is the load-bearing metric — run it on a schedule and record the history.

---

## 12. Invariants

1. The agent emits labels and a URL. Never numbers, never geometry.
2. No valid reading produces a mark outside the envelope.
3. Offsets are computed from the canonical, never from a prior instance.
4. Instances are append-only.
5. `insufficient` maps to zero.
6. Minting is idempotent on `(handle, source_post_id)`.
7. Every instance records `spec_version`, `map_version` and `schema_version`.
8. Nothing in the agent's output — rationale, handle, code — is ever interpolated into a template, a query, or a filesystem path without validation. Treat all of it as untrusted input, because it is.

---

## 13. Open items

- Mapping table contents and envelope bounds — supplied with the algorithm.
- Whether the cluster animation orders by `sequence` or by reading similarity.
- Retention and display policy for `unverified` instances.
- Whether to publish a per-handle canonical hash list, enabling third-party verification without trusting this service.
