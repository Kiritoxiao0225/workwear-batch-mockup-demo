SET LOCAL search_path TO garment_catalog, public;
-- Pricing v2: every charge is the measured supplier cost × 2.
-- Background removal is split by supplier (Meitu fine cut vs Volcengine saliency), and the
-- garment back view gets its own price instead of borrowing the artwork-generation price.

ALTER TABLE price_list DROP CONSTRAINT price_list_action_check;
ALTER TABLE price_list ADD CONSTRAINT price_list_action_check
  CHECK (action IN ('analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize'));
ALTER TABLE usage_events DROP CONSTRAINT usage_events_metric_code_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_metric_code_check
  CHECK (metric_code IN ('analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize'));

-- Costs measured 2026-10-02: EvoLink receipts (understanding ≈ ¥0.10, Sunburst artwork ≈ ¥0.17),
-- configured unit prices (MediaKit ¥0.006, Meitu ¥0.142), Volcengine saliency ¥0.05 (operator),
-- Seedream 5.0 Lite ¥0.22. Earlier holds keep the price snapshot they were reserved with.
-- clock_timestamp(), not now(): a fresh database applies 020 in the same transaction, and its
-- seed rows already hold now() for the same actions.
INSERT INTO price_list(action, cost_micro_cents, multiplier_milli, effective_from)
SELECT action, cost, 2000, clock_timestamp() FROM (VALUES
  ('analyze', 10000), ('generate', 17000), ('enhance', 600), ('cutout', 14200),
  ('cutout_standard', 5000), ('back_reference', 22000), ('recognize', 4000)) AS v(action, cost);

-- Spend per Beijing day, in credits. NULL means no cap. Existing and new accounts start at 2000 (¥20).
ALTER TABLE tenants ADD COLUMN daily_spend_cap_cents bigint DEFAULT 2000
  CHECK (daily_spend_cap_cents IS NULL OR daily_spend_cap_cents >= 0);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mockup_app') THEN
    GRANT SELECT, INSERT ON garment_catalog.price_list TO mockup_app;
    GRANT UPDATE (daily_spend_cap_cents) ON garment_catalog.tenants TO mockup_app;
  END IF;
END $$;
