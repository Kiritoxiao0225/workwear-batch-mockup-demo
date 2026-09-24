SET LOCAL search_path TO garment_catalog, public;
-- Scope the garment catalog to tenants, and make file access provable from a tenant-owned
-- reference rather than from knowing an id or a content hash.

-- ---------- Styles ----------
ALTER TABLE garment_styles ADD COLUMN tenant_id uuid REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED;
UPDATE garment_styles SET tenant_id = '00000000-0000-0000-0000-000000000001';
-- See 017: the deferred foreign key must be checked before the table can be altered.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE garment_styles ALTER COLUMN tenant_id SET NOT NULL;
-- The old key would stop two tenants from using the same style code.
ALTER TABLE garment_styles DROP CONSTRAINT garment_styles_source_namespace_style_code_key;
ALTER TABLE garment_styles ADD CONSTRAINT garment_styles_tenant_code_key
  UNIQUE (tenant_id, source_namespace, style_code);
CREATE INDEX garment_styles_tenant ON garment_styles(tenant_id);

-- ---------- Import batches ----------
-- Isolated failures and pending files have no style to resolve a tenant through, so the
-- batch itself has to carry the owner.
ALTER TABLE import_batches ADD COLUMN tenant_id uuid REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED;
UPDATE import_batches SET tenant_id = '00000000-0000-0000-0000-000000000001';
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE import_batches ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE import_batches DROP CONSTRAINT import_batches_manifest_hash_key;
ALTER TABLE import_batches ADD CONSTRAINT import_batches_tenant_manifest_key
  UNIQUE (tenant_id, manifest_hash);
CREATE INDEX import_batches_tenant ON import_batches(tenant_id);

-- ---------- Tenant file references ----------
-- Objects stay globally de-duplicated by content hash; the reference is what grants access,
-- and business metadata such as the original file name lives here rather than on the shared
-- `files` row (which belongs to whoever uploaded the bytes first).
CREATE TABLE tenant_file_refs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED,
  file_id uuid NOT NULL REFERENCES files(id) DEFERRABLE INITIALLY DEFERRED,
  purpose text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, file_id, purpose)
);
CREATE INDEX tenant_file_refs_file ON tenant_file_refs(file_id);

-- Every file that exists today predates multi-tenancy and therefore belongs to the internal
-- tenant. Backfilling from `files` rather than from each of the nine referencing tables is
-- complete by construction: no referencing table can be overlooked.
INSERT INTO tenant_file_refs(tenant_id, file_id, purpose, display_name)
SELECT '00000000-0000-0000-0000-000000000001', id, 'legacy', original_name FROM files
ON CONFLICT DO NOTHING;

-- ---------- Quota accounting ----------
CREATE TABLE tenant_usage (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED,
  style_count integer NOT NULL DEFAULT 0 CHECK (style_count >= 0),
  style_reserved integer NOT NULL DEFAULT 0 CHECK (style_reserved >= 0),
  bytes_used bigint NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
  bytes_reserved bigint NOT NULL DEFAULT 0 CHECK (bytes_reserved >= 0)
);

INSERT INTO tenant_usage(tenant_id, style_count, bytes_used)
SELECT t.id,
       (SELECT count(*) FROM garment_styles s WHERE s.tenant_id = t.id),
       COALESCE((SELECT sum(f.byte_length) FROM tenant_file_refs r
                   JOIN files f ON f.id = r.file_id WHERE r.tenant_id = t.id), 0)
  FROM tenants t;

-- Counting rows before writing cannot hold a limit under concurrency, so capacity is
-- reserved first, then confirmed or released. The record makes repeated confirmation,
-- repeated release and crash leftovers all resolvable.
CREATE TABLE quota_reservations (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED,
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  styles integer NOT NULL DEFAULT 0 CHECK (styles >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'committed', 'released')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((state = 'reserved') = (resolved_at IS NULL))
);
CREATE INDEX quota_reservations_expiry ON quota_reservations(expires_at) WHERE state = 'reserved';
CREATE INDEX quota_reservations_tenant ON quota_reservations(tenant_id, created_at DESC);

-- ---------- Backfill verification ----------
-- Runs inside the migration transaction: a failure here rolls the whole migration back
-- rather than leaving existing assets unreachable.
DO $$
DECLARE orphans integer; unowned integer;
BEGIN
  SELECT count(*) INTO orphans FROM files f
    WHERE NOT EXISTS (SELECT 1 FROM tenant_file_refs r WHERE r.file_id = f.id);
  IF orphans <> 0 THEN
    RAISE EXCEPTION '文件授权回填不完整：% 个文件没有租户引用', orphans;
  END IF;

  SELECT count(*) INTO unowned FROM garment_styles WHERE tenant_id IS NULL;
  IF unowned <> 0 THEN
    RAISE EXCEPTION '款式归属回填不完整：% 款没有租户', unowned;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tenant_usage WHERE tenant_id = '00000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION '内部租户缺少用量记录';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mockup_app') THEN
    GRANT SELECT, INSERT, DELETE ON garment_catalog.tenant_file_refs TO mockup_app;
    GRANT SELECT, INSERT, UPDATE ON garment_catalog.tenant_usage, garment_catalog.quota_reservations TO mockup_app;
  END IF;
END $$;
