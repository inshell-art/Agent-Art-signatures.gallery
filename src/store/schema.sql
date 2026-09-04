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

-- -------------------------------------------------------------------------
-- V1 additive model. The legacy tables above remain available read-only for
-- controlled cutover; no legacy instance is reinterpreted as a V1 signature.

CREATE TABLE x_accounts (
    x_user_id             TEXT PRIMARY KEY CHECK (x_user_id ~ '^(0|[1-9][0-9]*)$'),
    public_account_id     TEXT NOT NULL UNIQUE CHECK (public_account_id ~ '^xa1_[a-z2-7]{26}$'),
    current_handle        TEXT NOT NULL CHECK (current_handle ~ '^[A-Za-z0-9_]{1,15}$'),
    handle_normalized     TEXT NOT NULL CHECK (handle_normalized ~ '^[a-z0-9_]{1,15}$'),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_authenticated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE signatures (
    signature_id          TEXT PRIMARY KEY CHECK (signature_id ~ '^sg1_[a-z2-7]{52}$'),
    x_user_id             TEXT NOT NULL REFERENCES x_accounts (x_user_id),
    handle_at_claim       TEXT NOT NULL CHECK (handle_at_claim ~ '^[A-Za-z0-9_]{1,15}$'),
    handle_normalized     TEXT NOT NULL CHECK (handle_normalized ~ '^[a-z0-9_]{1,15}$'),
    gr0k_raw              INTEGER NOT NULL CHECK (gr0k_raw BETWEEN 0 AND 1000000),
    gr0k_scale            INTEGER NOT NULL CHECK (gr0k_scale = 1000000),
    renderer_version      TEXT NOT NULL,
    svg_sha256            TEXT NOT NULL CHECK (svg_sha256 ~ '^[0-9a-f]{64}$'),
    svg_storage_key       TEXT NOT NULL,
    card_renderer_version TEXT NOT NULL,
    png_sha256            TEXT NOT NULL CHECK (png_sha256 ~ '^[0-9a-f]{64}$'),
    card_storage_key      TEXT NOT NULL,
    claim_method          TEXT NOT NULL CHECK (claim_method = 'x_oauth_v1'),
    x_authenticated_at    TIMESTAMPTZ NOT NULL,
    claimed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (x_user_id, handle_normalized, gr0k_raw, gr0k_scale, renderer_version)
);

CREATE INDEX signatures_by_owner_claimed_at
    ON signatures (x_user_id, claimed_at DESC);

CREATE OR REPLACE FUNCTION reject_signature_update() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'V1 signatures are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signatures_are_immutable
    BEFORE UPDATE ON signatures
    FOR EACH ROW EXECUTE FUNCTION reject_signature_update();
