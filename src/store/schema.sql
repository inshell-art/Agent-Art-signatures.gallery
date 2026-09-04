-- Data model — handoff §7.
--
-- Append-only. No UPDATE, no DELETE on instances, with one narrow exception:
-- `provenance` transitions once from 'unverified' to 'verified' after async
-- post-issue verification (handoff §9.3). That's a trust status, not
-- generative content, so mutating it doesn't create the forgery risk
-- append-only exists to prevent. Every other column, and any real
-- correction, follows the append-only rule: new rows with a `supersedes`
-- pointer, never edits.

CREATE TABLE accounts (
    -- Primary key. Numeric X account ID, never the handle. Handles get
    -- renamed, released and re-registered; binding to the string would
    -- silently reassign a cluster.
    x_user_id     BIGINT PRIMARY KEY,

    -- The handle string frozen at claim time. This is what feeds the
    -- algorithm. A later rename must not split or reseed the cluster.
    seed_handle   TEXT NOT NULL,

    -- Display only. May change.
    current_handle TEXT NOT NULL,

    -- Nullable. Set on successful X OAuth claim.
    claimed_at    TIMESTAMPTZ
);

CREATE TABLE instances (
    id              BIGSERIAL PRIMARY KEY,

    -- Cluster owner. May be resolved after the fact for unclaimed handles,
    -- so this is nullable until a claim links it to an account.
    x_user_id       BIGINT REFERENCES accounts (x_user_id),

    -- Denormalised; the exact string used for generation.
    seed_handle     TEXT NOT NULL,

    -- The 4-character code (handoff §4.3).
    reading_code    CHAR(4) NOT NULL,

    -- Expanded axis->level object, for querying.
    reading_json    JSONB NOT NULL,

    -- The agent's one-line justification, verbatim, or NULL if none was
    -- supplied. Never parsed for control flow (handoff §8).
    rationale       TEXT,

    -- The participant's mention post ID.
    source_post_id  TEXT NOT NULL,

    -- The derived numeric vector, stored explicitly.
    offset_vector   JSONB NOT NULL,

    spec_version    TEXT NOT NULL,
    map_version     TEXT NOT NULL,
    schema_version  TEXT NOT NULL,

    provenance      TEXT NOT NULL CHECK (provenance IN ('verified', 'unverified')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Monotonic ordinal within the cluster.
    sequence        INTEGER NOT NULL,

    -- Append-only corrections point back at the row they correct.
    supersedes      BIGINT REFERENCES instances (id)
);

-- Idempotency key (handoff §7, §9.1, §12.6): a re-fetch by X's crawler must
-- return the existing instance, never issue a duplicate. Scoped by handle
-- rather than x_user_id since unclaimed handles must also be idempotent.
CREATE UNIQUE INDEX instances_idempotency_key
    ON instances (seed_handle, source_post_id);

CREATE INDEX instances_by_handle_sequence
    ON instances (seed_handle, sequence);
