-- 2026-10-03: the product owner removed the daily spend cap — accounts spend as much as their
-- balance allows. NULL already means "no cap" to holdCredits and the admin console; an
-- administrator can still set a cap on one account there.
ALTER TABLE tenants ALTER COLUMN daily_spend_cap_cents SET DEFAULT NULL;
UPDATE tenants SET daily_spend_cap_cents = NULL WHERE daily_spend_cap_cents IS NOT NULL;
