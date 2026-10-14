SET LOCAL search_path TO garment_catalog, public;

-- 036 made listing_plan_parts without a grant: the app role online could neither keep nor read the
-- parts of an analysis. The rows go with their product (ON DELETE CASCADE), so no DELETE is needed.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
    GRANT SELECT, INSERT ON listing_plan_parts TO mockup_app;
  END IF;
END $$;
