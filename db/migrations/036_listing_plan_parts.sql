SET LOCAL search_path TO garment_catalog, public;

-- 电商主图 step one in parts: each batch of sorted images (and the whole product's reading) is kept
-- as it comes back, keyed by what was asked (model, wording, the images), so 「继续整理」 after a cut
-- connection only asks for what is missing. Dropped with the product.
CREATE TABLE listing_plan_parts (
  project_id uuid NOT NULL REFERENCES listing_projects(id) ON DELETE CASCADE,
  key text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, key)
);
