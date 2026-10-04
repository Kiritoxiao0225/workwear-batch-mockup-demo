SET LOCAL search_path TO garment_catalog, public;

-- Free accounts get 2 GiB instead of 0.5 GiB: a 电商主图 product folder alone can be 100–200 MB.
-- Accounts whose quota was set by hand keep it.
UPDATE tenants SET storage_quota_bytes = 2147483648 WHERE plan = 'free' AND storage_quota_bytes = 536870912;

-- A product's uploaded source images are cleared 30 days after its last image was made; the
-- generated images stay. Set when that happened, so the page can say so.
ALTER TABLE listing_projects ADD COLUMN sources_cleared_at timestamptz;
