SET LOCAL search_path TO garment_catalog, public;

-- This is a copy of the editor capability. No CatalogHub connection or source data is used.
CREATE TABLE garment_mockup_projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX garment_mockup_projects_list ON garment_mockup_projects(tenant_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE garment_mockup_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  file_id uuid NOT NULL REFERENCES files(id),
  name text NOT NULL,
  source jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, file_id)
);
CREATE INDEX garment_mockup_assets_file ON garment_mockup_assets(file_id);
CREATE TRIGGER protect_garment_mockup_asset BEFORE INSERT OR UPDATE ON garment_mockup_assets
  FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
-- Older deployed cleanup workers must not remove content now owned by this copy.
-- Their row lock serializes with protect_ready_file_reference above.
CREATE FUNCTION protect_garment_mockup_file_gc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gc_state <> 'active' AND EXISTS (SELECT 1 FROM garment_mockup_assets WHERE file_id=OLD.id) THEN
    RAISE EXCEPTION '成衣效果图仍在使用文件 %，禁止回收', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_garment_mockup_gc BEFORE UPDATE OF gc_state ON files
  FOR EACH ROW EXECUTE FUNCTION protect_garment_mockup_file_gc();
CREATE TABLE garment_mockup_revisions (
  project_id uuid NOT NULL REFERENCES garment_mockup_projects(id),
  revision integer NOT NULL CHECK (revision > 0),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  state_json jsonb NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, revision),
  UNIQUE(project_id, request_id)
);
CREATE TABLE garment_mockup_ai_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid,
  action text NOT NULL CHECK (action IN ('understand','generate','cutout','back')),
  input_json jsonb NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','unknown')),
  result_json jsonb,
  error text,
  owner uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id, project_id) REFERENCES garment_mockup_projects(tenant_id, id)
);
CREATE INDEX garment_mockup_ai_queue ON garment_mockup_ai_jobs(status,created_at);
CREATE TABLE garment_mockup_ai_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES garment_mockup_ai_jobs(id),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK(status IN ('submitted','succeeded','failed','unknown')),
  provider_request_id text,
  receipt jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE TABLE garment_mockup_workers (id uuid PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
    GRANT SELECT,INSERT,UPDATE ON garment_mockup_projects,garment_mockup_assets,garment_mockup_revisions,
      garment_mockup_ai_jobs,garment_mockup_ai_attempts,garment_mockup_workers TO mockup_app;
  END IF;
END $$;
