-- E17 foundation, migration 1. Apply once with a migration role to a reviewed
-- database. Runtime never applies this file or imports existing local records.
BEGIN;
CREATE SCHEMA open_mint;
CREATE TABLE open_mint.schema_version (version integer PRIMARY KEY CHECK (version = 1));
INSERT INTO open_mint.schema_version VALUES (1);
CREATE TABLE open_mint.writer_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch bigint NOT NULL CHECK (epoch >= 0)
);
INSERT INTO open_mint.writer_epoch VALUES (true, 0);

CREATE TABLE open_mint.namespaces (
  namespace_id uuid PRIMARY KEY,
  profile text NOT NULL CHECK (profile IN ('local-fixture', 'local-real', 'staging-testnet', 'production')),
  provenance text NOT NULL CHECK (provenance IN ('grok', 'development-fixture')),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  CHECK ((profile = 'local-fixture') = (provenance = 'development-fixture'))
);
CREATE TABLE open_mint.budget_policies (
  namespace_id uuid PRIMARY KEY REFERENCES open_mint.namespaces,
  profile_version text NOT NULL CHECK (profile_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  expected_model text NOT NULL CHECK (expected_model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  generation_enabled boolean NOT NULL DEFAULT false,
  valid_until timestamptz NOT NULL,
  max_total integer NOT NULL CHECK (max_total BETWEEN 1 AND 100000),
  max_daily integer NOT NULL CHECK (max_daily BETWEEN 1 AND max_total),
  max_active integer NOT NULL CHECK (max_active = 1),
  max_queued integer NOT NULL CHECK (max_queued BETWEEN 1 AND 100),
  reservation_usd_ticks numeric(30,0) NOT NULL CHECK (reservation_usd_ticks >= 0),
  max_exposure_usd_ticks numeric(30,0) NOT NULL CHECK (max_exposure_usd_ticks >= reservation_usd_ticks)
);
CREATE TABLE open_mint.handle_guards (
  namespace_id uuid NOT NULL REFERENCES open_mint.namespaces,
  handle text NOT NULL CHECK (handle ~ '^[a-z0-9_]{1,15}$'),
  PRIMARY KEY (namespace_id, handle)
);
CREATE TABLE open_mint.assessment_attempts (
  namespace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  handle text NOT NULL,
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version = 1),
  profile_version text NOT NULL,
  admitted_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'closed')),
  PRIMARY KEY (namespace_id, attempt_id),
  UNIQUE (namespace_id, handle),
  UNIQUE (namespace_id, attempt_id, handle),
  FOREIGN KEY (namespace_id, handle) REFERENCES open_mint.handle_guards
);
CREATE TABLE open_mint.budget_reservations (
  namespace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  admitted_day date NOT NULL,
  reserved_usd_ticks numeric(30,0) NOT NULL CHECK (reserved_usd_ticks >= 0),
  PRIMARY KEY (namespace_id, attempt_id),
  FOREIGN KEY (namespace_id, attempt_id) REFERENCES open_mint.assessment_attempts
);
CREATE TABLE open_mint.jobs (
  namespace_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assessment', 'render')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'complete')),
  owner_epoch bigint CHECK (owner_epoch > 0),
  PRIMARY KEY (namespace_id, job_id),
  UNIQUE (namespace_id, attempt_id, kind),
  FOREIGN KEY (namespace_id, attempt_id) REFERENCES open_mint.assessment_attempts,
  CHECK ((state = 'queued') = (owner_epoch IS NULL))
);
CREATE TABLE open_mint.dispatch_fences (
  namespace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  leg text NOT NULL CHECK (leg IN ('x-identity', 'grok')),
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  dispatched_at timestamptz NOT NULL,
  PRIMARY KEY (namespace_id, attempt_id, leg),
  FOREIGN KEY (namespace_id, attempt_id) REFERENCES open_mint.assessment_attempts
);
CREATE TABLE open_mint.provider_receipts (
  namespace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  leg text NOT NULL,
  record_version integer NOT NULL DEFAULT 1 CHECK (record_version = 1),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 2 AND 16384),
  cost_status text NOT NULL CHECK (cost_status IN ('actual', 'estimated', 'unknown')),
  cost_usd_ticks numeric(30,0) CHECK (cost_usd_ticks >= 0),
  PRIMARY KEY (namespace_id, attempt_id, leg),
  FOREIGN KEY (namespace_id, attempt_id, leg) REFERENCES open_mint.dispatch_fences,
  CHECK ((cost_status = 'unknown') = (cost_usd_ticks IS NULL))
);
CREATE TABLE open_mint.verified_identities (
  namespace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 2 AND 4096),
  PRIMARY KEY (namespace_id, attempt_id),
  FOREIGN KEY (namespace_id, attempt_id) REFERENCES open_mint.assessment_attempts
);
CREATE TABLE open_mint.assessments (
  namespace_id uuid NOT NULL,
  handle text NOT NULL,
  assessment_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^0x[0-9a-f]{64}$'),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 2 AND 524288),
  PRIMARY KEY (namespace_id, handle),
  UNIQUE (namespace_id, assessment_id),
  UNIQUE (namespace_id, attempt_id),
  FOREIGN KEY (namespace_id, attempt_id, handle) REFERENCES open_mint.assessment_attempts (namespace_id, attempt_id, handle)
);
CREATE INDEX jobs_pending ON open_mint.jobs (namespace_id, kind, state);
CREATE INDEX reservations_day ON open_mint.budget_reservations (namespace_id, admitted_day);

