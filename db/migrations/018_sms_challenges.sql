SET LOCAL search_path TO garment_catalog, public;
-- Phone sign-in. Codes are stored hashed; send quota is reserved atomically before the
-- provider call so concurrent requests cannot exceed the limits the provider also enforces.

CREATE TABLE sms_challenges (
  id uuid PRIMARY KEY,
  phone text NOT NULL CHECK (phone ~ '^1[3-9][0-9]{9}$'),
  purpose text NOT NULL CHECK (purpose IN ('login', 'bind')),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  superseded boolean NOT NULL DEFAULT false,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  send_state text NOT NULL DEFAULT 'submitted'
    CHECK (send_state IN ('submitted', 'accepted', 'failed', 'unknown')),
  provider_biz_id text,
  provider_code text,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_challenges_active ON sms_challenges(phone, purpose, created_at DESC)
  WHERE consumed_at IS NULL AND NOT superseded;

CREATE TABLE sms_quota (
  scope text NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  window_start timestamptz NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (scope, window_seconds, window_start)
);
CREATE INDEX sms_quota_expiry ON sms_quota(window_start);

-- Failed verification attempts must survive a rolled back business transaction.
CREATE TABLE sms_attempts (
  id uuid PRIMARY KEY,
  challenge_id uuid NOT NULL REFERENCES sms_challenges(id) DEFERRABLE INITIALLY DEFERRED,
  ok boolean NOT NULL,
  request_ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_attempts_challenge ON sms_attempts(challenge_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mockup_app') THEN
    GRANT SELECT, INSERT, UPDATE ON garment_catalog.sms_challenges, garment_catalog.sms_quota TO mockup_app;
    GRANT SELECT, INSERT ON garment_catalog.sms_attempts TO mockup_app;
  END IF;
END $$;
