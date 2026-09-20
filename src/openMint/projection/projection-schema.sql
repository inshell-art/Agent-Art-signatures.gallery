-- E20 foundation. Apply once after persistence/schema.sql with a migration role.
-- Never applied by runtime startup. No chain, confirmation or public RPC default.
BEGIN;
CREATE TABLE open_mint.projection_schema_version(version integer PRIMARY KEY CHECK(version = 1));
INSERT INTO open_mint.projection_schema_version VALUES (1);
CREATE TABLE open_mint.projection_deployments (
  deployment_id uuid PRIMARY KEY,
  namespace_id uuid NOT NULL REFERENCES open_mint.namespaces,
  configuration bytea NOT NULL CHECK(octet_length(configuration) BETWEEN 1 AND 8192)
);
CREATE TABLE open_mint.projection_checkpoints (
  deployment_id uuid PRIMARY KEY REFERENCES open_mint.projection_deployments,
  head_number bigint CHECK(head_number >= 0), head_hash text,
  promoted_number bigint CHECK(promoted_number >= 0), promoted_hash text,
  health text NOT NULL DEFAULT 'unknown' CHECK(health IN ('unknown', 'available', 'safety-halted')),
  halt_reason text CHECK(halt_reason IN ('deployment-contradiction', 'canonical-contradiction', 'immutable-block-contradiction')),
  CHECK((head_number IS NULL) = (head_hash IS NULL)), CHECK((promoted_number IS NULL) = (promoted_hash IS NULL)),
  CHECK(promoted_number IS NULL OR promoted_number <= head_number),
  CHECK((health = 'safety-halted') = (halt_reason IS NOT NULL))
);
CREATE TABLE open_mint.projection_blocks (
  deployment_id uuid NOT NULL REFERENCES open_mint.projection_deployments,
  number bigint NOT NULL CHECK(number >= 0), hash text NOT NULL CHECK(hash ~ '^0x[0-9a-f]{64}$'),
  parent_hash text NOT NULL CHECK(parent_hash ~ '^0x[0-9a-f]{64}$'),
  canonical boolean NOT NULL,
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 262144),
  PRIMARY KEY(deployment_id, hash), UNIQUE(deployment_id, number, hash)
);
CREATE UNIQUE INDEX projection_canonical_height ON open_mint.projection_blocks(deployment_id, number) WHERE canonical;
CREATE TABLE open_mint.projection_logs (
  deployment_id uuid NOT NULL, block_hash text NOT NULL,
  transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_index integer NOT NULL CHECK(transaction_index >= 0), log_index integer NOT NULL CHECK(log_index >= 0),
  kind text NOT NULL CHECK(kind IN ('OpenSignatureMinted', 'Transfer')),
  payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 8192),
  PRIMARY KEY(deployment_id, block_hash, log_index),
  FOREIGN KEY(deployment_id, block_hash) REFERENCES open_mint.projection_blocks
);
CREATE TABLE open_mint.projection_mints (
  deployment_id uuid NOT NULL REFERENCES open_mint.projection_deployments,
  token_id numeric(78,0) NOT NULL CHECK(token_id > 0 AND token_id < power(2::numeric,256)),
  handle text NOT NULL CHECK(handle ~ '^[a-z0-9_]{1,15}$'), mbti text NOT NULL CHECK(mbti ~ '^[EI][NS][TF][JP]$'),
  nonce text NOT NULL CHECK(nonce ~ '^0x[0-9a-f]{64}$'),
  original_recipient text NOT NULL CHECK(original_recipient ~ '^0x[0-9a-f]{40}$'),
  block_number bigint NOT NULL, block_hash text NOT NULL, transaction_index integer NOT NULL CHECK(transaction_index >= 0),
  log_index integer NOT NULL CHECK(log_index >= 0), payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 8192),
  availability text NOT NULL DEFAULT 'unavailable' CHECK(availability IN ('available', 'unavailable', 'quarantined')),
  PRIMARY KEY(deployment_id, token_id), UNIQUE(deployment_id, handle), UNIQUE(deployment_id, nonce),
  FOREIGN KEY(deployment_id, block_number, block_hash) REFERENCES open_mint.projection_blocks(deployment_id, number, hash)
);
CREATE INDEX projection_home_position ON open_mint.projection_mints(deployment_id, block_number DESC, transaction_index DESC, log_index DESC, token_id DESC);
CREATE INDEX projection_mbti_position ON open_mint.projection_mints(deployment_id, mbti, block_number DESC, transaction_index DESC, log_index DESC, token_id DESC);
CREATE TABLE open_mint.projection_ownership (
  deployment_id uuid NOT NULL, token_id numeric(78,0) NOT NULL,
  owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$' AND owner <> '0x0000000000000000000000000000000000000000'),
  start_block bigint NOT NULL CHECK(start_block >= 0), start_transaction integer NOT NULL CHECK(start_transaction >= 0), start_log integer NOT NULL CHECK(start_log >= 0),
  end_block bigint, end_transaction integer, end_log integer,
  mint_block bigint NOT NULL CHECK(mint_block >= 0), mint_transaction integer NOT NULL CHECK(mint_transaction >= 0), mint_log integer NOT NULL CHECK(mint_log >= 0),
  PRIMARY KEY(deployment_id, token_id, start_block, start_transaction, start_log),
  FOREIGN KEY(deployment_id, token_id) REFERENCES open_mint.projection_mints ON DELETE CASCADE,
  CHECK((end_block IS NULL) = (end_transaction IS NULL) AND (end_block IS NULL) = (end_log IS NULL)),
  CHECK(end_block IS NULL OR ROW(end_block,end_transaction,end_log) > ROW(start_block,start_transaction,start_log))
);
CREATE UNIQUE INDEX projection_current_owner ON open_mint.projection_ownership(deployment_id, token_id) WHERE end_block IS NULL;
CREATE INDEX projection_owner_snapshot ON open_mint.projection_ownership(deployment_id, owner, mint_block DESC, mint_transaction DESC, mint_log DESC, token_id DESC, start_block, end_block);
CREATE TABLE open_mint.projection_promotions (
  deployment_id uuid NOT NULL, number bigint NOT NULL, hash text NOT NULL,
  policy_id text NOT NULL, evidence_reference text NOT NULL,
  PRIMARY KEY(deployment_id, number),
  FOREIGN KEY(deployment_id, number, hash) REFERENCES open_mint.projection_blocks(deployment_id, number, hash)
);
CREATE TRIGGER immutable_projection_deployment BEFORE UPDATE OR DELETE ON open_mint.projection_deployments
  FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_projection_log BEFORE UPDATE OR DELETE ON open_mint.projection_logs
  FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_projection_promotion BEFORE UPDATE OR DELETE ON open_mint.projection_promotions
  FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE FUNCTION open_mint.guard_projection_block() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'canonical') IS DISTINCT FROM (to_jsonb(OLD) - 'canonical') THEN
    RAISE EXCEPTION 'immutable projection block' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_projection_block BEFORE UPDATE OR DELETE ON open_mint.projection_blocks FOR EACH ROW EXECUTE FUNCTION open_mint.guard_projection_block();
CREATE FUNCTION open_mint.guard_projection_mint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS(SELECT 1 FROM open_mint.projection_checkpoints WHERE deployment_id=OLD.deployment_id AND promoted_number>=OLD.block_number) THEN
      RAISE EXCEPTION 'promoted mint rollback is forbidden' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'availability') IS DISTINCT FROM (to_jsonb(OLD) - 'availability') THEN
    RAISE EXCEPTION 'immutable projected mint' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_projection_mint BEFORE UPDATE OR DELETE ON open_mint.projection_mints FOR EACH ROW EXECUTE FUNCTION open_mint.guard_projection_mint();
REVOKE ALL ON FUNCTION open_mint.guard_projection_block(),open_mint.guard_projection_mint() FROM PUBLIC;
COMMIT;
