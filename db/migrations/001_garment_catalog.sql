CREATE SCHEMA IF NOT EXISTS garment_catalog;
SET LOCAL search_path TO garment_catalog, public;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  disabled boolean NOT NULL DEFAULT false,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE files (
  id uuid PRIMARY KEY,
  backend text NOT NULL CHECK (backend IN ('oss', 'local')),
  bucket text NOT NULL,
  object_key text NOT NULL,
  object_version_id text,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  has_alpha boolean NOT NULL,
  original_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (backend, bucket, sha256),
  UNIQUE (backend, bucket, object_key)
);
CREATE TABLE garment_styles (
  id uuid PRIMARY KEY,
  source_namespace text NOT NULL,
  style_code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_namespace, style_code)
);
CREATE TABLE garment_variants (
  id uuid PRIMARY KEY,
  style_id uuid NOT NULL REFERENCES garment_styles(id) DEFERRABLE INITIALLY DEFERRED,
  color_name text NOT NULL,
  current_asset_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (style_id, color_name)
);
CREATE TABLE garment_asset_versions (
  id uuid PRIMARY KEY,
  variant_id uuid NOT NULL REFERENCES garment_variants(id) DEFERRABLE INITIALLY DEFERRED,
  version integer NOT NULL CHECK (version > 0),
  file_id uuid NOT NULL REFERENCES files(id) DEFERRABLE INITIALLY DEFERRED,
  thumbnail_file_id uuid NOT NULL REFERENCES files(id) DEFERRABLE INITIALLY DEFERRED,
  layout text NOT NULL CHECK (layout IN ('front_back', 'front_only')),
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, version),
  UNIQUE (variant_id, file_id),
  UNIQUE (variant_id, id)
);
ALTER TABLE garment_variants ADD CONSTRAINT current_asset_belongs_to_variant
  FOREIGN KEY (id, current_asset_version_id) REFERENCES garment_asset_versions(variant_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE asset_sources (
  asset_version_id uuid NOT NULL REFERENCES garment_asset_versions(id) DEFERRABLE INITIALLY DEFERRED,
  file_id uuid NOT NULL REFERENCES files(id) DEFERRABLE INITIALLY DEFERRED,
  source_path text NOT NULL,
  PRIMARY KEY (asset_version_id, file_id, source_path)
);
CREATE TABLE garment_views (
  id uuid PRIMARY KEY,
  asset_version_id uuid NOT NULL REFERENCES garment_asset_versions(id) DEFERRABLE INITIALLY DEFERRED,
  face text NOT NULL CHECK (face IN ('front', 'back')),
  crop jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  latest_standard_id uuid,
  confirmed_standard_id uuid,
  UNIQUE (asset_version_id, face)
);
CREATE TABLE placement_standard_versions (
  id uuid PRIMARY KEY,
  view_id uuid NOT NULL REFERENCES garment_views(id) DEFERRABLE INITIALLY DEFERRED,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft', 'confirmed')),
  specification jsonb NOT NULL,
  source_standard_id uuid REFERENCES placement_standard_versions(id) DEFERRABLE INITIALLY DEFERRED,
  origin text NOT NULL CHECK (origin IN ('manual', 'inherited', 'model')),
  created_by uuid NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (view_id, revision),
  UNIQUE (view_id, id)
);
ALTER TABLE garment_views ADD CONSTRAINT latest_standard_belongs_to_view
  FOREIGN KEY (id, latest_standard_id) REFERENCES placement_standard_versions(view_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE garment_views ADD CONSTRAINT confirmed_standard_belongs_to_view
  FOREIGN KEY (id, confirmed_standard_id) REFERENCES placement_standard_versions(view_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  manifest_hash text NOT NULL UNIQUE,
  source_namespace text NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE import_items (
  batch_id uuid NOT NULL REFERENCES import_batches(id) DEFERRABLE INITIALLY DEFERRED,
  filename text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'imported', 'quarantined', 'failed')),
  file_id uuid REFERENCES files(id) DEFERRABLE INITIALLY DEFERRED,
  asset_version_id uuid REFERENCES garment_asset_versions(id) DEFERRABLE INITIALLY DEFERRED,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, filename)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  action text NOT NULL,
  entity_id uuid NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_versions_variant ON garment_asset_versions(variant_id);
CREATE INDEX audit_entity ON audit_events(entity_id, created_at);
