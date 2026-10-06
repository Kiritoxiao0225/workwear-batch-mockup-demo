-- 电商主图: confirming the material, reviewing the words and confirming them are one plan step now.
-- A product waiting in a removed step goes back to the plan step; its sorted material is kept and
-- nothing is charged again. One without sorted material (from before 032) must be analysed again.
UPDATE listing_projects SET status='materials', plan=NULL, materials=materials - 'choice', error=NULL
  WHERE status IN ('writing','review','confirmed') AND materials IS NOT NULL;
UPDATE listing_projects SET status='failed', plan=NULL, error='流程已更新，请重新分析'
  WHERE status IN ('writing','review','confirmed');
ALTER TABLE listing_projects DROP CONSTRAINT listing_projects_status_check;
ALTER TABLE listing_projects ADD CONSTRAINT listing_projects_status_check
  CHECK (status IN ('uploading','planning','materials','writing','failed','generating','done'));
-- Batches, the separate review and its confirmation time are no longer shown or used.
DROP INDEX IF EXISTS listing_projects_batch;
ALTER TABLE listing_projects DROP COLUMN batch_id, DROP COLUMN review, DROP COLUMN confirmed_at;
