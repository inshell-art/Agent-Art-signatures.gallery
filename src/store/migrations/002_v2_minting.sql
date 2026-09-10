-- signatures.gallery V2 minting schema
--
-- Additive to src/store/schema.sql.  V1 identity and artwork columns remain
-- untouched.  Values with Ethereum integer semantics use NUMERIC domains so
-- application code can exchange decimal strings without unsafe JS numbers.

BEGIN;

CREATE OR REPLACE FUNCTION v2_is_nonzero_bytes32(value BYTEA)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT octet_length(value) = 32
       AND value <> decode(repeat('00', 32), 'hex');
$$;

CREATE OR REPLACE FUNCTION v2_is_canonical_eoa_signature(value BYTEA)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT octet_length(value) = 65
       AND substring(value FROM 1 FOR 32) > decode(repeat('00', 32), 'hex')
       AND substring(value FROM 1 FOR 32)
             < decode('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex')
       AND substring(value FROM 33 FOR 32) > decode(repeat('00', 32), 'hex')
       AND substring(value FROM 33 FOR 32)
             <= decode('7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0', 'hex')
       AND get_byte(value, 64) IN (27, 28);
$$;

CREATE DOMAIN v2_bytes20 AS BYTEA
    CHECK (octet_length(VALUE) = 20);

CREATE DOMAIN v2_bytes32 AS BYTEA
    CHECK (octet_length(VALUE) = 32);

CREATE DOMAIN v2_nonzero_bytes32 AS BYTEA
    CHECK (v2_is_nonzero_bytes32(VALUE));

CREATE DOMAIN v2_eoa_signature AS BYTEA
    CHECK (v2_is_canonical_eoa_signature(VALUE));

CREATE DOMAIN v2_uint32 AS NUMERIC(10, 0)
    CHECK (VALUE >= 0 AND VALUE <= 4294967295);

CREATE DOMAIN v2_uint64 AS NUMERIC(20, 0)
    CHECK (VALUE >= 0 AND VALUE <= 18446744073709551615);

CREATE DOMAIN v2_uint256 AS NUMERIC(78, 0)
    CHECK (
        VALUE >= 0
        AND VALUE <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
    );

-- Supports exact identity-pair foreign keys without changing any V1 value.
CREATE UNIQUE INDEX x_accounts_identity_pair_v2
    ON x_accounts (x_user_id, public_account_id);

CREATE TABLE mint_deployments (
    deployment_id                  UUID PRIMARY KEY,
    environment                    TEXT NOT NULL
        CHECK (environment IN ('staging', 'production')),
    chain_id                       v2_uint256 NOT NULL,
    genesis_hash                   v2_nonzero_bytes32 NOT NULL,
    contract_address               v2_bytes20 NOT NULL
        CHECK (contract_address <> decode(repeat('00', 20), 'hex')),
    deployment_block_number        v2_uint256 NOT NULL,
    deployment_block_hash          v2_nonzero_bytes32 NOT NULL,
    runtime_code_hash              v2_nonzero_bytes32 NOT NULL,
    abi_version                    TEXT NOT NULL CHECK (length(abi_version) > 0),
    eip712_name                    TEXT NOT NULL CHECK (eip712_name = 'signatures.gallery'),
    eip712_version                 TEXT NOT NULL CHECK (eip712_version = '2'),
    collection_name                TEXT NOT NULL CHECK (collection_name = 'Gallery of Signatures'),
    collection_symbol              TEXT NOT NULL CHECK (collection_symbol = 'SIGN'),
    collection_uri                 TEXT NOT NULL
        CHECK (collection_uri ~ '^ipfs://b[a-z2-7]+$'),
    collection_metadata_sha256     v2_bytes32 NOT NULL,
    collection_uri_hash            v2_bytes32 NOT NULL,
    public_artifact_origin         TEXT NOT NULL
        CHECK (public_artifact_origin ~ '^https?://[^/]+$'),
    finality_policy                TEXT NOT NULL
        CHECK (finality_policy = 'ethereum_finalized_tag_v1'),
    lifecycle_state                TEXT NOT NULL
        CHECK (lifecycle_state IN ('prepared', 'canonical', 'retired')),
    issuance_enabled               BOOLEAN NOT NULL DEFAULT FALSE,
    indexing_enabled               BOOLEAN NOT NULL DEFAULT FALSE,
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (environment = 'production' AND chain_id = 1)
        OR (environment = 'staging' AND chain_id = 11155111)
    ),
    CHECK (NOT issuance_enabled OR lifecycle_state = 'canonical'),
    UNIQUE (chain_id, contract_address),
    UNIQUE (deployment_id, finality_policy)
);

CREATE UNIQUE INDEX mint_deployments_one_canonical_environment
    ON mint_deployments (environment)
    WHERE lifecycle_state = 'canonical';

CREATE INDEX mint_deployments_operational_gates
    ON mint_deployments (environment, lifecycle_state, issuance_enabled, indexing_enabled);

-- This durable row deliberately has no FK to signatures: after a safely
-- unminted erasure it remains as the non-personal, never-reenable tombstone.
CREATE TABLE signature_mint_controls (
    signature_id               TEXT PRIMARY KEY
        CHECK (signature_id ~ '^sg1_[a-z2-7]{52}$'),
    issuance_state             TEXT NOT NULL
        CHECK (issuance_state IN ('enabled', 'blocked', 'erasure_pending', 'erased')),
    version                    BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    broad_reason_class         TEXT,
    publication_fencing_token BIGINT NOT NULL DEFAULT 0
        CHECK (publication_fencing_token >= 0),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (issuance_state = 'enabled' AND broad_reason_class IS NULL)
        OR (issuance_state <> 'enabled' AND broad_reason_class IS NOT NULL
            AND length(broad_reason_class) > 0)
    )
);

CREATE INDEX signature_mint_controls_by_state
    ON signature_mint_controls (issuance_state, updated_at);

CREATE TABLE wallet_binding_challenges (
    challenge_id               TEXT PRIMARY KEY
        CHECK (length(challenge_id) BETWEEN 8 AND 128),
    bound_session_id_digest    v2_bytes32 NOT NULL,
    x_user_id                  TEXT NOT NULL,
    public_account_id          TEXT NOT NULL,
    wallet_address             v2_bytes20 NOT NULL
        CHECK (wallet_address <> decode(repeat('00', 20), 'hex')),
    chain_id                   v2_uint256 NOT NULL
        CHECK (chain_id IN (1, 11155111)),
    purpose                    TEXT NOT NULL CHECK (purpose = 'mint_wallet_binding_v1'),
    nonce_digest               v2_bytes32 NOT NULL,
    exact_siwe_message         TEXT NOT NULL
        CHECK (
            length(exact_siwe_message) > 0
            AND position(E'\r' IN exact_siwe_message) = 0
            AND right(exact_siwe_message, 1) <> E'\n'
        ),
    status                     TEXT NOT NULL
        CHECK (status IN ('pending', 'processing', 'consumed', 'failed', 'expired')),
    x_authenticated_at         TIMESTAMPTZ NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at                 TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (x_user_id, public_account_id)
        REFERENCES x_accounts (x_user_id, public_account_id) ON DELETE RESTRICT,
    CHECK (created_at >= x_authenticated_at),
    CHECK (expires_at > created_at),
    CHECK (expires_at <= created_at + INTERVAL '10 minutes'),
    CHECK (expires_at <= x_authenticated_at + INTERVAL '15 minutes')
);

CREATE UNIQUE INDEX wallet_binding_challenges_nonce_once
    ON wallet_binding_challenges (nonce_digest);

CREATE INDEX wallet_binding_challenges_pending_expiry
    ON wallet_binding_challenges (expires_at)
    WHERE status IN ('pending', 'processing');

CREATE INDEX wallet_binding_challenges_by_session
    ON wallet_binding_challenges (bound_session_id_digest, x_user_id, status);

CREATE TABLE wallet_binding_heads (
    x_user_id                TEXT NOT NULL REFERENCES x_accounts (x_user_id) ON DELETE RESTRICT,
    chain_id                 v2_uint256 NOT NULL CHECK (chain_id IN (1, 11155111)),
    active_wallet_binding_id v2_nonzero_bytes32,
    version                  BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (x_user_id, chain_id)
);

CREATE TABLE wallet_bindings (
    wallet_binding_id        v2_nonzero_bytes32 PRIMARY KEY,
    x_user_id                TEXT NOT NULL REFERENCES x_accounts (x_user_id) ON DELETE RESTRICT,
    chain_id                 v2_uint256 NOT NULL CHECK (chain_id IN (1, 11155111)),
    wallet_address           v2_bytes20 NOT NULL
        CHECK (wallet_address <> decode(repeat('00', 20), 'hex')),
    proof_scheme             TEXT NOT NULL CHECK (proof_scheme = 'eoa_siwe_v1'),
    siwe_message             TEXT NOT NULL
        CHECK (
            length(siwe_message) > 0
            AND position(E'\r' IN siwe_message) = 0
            AND right(siwe_message, 1) <> E'\n'
        ),
    siwe_message_hash        v2_bytes32 NOT NULL,
    wallet_proof             v2_eoa_signature NOT NULL,
    verification_block_number v2_uint256 NOT NULL,
    verification_block_hash v2_nonzero_bytes32 NOT NULL,
    x_authenticated_at       TIMESTAMPTZ NOT NULL,
    proved_at                TIMESTAMPTZ NOT NULL,
    activated_at             TIMESTAMPTZ NOT NULL,
    ended_at                 TIMESTAMPTZ,
    end_reason               TEXT CHECK (end_reason IN ('rebound', 'revoked')),
    CHECK (
        (ended_at IS NULL AND end_reason IS NULL)
        OR (ended_at IS NOT NULL AND end_reason IS NOT NULL AND ended_at >= activated_at)
    ),
    CHECK (proved_at >= x_authenticated_at),
    CHECK (proved_at <= x_authenticated_at + INTERVAL '15 minutes'),
    CHECK (activated_at >= proved_at),
    UNIQUE (wallet_binding_id, x_user_id, chain_id),
    UNIQUE (wallet_binding_id, wallet_address)
);

CREATE UNIQUE INDEX wallet_bindings_one_active_per_identity_chain
    ON wallet_bindings (x_user_id, chain_id)
    WHERE ended_at IS NULL;

CREATE INDEX wallet_bindings_by_wallet
    ON wallet_bindings (chain_id, wallet_address, activated_at DESC);

ALTER TABLE wallet_binding_heads
    ADD CONSTRAINT wallet_binding_heads_active_binding_fk
    FOREIGN KEY (active_wallet_binding_id, x_user_id, chain_id)
    REFERENCES wallet_bindings (wallet_binding_id, x_user_id, chain_id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE token_metadata (
    signature_id                 TEXT NOT NULL REFERENCES signatures (signature_id) ON DELETE RESTRICT,
    deployment_id                UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    metadata_version             TEXT NOT NULL CHECK (metadata_version = 'sg-nft-metadata-1.0.0'),
    svg_cid                      TEXT NOT NULL CHECK (svg_cid ~ '^b[a-z2-7]+$'),
    png_cid                      TEXT NOT NULL CHECK (png_cid ~ '^b[a-z2-7]+$'),
    metadata_cid                 TEXT NOT NULL CHECK (metadata_cid ~ '^b[a-z2-7]+$'),
    svg_sha256                   v2_bytes32 NOT NULL,
    png_sha256                   v2_bytes32 NOT NULL,
    metadata_sha256              v2_bytes32 NOT NULL,
    token_uri                    TEXT NOT NULL CHECK (token_uri ~ '^ipfs://b[a-z2-7]+$'),
    token_uri_hash               v2_bytes32 NOT NULL,
    canonical_json_storage_key   TEXT NOT NULL CHECK (length(canonical_json_storage_key) > 0),
    pin_provider_receipts        JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(pin_provider_receipts) = 'array'),
    preparation_state            TEXT NOT NULL
        CHECK (preparation_state IN (
            'reserved', 'publishing', 'verified', 'frozen', 'aborting', 'aborted'
        )),
    control_version              BIGINT NOT NULL CHECK (control_version > 0),
    lease_owner                  TEXT,
    lease_expires_at             TIMESTAMPTZ,
    fencing_token                BIGINT NOT NULL CHECK (fencing_token >= 0),
    cleanup_state                TEXT NOT NULL DEFAULT 'none' CHECK (length(cleanup_state) > 0),
    prepared_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at                  TIMESTAMPTZ,
    frozen_at                    TIMESTAMPTZ,
    PRIMARY KEY (signature_id, deployment_id),
    FOREIGN KEY (signature_id)
        REFERENCES signature_mint_controls (signature_id) ON DELETE RESTRICT,
    CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND length(lease_owner) > 0
            AND lease_expires_at IS NOT NULL)
    ),
    CHECK (
        preparation_state NOT IN ('verified', 'frozen')
        OR verified_at IS NOT NULL
    ),
    CHECK (preparation_state <> 'frozen' OR frozen_at IS NOT NULL),
    CHECK (preparation_state <> 'frozen' OR lease_owner IS NULL),
    CHECK (
        preparation_state NOT IN ('verified', 'frozen')
        OR jsonb_array_length(pin_provider_receipts) >= 2
    ),
    CHECK (token_uri = 'ipfs://' || metadata_cid),
    CHECK (verified_at IS NULL OR verified_at >= prepared_at),
    CHECK (frozen_at IS NULL OR (verified_at IS NOT NULL AND frozen_at >= verified_at))
);

CREATE INDEX token_metadata_preparation_work
    ON token_metadata (preparation_state, lease_expires_at);

CREATE INDEX token_metadata_by_deployment_state
    ON token_metadata (deployment_id, preparation_state);

CREATE TABLE mint_authorizations (
    authorization_id        v2_nonzero_bytes32 PRIMARY KEY,
    signature_id            TEXT NOT NULL,
    deployment_id           UUID NOT NULL,
    wallet_binding_id       v2_nonzero_bytes32 NOT NULL,
    mint_wallet             v2_bytes20 NOT NULL
        CHECK (mint_wallet <> decode(repeat('00', 20), 'hex')),
    signature_digest        v2_bytes32 NOT NULL,
    svg_sha256              v2_bytes32 NOT NULL,
    png_sha256              v2_bytes32 NOT NULL,
    metadata_sha256         v2_bytes32 NOT NULL,
    token_uri               TEXT NOT NULL CHECK (token_uri ~ '^ipfs://b[a-z2-7]+$'),
    token_uri_hash          v2_bytes32 NOT NULL,
    valid_after             TIMESTAMPTZ NOT NULL,
    deadline                TIMESTAMPTZ NOT NULL,
    authorizer_epoch        v2_uint32 NOT NULL CHECK (authorizer_epoch > 0),
    authorizer_address      v2_bytes20 NOT NULL
        CHECK (authorizer_address <> decode(repeat('00', 20), 'hex')),
    signer_key_version      TEXT NOT NULL CHECK (length(signer_key_version) > 0),
    signer_request_id       TEXT NOT NULL
        CHECK (
            signer_request_id = lower(signer_request_id)
            AND signer_request_id ~ '^[a-z0-9:_-]+$'
        ),
    typed_data_digest       v2_bytes32 NOT NULL,
    gallery_attestation     v2_eoa_signature,
    issuance_state          TEXT NOT NULL
        CHECK (issuance_state IN ('prepared', 'issued', 'signing_failed', 'signing_unknown')),
    chain_state             TEXT NOT NULL DEFAULT 'unseen'
        CHECK (chain_state IN (
            'unseen', 'observed_used_unfinalized', 'consumed_finalized',
            'revoked_unfinalized', 'revoked_finalized', 'orphaned_use',
            'expired_unconsumed'
        )),
    signer_audit_state      TEXT NOT NULL CHECK (length(signer_audit_state) > 0),
    last_signing_error_class TEXT,
    prepared_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    issued_at               TIMESTAMPTZ,
    -- Filled only when a finalized, pinned contract read plus contiguous
    -- finalized coverage proves an unused authorization safely expired.  The
    -- evidence lives on the row so a controlled erasure trigger can inspect
    -- OLD without racing deletion of a child evidence record.
    terminal_evidence_kind  TEXT
        CHECK (terminal_evidence_kind IS NULL OR terminal_evidence_kind = 'expired_unconsumed'),
    terminal_evidence_block_number v2_uint256,
    terminal_evidence_block_hash v2_bytes32,
    terminal_evidence_primary_hash v2_bytes32,
    terminal_evidence_secondary_hash v2_bytes32,
    terminal_evidence_authorization_state SMALLINT
        CHECK (terminal_evidence_authorization_state IS NULL OR terminal_evidence_authorization_state IN (0, 1, 2)),
    terminal_evidence_minted_signature BOOLEAN,
    terminal_evidence_finalized_coverage BOOLEAN,
    terminal_evidence_read_mode TEXT
        CHECK (
            terminal_evidence_read_mode IS NULL
            OR terminal_evidence_read_mode IN ('eip1898_block_hash', 'block_number_hash_fenced')
        ),
    terminal_evidence_validation_version TEXT,
    terminal_evidence_observed_at TIMESTAMPTZ,
    FOREIGN KEY (signature_id, deployment_id)
        REFERENCES token_metadata (signature_id, deployment_id) ON DELETE RESTRICT,
    FOREIGN KEY (wallet_binding_id, mint_wallet)
        REFERENCES wallet_bindings (wallet_binding_id, wallet_address) ON DELETE RESTRICT,
    CHECK (deadline = valid_after + INTERVAL '15 minutes'),
    CHECK (
        (issuance_state = 'issued' AND gallery_attestation IS NOT NULL AND issued_at IS NOT NULL)
        OR (issuance_state <> 'issued' AND gallery_attestation IS NULL AND issued_at IS NULL)
    ),
    CHECK (
        (terminal_evidence_kind IS NULL
            AND terminal_evidence_block_number IS NULL
            AND terminal_evidence_block_hash IS NULL
            AND terminal_evidence_primary_hash IS NULL
            AND terminal_evidence_secondary_hash IS NULL
            AND terminal_evidence_authorization_state IS NULL
            AND terminal_evidence_minted_signature IS NULL
            AND terminal_evidence_finalized_coverage IS NULL
            AND terminal_evidence_read_mode IS NULL
            AND terminal_evidence_validation_version IS NULL
            AND terminal_evidence_observed_at IS NULL)
        OR
        (terminal_evidence_kind = 'expired_unconsumed'
            AND terminal_evidence_block_number IS NOT NULL
            AND terminal_evidence_block_hash IS NOT NULL
            AND terminal_evidence_primary_hash IS NOT NULL
            AND terminal_evidence_secondary_hash IS NOT NULL
            AND terminal_evidence_authorization_state = 0
            AND terminal_evidence_minted_signature = FALSE
            AND terminal_evidence_finalized_coverage = TRUE
            AND terminal_evidence_read_mode IS NOT NULL
            AND terminal_evidence_validation_version IS NOT NULL
            AND length(terminal_evidence_validation_version) > 0
            AND terminal_evidence_observed_at IS NOT NULL)
    ),
    CHECK (
        (chain_state = 'expired_unconsumed' AND terminal_evidence_kind = 'expired_unconsumed')
        OR (chain_state <> 'expired_unconsumed' AND terminal_evidence_kind IS NULL)
    ),
    CHECK (right(signer_request_id, 64) = encode(authorization_id, 'hex')),
    UNIQUE (deployment_id, signer_request_id),
    UNIQUE (authorization_id, deployment_id),
    UNIQUE (authorization_id, signature_id, deployment_id),
    UNIQUE (authorization_id, deployment_id, mint_wallet)
);

