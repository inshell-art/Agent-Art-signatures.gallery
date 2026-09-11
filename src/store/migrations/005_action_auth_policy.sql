-- Keep applied migration 002 byte-identical. X confirmation now authorizes
-- one specific action; it is not a blanket age limit on identity observations.
-- Preserve SIWE's own ten-minute deadline, chronology, proof constraints,
-- binding locks, and the independent fifteen-minute mint-authority window.
BEGIN;

DO $$
DECLARE obsolete_constraint RECORD;
BEGIN
    FOR obsolete_constraint IN
        SELECT conrelid::regclass AS relation_name, conname
        FROM pg_constraint
        WHERE contype = 'c' AND (
            (conrelid = 'public.wallet_binding_challenges'::regclass
             AND pg_get_constraintdef(oid) = 'CHECK ((expires_at <= (x_authenticated_at + ''00:15:00''::interval)))')
            OR
            (conrelid = 'public.wallet_bindings'::regclass
             AND pg_get_constraintdef(oid) = 'CHECK ((proved_at <= (x_authenticated_at + ''00:15:00''::interval)))')
        )
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',
            obsolete_constraint.relation_name, obsolete_constraint.conname);
    END LOOP;
END;
$$;

COMMIT;
