SET LOCAL search_path TO garment_catalog, public;

-- 电商主图, stage 1: upload a product's images, let the model sort them and plan the listing
-- (one paid analysis), then the user confirms. Image generation comes in a later migration.
CREATE TABLE listing_projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  layout text NOT NULL,
  counts jsonb NOT NULL,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'planning', 'review', 'confirmed', 'failed')),
  plan jsonb,     -- the model's plan after the program's own corrections
  review jsonb,   -- what the user changed in the confirmation step
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX listing_projects_list ON listing_projects(tenant_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE listing_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  file_id uuid NOT NULL REFERENCES files(id),
  kind text NOT NULL CHECK (kind IN ('source')),
  name text NOT NULL,
  rel_path text NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES listing_projects(tenant_id, id),
  UNIQUE (project_id, rel_path)
);
CREATE INDEX listing_assets_project ON listing_assets(project_id, created_at);
CREATE INDEX listing_assets_file ON listing_assets(file_id);
CREATE TRIGGER protect_listing_asset BEFORE INSERT OR UPDATE ON listing_assets
  FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
CREATE FUNCTION protect_listing_file_gc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gc_state <> 'active' AND EXISTS (SELECT 1 FROM listing_assets WHERE file_id=OLD.id) THEN
    RAISE EXCEPTION '电商主图仍在使用文件 %，禁止回收', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_listing_gc BEFORE UPDATE OF gc_state ON files
  FOR EACH ROW EXECUTE FUNCTION protect_listing_file_gc();

-- Same lifecycle as garment_mockup_ai_jobs: a submitted provider call is never repeated.
CREATE TABLE listing_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  step text NOT NULL CHECK (step IN ('plan')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'unknown')),
  error text,
  owner uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES listing_projects(tenant_id, id)
);
CREATE INDEX listing_jobs_queue ON listing_jobs(status, created_at);
CREATE INDEX listing_jobs_project ON listing_jobs(project_id, created_at DESC);
CREATE TABLE listing_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES listing_jobs(id),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted', 'succeeded', 'failed', 'unknown')),
  provider_request_id text,
  receipt jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE TABLE listing_workers (id uuid PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now());

-- Planning reads every image of one product with gpt-6.1-sol: measured ¥0.81–0.89 for ~36 images.
ALTER TABLE price_list DROP CONSTRAINT price_list_action_check;
ALTER TABLE price_list ADD CONSTRAINT price_list_action_check
  CHECK (action IN ('analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize', 'listing_plan'));
INSERT INTO price_list(action, cost_micro_cents, multiplier_milli, effective_from)
VALUES ('listing_plan', 90000, 2000, clock_timestamp());
ALTER TABLE usage_events DROP CONSTRAINT usage_events_metric_code_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_metric_code_check
  CHECK (metric_code IN ('analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize', 'listing_plan'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
    GRANT SELECT, INSERT, UPDATE ON listing_projects, listing_assets, listing_jobs, listing_attempts, listing_workers TO mockup_app;
  END IF;
END $$;