CREATE INDEX mint_authorizations_by_signature
    ON mint_authorizations (signature_id, deployment_id, prepared_at DESC);

CREATE INDEX mint_authorizations_binding_guard
    ON mint_authorizations (wallet_binding_id, deadline, issuance_state, chain_state);

CREATE INDEX mint_authorizations_signing_recovery
    ON mint_authorizations (prepared_at)
    WHERE issuance_state IN ('prepared', 'signing_unknown');

CREATE INDEX mint_authorizations_chain_reconciliation
    ON mint_authorizations (deployment_id, deadline, chain_state);

-- The unresolved slot is durable state, never a wall-clock partial-index
-- predicate.  A row leaves it only through a database-validated definitive
-- signer failure or finalized chain terminal state.  The first index is the
-- exact idempotency slot; the second prevents a concurrent authorization for a
-- different wallet/binding for the same signature and deployment.
CREATE UNIQUE INDEX mint_authorizations_one_unresolved_binding_slot
    ON mint_authorizations (signature_id, deployment_id, wallet_binding_id)
    WHERE issuance_state <> 'signing_failed'
      AND chain_state NOT IN ('consumed_finalized', 'revoked_finalized', 'expired_unconsumed');

CREATE UNIQUE INDEX mint_authorizations_no_conflicting_wallet_slot
    ON mint_authorizations (signature_id, deployment_id)
    WHERE issuance_state <> 'signing_failed'
      AND chain_state NOT IN ('consumed_finalized', 'revoked_finalized', 'expired_unconsumed');

CREATE TABLE mint_attempts (
    attempt_id             UUID PRIMARY KEY,
    authorization_id       v2_nonzero_bytes32 NOT NULL,
    deployment_id          UUID NOT NULL,
    tx_hash                v2_nonzero_bytes32 NOT NULL,
    sender                 v2_bytes20 NOT NULL
        CHECK (sender <> decode(repeat('00', 20), 'hex')),
    transaction_nonce      v2_uint256 NOT NULL,
    first_reported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    first_rpc_seen_at      TIMESTAMPTZ,
    last_rpc_seen_at       TIMESTAMPTZ,
    receipt_status         TEXT NOT NULL DEFAULT 'unknown'
        CHECK (receipt_status IN ('unknown', 'success', 'revert')),
    state                  TEXT NOT NULL
        CHECK (state IN (
            'reported', 'seen_pending', 'stale_unknown', 'included_success',
            'included_revert', 'included_without_event', 'replaced', 'orphaned',
            'finalized_success', 'finalized_revert'
        )),
    failure_code           TEXT,
    FOREIGN KEY (authorization_id, deployment_id, sender)
        REFERENCES mint_authorizations (authorization_id, deployment_id, mint_wallet)
        ON DELETE RESTRICT,
    CHECK (
        (first_rpc_seen_at IS NULL AND last_rpc_seen_at IS NULL)
        OR (first_rpc_seen_at IS NOT NULL AND last_rpc_seen_at IS NOT NULL
            AND last_rpc_seen_at >= first_rpc_seen_at)
    ),
    CHECK (
        state NOT IN ('included_success', 'included_without_event', 'finalized_success')
        OR receipt_status = 'success'
    ),
    CHECK (
        state NOT IN ('included_revert', 'finalized_revert')
        OR receipt_status = 'revert'
    ),
    UNIQUE (deployment_id, tx_hash),
    UNIQUE (attempt_id, deployment_id)
);

CREATE INDEX mint_attempts_by_authorization
    ON mint_attempts (authorization_id, first_reported_at DESC);

CREATE INDEX mint_attempts_reconciliation_work
    ON mint_attempts (deployment_id, state, last_rpc_seen_at);

CREATE TABLE chain_blocks (
    deployment_id         UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    block_number          v2_uint256 NOT NULL,
    block_hash            v2_nonzero_bytes32 NOT NULL,
    parent_hash           v2_bytes32 NOT NULL,
    block_timestamp       TIMESTAMPTZ NOT NULL,
    canonical             BOOLEAN NOT NULL,
    finalized             BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    orphaned_at           TIMESTAMPTZ,
    PRIMARY KEY (deployment_id, block_hash),
    UNIQUE (deployment_id, block_hash, block_number),
    CHECK (NOT finalized OR canonical),
    CHECK (
        (canonical AND orphaned_at IS NULL)
        OR (NOT canonical AND orphaned_at IS NOT NULL)
    ),
    CHECK (orphaned_at IS NULL OR orphaned_at >= observed_at)
);

CREATE UNIQUE INDEX chain_blocks_one_canonical_hash_per_height
    ON chain_blocks (deployment_id, block_number)
    WHERE canonical;

CREATE INDEX chain_blocks_finalized_scan
    ON chain_blocks (deployment_id, finalized, block_number DESC);

ALTER TABLE mint_authorizations
    ADD CONSTRAINT mint_authorizations_terminal_evidence_block_fk
    FOREIGN KEY (
        deployment_id, terminal_evidence_block_hash,
        terminal_evidence_block_number
    ) REFERENCES chain_blocks (deployment_id, block_hash, block_number)
    ON DELETE RESTRICT;

CREATE TABLE transaction_receipt_observations (
    deployment_id         UUID NOT NULL,
    block_hash            v2_nonzero_bytes32 NOT NULL,
    block_number          v2_uint256 NOT NULL,
    tx_hash               v2_nonzero_bytes32 NOT NULL,
    receipt_status        SMALLINT NOT NULL CHECK (receipt_status IN (0, 1)),
    transaction_index     v2_uint64 NOT NULL,
    gas_used              v2_uint256 NOT NULL,
    canonical             BOOLEAN NOT NULL,
    finalized             BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    orphaned_at           TIMESTAMPTZ,
    PRIMARY KEY (deployment_id, block_hash, tx_hash),
    FOREIGN KEY (deployment_id, block_hash, block_number)
        REFERENCES chain_blocks (deployment_id, block_hash, block_number) ON DELETE RESTRICT,
    CHECK (NOT finalized OR canonical),
    CHECK (
        (canonical AND orphaned_at IS NULL)
        OR (NOT canonical AND orphaned_at IS NOT NULL)
    ),
    CHECK (orphaned_at IS NULL OR orphaned_at >= observed_at)
);

CREATE INDEX transaction_receipts_by_tx
    ON transaction_receipt_observations (deployment_id, tx_hash, observed_at DESC);

CREATE INDEX transaction_receipts_finality
    ON transaction_receipt_observations (deployment_id, finalized, block_number DESC);

CREATE TABLE contract_log_observations (
    event_observation_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    deployment_id         UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    block_hash            v2_nonzero_bytes32 NOT NULL,
    block_number          v2_uint256 NOT NULL,
    tx_hash               v2_nonzero_bytes32 NOT NULL,
    transaction_index     v2_uint64 NOT NULL,
    log_index             v2_uint64 NOT NULL,
    receipt_status        SMALLINT NOT NULL CHECK (receipt_status IN (0, 1)),
    event_kind            TEXT NOT NULL
        CHECK (event_kind IN (
            'signature_minted', 'transfer', 'authorizer_epoch_added',
            'authorizer_epoch_revoked', 'authorization_revoked',
            'mint_paused', 'mint_unpaused', 'role_granted', 'role_revoked',
            'role_admin_changed'
        )),
    topic0                 v2_bytes32 NOT NULL,
    topic1                 v2_bytes32,
    topic2                 v2_bytes32,
    topic3                 v2_bytes32,
    raw_data               BYTEA NOT NULL,
    signature_id           TEXT,
    signature_digest       v2_bytes32,
    authorization_id       v2_bytes32,
    mint_wallet            v2_bytes20,
    token_id               v2_uint256,
    wallet_binding_id      v2_bytes32,
    svg_sha256             v2_bytes32,
    png_sha256             v2_bytes32,
    metadata_sha256        v2_bytes32,
    token_uri_hash         v2_bytes32,
    authorizer_epoch       v2_uint32,
    authorization_digest   v2_bytes32,
    transfer_from          v2_bytes20,
    transfer_to            v2_bytes20,
    control_authorizer     v2_bytes20,
    decoded_payload        JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(decoded_payload) = 'object'),
    abi_version            TEXT NOT NULL CHECK (length(abi_version) > 0),
    validation_version     TEXT NOT NULL CHECK (length(validation_version) > 0),
    canonical              BOOLEAN NOT NULL,
    orphaned               BOOLEAN NOT NULL DEFAULT FALSE,
    validation_state       TEXT NOT NULL DEFAULT 'validation_pending'
        CHECK (validation_state IN ('validation_pending', 'validated', 'quarantined')),
    quarantine_code        TEXT,
    finality_state         TEXT NOT NULL DEFAULT 'unfinalized'
        CHECK (finality_state IN ('unfinalized', 'finalized', 'finality_revoked')),
    first_observed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    orphaned_at            TIMESTAMPTZ,
    UNIQUE (deployment_id, block_hash, tx_hash, log_index),
    UNIQUE (event_observation_id, deployment_id),
    UNIQUE (event_observation_id, signature_id, deployment_id),
    FOREIGN KEY (deployment_id, block_hash, block_number)
        REFERENCES chain_blocks (deployment_id, block_hash, block_number) ON DELETE RESTRICT,
    FOREIGN KEY (deployment_id, block_hash, tx_hash)
        REFERENCES transaction_receipt_observations (deployment_id, block_hash, tx_hash)
        ON DELETE RESTRICT,
    CHECK (
        (canonical AND NOT orphaned AND orphaned_at IS NULL)
        OR (NOT canonical AND orphaned AND orphaned_at IS NOT NULL)
    ),
    CHECK (last_observed_at >= first_observed_at),
    CHECK (finality_state <> 'finalized' OR canonical),
    CHECK (finality_state <> 'finality_revoked' OR orphaned),
    CHECK (
        (validation_state = 'quarantined' AND quarantine_code IS NOT NULL)
        OR (validation_state <> 'quarantined' AND quarantine_code IS NULL)
    ),
    CHECK (receipt_status = 1 OR validation_state = 'quarantined'),
    CHECK (
        event_kind <> 'signature_minted'
        OR (
            signature_digest IS NOT NULL AND authorization_id IS NOT NULL
            AND mint_wallet IS NOT NULL AND token_id IS NOT NULL
            AND wallet_binding_id IS NOT NULL AND svg_sha256 IS NOT NULL
            AND png_sha256 IS NOT NULL AND metadata_sha256 IS NOT NULL
            AND token_uri_hash IS NOT NULL AND authorizer_epoch IS NOT NULL
            AND authorization_digest IS NOT NULL
        )
    ),
    CHECK (
        event_kind <> 'transfer'
        OR (transfer_from IS NOT NULL AND transfer_to IS NOT NULL AND token_id IS NOT NULL)
    ),
    CHECK (
        event_kind NOT IN ('authorizer_epoch_added', 'authorizer_epoch_revoked')
        OR (authorizer_epoch IS NOT NULL AND control_authorizer IS NOT NULL)
    ),
    CHECK (event_kind <> 'authorization_revoked' OR authorization_id IS NOT NULL)
);

CREATE INDEX contract_logs_chain_order
    ON contract_log_observations (
        deployment_id, block_number, transaction_index, log_index
    );

CREATE INDEX contract_logs_reconciliation
    ON contract_log_observations (
        deployment_id, canonical, finality_state, validation_state, block_number
    );

CREATE INDEX contract_logs_by_authorization
    ON contract_log_observations (deployment_id, authorization_id)
    WHERE authorization_id IS NOT NULL;

CREATE INDEX contract_logs_by_token
    ON contract_log_observations (deployment_id, token_id, block_number, log_index)
    WHERE token_id IS NOT NULL;

CREATE TABLE mint_aggregates (
    signature_id             TEXT NOT NULL REFERENCES signatures (signature_id) ON DELETE RESTRICT,
    deployment_id            UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    state                    TEXT NOT NULL
        CHECK (state IN (
            'unminted', 'authorized', 'submitted', 'included_unfinalized',
            'finalized', 'validation_pending', 'quarantined', 'finality_revoked'
        )),
    active_authorization_id  v2_nonzero_bytes32,
    canonical_event_id       BIGINT,
    failure_code             TEXT,
    projection_version       BIGINT NOT NULL CHECK (projection_version > 0),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (signature_id, deployment_id),
    FOREIGN KEY (active_authorization_id, signature_id, deployment_id)
        REFERENCES mint_authorizations (authorization_id, signature_id, deployment_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (canonical_event_id, signature_id, deployment_id)
        REFERENCES contract_log_observations (
            event_observation_id, signature_id, deployment_id
        ) ON DELETE RESTRICT
);

CREATE INDEX mint_aggregates_by_state
    ON mint_aggregates (deployment_id, state, updated_at);

CREATE TABLE gallery_entries (
    signature_id             TEXT NOT NULL REFERENCES signatures (signature_id) ON DELETE RESTRICT,
    deployment_id            UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    canonical_event_id       BIGINT NOT NULL,
    token_id                 v2_uint256 NOT NULL,
    mint_wallet              v2_bytes20 NOT NULL
        CHECK (mint_wallet <> decode(repeat('00', 20), 'hex')),
    tx_hash                  v2_nonzero_bytes32 NOT NULL,
    block_number             v2_uint256 NOT NULL,
    block_hash               v2_nonzero_bytes32 NOT NULL,
    transaction_index        v2_uint64 NOT NULL,
    log_index                v2_uint64 NOT NULL,
    minted_at                TIMESTAMPTZ NOT NULL,
    finalized_at             TIMESTAMPTZ NOT NULL,
    chain_state              TEXT NOT NULL
        CHECK (chain_state IN ('finalized', 'finality_revoked')),
    PRIMARY KEY (signature_id, deployment_id),
    FOREIGN KEY (canonical_event_id, signature_id, deployment_id)
        REFERENCES contract_log_observations (
            event_observation_id, signature_id, deployment_id
        ) ON DELETE RESTRICT,
    CHECK (finalized_at >= minted_at),
    UNIQUE (deployment_id, token_id),
    UNIQUE (canonical_event_id)
);

CREATE INDEX gallery_entries_public_order
    ON gallery_entries (
        deployment_id, block_number DESC, transaction_index DESC,
        log_index DESC, signature_id
    )
    WHERE chain_state = 'finalized';

-- No FK to signatures: this durable override must survive a local erasure.
CREATE TABLE gallery_suppressions (
    signature_id          TEXT NOT NULL
        CHECK (signature_id ~ '^sg1_[a-z2-7]{52}$'),
    deployment_id         UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    status                TEXT NOT NULL CHECK (status = 'suppressed'),
    broad_reason_class    TEXT NOT NULL CHECK (length(broad_reason_class) > 0),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (signature_id, deployment_id),
    FOREIGN KEY (signature_id)
        REFERENCES signature_mint_controls (signature_id) ON DELETE RESTRICT
);

CREATE INDEX gallery_suppressions_by_deployment
    ON gallery_suppressions (deployment_id, created_at DESC);

CREATE TABLE token_holders (
    deployment_id              UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    token_id                   v2_uint256 NOT NULL,
    signature_id               TEXT NOT NULL REFERENCES signatures (signature_id) ON DELETE RESTRICT,
    current_holder             v2_bytes20,
    provisional_holder         v2_bytes20,
    last_transfer_block_number v2_uint256,
    last_transfer_block_hash   v2_bytes32,
    last_transfer_tx_hash      v2_bytes32,
    last_transfer_log_index    v2_uint64,
    projection_version         BIGINT NOT NULL CHECK (projection_version > 0),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (deployment_id, token_id),
    UNIQUE (signature_id, deployment_id),
    CHECK (current_holder IS NULL OR current_holder <> decode(repeat('00', 20), 'hex')),
    CHECK (provisional_holder IS NULL OR provisional_holder <> decode(repeat('00', 20), 'hex')),
    CHECK (
        (last_transfer_block_number IS NULL AND last_transfer_block_hash IS NULL
            AND last_transfer_tx_hash IS NULL AND last_transfer_log_index IS NULL)
        OR (last_transfer_block_number IS NOT NULL AND last_transfer_block_hash IS NOT NULL
            AND last_transfer_tx_hash IS NOT NULL AND last_transfer_log_index IS NOT NULL)
    )
);

CREATE INDEX token_holders_by_signature
    ON token_holders (signature_id, deployment_id);

CREATE TABLE indexer_checkpoints (
    deployment_id             UUID PRIMARY KEY REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    scanned_height            v2_uint256,
    scanned_hash              v2_bytes32,
    promoted_finalized_height v2_uint256,
    promoted_finalized_hash   v2_bytes32,
    lease_owner               TEXT,
    lease_expires_at          TIMESTAMPTZ,
    fencing_token             BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    finality_policy           TEXT NOT NULL CHECK (finality_policy = 'ethereum_finalized_tag_v1'),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (deployment_id, finality_policy)
        REFERENCES mint_deployments (deployment_id, finality_policy) ON DELETE RESTRICT,
    CHECK ((scanned_height IS NULL) = (scanned_hash IS NULL)),
    CHECK ((promoted_finalized_height IS NULL) = (promoted_finalized_hash IS NULL)),
    CHECK (
        promoted_finalized_height IS NULL
        OR (scanned_height IS NOT NULL AND promoted_finalized_height <= scanned_height)
    ),
    CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND length(lease_owner) > 0
            AND lease_expires_at IS NOT NULL)
    )
);

