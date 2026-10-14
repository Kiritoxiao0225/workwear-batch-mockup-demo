-- 电商主图 in two rounds: after the square images (and the cast, SKU and product images) a product
-- waits in 'square' for 「出竖版」. Each made image keeps where things are on it, found after it was
-- made, for the 画板. Old products and learned layouts are cleared by the release script, not here.
ALTER TABLE listing_projects DROP CONSTRAINT listing_projects_status_check;
ALTER TABLE listing_projects ADD CONSTRAINT listing_projects_status_check
  CHECK (status IN ('uploading','planning','materials','writing','failed','generating','square','done'));
ALTER TABLE listing_assets ADD COLUMN elements jsonb;
