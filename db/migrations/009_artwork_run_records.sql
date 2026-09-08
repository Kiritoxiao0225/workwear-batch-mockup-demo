CREATE TABLE garment_catalog.artwork_run_records (
  state_key text NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL,
  record_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (state_key, run_id, kind)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mockup_app') THEN
    GRANT SELECT, INSERT ON garment_catalog.artwork_run_records TO mockup_app;
  END IF;
END $$;
