SET LOCAL search_path TO garment_catalog, public;

-- 电商主图 for raw product folders: after upload the model first sorts the material (one paid
-- analysis, status planning), the user confirms the picks and selling points (materials), then
-- the model writes each image's words from the picks only (writing, free) and the user reviews
-- them as before (review). Products dropped together share a batch.
ALTER TABLE listing_projects DROP CONSTRAINT listing_projects_status_check;
ALTER TABLE listing_projects ADD CONSTRAINT listing_projects_status_check
  CHECK (status IN ('uploading', 'planning', 'materials', 'writing', 'review', 'confirmed', 'failed', 'generating', 'done'));
ALTER TABLE listing_projects ADD COLUMN batch_id uuid, ADD COLUMN materials jsonb;
CREATE INDEX listing_projects_batch ON listing_projects(tenant_id, batch_id) WHERE deleted_at IS NULL;

ALTER TABLE listing_jobs DROP CONSTRAINT listing_jobs_step_check;
ALTER TABLE listing_jobs ADD CONSTRAINT listing_jobs_step_check CHECK (step IN ('plan', 'write', 'product', 'image'));
