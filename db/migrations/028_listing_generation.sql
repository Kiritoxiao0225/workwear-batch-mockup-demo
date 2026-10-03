SET LOCAL search_path TO garment_catalog, public;

-- 电商主图, stage 2: white-background product images per colour, then the listing images.
-- A run is one confirmed "生成" (or one redo): its credits are held together and settled when
-- every job of the run has finished.
ALTER TABLE listing_projects DROP CONSTRAINT listing_projects_status_check;
ALTER TABLE listing_projects ADD CONSTRAINT listing_projects_status_check
  CHECK (status IN ('uploading', 'planning', 'review', 'confirmed', 'failed', 'generating', 'done'));

ALTER TABLE listing_assets DROP CONSTRAINT listing_assets_kind_check;
ALTER TABLE listing_assets ADD CONSTRAINT listing_assets_kind_check CHECK (kind IN ('source', 'product', 'output'));
ALTER TABLE listing_assets ADD COLUMN slot text, ADD COLUMN job_id uuid;
CREATE INDEX listing_assets_slot ON listing_assets(project_id, slot, created_at DESC) WHERE slot IS NOT NULL;

ALTER TABLE listing_jobs DROP CONSTRAINT listing_jobs_step_check;
ALTER TABLE listing_jobs ADD CONSTRAINT listing_jobs_step_check CHECK (step IN ('plan', 'product', 'image'));
ALTER TABLE listing_jobs ADD COLUMN run_id uuid, ADD COLUMN slot text, ADD COLUMN input jsonb,
  ADD COLUMN depends text[] NOT NULL DEFAULT '{}', ADD COLUMN result_asset uuid;
CREATE INDEX listing_jobs_run ON listing_jobs(run_id) WHERE run_id IS NOT NULL;

-- Measured on EvoLink gpt-image-2.5-sunburst, 1K medium: ¥0.15–0.22 per image with one or two
-- reference images, ¥0.32–0.36 for a multi-colour image with four.
ALTER TABLE price_list DROP CONSTRAINT price_list_action_check;
ALTER TABLE price_list ADD CONSTRAINT price_list_action_check
  CHECK (action IN ('analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize',
                    'listing_plan', 'listing_image', 'listing_image_multi'));
INSERT INTO price_list(action, cost_micro_cents, multiplier_milli, effective_from)
VALUES ('listing_image', 22000, 2000, clock_timestamp()), ('listing_image_multi', 36000, 2000, clock_timestamp());
ALTER TABLE usage_events DROP CONSTRAINT usage_events_metric_code_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_metric_code_check
  CHECK (metric_code IN ('analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize',
                         'listing_plan', 'listing_image', 'listing_image_multi'));
