-- Durable jobs are independent of browser requests. Leases fence worker restarts.
CREATE TABLE garment_catalog.artwork_jobs (
  id uuid PRIMARY KEY,
  state_key text NOT NULL,
  unit_id text NOT NULL,
  snapshot text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','completed','failed','review','unknown','cancelled')),
  message text NOT NULL DEFAULT '等待后台处理',
  candidate jsonb,
  error text,
  owner uuid,
  lease_until timestamptz,
  attempt integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX artwork_jobs_active_unit ON garment_catalog.artwork_jobs(state_key,unit_id)
  WHERE status IN ('queued','running','unknown');
CREATE INDEX artwork_jobs_queue ON garment_catalog.artwork_jobs(state_key,status,created_at);
CREATE TABLE garment_catalog.artwork_job_steps (
  job_id uuid NOT NULL REFERENCES garment_catalog.artwork_jobs(id),
  step_key text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','completed','failed','unknown')),
  result jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY(job_id,step_key)
);
CREATE TABLE garment_catalog.artwork_job_files (
  job_id uuid NOT NULL REFERENCES garment_catalog.artwork_jobs(id),
  file_id uuid NOT NULL REFERENCES garment_catalog.files(id),
  PRIMARY KEY(job_id,file_id)
);
CREATE TRIGGER protect_artwork_job_file BEFORE INSERT OR UPDATE ON garment_catalog.artwork_job_files
  FOR EACH ROW EXECUTE FUNCTION garment_catalog.protect_ready_file_reference('file_id');
CREATE TABLE garment_catalog.artwork_stage_slots (
  stage text NOT NULL,
  slot integer NOT NULL,
  owner uuid,
  job_id uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(stage,slot)
);
CREATE TABLE garment_catalog.artwork_workers (
  id uuid PRIMARY KEY,
  state_key text NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
  GRANT SELECT,INSERT,UPDATE ON garment_catalog.artwork_jobs,garment_catalog.artwork_job_steps,garment_catalog.artwork_stage_slots,garment_catalog.artwork_workers TO mockup_app;
  GRANT SELECT,INSERT ON garment_catalog.artwork_job_files TO mockup_app;
 END IF;
END $$;
