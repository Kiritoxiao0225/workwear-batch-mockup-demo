SET LOCAL search_path TO garment_catalog, public;
CREATE TABLE email_challenges (
 id uuid PRIMARY KEY,
 email text NOT NULL,
 code_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 superseded boolean NOT NULL DEFAULT false,
 consumed_at timestamptz,
 expires_at timestamptz NOT NULL,
 send_state text NOT NULL DEFAULT 'submitted' CHECK (send_state IN ('submitted','accepted','failed','unknown')),
 provider_id text,
 provider_code text,
 request_ip inet,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_challenges_active ON email_challenges(email,created_at DESC) WHERE consumed_at IS NULL AND NOT superseded;
CREATE TABLE email_quota (
 scope text NOT NULL,
 window_seconds integer NOT NULL,
 window_start timestamptz NOT NULL,
 used integer NOT NULL CHECK (used >= 0),
 PRIMARY KEY(scope,window_seconds,window_start)
);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
  GRANT SELECT, INSERT, UPDATE ON email_challenges,email_quota TO mockup_app;
 END IF;
END $$;
