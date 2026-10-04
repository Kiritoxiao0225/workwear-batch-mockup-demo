SET LOCAL search_path TO garment_catalog, public;

-- 电商主图: a team can learn a layout from 3–10 reference images it likes (100 credits). The
-- model writes it in the same fields as a built-in layout, three sample images are made with a
-- sample garment, and once saved it is shared by everyone in the tenant.
CREATE TABLE listing_layouts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'queued', 'learning', 'draft', 'ready', 'failed', 'deleted')),
  spec jsonb,     -- description, style, roles, sku: the fields of a built-in layout
  error text,
  owner uuid,
  lease_until timestamptz,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX listing_layouts_tenant ON listing_layouts(tenant_id, created_at DESC) WHERE status <> 'deleted';
CREATE INDEX listing_layouts_queue ON listing_layouts(created_at) WHERE status IN ('queued', 'learning');

-- Reference images the user uploaded and the sample images made from the learned layout.
CREATE TABLE listing_layout_files (
  layout_id uuid NOT NULL REFERENCES listing_layouts(id),
  file_id uuid NOT NULL REFERENCES files(id),
  kind text NOT NULL CHECK (kind IN ('ref', 'sample')),
  n integer NOT NULL CHECK (n >= 0),
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (layout_id, kind, n)
);
CREATE INDEX listing_layout_files_file ON listing_layout_files(file_id);
CREATE TRIGGER protect_listing_layout_file BEFORE INSERT OR UPDATE ON listing_layout_files
  FOR EACH ROW EXECUTE FUNCTION protect_ready_file_reference('file_id');
CREATE OR REPLACE FUNCTION protect_listing_file_gc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gc_state <> 'active' AND (EXISTS (SELECT 1 FROM listing_assets WHERE file_id=OLD.id)
      OR EXISTS (SELECT 1 FROM listing_layout_files WHERE file_id=OLD.id)) THEN
    RAISE EXCEPTION '电商主图仍在使用文件 %，禁止回收', OLD.id;
  END IF;
  RETURN NEW;
END $$;

-- Learning: one analysis of up to ten images plus three sample images, measured about ¥0.9.
ALTER TABLE price_list DROP CONSTRAINT price_list_action_check;
ALTER TABLE price_list ADD CONSTRAINT price_list_action_check
  CHECK (action IN ('analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize',
                    'listing_plan', 'listing_image', 'listing_image_multi', 'listing_layout'));
INSERT INTO price_list(action, cost_micro_cents, multiplier_milli, effective_from)
VALUES ('listing_layout', 90000, 1111, clock_timestamp());
ALTER TABLE usage_events DROP CONSTRAINT usage_events_metric_code_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_metric_code_check
  CHECK (metric_code IN ('analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize',
                         'listing_plan', 'listing_image', 'listing_image_multi', 'listing_layout'));

-- The 30-day clean-up of source images (030) deletes listing_assets rows; the app role could not.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
    GRANT SELECT, INSERT, UPDATE ON listing_layouts, listing_layout_files TO mockup_app;
    GRANT DELETE ON listing_assets TO mockup_app;
  END IF;
END $$;