CREATE INDEX indexer_checkpoints_leases
    ON indexer_checkpoints (lease_expires_at)
    WHERE lease_owner IS NOT NULL;

-- Non-personal reconciliation receipt retained with the durable mint-control
-- tombstone.  It is required before controlled deletion of authorization or
-- V1 identity rows, including the definitive signer-failure path.  This is
-- intentionally separate from a wall-clock expiry: the row commits to the
-- exact finalized block used for contiguous coverage and pinned contract reads.
CREATE TABLE signature_erasure_chain_evidence (
    signature_id                  TEXT NOT NULL,
    deployment_id                 UUID NOT NULL,
    finalized_block_number        v2_uint256 NOT NULL,
    finalized_block_hash          v2_nonzero_bytes32 NOT NULL,
    primary_provider_block_hash   v2_nonzero_bytes32 NOT NULL,
    secondary_provider_block_hash v2_nonzero_bytes32 NOT NULL,
    covered_through_deadline      TIMESTAMPTZ NOT NULL,
    pinned_minted_signature       BOOLEAN NOT NULL CHECK (NOT pinned_minted_signature),
    pinned_authorizations_verified BOOLEAN NOT NULL CHECK (pinned_authorizations_verified),
    contiguous_finalized_coverage BOOLEAN NOT NULL CHECK (contiguous_finalized_coverage),
    read_consistency_mode         TEXT NOT NULL
        CHECK (read_consistency_mode IN ('eip1898_block_hash', 'block_number_hash_fenced')),
    validation_version            TEXT NOT NULL CHECK (length(validation_version) > 0),
    observed_at                   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (signature_id, deployment_id),
    FOREIGN KEY (signature_id)
        REFERENCES signature_mint_controls (signature_id) ON DELETE RESTRICT,
    FOREIGN KEY (deployment_id)
        REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    FOREIGN KEY (deployment_id, finalized_block_hash, finalized_block_number)
        REFERENCES chain_blocks (deployment_id, block_hash, block_number) ON DELETE RESTRICT,
    CHECK (primary_provider_block_hash = finalized_block_hash),
    CHECK (secondary_provider_block_hash = finalized_block_hash)
);

CREATE TABLE contract_control_state (
    deployment_id             UUID PRIMARY KEY REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    mint_paused               BOOLEAN NOT NULL,
    current_authorizer_epoch  v2_uint32 NOT NULL CHECK (current_authorizer_epoch > 0),
    current_authorizer_address v2_bytes20 NOT NULL
        CHECK (current_authorizer_address <> decode(repeat('00', 20), 'hex')),
    revoked_epoch_set_digest  v2_bytes32 NOT NULL,
    last_control_event_id     BIGINT,
    projection_version        BIGINT NOT NULL CHECK (projection_version > 0),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (last_control_event_id, deployment_id)
        REFERENCES contract_log_observations (event_observation_id, deployment_id)
        ON DELETE RESTRICT
);

CREATE TABLE gallery_publication_outbox (
    outbox_id                 UUID PRIMARY KEY,
    signature_id              TEXT NOT NULL,
    deployment_id             UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    action                    TEXT NOT NULL
        CHECK (action IN ('publish', 'unpublish', 'origin_purge', 'cdn_purge', 'sitemap_refresh')),
    observed_control_version  BIGINT NOT NULL CHECK (observed_control_version > 0),
    payload                   JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(payload) = 'object'),
    state                     TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'processing', 'completed', 'failed', 'aborted')),
    available_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (signature_id)
        REFERENCES signature_mint_controls (signature_id) ON DELETE RESTRICT,
    UNIQUE (signature_id, deployment_id, action, observed_control_version)
);

CREATE INDEX gallery_publication_outbox_work
    ON gallery_publication_outbox (available_at, created_at)
    WHERE state IN ('pending', 'failed');

CREATE TABLE publication_leases (
    publication_lease_id UUID PRIMARY KEY,
    signature_id         TEXT NOT NULL,
    deployment_id        UUID NOT NULL REFERENCES mint_deployments (deployment_id) ON DELETE RESTRICT,
    control_version      BIGINT NOT NULL CHECK (control_version > 0),
    fencing_token        BIGINT NOT NULL CHECK (fencing_token > 0),
    staged_object_key    TEXT NOT NULL CHECK (length(staged_object_key) > 0),
    state                TEXT NOT NULL
        CHECK (state IN ('staging', 'ready', 'activated', 'aborted', 'expired')),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at           TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (signature_id)
        REFERENCES signature_mint_controls (signature_id) ON DELETE RESTRICT,
    CHECK (expires_at > created_at),
    UNIQUE (signature_id, deployment_id, fencing_token)
);

CREATE INDEX publication_leases_drain
    ON publication_leases (signature_id, state, expires_at)
    WHERE state IN ('staging', 'ready');

CREATE TABLE content_object_guards (
    storage_target_id TEXT NOT NULL CHECK (length(storage_target_id) > 0),
    object_key        TEXT NOT NULL CHECK (length(object_key) > 0),
    state             TEXT NOT NULL
        CHECK (state IN ('absent', 'present', 'deletion_pending')),
    fencing_token     BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    delete_after      TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (storage_target_id, object_key),
    CHECK (
        (state = 'deletion_pending' AND delete_after IS NOT NULL)
        OR (state <> 'deletion_pending' AND delete_after IS NULL)
    )
);

CREATE INDEX content_object_guards_gc
    ON content_object_guards (delete_after)
    WHERE state = 'deletion_pending';

