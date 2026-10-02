SET LOCAL search_path TO garment_catalog, public;
-- Administrator console: a private note per account and the pages it may open.
-- NULL keeps the default (every page except the internal-only WPS delivery), so existing
-- accounts behave exactly as before until an administrator narrows them.
ALTER TABLE users ADD COLUMN admin_note text NOT NULL DEFAULT '' CHECK (char_length(admin_note) <= 500);
ALTER TABLE users ADD COLUMN allowed_pages text[];
