SET LOCAL search_path TO garment_catalog, public;
CREATE TABLE catalog_body_geometry (
  input_hash text PRIMARY KEY CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  algorithm text NOT NULL,
  image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[a-f0-9]{64}$'),
  image_width integer NOT NULL CHECK (image_width > 0),
  image_height integer NOT NULL CHECK (image_height > 0),
  crops jsonb NOT NULL CHECK (jsonb_typeof(crops) = 'array'),
  width_ratios jsonb NOT NULL CHECK (jsonb_typeof(width_ratios) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mockup_app') THEN
    GRANT SELECT, INSERT, UPDATE ON catalog_body_geometry TO mockup_app;
  END IF;
END $$;