CREATE TABLE open_mint.assessment_terminals (
  namespace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('abstained','invalid','uncertain','blocked-before-dispatch')),
  reason text CHECK (reason IN ('insufficient-evidence','subject-unavailable','provider-refusal')),
  phase text NOT NULL CHECK (phase IN ('before-dispatch','x-identity','grok')),
  owner_epoch bigint NOT NULL CHECK (owner_epoch > 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, attempt_id),
  FOREIGN KEY (namespace_id, attempt_id) REFERENCES open_mint.assessment_attempts,
  CHECK ((kind='abstained') = (reason IS NOT NULL)),
  CHECK (kind <> 'abstained' OR phase='grok'),
  CHECK ((kind='blocked-before-dispatch') = (phase='before-dispatch'))
);

CREATE TABLE open_mint.session_profiles (
  namespace_id uuid PRIMARY KEY REFERENCES open_mint.namespaces,
  origin text NOT NULL CHECK (length(origin) BETWEEN 8 AND 2048),
  chain_id numeric(78,0) NOT NULL CHECK (chain_id > 0)
);
CREATE TABLE open_mint.sessions (
  namespace_id uuid NOT NULL REFERENCES open_mint.namespaces,
  session_hash text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  csrf text NOT NULL CHECK (csrf ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  revoked boolean NOT NULL DEFAULT false,
  wallet text CHECK (wallet ~ '^0x[0-9A-Fa-f]{40}$'),
  proof_wallet text CHECK (proof_wallet ~ '^0x[0-9A-Fa-f]{40}$'),
  proof_code_hash text CHECK (proof_code_hash ~ '^[0-9a-f]{64}$'),
  proof_expires_at timestamptz,
  active_challenge_hash text,
  PRIMARY KEY (namespace_id, session_hash),
  CHECK ((proof_wallet IS NULL) = (proof_expires_at IS NULL)),
  CHECK (proof_wallet IS NOT NULL OR proof_code_hash IS NULL),
  CHECK (NOT revoked OR (wallet IS NULL AND proof_wallet IS NULL AND active_challenge_hash IS NULL))
);
CREATE TABLE open_mint.wallet_challenges (
  namespace_id uuid NOT NULL,
  challenge_hash text NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  session_hash text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  message bytea NOT NULL CHECK (octet_length(message) BETWEEN 1 AND 8192),
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9A-Fa-f]{40}$'),
  code_hash text CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (namespace_id, challenge_hash),
  UNIQUE (namespace_id, session_hash, challenge_hash),
  UNIQUE (namespace_id, session_hash, generation),
  FOREIGN KEY (namespace_id, session_hash) REFERENCES open_mint.sessions
);
ALTER TABLE open_mint.sessions ADD FOREIGN KEY (namespace_id, session_hash, active_challenge_hash)
  REFERENCES open_mint.wallet_challenges(namespace_id, session_hash, challenge_hash);
CREATE UNIQUE INDEX one_active_challenge ON open_mint.wallet_challenges (namespace_id, session_hash) WHERE consumed_at IS NULL;
CREATE INDEX live_sessions ON open_mint.sessions (namespace_id, expires_at) WHERE NOT revoked;

