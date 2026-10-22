SET LOCAL search_path TO garment_catalog, public;

-- 10-22: an image that failed for a passing reason (the relay timed out, was rate-limited or broke)
-- goes back in the queue instead of failing: `retry_at` is when it may be taken again, `retries` how
-- many times it went back. `stopped`: the user stopped the product's images, so nothing goes back.
ALTER TABLE listing_jobs
  ADD COLUMN IF NOT EXISTS retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS retries integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stopped boolean NOT NULL DEFAULT false;
