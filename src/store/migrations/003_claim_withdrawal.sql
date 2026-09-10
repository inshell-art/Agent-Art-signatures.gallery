-- Ordinary claim withdrawal is deletion, not administrative erasure. Keep the
-- original erasure guard for that separate workflow. This narrow alternative
-- only permits claims with no normalized V2 mint/publication history. The
-- local executable adapter additionally checks and atomically prunes its
-- durable mint snapshot under the shared runtime operation boundary.
BEGIN;

ALTER TABLE signatures ADD COLUMN IF NOT EXISTS claim_instance_id UUID NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION v2_guard_claim_withdrawal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE control_state TEXT;
BEGIN
    INSERT INTO signature_mint_controls (signature_id, issuance_state)
    VALUES (OLD.signature_id, 'enabled') ON CONFLICT DO NOTHING;
    SELECT issuance_state INTO control_state FROM signature_mint_controls
      WHERE signature_id = OLD.signature_id FOR UPDATE;
    IF control_state <> 'enabled'
       OR EXISTS (SELECT 1 FROM token_metadata WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM mint_authorizations WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM mint_aggregates WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM gallery_entries WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM token_holders WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM contract_log_observations WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM gallery_suppressions WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM gallery_publication_outbox WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM publication_leases WHERE signature_id = OLD.signature_id)
       OR EXISTS (SELECT 1 FROM content_object_write_leases WHERE control_signature_id = OLD.signature_id AND state = 'writing' AND expires_at > now())
       OR EXISTS (SELECT 1 FROM content_object_references WHERE control_signature_id = OLD.signature_id)
    THEN RAISE EXCEPTION 'claim withdrawal blocked by mint or publication authority';
    END IF;
    -- Invalidate writers holding the old claim's fence without suppressing a
    -- future fresh claim of the same deterministic artwork.
    UPDATE signature_mint_controls SET version = version + 1,
      publication_fencing_token = publication_fencing_token + 1, updated_at = now()
      WHERE signature_id = OLD.signature_id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS signatures_v2_erasure_guard ON signatures;
CREATE TRIGGER signatures_v2_erasure_guard BEFORE DELETE ON signatures
FOR EACH ROW WHEN (current_setting('signatures.claim_withdrawal', true) IS DISTINCT FROM OLD.signature_id)
EXECUTE FUNCTION v2_guard_v1_signature_erasure();

DROP TRIGGER IF EXISTS signatures_claim_withdrawal_guard ON signatures;
CREATE TRIGGER signatures_claim_withdrawal_guard BEFORE DELETE ON signatures
FOR EACH ROW WHEN (current_setting('signatures.claim_withdrawal', true) = OLD.signature_id)
EXECUTE FUNCTION v2_guard_claim_withdrawal();

COMMIT;
