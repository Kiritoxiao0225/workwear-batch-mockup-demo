SET LOCAL search_path TO garment_catalog, public;

-- 存储空间 stage 2 (10-28): a deletion goes to a 回收站 for 7 days. Its space is given back at
-- once; until the item is purged its rows stay here so 恢复 can put them back exactly.

-- 「只删图片」: the plan and copy stay, every picture goes. Set when that happened.
ALTER TABLE listing_projects ADD COLUMN images_cleared_at timestamptz;

-- A small cover kept after 「只删图片」 so the product can still be recognised in the list.
ALTER TABLE listing_assets DROP CONSTRAINT listing_assets_kind_check;
ALTER TABLE listing_assets ADD CONSTRAINT listing_assets_kind_check CHECK (kind IN ('source', 'product', 'output', 'ref', 'thumb'));

CREATE TABLE trash_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid REFERENCES users(id),
  feature text NOT NULL CHECK (feature IN ('listing', 'artwork')),
  -- The listing project id, or the 图稿 case id.
  target_id text NOT NULL,
  -- sources: the uploaded originals; images: every picture, the record stays; all: the whole record.
  mode text NOT NULL CHECK (mode IN ('sources', 'images', 'all')),
  name text NOT NULL,
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  files integer NOT NULL DEFAULT 0 CHECK (files >= 0),
  -- What 恢复 puts back besides the rows (e.g. the product's earlier sources_cleared_at).
  state jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Restorable until then; 「立即彻底删除」 sets it to now. The daily clean-up deletes the files after it.
  purge_after timestamptz NOT NULL,
  restored_at timestamptz,
  purged_at timestamptz
);
CREATE INDEX trash_items_tenant ON trash_items(tenant_id, created_at DESC) WHERE restored_at IS NULL AND purged_at IS NULL;
CREATE INDEX trash_items_target ON trash_items(target_id) WHERE restored_at IS NULL AND purged_at IS NULL;
CREATE INDEX trash_items_due ON trash_items(purge_after) WHERE restored_at IS NULL AND purged_at IS NULL;

-- A 电商主图 picture taken out by 「只删原图」/「只删图片」, column for column, so 恢复 moves it back.
CREATE TABLE listing_assets_trash (LIKE listing_assets INCLUDING DEFAULTS);
ALTER TABLE listing_assets_trash ADD COLUMN trash_id uuid NOT NULL REFERENCES trash_items(id);
CREATE INDEX listing_assets_trash_item ON listing_assets_trash(trash_id);
CREATE INDEX listing_assets_trash_file ON listing_assets_trash(file_id);

-- A file in the 回收站 is still restorable: never reclaim it while a trashed row holds it.
CREATE OR REPLACE FUNCTION protect_listing_file_gc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gc_state <> 'active' AND (EXISTS (SELECT 1 FROM listing_assets WHERE file_id=OLD.id)
      OR EXISTS (SELECT 1 FROM listing_layout_files WHERE file_id=OLD.id)
      OR EXISTS (SELECT 1 FROM listing_assets_trash WHERE file_id=OLD.id)) THEN
    RAISE EXCEPTION '电商主图仍在使用文件 %，禁止回收', OLD.id;
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
    GRANT SELECT, INSERT, UPDATE ON trash_items TO mockup_app;
    GRANT SELECT, INSERT, DELETE ON listing_assets_trash TO mockup_app;
  END IF;
END $$;
