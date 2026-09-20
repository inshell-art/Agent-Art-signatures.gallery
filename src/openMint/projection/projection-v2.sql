-- Explicit additive v1 -> v2 migration, never run by application startup.
-- Stop the writer and back up the selected database before operator execution.
-- No assessment, artifact, event or projection rows are rewritten or deleted.
BEGIN;
LOCK TABLE open_mint.projection_schema_version,open_mint.projection_ownership IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF (SELECT count(*) FROM open_mint.projection_schema_version) <> 1
    OR NOT EXISTS(SELECT 1 FROM open_mint.projection_schema_version WHERE version=1) THEN
    RAISE EXCEPTION 'projection upgrade requires exactly schema v1' USING ERRCODE='55000';
  END IF;
END $$;
-- Runtime rollback needs DELETE/interval-end UPDATE, not permission to erase
-- ownership already visible in a promoted snapshot. Preserve those intervals.
CREATE FUNCTION open_mint.guard_projection_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE promoted bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT promoted_number INTO promoted FROM open_mint.projection_checkpoints WHERE deployment_id=NEW.deployment_id;
    IF NEW.start_block<=promoted THEN RAISE EXCEPTION 'promoted ownership insertion is forbidden' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  SELECT promoted_number INTO promoted FROM open_mint.projection_checkpoints WHERE deployment_id=OLD.deployment_id;
  IF TG_OP = 'DELETE' THEN
    IF OLD.start_block<=promoted THEN RAISE EXCEPTION 'promoted ownership rollback is forbidden' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['end_block','end_transaction','end_log']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['end_block','end_transaction','end_log'])
    OR OLD.end_block<=promoted OR NEW.end_block<=promoted THEN
    RAISE EXCEPTION 'immutable or promoted ownership interval' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_projection_ownership BEFORE INSERT OR UPDATE OR DELETE ON open_mint.projection_ownership
  FOR EACH ROW EXECUTE FUNCTION open_mint.guard_projection_ownership();
REVOKE ALL ON FUNCTION open_mint.guard_projection_ownership() FROM PUBLIC;
ALTER TABLE open_mint.projection_schema_version DROP CONSTRAINT projection_schema_version_version_check;
UPDATE open_mint.projection_schema_version SET version=2;
ALTER TABLE open_mint.projection_schema_version ADD CONSTRAINT projection_schema_version_version_check CHECK(version=2);
COMMIT;
