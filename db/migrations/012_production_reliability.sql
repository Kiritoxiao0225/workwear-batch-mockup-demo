SET search_path TO garment_catalog, public;

-- Cutout receipts outlive their current canvas use. Keep every exact image byte
-- referenced by the receipt, including pending jobs and abandoned submissions.
CREATE TABLE artwork_cutout_files (
  state_key text NOT NULL,
  job_key text NOT NULL,
  file_id uuid NOT NULL REFERENCES files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(state_key,job_key,file_id)
);
CREATE INDEX artwork_cutout_files_file ON artwork_cutout_files(file_id);
CREATE TRIGGER artwork_cutout_files_ready BEFORE INSERT OR UPDATE ON artwork_cutout_files
  FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');

CREATE TABLE wps_analysis_jobs (
  id uuid PRIMARY KEY,
  save_id uuid NOT NULL DEFAULT gen_random_uuid(),
  state_key text NOT NULL,
  record_id text NOT NULL,
  source_hash text NOT NULL,
  analysis_version text NOT NULL,
  source_json jsonb NOT NULL,
  target_snapshot text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','saving','completed','failed','stale','unknown')),
  result_json jsonb,
  error text,
  owner text,
  lease_until timestamptz,
  stage text,
  timings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(state_key,record_id,source_hash,analysis_version)
);
CREATE UNIQUE INDEX wps_analysis_active_record ON wps_analysis_jobs(state_key,record_id)
  WHERE status IN ('queued','running','saving','unknown');
CREATE INDEX wps_analysis_dispatch ON wps_analysis_jobs(status,created_at);
CREATE TABLE wps_analysis_files (
  job_id uuid NOT NULL REFERENCES wps_analysis_jobs(id),
  file_id uuid NOT NULL REFERENCES files(id),
  PRIMARY KEY(job_id,file_id)
);
CREATE INDEX wps_analysis_files_file ON wps_analysis_files(file_id);
CREATE TRIGGER wps_analysis_files_ready BEFORE INSERT OR UPDATE ON wps_analysis_files
  FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
  GRANT SELECT,INSERT,UPDATE ON garment_catalog.wps_analysis_jobs TO mockup_app;
  GRANT SELECT,INSERT ON garment_catalog.artwork_cutout_files,garment_catalog.wps_analysis_files TO mockup_app;
 END IF;
END $$;
