SET LOCAL search_path TO garment_catalog, public;

ALTER TABLE files ADD COLUMN gc_state text NOT NULL DEFAULT 'active' CHECK (gc_state IN ('active','deleting','deleted'));
ALTER TABLE files ADD COLUMN retain_until timestamptz NOT NULL DEFAULT now() + interval '24 hours';
ALTER TABLE files ADD COLUMN upload_count integer NOT NULL DEFAULT 0;

CREATE TABLE production_states (
  state_key text PRIMARY KEY,
  revision bigint NOT NULL,
  state_jsonb jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE production_file_refs (
  state_key text NOT NULL REFERENCES production_states(state_key),
  ref_key text NOT NULL,
  file_id uuid NOT NULL REFERENCES files(id),
  PRIMARY KEY(state_key,ref_key)
);
CREATE INDEX production_file_refs_file ON production_file_refs(file_id);
CREATE TABLE production_operations (
  operation_key text PRIMARY KEY,
  owner text NOT NULL,
  lease_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE production_renders (
  state_key text NOT NULL REFERENCES production_states(state_key),
  version_id text NOT NULL,
  input_hash text NOT NULL,
  file_id uuid REFERENCES files(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(state_key,version_id)
);
CREATE TABLE production_render_cache (
  input_hash text PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES files(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every live reference must serialize with GC on the file row, including reuse by the garment library.
CREATE FUNCTION protect_ready_file_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE key text; value uuid; found_file files%ROWTYPE;
BEGIN
  FOREACH key IN ARRAY TG_ARGV LOOP
    value := (to_jsonb(NEW)->>key)::uuid;
    IF value IS NULL THEN CONTINUE; END IF;
    SELECT * INTO found_file FROM files WHERE id=value FOR SHARE;
    IF NOT FOUND OR found_file.status <> 'ready' OR found_file.gc_state <> 'active' THEN
      RAISE EXCEPTION 'File % is not ready for a new reference', value;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_production_ref BEFORE INSERT OR UPDATE ON production_file_refs FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
CREATE TRIGGER protect_production_render BEFORE INSERT OR UPDATE ON production_renders FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
CREATE TRIGGER protect_production_cache BEFORE INSERT OR UPDATE ON production_render_cache FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
CREATE TRIGGER protect_garment_file BEFORE INSERT OR UPDATE ON garment_asset_versions FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id','thumbnail_file_id');
CREATE TRIGGER protect_source_file BEFORE INSERT OR UPDATE ON asset_sources FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
CREATE TRIGGER protect_import_file BEFORE INSERT OR UPDATE ON import_items FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
