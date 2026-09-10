-- Local-only persistence for the executable Anvil/PostgreSQL rehearsal.
--
-- The production-shaped V1 schema and V2 migration are applied first. These
-- tables deliberately live in a separate schema so local snapshots cannot be
-- mistaken for the normalized production repositories required by the V2
-- handoff.

CREATE SCHEMA IF NOT EXISTS local_rehearsal;

CREATE TABLE IF NOT EXISTS local_rehearsal.schema_migrations (
    migration_name TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS local_rehearsal.state_snapshots (
    snapshot_name TEXT PRIMARY KEY,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS local_rehearsal.chain_runs (
    run_name TEXT PRIMARY KEY,
    chain_id NUMERIC(78, 0) NOT NULL,
    rpc_url TEXT NOT NULL,
    contract_address BYTEA NOT NULL CHECK (octet_length(contract_address) = 20),
    deployment_transaction BYTEA NOT NULL CHECK (octet_length(deployment_transaction) = 32),
    deployment_block_number NUMERIC(78, 0) NOT NULL,
    deployment_block_hash BYTEA NOT NULL CHECK (octet_length(deployment_block_hash) = 32),
    runtime_code_hash BYTEA NOT NULL CHECK (octet_length(runtime_code_hash) = 32),
    seeded_mint_transaction BYTEA CHECK (seeded_mint_transaction IS NULL OR octet_length(seeded_mint_transaction) = 32),
    seeded_signature_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS local_rehearsal.artifact_references (
    storage_key TEXT NOT NULL,
    signature_id TEXT NOT NULL,
    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('svg', 'png')),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (storage_key, signature_id, artifact_kind)
);