CREATE FUNCTION open_mint.refuse_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'open-mint immutable evidence cannot be changed' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER immutable_namespace BEFORE UPDATE OR DELETE ON open_mint.namespaces FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON open_mint.handle_guards FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_reservation BEFORE UPDATE OR DELETE ON open_mint.budget_reservations FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_dispatch BEFORE UPDATE OR DELETE ON open_mint.dispatch_fences FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON open_mint.provider_receipts FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_identity BEFORE UPDATE OR DELETE ON open_mint.verified_identities FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_assessment BEFORE UPDATE OR DELETE ON open_mint.assessments FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_assessment_terminal BEFORE UPDATE OR DELETE ON open_mint.assessment_terminals FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_session_profile BEFORE UPDATE OR DELETE ON open_mint.session_profiles FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();

CREATE FUNCTION open_mint.guard_challenge_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'challenge deletion is forbidden' USING ERRCODE = '55000'; END IF;
  IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at') OR
    OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'invalid challenge transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_challenge BEFORE UPDATE OR DELETE ON open_mint.wallet_challenges FOR EACH ROW EXECUTE FUNCTION open_mint.guard_challenge_change();
CREATE FUNCTION open_mint.guard_session_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'session deletion requires a reviewed retention migration' USING ERRCODE = '55000'; END IF;
  IF ROW(NEW.namespace_id, NEW.session_hash, NEW.csrf, NEW.expires_at) IS DISTINCT FROM ROW(OLD.namespace_id, OLD.session_hash, OLD.csrf, OLD.expires_at)
    OR OLD.revoked OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation + 1
    OR (NEW.generation <> OLD.generation AND NEW.proof_wallet IS NOT NULL)
    OR (NEW.revoked AND NEW.generation <> OLD.generation + 1) THEN
    RAISE EXCEPTION 'invalid session transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_session BEFORE UPDATE OR DELETE ON open_mint.sessions FOR EACH ROW EXECUTE FUNCTION open_mint.guard_session_change();

-- Operational changes have narrow monotonic transitions; arbitrary JSON writes
-- and deletion cannot erase an initial attempt or manufacture another retry.
CREATE FUNCTION open_mint.guard_attempt_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'attempt deletion is forbidden' USING ERRCODE = '55000'; END IF;
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') OR
     OLD.state <> 'pending' OR NOT (
       (NEW.state = 'accepted' AND EXISTS (SELECT 1 FROM open_mint.assessments WHERE namespace_id = NEW.namespace_id AND attempt_id = NEW.attempt_id)) OR
       (NEW.state = 'closed' AND EXISTS (SELECT 1 FROM open_mint.assessment_terminals WHERE namespace_id = NEW.namespace_id AND attempt_id = NEW.attempt_id))
     ) THEN RAISE EXCEPTION 'invalid attempt transition' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_attempt BEFORE UPDATE OR DELETE ON open_mint.assessment_attempts FOR EACH ROW EXECUTE FUNCTION open_mint.guard_attempt_change();

CREATE FUNCTION open_mint.guard_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'budget policy deletion is forbidden' USING ERRCODE = '55000'; END IF;
  IF (to_jsonb(NEW) - 'generation_enabled') IS DISTINCT FROM (to_jsonb(OLD) - 'generation_enabled') THEN
    RAISE EXCEPTION 'budget policy is immutable except its kill switch' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_policy BEFORE UPDATE OR DELETE ON open_mint.budget_policies FOR EACH ROW EXECUTE FUNCTION open_mint.guard_policy_change();

CREATE FUNCTION open_mint.guard_job_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'job deletion is forbidden' USING ERRCODE = '55000'; END IF;
  IF (to_jsonb(NEW) - 'state' - 'owner_epoch') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'owner_epoch') OR NOT (
    (OLD.state = 'queued' AND NEW.state = 'running' AND NEW.owner_epoch IS NOT NULL) OR
    (OLD.state = 'running' AND NEW.state = 'complete' AND NEW.owner_epoch = OLD.owner_epoch)
  ) THEN RAISE EXCEPTION 'invalid job transition' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_job BEFORE UPDATE OR DELETE ON open_mint.jobs FOR EACH ROW EXECUTE FUNCTION open_mint.guard_job_change();

REVOKE ALL ON SCHEMA open_mint FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA open_mint FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA open_mint FROM PUBLIC;
COMMIT;
