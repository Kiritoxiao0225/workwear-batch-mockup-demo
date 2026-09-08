SET LOCAL search_path TO garment_catalog, public;

ALTER TABLE garment_variants ADD CONSTRAINT variant_style_identity UNIQUE(style_id,id);
ALTER TABLE garment_styles ADD COLUMN reference_variant_id uuid;
ALTER TABLE garment_styles ADD CONSTRAINT reference_variant_belongs_to_style
  FOREIGN KEY(id,reference_variant_id) REFERENCES garment_variants(style_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE placement_standard_versions ALTER COLUMN specification DROP NOT NULL;
ALTER TABLE placement_standard_versions ADD COLUMN alignment jsonb;
ALTER TABLE placement_standard_versions ADD CONSTRAINT inherited_standard_source
  CHECK ((origin='inherited' AND specification IS NULL AND source_standard_id IS NOT NULL AND alignment IS NOT NULL)
    OR (origin<>'inherited' AND specification IS NOT NULL AND alignment IS NULL));

CREATE TABLE standard_reuse_checks (
  id uuid PRIMARY KEY,
  source_standard_id uuid NOT NULL REFERENCES placement_standard_versions(id) DEFERRABLE INITIALLY DEFERRED,
  target_view_id uuid NOT NULL REFERENCES garment_views(id) DEFERRABLE INITIALLY DEFERRED,
  target_revision integer NOT NULL CHECK(target_revision>=0),
  alignment jsonb NOT NULL,
  assessment jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_standard_id uuid REFERENCES placement_standard_versions(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX standard_reuse_target ON standard_reuse_checks(target_view_id);
