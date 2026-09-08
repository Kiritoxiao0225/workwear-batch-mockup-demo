CREATE TABLE IF NOT EXISTS garment_catalog.artwork_cutout_jobs (
  state_key text NOT NULL,
  job_key text NOT NULL,
  job_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (state_key, job_key)
);

-- Cloud deployments use a separate application role. Run this migration as
-- the schema owner; the runtime role intentionally has no CREATE permission.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mockup_app') THEN
    GRANT SELECT, INSERT, UPDATE ON garment_catalog.artwork_cutout_jobs TO mockup_app;
  END IF;
END $$;