CREATE TABLE content_object_write_leases (
    lease_id                TEXT PRIMARY KEY CHECK (length(lease_id) > 0),
    storage_target_id       TEXT NOT NULL,
    object_key              TEXT NOT NULL,
    fencing_token           BIGINT NOT NULL CHECK (fencing_token > 0),
    owner                   TEXT NOT NULL CHECK (length(owner) > 0),
    purpose                 TEXT NOT NULL CHECK (length(purpose) > 0),
    reference_kind          TEXT NOT NULL
        CHECK (reference_kind IN (
            'v1_svg', 'v1_png', 'v2_svg_pin', 'v2_png_pin', 'v2_metadata_pin'
        )),
    reference_id            TEXT NOT NULL CHECK (length(reference_id) > 0),
    control_signature_id    TEXT NOT NULL,
    control_version         BIGINT NOT NULL CHECK (control_version > 0),
    metadata_deployment_id  UUID,
    metadata_fencing_token  BIGINT CHECK (metadata_fencing_token > 0),
    metadata_lease_owner    TEXT CHECK (
        metadata_lease_owner IS NULL OR length(metadata_lease_owner) > 0
    ),
    state                   TEXT NOT NULL
        CHECK (state IN ('writing', 'committed', 'aborted', 'expired')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at              TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (storage_target_id, object_key)
        REFERENCES content_object_guards (storage_target_id, object_key) ON DELETE RESTRICT,
    FOREIGN KEY (control_signature_id)
        REFERENCES signature_mint_controls (signature_id) ON DELETE RESTRICT,
    CHECK (expires_at > created_at),
    CHECK (
        (
            reference_kind IN ('v1_svg', 'v1_png')
            AND reference_id = control_signature_id
            AND metadata_deployment_id IS NULL
            AND metadata_fencing_token IS NULL
            AND metadata_lease_owner IS NULL
        )
        OR (
            reference_kind IN ('v2_svg_pin', 'v2_png_pin', 'v2_metadata_pin')
            AND metadata_deployment_id IS NOT NULL
            AND metadata_fencing_token IS NOT NULL
            AND metadata_lease_owner IS NOT NULL
        )
    ),
    UNIQUE (lease_id, storage_target_id, object_key),
    UNIQUE (storage_target_id, object_key, fencing_token)
);

CREATE INDEX content_object_write_leases_active
    ON content_object_write_leases (storage_target_id, object_key, expires_at)
    WHERE state = 'writing';

CREATE TABLE content_object_references (
    storage_target_id       TEXT NOT NULL,
    object_key              TEXT NOT NULL,
    reference_kind          TEXT NOT NULL
        CHECK (reference_kind IN (
            'v1_svg', 'v1_png', 'v2_svg_pin', 'v2_png_pin', 'v2_metadata_pin'
        )),
    reference_id            TEXT NOT NULL CHECK (length(reference_id) > 0),
    write_lease_id          TEXT NOT NULL,
    control_signature_id    TEXT NOT NULL,
    control_version         BIGINT NOT NULL CHECK (control_version > 0),
    metadata_deployment_id  UUID,
    metadata_fencing_token  BIGINT CHECK (metadata_fencing_token > 0),
    metadata_lease_owner    TEXT CHECK (
        metadata_lease_owner IS NULL OR length(metadata_lease_owner) > 0
    ),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (storage_target_id, object_key, reference_kind, reference_id),
    FOREIGN KEY (storage_target_id, object_key)
        REFERENCES content_object_guards (storage_target_id, object_key) ON DELETE RESTRICT,
    FOREIGN KEY (write_lease_id)
        REFERENCES content_object_write_leases (lease_id) ON DELETE RESTRICT,
    FOREIGN KEY (control_signature_id)
        REFERENCES signature_mint_controls (signature_id) ON DELETE RESTRICT,
    CHECK (
        (
            reference_kind IN ('v1_svg', 'v1_png')
            AND reference_id = control_signature_id
            AND metadata_deployment_id IS NULL
            AND metadata_fencing_token IS NULL
            AND metadata_lease_owner IS NULL
        )
        OR (
            reference_kind IN ('v2_svg_pin', 'v2_png_pin', 'v2_metadata_pin')
            AND metadata_deployment_id IS NOT NULL
            AND metadata_fencing_token IS NOT NULL
            AND metadata_lease_owner IS NOT NULL
        )
    )
);

CREATE INDEX content_object_references_by_owner
    ON content_object_references (reference_kind, reference_id);

-- V2 reference ownership is deliberately canonical rather than encoded only in
-- provider receipts.  The kind remains in the identifier because the same CID
-- may legitimately contain bytes retained for more than one artifact role.
CREATE OR REPLACE FUNCTION v2_token_metadata_reference_id(
    metadata_signature_id TEXT,
    metadata_deployment_id UUID,
    metadata_reference_kind TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT metadata_signature_id || ':' || metadata_deployment_id::text
        || ':' || metadata_reference_kind
$$;

-- -------------------------------------------------------------------------
-- Database-enforced state transitions and race guards.

CREATE OR REPLACE FUNCTION v2_guard_deployment_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF ROW(
        NEW.deployment_id, NEW.environment, NEW.chain_id, NEW.genesis_hash,
        NEW.contract_address, NEW.deployment_block_number, NEW.deployment_block_hash,
        NEW.runtime_code_hash, NEW.abi_version, NEW.eip712_name, NEW.eip712_version,
        NEW.collection_name, NEW.collection_symbol, NEW.collection_uri,
        NEW.collection_metadata_sha256, NEW.collection_uri_hash,
        NEW.public_artifact_origin, NEW.finality_policy, NEW.created_at
    ) IS DISTINCT FROM ROW(
        OLD.deployment_id, OLD.environment, OLD.chain_id, OLD.genesis_hash,
        OLD.contract_address, OLD.deployment_block_number, OLD.deployment_block_hash,
        OLD.runtime_code_hash, OLD.abi_version, OLD.eip712_name, OLD.eip712_version,
        OLD.collection_name, OLD.collection_symbol, OLD.collection_uri,
        OLD.collection_metadata_sha256, OLD.collection_uri_hash,
        OLD.public_artifact_origin, OLD.finality_policy, OLD.created_at
    ) THEN
        RAISE EXCEPTION 'mint deployment manifest fields are immutable';
    END IF;

    IF OLD.lifecycle_state = 'retired' AND NEW.lifecycle_state <> 'retired' THEN
        RAISE EXCEPTION 'a retired mint deployment cannot be reactivated';
    END IF;
    IF OLD.lifecycle_state = 'canonical' AND NEW.lifecycle_state = 'prepared' THEN
        RAISE EXCEPTION 'a canonical mint deployment cannot return to prepared';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'mint deployment updated_at cannot move backwards';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER mint_deployments_guard_update
    BEFORE UPDATE ON mint_deployments
    FOR EACH ROW EXECUTE FUNCTION v2_guard_deployment_update();

CREATE OR REPLACE FUNCTION v2_guard_signature_mint_control()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'signature mint controls are durable tombstones';
    END IF;
    IF NEW.signature_id <> OLD.signature_id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'signature mint control identity is immutable';
    END IF;
    IF OLD.issuance_state = 'erased' THEN
        RAISE EXCEPTION 'an erased signature mint control cannot change';
    END IF;
    IF NEW.version < OLD.version
       OR NEW.publication_fencing_token < OLD.publication_fencing_token THEN
        RAISE EXCEPTION 'control versions and fences are monotonic';
    END IF;
    IF ROW(NEW.issuance_state, NEW.broad_reason_class)
         IS DISTINCT FROM ROW(OLD.issuance_state, OLD.broad_reason_class)
       AND NEW.version <= OLD.version THEN
        RAISE EXCEPTION 'a control-state change must advance version';
    END IF;
    IF OLD.issuance_state = 'erasure_pending'
       AND NEW.issuance_state NOT IN ('erasure_pending', 'blocked', 'erased') THEN
        RAISE EXCEPTION 'erasure_pending may only remain pending, block, or erase';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'control updated_at cannot move backwards';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER signature_mint_controls_guard
    BEFORE UPDATE OR DELETE ON signature_mint_controls
    FOR EACH ROW EXECUTE FUNCTION v2_guard_signature_mint_control();

CREATE OR REPLACE FUNCTION v2_validate_erasure_suppressions_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.issuance_state IN ('erasure_pending', 'erased')
       AND EXISTS (
           SELECT 1
             FROM mint_deployments deployment
            WHERE NOT EXISTS (
                SELECT 1
                  FROM gallery_suppressions suppression
                 WHERE suppression.signature_id = NEW.signature_id
                   AND suppression.deployment_id = deployment.deployment_id
            )
       ) THEN
        RAISE EXCEPTION 'erasure control requires suppression in every configured deployment';
    END IF;
    IF NEW.issuance_state = 'erased'
       AND EXISTS (
           SELECT 1 FROM gallery_entries
            WHERE signature_id = NEW.signature_id
       ) THEN
        RAISE EXCEPTION 'a signature with finalized mint provenance cannot be erased';
    END IF;
    IF NEW.issuance_state = 'erased'
       AND EXISTS (
            SELECT 1
              FROM contract_log_observations event
             WHERE event.signature_id = NEW.signature_id
               AND event.event_kind = 'signature_minted'
               AND event.validation_state = 'validated'
               AND event.finality_state IN ('finalized', 'finality_revoked')
       ) THEN
        RAISE EXCEPTION 'a signature with finalized chain mint evidence cannot be erased';
    END IF;
    IF NEW.issuance_state = 'erased'
       AND EXISTS (
            SELECT 1
              FROM mint_deployments deployment
             WHERE NOT v2_has_signature_erasure_chain_evidence(
                 NEW.signature_id, deployment.deployment_id, '-infinity'::timestamptz
             )
       ) THEN
        RAISE EXCEPTION 'erased control requires finalized reconciliation evidence for every deployment';
    END IF;
    IF NEW.issuance_state = 'erased'
       AND EXISTS (
           SELECT 1 FROM signatures
            WHERE signature_id = NEW.signature_id
       ) THEN
        RAISE EXCEPTION 'erase the V1 signature before sealing its mint-control tombstone';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER signature_mint_controls_erasure_suppressions
    AFTER INSERT OR UPDATE ON signature_mint_controls
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION v2_validate_erasure_suppressions_commit();

CREATE OR REPLACE FUNCTION v2_validate_deployment_suppression_copy_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF (NEW.indexing_enabled OR NEW.issuance_enabled)
       AND EXISTS (
           SELECT gated.signature_id
             FROM (
                 SELECT signature_id
                   FROM signature_mint_controls
                  WHERE issuance_state IN ('erasure_pending', 'erased')
                 UNION
                 SELECT signature_id FROM gallery_suppressions
             ) gated
            WHERE NOT EXISTS (
                SELECT 1
                  FROM gallery_suppressions suppression
                 WHERE suppression.signature_id = gated.signature_id
                   AND suppression.deployment_id = NEW.deployment_id
            )
       ) THEN
        RAISE EXCEPTION 'deployment gates require copied erasure/suppression controls';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER mint_deployments_validate_suppression_copy
    AFTER INSERT OR UPDATE ON mint_deployments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION v2_validate_deployment_suppression_copy_commit();

CREATE OR REPLACE FUNCTION v2_guard_challenge_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION 'a wallet challenge must begin pending';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(
        NEW.challenge_id, NEW.bound_session_id_digest, NEW.x_user_id,
        NEW.public_account_id, NEW.wallet_address, NEW.chain_id, NEW.purpose, NEW.nonce_digest,
        NEW.exact_siwe_message, NEW.x_authenticated_at, NEW.created_at, NEW.expires_at
    ) IS DISTINCT FROM ROW(
        OLD.challenge_id, OLD.bound_session_id_digest, OLD.x_user_id,
        OLD.public_account_id, OLD.wallet_address, OLD.chain_id, OLD.purpose, OLD.nonce_digest,
        OLD.exact_siwe_message, OLD.x_authenticated_at, OLD.created_at, OLD.expires_at
    ) THEN
        RAISE EXCEPTION 'wallet challenge payload is immutable';
    END IF;
    IF OLD.status IN ('consumed', 'failed', 'expired') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'terminal wallet challenge cannot transition';
    END IF;
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'processing', 'expired') THEN
        RAISE EXCEPTION 'invalid wallet challenge transition';
    END IF;
    IF OLD.status = 'processing'
       AND NEW.status NOT IN ('processing', 'consumed', 'failed', 'expired') THEN
        RAISE EXCEPTION 'invalid wallet challenge transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_binding_challenges_guard
    BEFORE INSERT OR UPDATE ON wallet_binding_challenges
    FOR EACH ROW EXECUTE FUNCTION v2_guard_challenge_transition();

CREATE OR REPLACE FUNCTION v2_has_finalized_consumption_evidence(
    authorization_row mint_authorizations
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM contract_log_observations event
          JOIN transaction_receipt_observations receipt
            ON receipt.deployment_id = event.deployment_id
           AND receipt.block_hash = event.block_hash
           AND receipt.tx_hash = event.tx_hash
          JOIN chain_blocks block
            ON block.deployment_id = event.deployment_id
           AND block.block_hash = event.block_hash
           AND block.block_number = event.block_number
         WHERE event.deployment_id = authorization_row.deployment_id
           AND event.event_kind = 'signature_minted'
           AND event.authorization_id = authorization_row.authorization_id
           AND event.signature_id = authorization_row.signature_id
           AND event.signature_digest = authorization_row.signature_digest
           AND event.wallet_binding_id = authorization_row.wallet_binding_id
           AND event.mint_wallet = authorization_row.mint_wallet
           AND event.svg_sha256 = authorization_row.svg_sha256
           AND event.png_sha256 = authorization_row.png_sha256
           AND event.metadata_sha256 = authorization_row.metadata_sha256
           AND event.token_uri_hash = authorization_row.token_uri_hash
           AND event.authorizer_epoch = authorization_row.authorizer_epoch
           AND event.authorization_digest = authorization_row.typed_data_digest
           AND event.receipt_status = 1
           AND event.validation_state = 'validated'
           AND event.canonical
           AND NOT event.orphaned
           AND event.finality_state = 'finalized'
           AND receipt.receipt_status = 1
           AND receipt.canonical
           AND receipt.finalized
           AND block.canonical
           AND block.finalized
    );
$$;

CREATE OR REPLACE FUNCTION v2_has_finalized_revocation_evidence(
    authorization_row mint_authorizations
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM contract_log_observations event
          JOIN transaction_receipt_observations receipt
            ON receipt.deployment_id = event.deployment_id
           AND receipt.block_hash = event.block_hash
           AND receipt.tx_hash = event.tx_hash
          JOIN chain_blocks block
            ON block.deployment_id = event.deployment_id
           AND block.block_hash = event.block_hash
           AND block.block_number = event.block_number
         WHERE event.deployment_id = authorization_row.deployment_id
           AND (
               (event.event_kind = 'authorization_revoked'
                   AND event.authorization_id = authorization_row.authorization_id)
               OR
               (event.event_kind = 'authorizer_epoch_revoked'
                   AND event.authorizer_epoch = authorization_row.authorizer_epoch)
           )
           AND event.receipt_status = 1
           AND event.validation_state = 'validated'
           AND event.canonical
           AND NOT event.orphaned
           AND event.finality_state = 'finalized'
           AND receipt.receipt_status = 1
           AND receipt.canonical
           AND receipt.finalized
           AND block.canonical
           AND block.finalized
    );
$$;

CREATE OR REPLACE FUNCTION v2_has_finalized_expiry_evidence(
    authorization_row mint_authorizations
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
       authorization_row.terminal_evidence_kind = 'expired_unconsumed'
       AND authorization_row.terminal_evidence_authorization_state = 0
       AND authorization_row.terminal_evidence_minted_signature = FALSE
       AND authorization_row.terminal_evidence_finalized_coverage = TRUE
       AND authorization_row.terminal_evidence_primary_hash
             = authorization_row.terminal_evidence_block_hash
       AND authorization_row.terminal_evidence_secondary_hash
             = authorization_row.terminal_evidence_block_hash
       AND authorization_row.terminal_evidence_observed_at IS NOT NULL
       AND EXISTS (
            SELECT 1
              FROM chain_blocks block
              JOIN indexer_checkpoints checkpoint
                ON checkpoint.deployment_id = block.deployment_id
             WHERE block.deployment_id = authorization_row.deployment_id
               AND block.block_number = authorization_row.terminal_evidence_block_number
               AND block.block_hash = authorization_row.terminal_evidence_block_hash
               AND block.canonical
               AND block.finalized
               AND block.block_timestamp > authorization_row.deadline
               AND authorization_row.terminal_evidence_observed_at >= block.block_timestamp
               AND checkpoint.promoted_finalized_height >= block.block_number
       )
       AND NOT EXISTS (
            SELECT 1
              FROM contract_log_observations event
             WHERE event.deployment_id = authorization_row.deployment_id
               AND event.event_kind = 'signature_minted'
               AND (
                   event.authorization_id = authorization_row.authorization_id
                   OR event.signature_digest = authorization_row.signature_digest
               )
               AND event.canonical
               AND NOT event.orphaned
               AND event.validation_state = 'validated'
               AND event.finality_state = 'finalized'
       )
       AND NOT EXISTS (
            SELECT 1
              FROM gallery_entries entry
             WHERE entry.signature_id = authorization_row.signature_id
               AND entry.deployment_id = authorization_row.deployment_id
       ),
       FALSE
    );
$$;

CREATE OR REPLACE FUNCTION v2_authorization_is_safely_dead(
    authorization_row mint_authorizations
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((
        authorization_row.issuance_state = 'signing_failed'
        AND authorization_row.signer_audit_state = 'proven_never_signed'
        AND authorization_row.chain_state = 'unseen'
        AND NOT EXISTS (
            SELECT 1 FROM mint_attempts attempt
             WHERE attempt.authorization_id = authorization_row.authorization_id
               AND attempt.deployment_id = authorization_row.deployment_id
        )
    ) OR (
        authorization_row.chain_state = 'consumed_finalized'
        AND v2_has_finalized_consumption_evidence(authorization_row)
    ) OR (
        authorization_row.chain_state = 'revoked_finalized'
        AND v2_has_finalized_revocation_evidence(authorization_row)
    ) OR (
        authorization_row.chain_state = 'expired_unconsumed'
        AND v2_has_finalized_expiry_evidence(authorization_row)
    ), FALSE);
$$;

CREATE OR REPLACE FUNCTION v2_binding_guard_has_unresolved_authority(
    guarded_x_user_id TEXT,
    guarded_chain_id v2_uint256
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM wallet_bindings binding
          JOIN mint_authorizations mint_auth
            ON mint_auth.wallet_binding_id = binding.wallet_binding_id
         WHERE binding.x_user_id = guarded_x_user_id
           AND binding.chain_id = guarded_chain_id
           AND NOT v2_authorization_is_safely_dead(mint_auth)
    );
$$;

CREATE OR REPLACE FUNCTION v2_has_signature_erasure_chain_evidence(
    target_signature_id TEXT,
    target_deployment_id UUID,
    required_deadline TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM signature_erasure_chain_evidence evidence
          JOIN chain_blocks block
            ON block.deployment_id = evidence.deployment_id
           AND block.block_hash = evidence.finalized_block_hash
           AND block.block_number = evidence.finalized_block_number
          JOIN indexer_checkpoints checkpoint
            ON checkpoint.deployment_id = evidence.deployment_id
         WHERE evidence.signature_id = target_signature_id
           AND evidence.deployment_id = target_deployment_id
           AND evidence.covered_through_deadline >= required_deadline
           AND evidence.pinned_minted_signature = FALSE
           AND evidence.pinned_authorizations_verified
           AND evidence.contiguous_finalized_coverage
           AND evidence.primary_provider_block_hash = evidence.finalized_block_hash
           AND evidence.secondary_provider_block_hash = evidence.finalized_block_hash
           AND block.canonical
           AND block.finalized
           AND block.block_timestamp > evidence.covered_through_deadline
           AND checkpoint.promoted_finalized_height >= block.block_number
           AND evidence.observed_at >= block.block_timestamp
           AND NOT EXISTS (
               SELECT 1
                 FROM contract_log_observations event
                WHERE event.signature_id = target_signature_id
                  AND event.deployment_id = target_deployment_id
                  AND event.event_kind = 'signature_minted'
                  AND (
                      (event.canonical AND NOT event.orphaned)
                      OR event.finality_state IN ('finalized', 'finality_revoked')
                  )
           )
    );
$$;

CREATE OR REPLACE FUNCTION v2_guard_signature_erasure_chain_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_state TEXT;
    supporting_block_ready BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'signature erasure chain evidence is an immutable durable receipt';
    END IF;

    SELECT issuance_state INTO control_state
      FROM signature_mint_controls
     WHERE signature_id = NEW.signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_state <> 'erasure_pending' THEN
        RAISE EXCEPTION 'signature erasure evidence requires erasure_pending control';
    END IF;

    SELECT block.canonical AND block.finalized
           AND block.block_timestamp > NEW.covered_through_deadline
           AND checkpoint.promoted_finalized_height >= block.block_number
      INTO supporting_block_ready
      FROM chain_blocks block
      JOIN indexer_checkpoints checkpoint
        ON checkpoint.deployment_id = block.deployment_id
     WHERE block.deployment_id = NEW.deployment_id
       AND block.block_hash = NEW.finalized_block_hash
       AND block.block_number = NEW.finalized_block_number;

    IF supporting_block_ready IS DISTINCT FROM TRUE
       OR NEW.primary_provider_block_hash <> NEW.finalized_block_hash
       OR NEW.secondary_provider_block_hash <> NEW.finalized_block_hash
       OR NOT NEW.contiguous_finalized_coverage
       OR NEW.pinned_minted_signature
       OR NOT NEW.pinned_authorizations_verified
       OR NEW.observed_at < (
           SELECT block_timestamp
             FROM chain_blocks
            WHERE deployment_id = NEW.deployment_id
              AND block_hash = NEW.finalized_block_hash
              AND block_number = NEW.finalized_block_number
       ) THEN
        RAISE EXCEPTION 'signature erasure evidence requires agreed finalized coverage and pinned unused state';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM mint_authorizations mint_auth
         WHERE mint_auth.signature_id = NEW.signature_id
           AND mint_auth.deployment_id = NEW.deployment_id
           AND (
               mint_auth.deadline > NEW.covered_through_deadline
               OR mint_auth.chain_state = 'consumed_finalized'
               OR NOT v2_authorization_is_safely_dead(mint_auth)
           )
    ) THEN
        RAISE EXCEPTION 'signature erasure evidence does not cover every safely reconciled authorization';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM contract_log_observations event
         WHERE event.signature_id = NEW.signature_id
           AND event.deployment_id = NEW.deployment_id
           AND event.event_kind = 'signature_minted'
           AND (
               (event.canonical AND NOT event.orphaned)
               OR event.finality_state IN ('finalized', 'finality_revoked')
           )
    ) THEN
        RAISE EXCEPTION 'observed mint evidence prevents an erasure reconciliation receipt';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER signature_erasure_chain_evidence_guard
    BEFORE INSERT OR UPDATE OR DELETE ON signature_erasure_chain_evidence
    FOR EACH ROW EXECUTE FUNCTION v2_guard_signature_erasure_chain_evidence();

CREATE OR REPLACE FUNCTION v2_validate_wallet_binding_head()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    binding_ended_at TIMESTAMPTZ;
    guarded_x_user_id TEXT;
    guarded_chain_id v2_uint256;
    binding_changed BOOLEAN;
BEGIN
    guarded_x_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.x_user_id ELSE NEW.x_user_id END;
    guarded_chain_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.chain_id ELSE NEW.chain_id END;
    IF TG_OP = 'UPDATE' THEN
        binding_changed := NEW.active_wallet_binding_id IS DISTINCT FROM OLD.active_wallet_binding_id;
    ELSE
        binding_changed := TRUE;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.active_wallet_binding_id IS NOT NULL THEN
            RAISE EXCEPTION 'clear and version the binding head before deleting it';
        END IF;
        IF v2_binding_guard_has_unresolved_authority(guarded_x_user_id, guarded_chain_id) THEN
            RAISE EXCEPTION 'wallet binding head cannot be deleted while mint authority is unresolved';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.x_user_id, NEW.chain_id)
             IS DISTINCT FROM ROW(OLD.x_user_id, OLD.chain_id) THEN
            RAISE EXCEPTION 'wallet binding head identity is immutable';
        END IF;
        IF NEW.version < OLD.version THEN
            RAISE EXCEPTION 'wallet binding head version cannot decrease';
        END IF;
        IF NEW.active_wallet_binding_id IS DISTINCT FROM OLD.active_wallet_binding_id
           AND NEW.version <= OLD.version THEN
            RAISE EXCEPTION 'wallet binding head change must advance version';
        END IF;
        IF NEW.updated_at < OLD.updated_at THEN
            RAISE EXCEPTION 'wallet binding head updated_at cannot move backwards';
        END IF;
    END IF;

    IF binding_changed
       AND v2_binding_guard_has_unresolved_authority(guarded_x_user_id, guarded_chain_id) THEN
        RAISE EXCEPTION 'wallet binding head cannot change while mint authority is unresolved';
    END IF;

    IF NEW.active_wallet_binding_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT ended_at
      INTO binding_ended_at
      FROM wallet_bindings
     WHERE wallet_binding_id = NEW.active_wallet_binding_id
       AND x_user_id = NEW.x_user_id
       AND chain_id = NEW.chain_id;

    IF NOT FOUND OR binding_ended_at IS NOT NULL THEN
        RAISE EXCEPTION 'wallet binding head must reference an active matching binding';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_binding_heads_validate_active
    BEFORE INSERT OR UPDATE OR DELETE ON wallet_binding_heads
    FOR EACH ROW EXECUTE FUNCTION v2_validate_wallet_binding_head();

CREATE OR REPLACE FUNCTION v2_guard_wallet_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    guarded_x_user_id TEXT;
    guarded_chain_id v2_uint256;
