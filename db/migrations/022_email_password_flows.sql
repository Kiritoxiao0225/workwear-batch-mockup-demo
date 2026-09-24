SET LOCAL search_path TO garment_catalog, public;
-- Existing accounts and active sessions retain their identities during the UI switch.
ALTER TABLE users ADD COLUMN password_version integer NOT NULL DEFAULT 0 CHECK (password_version >= 0);
ALTER TABLE email_challenges ADD COLUMN purpose text NOT NULL DEFAULT 'legacy'
  CHECK (purpose IN ('legacy','register','reset','setup'));
CREATE TABLE email_password_tickets (
  token_hash text PRIMARY KEY,
  challenge_id uuid NOT NULL UNIQUE REFERENCES email_challenges(id),
  email text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register','reset','setup')),
  user_id uuid REFERENCES users(id),
  password_version integer,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_password_tickets_email ON email_password_tickets(email) WHERE consumed_at IS NULL;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mockup_app') THEN
  GRANT SELECT, INSERT, UPDATE ON email_password_tickets TO mockup_app;
 END IF;
END $$;
