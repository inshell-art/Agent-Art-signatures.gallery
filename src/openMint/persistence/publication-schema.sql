-- Additive E18 migration, after schema.sql. Explicit migration role only.
BEGIN;
CREATE TABLE open_mint.publication_profiles (
  namespace_id uuid PRIMARY KEY REFERENCES open_mint.namespaces,
  origin text NOT NULL,
  destination text NOT NULL CHECK (destination ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  source text NOT NULL CHECK (source ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CHECK (destination <> source)
);
CREATE TABLE open_mint.public_artifacts (
  namespace_id uuid NOT NULL,
  handle text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^0x[0-9a-f]{64}$'),
  header bytea NOT NULL CHECK (octet_length(header) BETWEEN 2 AND 1048576),
  svg bytea NOT NULL CHECK (octet_length(svg) BETWEEN 1 AND 8388608),
  png bytea NOT NULL CHECK (octet_length(png) BETWEEN 1 AND 8388608),
  metadata bytea NOT NULL CHECK (octet_length(metadata) BETWEEN 1 AND 8388608),
  PRIMARY KEY (namespace_id, digest),
  UNIQUE (namespace_id, handle),
  FOREIGN KEY (namespace_id, handle) REFERENCES open_mint.assessments,
  FOREIGN KEY (namespace_id) REFERENCES open_mint.publication_profiles
);
CREATE TABLE open_mint.publication_observations (
  namespace_id uuid NOT NULL,
  digest text NOT NULL,
  object_kind text NOT NULL CHECK (object_kind IN ('svg', 'png', 'metadata')),
  phase text NOT NULL CHECK (phase IN ('uploaded', 'retrieved')),
  identity text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, digest, object_kind, phase),
  FOREIGN KEY (namespace_id, digest) REFERENCES open_mint.public_artifacts
);
CREATE TABLE open_mint.completed_publications (
  namespace_id uuid NOT NULL,
  digest text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, digest),
  FOREIGN KEY (namespace_id, digest) REFERENCES open_mint.public_artifacts
);
CREATE FUNCTION open_mint.check_publication_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
  SELECT CASE WHEN NEW.phase = 'uploaded' THEN destination ELSE source END INTO expected
    FROM open_mint.publication_profiles WHERE namespace_id = NEW.namespace_id;
  IF NEW.identity IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication identity mismatch' USING ERRCODE = '55000'; END IF;
  IF NEW.phase = 'retrieved' AND NOT EXISTS (SELECT 1 FROM open_mint.publication_observations
    WHERE namespace_id = NEW.namespace_id AND digest = NEW.digest AND object_kind = NEW.object_kind AND phase = 'uploaded')
    THEN RAISE EXCEPTION 'retrieval requires upload evidence' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION open_mint.check_publication_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM open_mint.publication_observations WHERE namespace_id = NEW.namespace_id AND digest = NEW.digest) <> 6
    THEN RAISE EXCEPTION 'publication evidence incomplete' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_publication_observation BEFORE INSERT ON open_mint.publication_observations FOR EACH ROW EXECUTE FUNCTION open_mint.check_publication_observation();
CREATE TRIGGER check_publication_complete BEFORE INSERT ON open_mint.completed_publications FOR EACH ROW EXECUTE FUNCTION open_mint.check_publication_complete();
CREATE TRIGGER immutable_publication_profile BEFORE UPDATE OR DELETE ON open_mint.publication_profiles FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_public_artifact BEFORE UPDATE OR DELETE ON open_mint.public_artifacts FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_publication_observation BEFORE UPDATE OR DELETE ON open_mint.publication_observations FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
CREATE TRIGGER immutable_completed_publication BEFORE UPDATE OR DELETE ON open_mint.completed_publications FOR EACH ROW EXECUTE FUNCTION open_mint.refuse_immutable_mutation();
COMMIT;
