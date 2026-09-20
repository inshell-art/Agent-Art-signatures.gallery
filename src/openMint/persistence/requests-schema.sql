-- Additive private-request migration after schema.sql; no public runtime enabled.
BEGIN;
CREATE TABLE open_mint.request_profiles (
  namespace_id uuid NOT NULL REFERENCES open_mint.namespaces,
  deployment_id uuid NOT NULL,
  chain_id numeric(78,0) NOT NULL CHECK (chain_id > 0),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  genesis_hash text NOT NULL CHECK (genesis_hash ~ '^0x[0-9a-f]{64}$'),
  runtime_code_hash text NOT NULL CHECK (runtime_code_hash ~ '^0x[0-9a-f]{64}$'),
  authorizer text NOT NULL CHECK (authorizer ~ '^0x[0-9a-f]{40}$'),
  deployment_block numeric(78,0) NOT NULL CHECK (deployment_block >= 0),
  deployment_block_hash text NOT NULL CHECK (deployment_block_hash ~ '^0x[0-9a-f]{64}$'),
  max_evidence_age_ms integer NOT NULL CHECK (max_evidence_age_ms BETWEEN 1 AND 60000),
  max_block_age_ms integer NOT NULL CHECK (max_block_age_ms BETWEEN 1 AND 3600000),
  max_future_skew_ms integer NOT NULL CHECK (max_future_skew_ms BETWEEN 0 AND 300000),
  PRIMARY KEY (namespace_id, deployment_id)
);
ALTER TABLE open_mint.assessments ADD UNIQUE (namespace_id, handle, assessment_id);
CREATE TABLE open_mint.requests (
  namespace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  deployment_id uuid NOT NULL,
  session_hash text NOT NULL,
  session_generation bigint NOT NULL CHECK (session_generation >= 0),
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9A-Fa-f]{40}$'),
  handle text NOT NULL CHECK (handle ~ '^[a-z0-9_]{1,15}$'),
  requested_handle text NOT NULL CHECK (requested_handle ~ '^[A-Za-z0-9_]{1,15}$' AND lower(requested_handle) = handle),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempt_id uuid,
  assessment_id uuid,
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  preflight_observed_at timestamptz NOT NULL,
  preflight_valid_until timestamptz NOT NULL,
  preflight_block_number numeric(78,0) NOT NULL CHECK (preflight_block_number >= 0),
  preflight_block_hash text NOT NULL CHECK (preflight_block_hash ~ '^0x[0-9a-f]{64}$'),
  preflight_nonce numeric(78,0) NOT NULL CHECK (preflight_nonce >= 0),
  PRIMARY KEY (namespace_id, request_id),
  UNIQUE (namespace_id, code_hash),
  FOREIGN KEY (namespace_id, deployment_id) REFERENCES open_mint.request_profiles,
  FOREIGN KEY (namespace_id, session_hash) REFERENCES open_mint.sessions,
  FOREIGN KEY (namespace_id, attempt_id, handle) REFERENCES open_mint.assessment_attempts (namespace_id, attempt_id, handle),
  FOREIGN KEY (namespace_id, handle, assessment_id) REFERENCES open_mint.assessments (namespace_id, handle, assessment_id),
  CHECK (num_nonnulls(attempt_id, assessment_id) = 1),
  CHECK (expires_at = created_at + interval '15 minutes'),
  CHECK (preflight_observed_at <= created_at AND created_at < preflight_valid_until)
);
CREATE INDEX live_session_requests ON open_mint.requests (namespace_id, session_hash, expires_at);
CREATE TRIGGER immutable_request_profile BEFORE UPDATE OR DELETE ON open_mint.request_profiles FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_request BEFORE UPDATE OR DELETE ON open_mint.requests FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
REVOKE ALL ON open_mint.request_profiles, open_mint.requests FROM PUBLIC;
COMMIT;
