-- Algorithm v1.0.0 is a breaking artwork contract. Never reinterpret old
-- fractional seeds or silently re-key immutable claims. The operator must
-- explicitly retire obsolete local data before this migration is allowed.
BEGIN;

DO $$
DECLARE obsolete_tuple_constraint RECORD;
BEGIN
    IF EXISTS (
        SELECT 1 FROM signatures
        WHERE gr0k_scale <> 1 OR gr0k_raw NOT BETWEEN 1 AND 100
           OR renderer_version <> 'sg-renderer-1.0.0'
    ) THEN
        RAISE EXCEPTION 'Obsolete signature claims must be explicitly retired before adopting algorithm v1.0.0';
    END IF;

    ALTER TABLE signatures DROP CONSTRAINT IF EXISTS signatures_gr0k_raw_check;
    ALTER TABLE signatures ADD CONSTRAINT signatures_gr0k_raw_check CHECK (gr0k_raw BETWEEN 1 AND 100);
    ALTER TABLE signatures DROP CONSTRAINT IF EXISTS signatures_gr0k_scale_check;
    ALTER TABLE signatures ADD CONSTRAINT signatures_gr0k_scale_check CHECK (gr0k_scale = 1);
    ALTER TABLE signatures ALTER COLUMN handle_at_claim TYPE TEXT COLLATE "C";

    FOR obsolete_tuple_constraint IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'signatures'::regclass AND contype = 'u'
          AND pg_get_constraintdef(oid) = 'UNIQUE (x_user_id, handle_normalized, gr0k_raw, gr0k_scale, renderer_version)'
    LOOP
        EXECUTE format('ALTER TABLE signatures DROP CONSTRAINT %I', obsolete_tuple_constraint.conname);
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'signatures'::regclass AND conname = 'signatures_formal_artwork_unique') THEN
        ALTER TABLE signatures ADD CONSTRAINT signatures_formal_artwork_unique
            UNIQUE (x_user_id, handle_at_claim, gr0k_raw, gr0k_scale, renderer_version);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'signatures'::regclass AND conname = 'signatures_artwork_account_match') THEN
        ALTER TABLE signatures ADD CONSTRAINT signatures_artwork_account_match
            CHECK (lower(handle_at_claim COLLATE "C") = handle_normalized);
    END IF;
END;
$$;

COMMIT;