BEGIN
    guarded_x_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.x_user_id ELSE NEW.x_user_id END;
    guarded_chain_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.chain_id ELSE NEW.chain_id END;

    -- The head is the serialization row for both binding changes and
    -- authorization preparation.  Requiring it on INSERT prevents a binding
    -- from being activated through a path that never acquired the guard.
    PERFORM 1
      FROM wallet_binding_heads
     WHERE x_user_id = guarded_x_user_id
       AND chain_id = guarded_chain_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'wallet binding mutation requires its binding guard row';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.ended_at IS NOT NULL OR NEW.end_reason IS NOT NULL THEN
            RAISE EXCEPTION 'a wallet binding must begin active';
        END IF;
        IF v2_binding_guard_has_unresolved_authority(guarded_x_user_id, guarded_chain_id) THEN
            RAISE EXCEPTION 'new wallet binding cannot activate while mint authority is unresolved';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF v2_binding_guard_has_unresolved_authority(guarded_x_user_id, guarded_chain_id) THEN
            RAISE EXCEPTION 'wallet binding cannot be deleted while mint authority is unresolved';
        END IF;
        IF EXISTS (
            SELECT 1
              FROM signatures sig
              LEFT JOIN signature_mint_controls control
                ON control.signature_id = sig.signature_id
             WHERE sig.x_user_id = OLD.x_user_id
               AND (
                   control.signature_id IS NULL
                   OR control.issuance_state NOT IN ('erasure_pending', 'erased')
               )
        ) THEN
            RAISE EXCEPTION 'wallet binding history is still required by a retained signature';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF ROW(
            NEW.wallet_binding_id, NEW.x_user_id, NEW.chain_id, NEW.wallet_address,
            NEW.proof_scheme, NEW.siwe_message, NEW.siwe_message_hash,
            NEW.wallet_proof, NEW.verification_block_number,
            NEW.verification_block_hash, NEW.x_authenticated_at, NEW.proved_at,
            NEW.activated_at
        ) IS DISTINCT FROM ROW(
            OLD.wallet_binding_id, OLD.x_user_id, OLD.chain_id, OLD.wallet_address,
            OLD.proof_scheme, OLD.siwe_message, OLD.siwe_message_hash,
            OLD.wallet_proof, OLD.verification_block_number,
            OLD.verification_block_hash, OLD.x_authenticated_at, OLD.proved_at,
            OLD.activated_at
        ) THEN
            RAISE EXCEPTION 'wallet binding proof and identity are immutable';
        END IF;
        IF OLD.ended_at IS NOT NULL
           AND ROW(NEW.ended_at, NEW.end_reason)
                 IS DISTINCT FROM ROW(OLD.ended_at, OLD.end_reason) THEN
            RAISE EXCEPTION 'ended wallet binding is immutable';
        END IF;
        IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL THEN
            IF v2_binding_guard_has_unresolved_authority(guarded_x_user_id, guarded_chain_id) THEN
                RAISE EXCEPTION 'wallet binding cannot end while mint authority is unresolved';
            END IF;
            PERFORM 1
              FROM wallet_binding_heads
             WHERE x_user_id = OLD.x_user_id
               AND chain_id = OLD.chain_id
               AND active_wallet_binding_id = OLD.wallet_binding_id
             FOR UPDATE;
            IF FOUND THEN
                RAISE EXCEPTION 'clear and version the binding head before ending its binding';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_bindings_guard
    BEFORE INSERT OR UPDATE OR DELETE ON wallet_bindings
    FOR EACH ROW EXECUTE FUNCTION v2_guard_wallet_binding();

CREATE OR REPLACE FUNCTION v2_validate_wallet_binding_activation_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    head_binding_id v2_nonzero_bytes32;
BEGIN
    SELECT active_wallet_binding_id INTO head_binding_id
      FROM wallet_binding_heads
     WHERE x_user_id = NEW.x_user_id
       AND chain_id = NEW.chain_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'wallet binding commit requires its binding guard row';
    END IF;
    IF NEW.ended_at IS NULL
       AND head_binding_id IS DISTINCT FROM NEW.wallet_binding_id THEN
        RAISE EXCEPTION 'active wallet binding must be the versioned binding head';
    END IF;
    IF NEW.ended_at IS NOT NULL
       AND head_binding_id IS NOT DISTINCT FROM NEW.wallet_binding_id THEN
        RAISE EXCEPTION 'ended wallet binding cannot remain the active head';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER wallet_bindings_validate_activation_commit
    AFTER INSERT OR UPDATE ON wallet_bindings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION v2_validate_wallet_binding_activation_commit();

CREATE OR REPLACE FUNCTION v2_guard_indexer_checkpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.deployment_id <> OLD.deployment_id
       OR NEW.finality_policy <> OLD.finality_policy THEN
        RAISE EXCEPTION 'indexer checkpoint identity and finality policy are immutable';
    END IF;
    IF NEW.fencing_token < OLD.fencing_token THEN
        RAISE EXCEPTION 'indexer fencing token cannot decrease';
    END IF;
    IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       AND NEW.lease_owner IS NOT NULL
       AND NEW.fencing_token <= OLD.fencing_token THEN
        RAISE EXCEPTION 'new indexer lease owner must advance the fence';
    END IF;
    IF OLD.promoted_finalized_height IS NOT NULL
       AND (
           NEW.promoted_finalized_height IS NULL
           OR NEW.promoted_finalized_height < OLD.promoted_finalized_height
       ) THEN
        RAISE EXCEPTION 'promoted finalized checkpoint cannot move backwards';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'indexer checkpoint updated_at cannot move backwards';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER indexer_checkpoints_guard
    BEFORE UPDATE ON indexer_checkpoints
    FOR EACH ROW EXECUTE FUNCTION v2_guard_indexer_checkpoint();

CREATE OR REPLACE FUNCTION v2_guard_chain_block_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.finalized THEN
            RAISE EXCEPTION 'chain block observation must begin unfinalized';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'chain block observations are append-only evidence';
    END IF;
    IF ROW(
        NEW.deployment_id, NEW.block_number, NEW.block_hash,
        NEW.parent_hash, NEW.block_timestamp, NEW.observed_at
    ) IS DISTINCT FROM ROW(
        OLD.deployment_id, OLD.block_number, OLD.block_hash,
        OLD.parent_hash, OLD.block_timestamp, OLD.observed_at
    ) THEN
        RAISE EXCEPTION 'chain block observation identity and payload are immutable';
    END IF;
    IF OLD.finalized
       AND ROW(NEW.canonical, NEW.finalized, NEW.orphaned_at)
             IS DISTINCT FROM ROW(OLD.canonical, OLD.finalized, OLD.orphaned_at) THEN
        RAISE EXCEPTION 'finalized chain block evidence is immutable; enter chain safety halt';
    END IF;
    IF NOT OLD.canonical
       AND ROW(NEW.canonical, NEW.finalized, NEW.orphaned_at)
             IS DISTINCT FROM ROW(OLD.canonical, OLD.finalized, OLD.orphaned_at) THEN
        RAISE EXCEPTION 'orphaned block observation is immutable';
    END IF;
    IF OLD.canonical AND NOT OLD.finalized THEN
        IF NEW.canonical AND NEW.orphaned_at IS NULL THEN
            NULL;
        ELSIF NOT NEW.canonical AND NOT NEW.finalized AND NEW.orphaned_at IS NOT NULL THEN
            NULL;
        ELSE
            RAISE EXCEPTION 'invalid canonical block observation transition';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER chain_blocks_guard
    BEFORE INSERT OR UPDATE OR DELETE ON chain_blocks
    FOR EACH ROW EXECUTE FUNCTION v2_guard_chain_block_observation();

CREATE OR REPLACE FUNCTION v2_guard_receipt_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    supporting_block_finalized BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.finalized THEN
            RAISE EXCEPTION 'transaction receipt observation must begin unfinalized';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'transaction receipt observations are append-only evidence';
    END IF;
    IF ROW(
        NEW.deployment_id, NEW.block_hash, NEW.block_number, NEW.tx_hash,
        NEW.receipt_status, NEW.transaction_index, NEW.gas_used, NEW.observed_at
    ) IS DISTINCT FROM ROW(
        OLD.deployment_id, OLD.block_hash, OLD.block_number, OLD.tx_hash,
        OLD.receipt_status, OLD.transaction_index, OLD.gas_used, OLD.observed_at
    ) THEN
        RAISE EXCEPTION 'transaction receipt observation identity and payload are immutable';
    END IF;
    IF OLD.finalized
       AND ROW(NEW.canonical, NEW.finalized, NEW.orphaned_at)
             IS DISTINCT FROM ROW(OLD.canonical, OLD.finalized, OLD.orphaned_at) THEN
        RAISE EXCEPTION 'finalized transaction receipt evidence is immutable; enter chain safety halt';
    END IF;
    IF NOT OLD.canonical
       AND ROW(NEW.canonical, NEW.finalized, NEW.orphaned_at)
             IS DISTINCT FROM ROW(OLD.canonical, OLD.finalized, OLD.orphaned_at) THEN
        RAISE EXCEPTION 'orphaned transaction receipt observation is immutable';
    END IF;
    IF OLD.canonical AND NOT OLD.finalized THEN
        IF NEW.canonical AND NEW.orphaned_at IS NULL THEN
            NULL;
        ELSIF NOT NEW.canonical AND NOT NEW.finalized AND NEW.orphaned_at IS NOT NULL THEN
            NULL;
        ELSE
            RAISE EXCEPTION 'invalid transaction receipt observation transition';
        END IF;
    END IF;
    IF NEW.finalized THEN
        SELECT canonical AND finalized INTO supporting_block_finalized
          FROM chain_blocks
         WHERE deployment_id = NEW.deployment_id
           AND block_hash = NEW.block_hash
           AND block_number = NEW.block_number;
        IF supporting_block_finalized IS DISTINCT FROM TRUE OR NOT NEW.canonical THEN
            RAISE EXCEPTION 'finalized receipt requires finalized canonical block evidence';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER transaction_receipt_observations_guard
    BEFORE INSERT OR UPDATE OR DELETE ON transaction_receipt_observations
    FOR EACH ROW EXECUTE FUNCTION v2_guard_receipt_observation();

CREATE OR REPLACE FUNCTION v2_guard_contract_log_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    supporting_block_finalized BOOLEAN;
    supporting_receipt_finalized BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.finality_state <> 'unfinalized' THEN
            RAISE EXCEPTION 'contract log observation must begin unfinalized';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'contract log observations are append-only evidence';
    END IF;

    IF ROW(
        NEW.event_observation_id, NEW.deployment_id, NEW.block_hash,
        NEW.block_number, NEW.tx_hash, NEW.transaction_index, NEW.log_index,
        NEW.receipt_status, NEW.event_kind, NEW.topic0, NEW.topic1,
        NEW.topic2, NEW.topic3, NEW.raw_data, NEW.signature_id,
        NEW.signature_digest, NEW.authorization_id, NEW.mint_wallet,
        NEW.token_id, NEW.wallet_binding_id, NEW.svg_sha256,
        NEW.png_sha256, NEW.metadata_sha256, NEW.token_uri_hash,
        NEW.authorizer_epoch, NEW.authorization_digest, NEW.transfer_from,
        NEW.transfer_to, NEW.control_authorizer, NEW.decoded_payload,
        NEW.abi_version, NEW.validation_version, NEW.first_observed_at
    ) IS DISTINCT FROM ROW(
        OLD.event_observation_id, OLD.deployment_id, OLD.block_hash,
        OLD.block_number, OLD.tx_hash, OLD.transaction_index, OLD.log_index,
        OLD.receipt_status, OLD.event_kind, OLD.topic0, OLD.topic1,
        OLD.topic2, OLD.topic3, OLD.raw_data, OLD.signature_id,
        OLD.signature_digest, OLD.authorization_id, OLD.mint_wallet,
        OLD.token_id, OLD.wallet_binding_id, OLD.svg_sha256,
        OLD.png_sha256, OLD.metadata_sha256, OLD.token_uri_hash,
        OLD.authorizer_epoch, OLD.authorization_digest, OLD.transfer_from,
        OLD.transfer_to, OLD.control_authorizer, OLD.decoded_payload,
        OLD.abi_version, OLD.validation_version, OLD.first_observed_at
    ) THEN
        RAISE EXCEPTION 'contract log observation identity and decoded payload are immutable';
    END IF;
    IF NEW.last_observed_at < OLD.last_observed_at THEN
        RAISE EXCEPTION 'contract log last observation time cannot move backwards';
    END IF;
    IF OLD.validation_state = 'quarantined'
       AND ROW(NEW.validation_state, NEW.quarantine_code)
             IS DISTINCT FROM ROW(OLD.validation_state, OLD.quarantine_code) THEN
        RAISE EXCEPTION 'quarantined contract log evidence is terminal';
    END IF;
    IF OLD.validation_state = 'validated'
       AND NEW.validation_state = 'validation_pending' THEN
        RAISE EXCEPTION 'validated contract log cannot return to pending';
    END IF;
    IF OLD.finality_state = 'finality_revoked'
       AND ROW(
           NEW.canonical, NEW.orphaned, NEW.validation_state,
           NEW.quarantine_code, NEW.finality_state, NEW.orphaned_at
       ) IS DISTINCT FROM ROW(
           OLD.canonical, OLD.orphaned, OLD.validation_state,
           OLD.quarantine_code, OLD.finality_state, OLD.orphaned_at
       ) THEN
        RAISE EXCEPTION 'finality-revoked contract log evidence is immutable';
    END IF;
    IF OLD.finality_state = 'finalized' THEN
        IF NEW.finality_state = 'finalized' THEN
            IF ROW(
                NEW.canonical, NEW.orphaned, NEW.validation_state,
                NEW.quarantine_code, NEW.orphaned_at
            ) IS DISTINCT FROM ROW(
                OLD.canonical, OLD.orphaned, OLD.validation_state,
                OLD.quarantine_code, OLD.orphaned_at
            ) THEN
                RAISE EXCEPTION 'finalized contract log evidence is immutable';
            END IF;
        ELSIF NOT (
            NEW.finality_state = 'finality_revoked'
            AND NOT NEW.canonical AND NEW.orphaned AND NEW.orphaned_at IS NOT NULL
            AND NEW.validation_state = OLD.validation_state
            AND NEW.quarantine_code IS NOT DISTINCT FROM OLD.quarantine_code
        ) THEN
            RAISE EXCEPTION 'finalized log may only enter explicit finality_revoked state';
        END IF;
    ELSIF NEW.finality_state = 'finality_revoked' THEN
        RAISE EXCEPTION 'only a previously finalized log may become finality_revoked';
    END IF;
    IF NOT OLD.canonical AND NEW.canonical THEN
        RAISE EXCEPTION 'an orphaned observation cannot be recanonicalized; insert the new block observation';
    END IF;
    IF OLD.canonical AND NOT NEW.canonical
       AND NOT (
           NEW.orphaned AND NEW.orphaned_at IS NOT NULL
           AND NEW.finality_state IN ('unfinalized', 'finality_revoked')
       ) THEN
        RAISE EXCEPTION 'orphaning a contract log requires explicit orphan state';
    END IF;

    IF NEW.finality_state = 'finalized' THEN
        SELECT canonical AND finalized INTO supporting_block_finalized
          FROM chain_blocks
         WHERE deployment_id = NEW.deployment_id
           AND block_hash = NEW.block_hash
           AND block_number = NEW.block_number;
        SELECT canonical AND finalized AND receipt_status = NEW.receipt_status
          INTO supporting_receipt_finalized
          FROM transaction_receipt_observations
         WHERE deployment_id = NEW.deployment_id
           AND block_hash = NEW.block_hash
           AND tx_hash = NEW.tx_hash;
        IF supporting_block_finalized IS DISTINCT FROM TRUE
           OR supporting_receipt_finalized IS DISTINCT FROM TRUE
           OR NOT NEW.canonical OR NEW.orphaned
           OR NEW.validation_state <> 'validated' THEN
            RAISE EXCEPTION 'finalized log requires finalized canonical block, receipt, and validation evidence';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER contract_log_observations_guard
    BEFORE INSERT OR UPDATE OR DELETE ON contract_log_observations
    FOR EACH ROW EXECUTE FUNCTION v2_guard_contract_log_observation();

CREATE OR REPLACE FUNCTION v2_guard_gallery_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.chain_state <> 'finalized' THEN
            RAISE EXCEPTION 'gallery entry must begin from finalized chain state';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'finalized Gallery provenance cannot be deleted';
    END IF;
    IF ROW(
        NEW.signature_id, NEW.deployment_id, NEW.canonical_event_id,
        NEW.token_id, NEW.mint_wallet, NEW.tx_hash, NEW.block_number,
        NEW.block_hash, NEW.transaction_index, NEW.log_index,
        NEW.minted_at, NEW.finalized_at
    ) IS DISTINCT FROM ROW(
        OLD.signature_id, OLD.deployment_id, OLD.canonical_event_id,
        OLD.token_id, OLD.mint_wallet, OLD.tx_hash, OLD.block_number,
        OLD.block_hash, OLD.transaction_index, OLD.log_index,
        OLD.minted_at, OLD.finalized_at
    ) THEN
        RAISE EXCEPTION 'Gallery mint provenance is immutable';
    END IF;
    IF OLD.chain_state = 'finality_revoked' AND NEW.chain_state <> OLD.chain_state THEN
        RAISE EXCEPTION 'finality-revoked Gallery provenance is terminal';
    END IF;
    IF OLD.chain_state = 'finalized'
       AND NEW.chain_state NOT IN ('finalized', 'finality_revoked') THEN
        RAISE EXCEPTION 'invalid Gallery chain-state transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER gallery_entries_guard
    BEFORE INSERT OR UPDATE OR DELETE ON gallery_entries
    FOR EACH ROW EXECUTE FUNCTION v2_guard_gallery_entry();

