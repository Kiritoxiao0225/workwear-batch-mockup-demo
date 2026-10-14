SET LOCAL search_path TO garment_catalog, public;

-- 电商主图 shop services: each tenant has one hidden product row of kind 'shop' that holds what the
-- shop offers (`shop`: services, crafts, sample LOGO) and its four service images (slots
-- service:A-light …). The images go through the same jobs, credits and versions as a product's;
-- every product copies its master's one as its second image.
ALTER TABLE listing_projects ADD COLUMN kind text NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'shop')),
  ADD COLUMN shop jsonb;
CREATE UNIQUE INDEX listing_projects_shop ON listing_projects(tenant_id) WHERE kind = 'shop';

-- 「点图修改」: a redrawn image is kept as a candidate version and becomes the current one only
-- when the user adopts it (chosen_at). Reference images the user adds to a change are kind 'ref'.
ALTER TABLE listing_assets ADD COLUMN candidate boolean NOT NULL DEFAULT false;
ALTER TABLE listing_assets DROP CONSTRAINT listing_assets_kind_check;
ALTER TABLE listing_assets ADD CONSTRAINT listing_assets_kind_check CHECK (kind IN ('source', 'product', 'output', 'ref'));
