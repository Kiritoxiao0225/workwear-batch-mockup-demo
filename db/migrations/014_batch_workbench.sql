SET LOCAL search_path TO garment_catalog, public;
-- Independent workbench state; legacy production_states remain untouched.
CREATE TABLE batch_documents (
  workspace text NOT NULL,
  path text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  content_json jsonb,
  content_gzip bytea,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace,path),
  CHECK ((content_json IS NULL) <> (content_gzip IS NULL))
);
CREATE TABLE batch_assets (
  workspace text NOT NULL,
  path text NOT NULL,
  file_id uuid NOT NULL REFERENCES files(id),
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace,path)
);
CREATE INDEX batch_assets_file ON batch_assets(file_id);
CREATE TRIGGER protect_batch_asset BEFORE INSERT OR UPDATE ON batch_assets FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
CREATE TABLE batch_queue (
  id text PRIMARY KEY,
  workspace text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('analysis','production','sync','mockup')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','finished','failed','unknown')),
  owner text,
  lease_until timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX batch_queue_claim ON batch_queue(status,created_at);
CREATE TABLE batch_workers (id text PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now(), build_commit text);