CREATE OR REPLACE FUNCTION v2_guard_token_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_state TEXT;
    current_control_version BIGINT;
    v1_svg_hash TEXT;
    v1_png_hash TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.preparation_state <> 'reserved' THEN
            RAISE EXCEPTION 'token metadata must begin reserved';
        END IF;
        SELECT issuance_state, version
          INTO control_state, current_control_version
          FROM signature_mint_controls
         WHERE signature_id = NEW.signature_id
         FOR UPDATE;
        IF NOT FOUND OR control_state <> 'enabled'
           OR current_control_version <> NEW.control_version THEN
            RAISE EXCEPTION 'token metadata reservation requires the current enabled control';
        END IF;
        SELECT svg_sha256, png_sha256 INTO v1_svg_hash, v1_png_hash
          FROM signatures
         WHERE signature_id = NEW.signature_id;
        IF NOT FOUND OR v1_svg_hash <> encode(NEW.svg_sha256, 'hex')
           OR v1_png_hash <> encode(NEW.png_sha256, 'hex') THEN
            RAISE EXCEPTION 'token metadata must retain the exact V1 artifact hashes';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        SELECT issuance_state INTO control_state
          FROM signature_mint_controls
         WHERE signature_id = OLD.signature_id
         FOR UPDATE;
        IF NOT FOUND OR control_state IS DISTINCT FROM 'erasure_pending' THEN
            RAISE EXCEPTION 'token metadata deletion requires erasure_pending control';
        END IF;
        IF OLD.preparation_state NOT IN ('aborted', 'frozen')
           OR OLD.lease_owner IS NOT NULL THEN
            RAISE EXCEPTION 'token metadata preparation and its worker must be terminal before deletion';
        END IF;
        IF EXISTS (
            SELECT 1 FROM gallery_entries
             WHERE signature_id = OLD.signature_id
               AND deployment_id = OLD.deployment_id
        ) THEN
            RAISE EXCEPTION 'minted token metadata cannot enter the erasure path';
        END IF;
        IF NOT v2_has_signature_erasure_chain_evidence(
            OLD.signature_id, OLD.deployment_id, OLD.prepared_at
        ) THEN
            RAISE EXCEPTION 'token metadata deletion requires finalized erasure reconciliation evidence';
        END IF;

        -- Lock every currently known target/key pair in a stable order.  This
        -- serializes the drain check with reference commits and writer leases.
        -- `canonical_json_storage_key` covers the canonical metadata object;
        -- the three CIDs cover every provider-specific retained pin.
        PERFORM 1
          FROM content_object_guards guard
         WHERE guard.object_key IN (
             OLD.svg_cid,
             OLD.png_cid,
             OLD.metadata_cid,
             OLD.canonical_json_storage_key
         )
         ORDER BY guard.storage_target_id, guard.object_key
         FOR UPDATE;

        IF EXISTS (
            SELECT 1
              FROM content_object_references reference
             WHERE (
                 reference.reference_kind = 'v2_svg_pin'
                 AND reference.reference_id = v2_token_metadata_reference_id(
                     OLD.signature_id, OLD.deployment_id, 'v2_svg_pin'
                 )
                 AND reference.object_key = OLD.svg_cid
             ) OR (
                 reference.reference_kind = 'v2_png_pin'
                 AND reference.reference_id = v2_token_metadata_reference_id(
                     OLD.signature_id, OLD.deployment_id, 'v2_png_pin'
                 )
                 AND reference.object_key = OLD.png_cid
             ) OR (
                 reference.reference_kind = 'v2_metadata_pin'
                 AND reference.reference_id = v2_token_metadata_reference_id(
                     OLD.signature_id, OLD.deployment_id, 'v2_metadata_pin'
                 )
                 AND reference.object_key IN (
                     OLD.metadata_cid, OLD.canonical_json_storage_key
                 )
             )
        ) THEN
            RAISE EXCEPTION 'V2 metadata content references must be detached before deletion';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM content_object_write_leases lease
             WHERE lease.object_key IN (
                 OLD.svg_cid,
                 OLD.png_cid,
                 OLD.metadata_cid,
                 OLD.canonical_json_storage_key
             )
               AND lease.state = 'writing'
        ) THEN
            RAISE EXCEPTION 'V2 metadata content writers must be drained before deletion';
        END IF;

        -- `pin_provider_receipts` remains immutable evidence while this row is
        -- frozen; it is not the live retention count.  Owner-scoped references
        -- are detached first, and §11.16 GC later deletes an object only when
        -- every (including another signature's shared-CID) reference is gone.
        RETURN OLD;
    END IF;

    IF NEW.preparation_state NOT IN ('aborting', 'aborted') THEN
        SELECT issuance_state, version
          INTO control_state, current_control_version
          FROM signature_mint_controls
         WHERE signature_id = NEW.signature_id
         FOR UPDATE;
        IF NOT FOUND OR control_state <> 'enabled'
           OR current_control_version <> NEW.control_version THEN
            RAISE EXCEPTION 'metadata worker lost its signature control fence';
        END IF;
    END IF;

    IF ROW(
        NEW.signature_id, NEW.deployment_id, NEW.metadata_version,
        NEW.svg_cid, NEW.png_cid, NEW.metadata_cid, NEW.svg_sha256,
        NEW.png_sha256, NEW.metadata_sha256, NEW.token_uri, NEW.token_uri_hash,
        NEW.canonical_json_storage_key, NEW.control_version, NEW.prepared_at
    ) IS DISTINCT FROM ROW(
        OLD.signature_id, OLD.deployment_id, OLD.metadata_version,
        OLD.svg_cid, OLD.png_cid, OLD.metadata_cid, OLD.svg_sha256,
        OLD.png_sha256, OLD.metadata_sha256, OLD.token_uri, OLD.token_uri_hash,
        OLD.canonical_json_storage_key, OLD.control_version, OLD.prepared_at
    ) THEN
        RAISE EXCEPTION 'token metadata payload fields are immutable';
    END IF;
    IF OLD.preparation_state = 'frozen' THEN
        RAISE EXCEPTION 'frozen token metadata is immutable';
    END IF;
    IF OLD.preparation_state = 'aborted' AND NEW.preparation_state <> 'aborted' THEN
        RAISE EXCEPTION 'aborted token metadata is terminal';
    END IF;
    IF NEW.fencing_token < OLD.fencing_token THEN
        RAISE EXCEPTION 'token metadata fencing token cannot decrease';
    END IF;
    IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
       AND NEW.lease_owner IS NOT NULL
       AND NEW.fencing_token <= OLD.fencing_token THEN
        RAISE EXCEPTION 'new metadata lease owner must advance the fence';
    END IF;
    IF OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at <= now()
       AND NEW.preparation_state NOT IN ('aborting', 'aborted')
       AND NOT (
           NEW.fencing_token > OLD.fencing_token
           AND NEW.lease_owner IS NOT NULL
           AND NEW.lease_expires_at > now()
       ) THEN
        RAISE EXCEPTION 'expired metadata worker may only enter cleanup';
    END IF;
    IF NEW.preparation_state <> OLD.preparation_state AND NOT (
        (OLD.preparation_state = 'reserved' AND NEW.preparation_state IN ('publishing', 'aborting'))
        OR (OLD.preparation_state = 'publishing' AND NEW.preparation_state IN ('verified', 'aborting'))
        OR (OLD.preparation_state = 'verified' AND NEW.preparation_state IN ('frozen', 'aborting'))
        OR (OLD.preparation_state = 'aborting' AND NEW.preparation_state = 'aborted')
    ) THEN
        RAISE EXCEPTION 'invalid token metadata preparation transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER token_metadata_guard
    BEFORE INSERT OR UPDATE OR DELETE ON token_metadata
    FOR EACH ROW EXECUTE FUNCTION v2_guard_token_metadata();

CREATE OR REPLACE FUNCTION v2_guard_mint_authorization()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_state TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.issuance_state <> 'prepared' OR NEW.chain_state <> 'unseen' THEN
            RAISE EXCEPTION 'mint authorization must begin prepared and unseen';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        SELECT issuance_state INTO control_state
          FROM signature_mint_controls
         WHERE signature_id = OLD.signature_id
         FOR UPDATE;
        IF NOT FOUND OR control_state IS DISTINCT FROM 'erasure_pending' THEN
            RAISE EXCEPTION 'mint authorization deletion requires erasure_pending control';
        END IF;
        IF OLD.chain_state = 'consumed_finalized'
           OR v2_has_finalized_consumption_evidence(OLD) THEN
            RAISE EXCEPTION 'a consumed mint authorization is permanent provenance';
        END IF;
        IF NOT v2_authorization_is_safely_dead(OLD) THEN
            RAISE EXCEPTION 'mint authorization is not proven safely dead';
        END IF;
        IF NOT v2_has_signature_erasure_chain_evidence(
            OLD.signature_id, OLD.deployment_id, OLD.deadline
        ) THEN
            RAISE EXCEPTION 'mint authorization deletion requires finalized erasure reconciliation evidence';
        END IF;
        RETURN OLD;
    END IF;

    IF ROW(
        NEW.authorization_id, NEW.signature_id, NEW.deployment_id,
        NEW.wallet_binding_id, NEW.mint_wallet, NEW.signature_digest,
        NEW.svg_sha256, NEW.png_sha256, NEW.metadata_sha256, NEW.token_uri,
        NEW.token_uri_hash, NEW.valid_after, NEW.deadline,
        NEW.authorizer_epoch, NEW.authorizer_address, NEW.signer_key_version,
        NEW.signer_request_id, NEW.typed_data_digest, NEW.prepared_at
    ) IS DISTINCT FROM ROW(
        OLD.authorization_id, OLD.signature_id, OLD.deployment_id,
        OLD.wallet_binding_id, OLD.mint_wallet, OLD.signature_digest,
        OLD.svg_sha256, OLD.png_sha256, OLD.metadata_sha256, OLD.token_uri,
        OLD.token_uri_hash, OLD.valid_after, OLD.deadline,
        OLD.authorizer_epoch, OLD.authorizer_address, OLD.signer_key_version,
        OLD.signer_request_id, OLD.typed_data_digest, OLD.prepared_at
    ) THEN
        RAISE EXCEPTION 'mint authorization typed fields are immutable';
    END IF;
    IF OLD.gallery_attestation IS NOT NULL
       AND NEW.gallery_attestation IS DISTINCT FROM OLD.gallery_attestation THEN
        RAISE EXCEPTION 'gallery attestation is immutable once stored';
    END IF;
    IF OLD.issued_at IS NOT NULL AND NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
        RAISE EXCEPTION 'issued_at is immutable once stored';
    END IF;
    IF OLD.terminal_evidence_kind IS NOT NULL
       AND ROW(
            NEW.terminal_evidence_kind, NEW.terminal_evidence_block_number,
            NEW.terminal_evidence_block_hash, NEW.terminal_evidence_primary_hash,
            NEW.terminal_evidence_secondary_hash,
            NEW.terminal_evidence_authorization_state,
            NEW.terminal_evidence_minted_signature,
            NEW.terminal_evidence_finalized_coverage,
            NEW.terminal_evidence_read_mode,
            NEW.terminal_evidence_validation_version,
            NEW.terminal_evidence_observed_at
       ) IS DISTINCT FROM ROW(
            OLD.terminal_evidence_kind, OLD.terminal_evidence_block_number,
            OLD.terminal_evidence_block_hash, OLD.terminal_evidence_primary_hash,
            OLD.terminal_evidence_secondary_hash,
            OLD.terminal_evidence_authorization_state,
            OLD.terminal_evidence_minted_signature,
            OLD.terminal_evidence_finalized_coverage,
            OLD.terminal_evidence_read_mode,
            OLD.terminal_evidence_validation_version,
            OLD.terminal_evidence_observed_at
       ) THEN
        RAISE EXCEPTION 'mint authorization terminal evidence is immutable once stored';
    END IF;
    IF NEW.issuance_state <> OLD.issuance_state AND NOT (
        (OLD.issuance_state = 'prepared'
            AND NEW.issuance_state IN ('issued', 'signing_failed', 'signing_unknown'))
        OR (OLD.issuance_state = 'signing_unknown'
            AND NEW.issuance_state IN ('issued', 'signing_failed'))
    ) THEN
        RAISE EXCEPTION 'invalid mint authorization issuance transition';
    END IF;

    IF NEW.issuance_state = 'signing_failed'
       AND (
           NEW.signer_audit_state <> 'proven_never_signed'
           OR NEW.chain_state <> 'unseen'
           OR EXISTS (
               SELECT 1 FROM mint_attempts attempt
                WHERE attempt.authorization_id = NEW.authorization_id
                  AND attempt.deployment_id = NEW.deployment_id
           )
       ) THEN
        RAISE EXCEPTION 'signing_failed requires durable proof that no signature was released';
    END IF;

    IF NEW.chain_state IS DISTINCT FROM OLD.chain_state AND NOT (
        (OLD.chain_state = 'unseen'
            AND NEW.chain_state IN (
                'observed_used_unfinalized', 'consumed_finalized',
                'revoked_unfinalized', 'revoked_finalized', 'expired_unconsumed'
            ))
        OR (OLD.chain_state = 'observed_used_unfinalized'
            AND NEW.chain_state IN ('consumed_finalized', 'orphaned_use'))
        OR (OLD.chain_state = 'revoked_unfinalized'
            AND NEW.chain_state IN ('revoked_finalized', 'unseen'))
        OR (OLD.chain_state = 'orphaned_use'
            AND NEW.chain_state IN (
                'unseen', 'observed_used_unfinalized', 'consumed_finalized',
                'revoked_unfinalized', 'revoked_finalized', 'expired_unconsumed'
            ))
    ) THEN
        RAISE EXCEPTION 'invalid mint authorization chain transition';
    END IF;

    IF NEW.chain_state = 'consumed_finalized'
       AND NOT v2_has_finalized_consumption_evidence(NEW) THEN
        RAISE EXCEPTION 'consumed_finalized requires a finalized validated mint event and receipt';
    END IF;
    IF NEW.chain_state = 'revoked_finalized'
       AND NOT v2_has_finalized_revocation_evidence(NEW) THEN
        RAISE EXCEPTION 'revoked_finalized requires a finalized validated revocation event';
    END IF;
    IF NEW.chain_state = 'expired_unconsumed'
       AND NOT v2_has_finalized_expiry_evidence(NEW) THEN
        RAISE EXCEPTION 'expired_unconsumed requires finalized coverage and a pinned unused-state read';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER mint_authorizations_guard
    BEFORE INSERT OR UPDATE OR DELETE ON mint_authorizations
    FOR EACH ROW EXECUTE FUNCTION v2_guard_mint_authorization();

CREATE OR REPLACE FUNCTION v2_guard_mint_attempt_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_state TEXT;
    authorization_row mint_authorizations%ROWTYPE;
BEGIN
    SELECT * INTO authorization_row
      FROM mint_authorizations
     WHERE authorization_id = OLD.authorization_id
       AND deployment_id = OLD.deployment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'mint attempt authorization is missing';
    END IF;
    SELECT issuance_state INTO control_state
      FROM signature_mint_controls
     WHERE signature_id = authorization_row.signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_state <> 'erasure_pending' THEN
        RAISE EXCEPTION 'mint attempt deletion requires erasure_pending control';
    END IF;
    IF NOT v2_authorization_is_safely_dead(authorization_row)
       OR authorization_row.chain_state = 'consumed_finalized' THEN
        RAISE EXCEPTION 'mint attempt deletion requires safely dead unconsumed authority';
    END IF;
    IF NOT v2_has_signature_erasure_chain_evidence(
        authorization_row.signature_id,
        authorization_row.deployment_id,
        authorization_row.deadline
    ) THEN
        RAISE EXCEPTION 'mint attempt deletion requires finalized erasure reconciliation evidence';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER mint_attempts_guard_delete
    BEFORE DELETE ON mint_attempts
    FOR EACH ROW EXECUTE FUNCTION v2_guard_mint_attempt_delete();

CREATE OR REPLACE FUNCTION v2_guard_mint_attempt_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    authorization_row mint_authorizations%ROWTYPE;
BEGIN
    SELECT * INTO authorization_row
      FROM mint_authorizations
     WHERE authorization_id = NEW.authorization_id
       AND deployment_id = NEW.deployment_id
     FOR SHARE;
    IF NOT FOUND OR authorization_row.issuance_state <> 'issued'
       OR authorization_row.gallery_attestation IS NULL THEN
        RAISE EXCEPTION 'a transaction attempt requires a durably issued authorization';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF ROW(
            NEW.attempt_id, NEW.authorization_id, NEW.deployment_id,
            NEW.tx_hash, NEW.sender, NEW.transaction_nonce, NEW.first_reported_at
        ) IS DISTINCT FROM ROW(
            OLD.attempt_id, OLD.authorization_id, OLD.deployment_id,
            OLD.tx_hash, OLD.sender, OLD.transaction_nonce, OLD.first_reported_at
        ) THEN
            RAISE EXCEPTION 'mint attempt identity and client report are immutable';
        END IF;
        IF OLD.state IN ('finalized_success', 'finalized_revert')
           AND ROW(
               NEW.state, NEW.receipt_status, NEW.failure_code,
               NEW.first_rpc_seen_at, NEW.last_rpc_seen_at
           ) IS DISTINCT FROM ROW(
               OLD.state, OLD.receipt_status, OLD.failure_code,
               OLD.first_rpc_seen_at, OLD.last_rpc_seen_at
           ) THEN
            RAISE EXCEPTION 'finalized mint attempt is immutable';
        END IF;
        IF OLD.first_rpc_seen_at IS NOT NULL
           AND NEW.first_rpc_seen_at IS DISTINCT FROM OLD.first_rpc_seen_at THEN
            RAISE EXCEPTION 'mint attempt first RPC observation is immutable once set';
        END IF;
        IF OLD.last_rpc_seen_at IS NOT NULL
           AND NEW.last_rpc_seen_at < OLD.last_rpc_seen_at THEN
            RAISE EXCEPTION 'mint attempt RPC observation time cannot move backwards';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER mint_attempts_guard_write
    BEFORE INSERT OR UPDATE ON mint_attempts
    FOR EACH ROW EXECUTE FUNCTION v2_guard_mint_attempt_write();

CREATE OR REPLACE FUNCTION v2_validate_mint_authorization_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    metadata_row token_metadata%ROWTYPE;
    binding_row wallet_bindings%ROWTYPE;
    control_row signature_mint_controls%ROWTYPE;
    head_binding_id v2_nonzero_bytes32;
    deployment_open BOOLEAN;
    deployment_chain_id v2_uint256;
    signature_owner TEXT;
BEGIN
    SELECT * INTO metadata_row
      FROM token_metadata
     WHERE signature_id = NEW.signature_id
       AND deployment_id = NEW.deployment_id
     FOR SHARE;
    IF NOT FOUND OR metadata_row.preparation_state <> 'frozen'
       OR metadata_row.svg_sha256 <> NEW.svg_sha256
       OR metadata_row.png_sha256 <> NEW.png_sha256
       OR metadata_row.metadata_sha256 <> NEW.metadata_sha256
       OR metadata_row.token_uri <> NEW.token_uri
       OR metadata_row.token_uri_hash <> NEW.token_uri_hash THEN
        RAISE EXCEPTION 'authorization must match frozen verified token metadata';
    END IF;

    SELECT * INTO binding_row
      FROM wallet_bindings
     WHERE wallet_binding_id = NEW.wallet_binding_id
     FOR UPDATE;
    IF NOT FOUND OR binding_row.wallet_address <> NEW.mint_wallet
       OR binding_row.ended_at IS NOT NULL THEN
        RAISE EXCEPTION 'authorization wallet does not match its binding';
    END IF;

    SELECT x_user_id INTO signature_owner
      FROM signatures
     WHERE signature_id = NEW.signature_id;
    IF NOT FOUND OR signature_owner IS DISTINCT FROM binding_row.x_user_id THEN
        RAISE EXCEPTION 'authorization binding does not belong to the V1 claimant';
    END IF;

    SELECT active_wallet_binding_id INTO head_binding_id
      FROM wallet_binding_heads
     WHERE x_user_id = binding_row.x_user_id
       AND chain_id = binding_row.chain_id
     FOR UPDATE;
    IF NOT FOUND OR head_binding_id IS DISTINCT FROM NEW.wallet_binding_id THEN
        RAISE EXCEPTION 'authorization binding is not the active binding head';
    END IF;

    SELECT * INTO control_row
      FROM signature_mint_controls
     WHERE signature_id = NEW.signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_row.issuance_state <> 'enabled'
       OR control_row.version <> metadata_row.control_version
       OR EXISTS (
            SELECT 1 FROM gallery_suppressions
             WHERE signature_id = NEW.signature_id
               AND deployment_id = NEW.deployment_id
       ) THEN
        RAISE EXCEPTION 'authorization requires the current enabled signature control';
    END IF;

    SELECT issuance_enabled AND lifecycle_state = 'canonical', chain_id
      INTO deployment_open, deployment_chain_id
      FROM mint_deployments
     WHERE deployment_id = NEW.deployment_id
     FOR SHARE;
    IF NOT FOUND OR NOT deployment_open
       OR deployment_chain_id IS DISTINCT FROM binding_row.chain_id THEN
        RAISE EXCEPTION 'authorization requires the canonical issuance-enabled deployment';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER mint_authorizations_validate_commit
    AFTER INSERT ON mint_authorizations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION v2_validate_mint_authorization_commit();

CREATE OR REPLACE FUNCTION v2_validate_gallery_entry_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    event_row contract_log_observations%ROWTYPE;
BEGIN
    SELECT * INTO event_row
      FROM contract_log_observations
     WHERE event_observation_id = NEW.canonical_event_id
     FOR SHARE;

    IF NOT FOUND
       OR event_row.event_kind <> 'signature_minted'
       OR event_row.deployment_id <> NEW.deployment_id
       OR event_row.signature_id IS DISTINCT FROM NEW.signature_id
       OR event_row.validation_state <> 'validated'
       OR event_row.receipt_status <> 1
       OR (
           NEW.chain_state = 'finalized'
           AND (event_row.finality_state <> 'finalized' OR NOT event_row.canonical)
       )
       OR (
           NEW.chain_state = 'finality_revoked'
           AND (event_row.finality_state <> 'finality_revoked' OR NOT event_row.orphaned)
       )
       OR event_row.token_id IS DISTINCT FROM NEW.token_id
       OR event_row.mint_wallet IS DISTINCT FROM NEW.mint_wallet
       OR event_row.tx_hash <> NEW.tx_hash
       OR event_row.block_number <> NEW.block_number
       OR event_row.block_hash <> NEW.block_hash
       OR event_row.transaction_index <> NEW.transaction_index
       OR event_row.log_index <> NEW.log_index THEN
        RAISE EXCEPTION 'gallery entry must match its validated SignatureMinted chain state';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER gallery_entries_validate_commit
    AFTER INSERT OR UPDATE ON gallery_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION v2_validate_gallery_entry_commit();

CREATE OR REPLACE FUNCTION v2_lock_gallery_suppression_control()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_signature_id TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_signature_id := OLD.signature_id;
    ELSE
        target_signature_id := NEW.signature_id;
    END IF;
    IF TG_OP = 'UPDATE'
       AND ROW(NEW.signature_id, NEW.deployment_id, NEW.status, NEW.created_at)
             IS DISTINCT FROM ROW(OLD.signature_id, OLD.deployment_id, OLD.status, OLD.created_at) THEN
        RAISE EXCEPTION 'gallery suppression identity and status are immutable';
    END IF;
    PERFORM 1
      FROM signature_mint_controls
     WHERE signature_id = target_signature_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'gallery suppression requires a signature control row';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER gallery_suppressions_lock_control
    BEFORE INSERT OR UPDATE OR DELETE ON gallery_suppressions
    FOR EACH ROW EXECUTE FUNCTION v2_lock_gallery_suppression_control();

CREATE OR REPLACE FUNCTION v2_guard_gallery_outbox_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_row signature_mint_controls%ROWTYPE;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'pending' THEN
            RAISE EXCEPTION 'gallery outbox item must begin pending';
        END IF;
    ELSE
        IF ROW(
            NEW.outbox_id, NEW.signature_id, NEW.deployment_id, NEW.action,
            NEW.observed_control_version, NEW.payload, NEW.created_at
        ) IS DISTINCT FROM ROW(
            OLD.outbox_id, OLD.signature_id, OLD.deployment_id, OLD.action,
            OLD.observed_control_version, OLD.payload, OLD.created_at
        ) THEN
            RAISE EXCEPTION 'gallery outbox identity, action, authority, and payload are immutable';
        END IF;
        IF OLD.state IN ('completed', 'aborted') AND NEW.state <> OLD.state THEN
            RAISE EXCEPTION 'terminal gallery outbox item cannot transition';
        END IF;
        IF NEW.state <> OLD.state AND NOT (
            (OLD.state = 'pending' AND NEW.state IN ('processing', 'failed', 'aborted'))
            OR (OLD.state = 'processing' AND NEW.state IN ('completed', 'failed', 'aborted'))
            OR (OLD.state = 'failed' AND NEW.state IN ('processing', 'aborted'))
        ) THEN
            RAISE EXCEPTION 'invalid gallery outbox state transition';
        END IF;
        IF NEW.updated_at < OLD.updated_at THEN
            RAISE EXCEPTION 'gallery outbox updated_at cannot move backwards';
        END IF;
    END IF;

    -- An abort is the fail-closed cleanup path after finality, suppression, or
    -- control authority is lost.  Every other publish write revalidates.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.action <> 'publish' OR NEW.state = 'aborted' THEN
            RETURN NEW;
        END IF;
    END IF;

    SELECT * INTO control_row
      FROM signature_mint_controls
     WHERE signature_id = NEW.signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_row.version <> NEW.observed_control_version THEN
        RAISE EXCEPTION 'gallery outbox item has a stale control version';
    END IF;
    IF NEW.action = 'publish'
       AND (
           control_row.issuance_state <> 'enabled'
           OR EXISTS (
               SELECT 1 FROM gallery_suppressions
                WHERE signature_id = NEW.signature_id
                  AND deployment_id = NEW.deployment_id
           )
       ) THEN
        RAISE EXCEPTION 'suppressed or disabled signature cannot enqueue publication';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER gallery_publication_outbox_guard_write
    BEFORE INSERT OR UPDATE ON gallery_publication_outbox
    FOR EACH ROW EXECUTE FUNCTION v2_guard_gallery_outbox_insert();

-- Gallery finalization and its publish outbox item are commonly written in the
-- same indexer transaction.  Keep this ownership check deferred so either row
-- may be inserted first, while still making an unfinalized publish impossible
-- to commit.
CREATE OR REPLACE FUNCTION v2_validate_gallery_publish_outbox_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_row signature_mint_controls%ROWTYPE;
BEGIN
    IF NEW.action <> 'publish' OR NEW.state = 'aborted' THEN
        RETURN NULL;
    END IF;

    SELECT * INTO control_row
      FROM signature_mint_controls
     WHERE signature_id = NEW.signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_row.issuance_state <> 'enabled'
       OR control_row.version <> NEW.observed_control_version
       OR EXISTS (
            SELECT 1 FROM gallery_suppressions
             WHERE signature_id = NEW.signature_id
               AND deployment_id = NEW.deployment_id
       ) THEN
        RAISE EXCEPTION 'publish outbox item lost its control/suppression fence';
    END IF;

    PERFORM 1
      FROM gallery_entries entry
     WHERE entry.signature_id = NEW.signature_id
       AND entry.deployment_id = NEW.deployment_id
       AND entry.chain_state = 'finalized'
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'publish outbox item requires an exact finalized Gallery entry';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER gallery_publication_outbox_validate_finality_commit
    AFTER INSERT OR UPDATE ON gallery_publication_outbox
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION v2_validate_gallery_publish_outbox_commit();

CREATE OR REPLACE FUNCTION v2_guard_publication_lease()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_row signature_mint_controls%ROWTYPE;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.state <> 'staging' THEN
        RAISE EXCEPTION 'publication lease must begin staging';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF ROW(
            NEW.publication_lease_id, NEW.signature_id, NEW.deployment_id,
            NEW.control_version, NEW.fencing_token, NEW.staged_object_key,
            NEW.created_at, NEW.expires_at
        ) IS DISTINCT FROM ROW(
            OLD.publication_lease_id, OLD.signature_id, OLD.deployment_id,
            OLD.control_version, OLD.fencing_token, OLD.staged_object_key,
            OLD.created_at, OLD.expires_at
        ) THEN
            RAISE EXCEPTION 'publication lease identity and fence are immutable';
        END IF;
        IF OLD.state IN ('activated', 'aborted', 'expired') AND NEW.state <> OLD.state THEN
            RAISE EXCEPTION 'terminal publication lease cannot transition';
        END IF;
        IF NEW.state <> OLD.state AND NOT (
            (OLD.state = 'staging' AND NEW.state IN ('ready', 'aborted', 'expired'))
            OR (OLD.state = 'ready' AND NEW.state IN ('activated', 'aborted', 'expired'))
        ) THEN
            RAISE EXCEPTION 'invalid publication lease transition';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.state IN ('staging', 'ready', 'activated') THEN
        IF NEW.expires_at <= now() THEN
            RAISE EXCEPTION 'publication lease has expired';
        END IF;
        SELECT * INTO control_row
          FROM signature_mint_controls
         WHERE signature_id = NEW.signature_id
         FOR UPDATE;
        IF NOT FOUND OR control_row.issuance_state <> 'enabled'
           OR control_row.version <> NEW.control_version
           OR control_row.publication_fencing_token <> NEW.fencing_token
           OR EXISTS (
                SELECT 1 FROM gallery_suppressions
                 WHERE signature_id = NEW.signature_id
                   AND deployment_id = NEW.deployment_id
        ) THEN
            RAISE EXCEPTION 'publication lease lost its control/suppression fence';
        END IF;

        -- Recheck finality for staging, ready, and especially the activation
        -- write.  A queued publish item is never authority to expose content.
        PERFORM 1
          FROM gallery_entries entry
         WHERE entry.signature_id = NEW.signature_id
           AND entry.deployment_id = NEW.deployment_id
           AND entry.chain_state = 'finalized'
         FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'publication lease requires an exact finalized Gallery entry';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER publication_leases_guard
    BEFORE INSERT OR UPDATE ON publication_leases
    FOR EACH ROW EXECUTE FUNCTION v2_guard_publication_lease();

CREATE OR REPLACE FUNCTION v2_guard_content_object()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.fencing_token < OLD.fencing_token THEN
        RAISE EXCEPTION 'content-object fencing token cannot decrease';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
        (OLD.state = 'absent' AND NEW.state IN ('present', 'deletion_pending'))
        OR (OLD.state = 'present' AND NEW.state = 'deletion_pending')
        OR (OLD.state = 'deletion_pending' AND NEW.state = 'absent')
    ) THEN
        RAISE EXCEPTION 'invalid content-object guard transition';
    END IF;
    IF NEW.state = 'deletion_pending' AND OLD.state <> 'deletion_pending' THEN
        IF NEW.fencing_token <= OLD.fencing_token THEN
            RAISE EXCEPTION 'content deletion must advance the fence';
        END IF;
        IF NEW.delete_after <= now() THEN
            RAISE EXCEPTION 'content deletion requires a future grace deadline';
        END IF;
        IF EXISTS (
            SELECT 1 FROM content_object_references
             WHERE storage_target_id = OLD.storage_target_id
               AND object_key = OLD.object_key
        ) OR EXISTS (
            SELECT 1 FROM content_object_write_leases
             WHERE storage_target_id = OLD.storage_target_id
               AND object_key = OLD.object_key
               AND state = 'writing'
               AND expires_at > now()
        ) THEN
            RAISE EXCEPTION 'content deletion requires zero references and no live writer lease';
        END IF;
    END IF;
    IF OLD.state = 'deletion_pending' AND NEW.state = 'absent' THEN
        IF now() < OLD.delete_after THEN
            RAISE EXCEPTION 'content deletion grace period has not elapsed';
        END IF;
        IF EXISTS (
            SELECT 1 FROM content_object_references
             WHERE storage_target_id = OLD.storage_target_id
               AND object_key = OLD.object_key
        ) OR EXISTS (
            SELECT 1 FROM content_object_write_leases
             WHERE storage_target_id = OLD.storage_target_id
               AND object_key = OLD.object_key
               AND state = 'writing'
               AND expires_at > now()
        ) THEN
            RAISE EXCEPTION 'content object is not safe to mark absent';
        END IF;
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'content-object updated_at cannot move backwards';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER content_object_guards_guard
    BEFORE UPDATE ON content_object_guards
    FOR EACH ROW EXECUTE FUNCTION v2_guard_content_object();

