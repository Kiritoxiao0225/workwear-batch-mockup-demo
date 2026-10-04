SET LOCAL search_path TO garment_catalog, public;

-- 电商主图: the user can go back to an earlier version of an image. A slot's current image is the
-- version chosen most recently, or the newest one when a newer image was made after that choice.
ALTER TABLE listing_assets ADD COLUMN chosen_at timestamptz;