CREATE OR REPLACE FUNCTION v2_guard_content_write_lease()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    guard_row content_object_guards%ROWTYPE;
    control_row signature_mint_controls%ROWTYPE;
    metadata_row token_metadata%ROWTYPE;
    v1_object_matches BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'writing' THEN
            RAISE EXCEPTION 'content write lease must begin writing';
        END IF;
    ELSE
        IF ROW(
            NEW.lease_id, NEW.storage_target_id, NEW.object_key, NEW.fencing_token,
            NEW.owner, NEW.purpose, NEW.reference_kind, NEW.reference_id,
            NEW.control_signature_id, NEW.control_version,
            NEW.metadata_deployment_id, NEW.metadata_fencing_token,
            NEW.metadata_lease_owner, NEW.created_at, NEW.expires_at
        ) IS DISTINCT FROM ROW(
            OLD.lease_id, OLD.storage_target_id, OLD.object_key, OLD.fencing_token,
            OLD.owner, OLD.purpose, OLD.reference_kind, OLD.reference_id,
            OLD.control_signature_id, OLD.control_version,
            OLD.metadata_deployment_id, OLD.metadata_fencing_token,
            OLD.metadata_lease_owner, OLD.created_at, OLD.expires_at
        ) THEN
            RAISE EXCEPTION 'content write lease identity, owner authority, and fences are immutable';
        END IF;
        IF OLD.state IN ('committed', 'aborted', 'expired') AND NEW.state <> OLD.state THEN
            RAISE EXCEPTION 'terminal content write lease cannot transition';
        END IF;
        IF NEW.state <> OLD.state
           AND NOT (OLD.state = 'writing' AND NEW.state IN ('committed', 'aborted', 'expired')) THEN
            RAISE EXCEPTION 'invalid content write lease transition';
        END IF;

        -- Cleanup must remain possible after a control or metadata fence is
        -- lost.  Only a writer that remains active or claims commit authority
        -- needs to pass all authority checks below.
        IF NEW.state IN ('aborted', 'expired') THEN
            RETURN NEW;
        END IF;
    END IF;

    IF NEW.expires_at <= now() THEN
        RAISE EXCEPTION 'content write lease must retain a live deadline through commit';
    END IF;

    SELECT * INTO control_row
      FROM signature_mint_controls
     WHERE signature_id = NEW.control_signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_row.issuance_state <> 'enabled'
       OR control_row.version <> NEW.control_version THEN
        RAISE EXCEPTION 'content writer lost its signature control fence';
    END IF;

    IF NEW.reference_kind IN ('v1_svg', 'v1_png') THEN
        SELECT CASE NEW.reference_kind
                   WHEN 'v1_svg' THEN sig.svg_storage_key = NEW.object_key
                   WHEN 'v1_png' THEN sig.card_storage_key = NEW.object_key
                   ELSE FALSE
               END
          INTO v1_object_matches
          FROM signatures sig
         WHERE sig.signature_id = NEW.control_signature_id
         FOR KEY SHARE;
        IF NOT FOUND OR v1_object_matches IS DISTINCT FROM TRUE
           OR NEW.reference_id <> NEW.control_signature_id THEN
            RAISE EXCEPTION 'V1 content writer must name its exact signature artifact';
        END IF;
    ELSE
        SELECT * INTO metadata_row
          FROM token_metadata metadata
         WHERE metadata.signature_id = NEW.control_signature_id
           AND metadata.deployment_id = NEW.metadata_deployment_id
         FOR UPDATE;
        IF NOT FOUND OR metadata_row.preparation_state <> 'publishing'
           OR metadata_row.control_version <> NEW.control_version
           OR metadata_row.fencing_token <> NEW.metadata_fencing_token
           OR metadata_row.lease_owner IS DISTINCT FROM NEW.metadata_lease_owner
           OR metadata_row.lease_expires_at IS NULL
           OR metadata_row.lease_expires_at <= now()
           OR NEW.reference_id <> v2_token_metadata_reference_id(
               metadata_row.signature_id, metadata_row.deployment_id, NEW.reference_kind
           )
           OR NOT (
               (NEW.reference_kind = 'v2_svg_pin' AND NEW.object_key = metadata_row.svg_cid)
               OR (NEW.reference_kind = 'v2_png_pin' AND NEW.object_key = metadata_row.png_cid)
               OR (NEW.reference_kind = 'v2_metadata_pin'
                   AND NEW.object_key IN (
                       metadata_row.metadata_cid, metadata_row.canonical_json_storage_key
                   ))
           ) THEN
            RAISE EXCEPTION 'content writer lost its exact metadata-preparation fence';
        END IF;
    END IF;

    SELECT * INTO guard_row
      FROM content_object_guards
     WHERE storage_target_id = NEW.storage_target_id
       AND object_key = NEW.object_key
     FOR UPDATE;
    IF NOT FOUND OR guard_row.state = 'deletion_pending'
       OR guard_row.fencing_token <> NEW.fencing_token
       OR (NEW.state = 'committed' AND guard_row.state <> 'present') THEN
        RAISE EXCEPTION 'content write lease does not own the current object guard fence';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER content_object_write_leases_guard
    BEFORE INSERT OR UPDATE ON content_object_write_leases
    FOR EACH ROW EXECUTE FUNCTION v2_guard_content_write_lease();

-- This immediate gate proves that a reference was attached while its owner was
-- still allowed to write.  The deferred gate below then permits the same
-- transaction to advance publishing -> verified/frozen while rechecking that
-- neither the control nor metadata fence changed before commit.
CREATE OR REPLACE FUNCTION v2_guard_content_reference_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_row signature_mint_controls%ROWTYPE;
    metadata_row token_metadata%ROWTYPE;
    v1_object_matches BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'content references are immutable; detach and recreate under a fresh fence';
    END IF;

    SELECT * INTO control_row
      FROM signature_mint_controls
     WHERE signature_id = NEW.control_signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_row.issuance_state <> 'enabled'
       OR control_row.version <> NEW.control_version THEN
        RAISE EXCEPTION 'content reference lost its signature control fence';
    END IF;

    IF NEW.reference_kind IN ('v1_svg', 'v1_png') THEN
        SELECT CASE NEW.reference_kind
                   WHEN 'v1_svg' THEN sig.svg_storage_key = NEW.object_key
                   WHEN 'v1_png' THEN sig.card_storage_key = NEW.object_key
                   ELSE FALSE
               END
          INTO v1_object_matches
          FROM signatures sig
         WHERE sig.signature_id = NEW.control_signature_id
         FOR KEY SHARE;
        IF NOT FOUND OR v1_object_matches IS DISTINCT FROM TRUE
           OR NEW.reference_id <> NEW.control_signature_id THEN
            RAISE EXCEPTION 'V1 content reference must name its exact signature artifact';
        END IF;
    ELSE
        SELECT * INTO metadata_row
          FROM token_metadata metadata
         WHERE metadata.signature_id = NEW.control_signature_id
           AND metadata.deployment_id = NEW.metadata_deployment_id
         FOR UPDATE;
        IF NOT FOUND OR metadata_row.preparation_state <> 'publishing'
           OR metadata_row.control_version <> NEW.control_version
           OR metadata_row.fencing_token <> NEW.metadata_fencing_token
           OR metadata_row.lease_owner IS DISTINCT FROM NEW.metadata_lease_owner
           OR metadata_row.lease_expires_at IS NULL
           OR metadata_row.lease_expires_at <= now()
           OR NEW.reference_id <> v2_token_metadata_reference_id(
               metadata_row.signature_id, metadata_row.deployment_id, NEW.reference_kind
           )
           OR NOT (
               (NEW.reference_kind = 'v2_svg_pin' AND NEW.object_key = metadata_row.svg_cid)
               OR (NEW.reference_kind = 'v2_png_pin' AND NEW.object_key = metadata_row.png_cid)
               OR (NEW.reference_kind = 'v2_metadata_pin'
                   AND NEW.object_key IN (
                       metadata_row.metadata_cid, metadata_row.canonical_json_storage_key
                   ))
           ) THEN
            RAISE EXCEPTION 'V2 content reference requires the live metadata-preparation owner and fence';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER content_object_references_guard_write
    BEFORE INSERT OR UPDATE ON content_object_references
    FOR EACH ROW EXECUTE FUNCTION v2_guard_content_reference_write();

CREATE OR REPLACE FUNCTION v2_validate_content_reference_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    lease_row content_object_write_leases%ROWTYPE;
    guard_row content_object_guards%ROWTYPE;
    control_row signature_mint_controls%ROWTYPE;
    metadata_row token_metadata%ROWTYPE;
    lease_found BOOLEAN;
    guard_found BOOLEAN;
    v1_object_matches BOOLEAN;
BEGIN
    SELECT * INTO lease_row
      FROM content_object_write_leases
     WHERE lease_id = NEW.write_lease_id
     FOR SHARE;
    lease_found := FOUND;
    SELECT * INTO guard_row
      FROM content_object_guards
     WHERE storage_target_id = NEW.storage_target_id
       AND object_key = NEW.object_key
     FOR UPDATE;
    guard_found := FOUND;

    IF NOT lease_found OR NOT guard_found
       OR lease_row.storage_target_id <> NEW.storage_target_id
       OR lease_row.object_key <> NEW.object_key
       OR lease_row.reference_kind <> NEW.reference_kind
       OR lease_row.reference_id <> NEW.reference_id
       OR lease_row.control_signature_id <> NEW.control_signature_id
       OR lease_row.control_version <> NEW.control_version
       OR lease_row.metadata_deployment_id IS DISTINCT FROM NEW.metadata_deployment_id
       OR lease_row.metadata_fencing_token IS DISTINCT FROM NEW.metadata_fencing_token
       OR lease_row.metadata_lease_owner IS DISTINCT FROM NEW.metadata_lease_owner
       OR lease_row.state <> 'committed'
       OR guard_row.state <> 'present'
       OR guard_row.fencing_token <> lease_row.fencing_token THEN
        RAISE EXCEPTION 'content reference did not commit under its exact current writer fence';
    END IF;

    SELECT * INTO control_row
      FROM signature_mint_controls
     WHERE signature_id = NEW.control_signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_row.issuance_state <> 'enabled'
       OR control_row.version <> NEW.control_version THEN
        RAISE EXCEPTION 'content reference lost its signature control fence before commit';
    END IF;

    IF NEW.reference_kind IN ('v1_svg', 'v1_png') THEN
        SELECT CASE NEW.reference_kind
                   WHEN 'v1_svg' THEN sig.svg_storage_key = NEW.object_key
                   WHEN 'v1_png' THEN sig.card_storage_key = NEW.object_key
                   ELSE FALSE
               END
          INTO v1_object_matches
          FROM signatures sig
         WHERE sig.signature_id = NEW.control_signature_id
         FOR KEY SHARE;
        IF NOT FOUND OR v1_object_matches IS DISTINCT FROM TRUE
           OR NEW.reference_id <> NEW.control_signature_id THEN
            RAISE EXCEPTION 'V1 content reference lost its exact signature owner before commit';
        END IF;
    ELSE
        SELECT * INTO metadata_row
          FROM token_metadata metadata
         WHERE metadata.signature_id = NEW.control_signature_id
           AND metadata.deployment_id = NEW.metadata_deployment_id
         FOR UPDATE;
        IF NOT FOUND
           OR metadata_row.preparation_state NOT IN ('publishing', 'verified', 'frozen')
           OR metadata_row.control_version <> NEW.control_version
           OR metadata_row.fencing_token <> NEW.metadata_fencing_token
           OR (
               metadata_row.preparation_state = 'publishing'
               AND (
                   metadata_row.lease_owner IS DISTINCT FROM NEW.metadata_lease_owner
                   OR metadata_row.lease_expires_at IS NULL
                   OR metadata_row.lease_expires_at <= now()
               )
           )
           OR NEW.reference_id <> v2_token_metadata_reference_id(
               metadata_row.signature_id, metadata_row.deployment_id, NEW.reference_kind
           )
           OR NOT (
               (NEW.reference_kind = 'v2_svg_pin' AND NEW.object_key = metadata_row.svg_cid)
               OR (NEW.reference_kind = 'v2_png_pin' AND NEW.object_key = metadata_row.png_cid)
               OR (NEW.reference_kind = 'v2_metadata_pin'
                   AND NEW.object_key IN (
                       metadata_row.metadata_cid, metadata_row.canonical_json_storage_key
                   ))
           ) THEN
            RAISE EXCEPTION 'V2 content reference lost its metadata-preparation fence before commit';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER content_object_references_validate_commit
    AFTER INSERT OR UPDATE ON content_object_references
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION v2_validate_content_reference_commit();

CREATE OR REPLACE FUNCTION v2_guard_v1_signature_erasure()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    control_state TEXT;
BEGIN
    SELECT issuance_state INTO control_state
      FROM signature_mint_controls
     WHERE signature_id = OLD.signature_id
     FOR UPDATE;
    IF NOT FOUND OR control_state <> 'erasure_pending' THEN
        RAISE EXCEPTION 'V1 signature deletion requires erasure_pending mint control';
    END IF;
    IF EXISTS (
        SELECT 1 FROM publication_leases
         WHERE signature_id = OLD.signature_id
           AND state IN ('staging', 'ready')
    ) OR EXISTS (
        SELECT 1 FROM gallery_publication_outbox
         WHERE signature_id = OLD.signature_id
           AND state IN ('pending', 'processing', 'failed')
    ) THEN
        RAISE EXCEPTION 'publication work must be fenced and drained before V1 erasure';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM mint_authorizations mint_auth
         WHERE mint_auth.signature_id = OLD.signature_id
           AND NOT v2_authorization_is_safely_dead(mint_auth)
    ) THEN
        RAISE EXCEPTION 'all mint authorizations must be proven safely dead before V1 erasure';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM mint_deployments deployment
         WHERE NOT v2_has_signature_erasure_chain_evidence(
             OLD.signature_id, deployment.deployment_id, '-infinity'::timestamptz
         )
    ) THEN
        RAISE EXCEPTION 'V1 signature deletion requires finalized erasure evidence for every deployment';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM contract_log_observations event
         WHERE event.signature_id = OLD.signature_id
           AND event.event_kind = 'signature_minted'
           AND (
               (event.canonical AND NOT event.orphaned)
               OR event.finality_state IN ('finalized', 'finality_revoked')
           )
    ) THEN
        RAISE EXCEPTION 'observed mint evidence blocks V1 erasure';
    END IF;
    IF EXISTS (
        SELECT 1 FROM content_object_references
         WHERE reference_id = OLD.signature_id
           AND reference_kind IN ('v1_svg', 'v1_png')
    ) THEN
        RAISE EXCEPTION 'V1 artifact references must be detached before V1 erasure';
    END IF;
    IF EXISTS (
        SELECT 1 FROM content_object_write_leases
         WHERE storage_target_id = 'v1_primary_artifact_store'
           AND object_key IN (OLD.svg_storage_key, OLD.card_storage_key)
           AND state = 'writing'
           AND expires_at > now()
    ) THEN
        RAISE EXCEPTION 'V1 artifact writers must be drained before V1 erasure';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER signatures_v2_erasure_guard
    BEFORE DELETE ON signatures
    FOR EACH ROW EXECUTE FUNCTION v2_guard_v1_signature_erasure();

-- -------------------------------------------------------------------------
-- Additive V1 bridge.  Deployment gates default closed, so these rows do not
-- enable V2 by themselves.  The cutover runbook must still verify each V1
-- artifact against its stored SHA-256 before enabling an issuer or worker.

INSERT INTO signature_mint_controls (
    signature_id, issuance_state, version, broad_reason_class,
    publication_fencing_token, created_at, updated_at
)
SELECT signature_id, 'enabled', 1, NULL, 0, claimed_at, now()
  FROM signatures
ON CONFLICT (signature_id) DO NOTHING;

-- `v1_primary_artifact_store` is the logical target name for the existing V1
-- AssetStore.  Production configuration must map it to the real V1 namespace.
INSERT INTO content_object_guards (
    storage_target_id, object_key, state, fencing_token, updated_at
)
SELECT 'v1_primary_artifact_store', object_key, 'present', 1, now()
  FROM (
      SELECT svg_storage_key AS object_key FROM signatures
      UNION
      SELECT card_storage_key AS object_key FROM signatures
  ) retained_objects
ON CONFLICT (storage_target_id, object_key) DO NOTHING;

-- Synthetic, per-reference fenced leases bring already-committed V1 objects
-- into the same owner-authority invariant as every later V1/V2 writer.  The
-- object guard remains shared, so byte-identical artifacts still retain one
-- physical object until the final independent reference is removed.
--
-- Validate each imported reference before advancing the same shared object's
-- fence for a later owner.  The runtime trigger remains initially deferred so
-- a normal writer transaction may commit its lease/reference in either order.
SET CONSTRAINTS content_object_references_validate_commit IMMEDIATE;

DO $v2_v1_content_backfill$
DECLARE
    artifact RECORD;
    next_fencing_token BIGINT;
    backfill_lease_id TEXT;
BEGIN
    FOR artifact IN
        SELECT sig.signature_id,
               control.version AS control_version,
               sig.svg_storage_key AS object_key,
               'v1_svg'::TEXT AS reference_kind,
               sig.claimed_at
          FROM signatures sig
          JOIN signature_mint_controls control
            ON control.signature_id = sig.signature_id
        UNION ALL
        SELECT sig.signature_id,
               control.version AS control_version,
               sig.card_storage_key AS object_key,
               'v1_png'::TEXT AS reference_kind,
               sig.claimed_at
          FROM signatures sig
          JOIN signature_mint_controls control
            ON control.signature_id = sig.signature_id
         ORDER BY object_key, signature_id, reference_kind
    LOOP
        UPDATE content_object_guards
           SET fencing_token = fencing_token + 1,
               updated_at = now()
         WHERE storage_target_id = 'v1_primary_artifact_store'
           AND object_key = artifact.object_key
         RETURNING fencing_token INTO next_fencing_token;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'V1 content backfill is missing its shared object guard';
        END IF;

        backfill_lease_id := 'v1-backfill:' || artifact.signature_id
            || ':' || artifact.reference_kind;
        INSERT INTO content_object_write_leases (
            lease_id, storage_target_id, object_key, fencing_token, owner,
            purpose, reference_kind, reference_id, control_signature_id,
            control_version, state, created_at, expires_at
        ) VALUES (
            backfill_lease_id, 'v1_primary_artifact_store', artifact.object_key,
            next_fencing_token, 'migration-002',
            'v1_artifact_reference_backfill', artifact.reference_kind,
            artifact.signature_id, artifact.signature_id,
            artifact.control_version, 'writing', now(), now() + INTERVAL '1 hour'
        );

        UPDATE content_object_write_leases
           SET state = 'committed'
         WHERE lease_id = backfill_lease_id;

        INSERT INTO content_object_references (
            storage_target_id, object_key, reference_kind, reference_id,
            write_lease_id, control_signature_id, control_version, created_at
        ) VALUES (
            'v1_primary_artifact_store', artifact.object_key,
            artifact.reference_kind, artifact.signature_id, backfill_lease_id,
            artifact.signature_id, artifact.control_version, artifact.claimed_at
        );
    END LOOP;
END;
$v2_v1_content_backfill$;

SET CONSTRAINTS content_object_references_validate_commit DEFERRED;

COMMIT;
