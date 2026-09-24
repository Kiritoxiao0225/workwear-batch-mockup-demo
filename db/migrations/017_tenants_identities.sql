SET LOCAL search_path TO garment_catalog, public;
-- Multi-tenant accounts. Existing data keeps working: the internal tenant owns it and
-- resolves to the same 'main' workspace the WPS delivery already uses.

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'internal')),
  billing_mode text NOT NULL DEFAULT 'charge' CHECK (billing_mode IN ('charge', 'exempt')),
  style_quota integer NOT NULL CHECK (style_quota >= 0),
  storage_quota_bytes bigint NOT NULL CHECK (storage_quota_bytes >= 0),
  workspace text NOT NULL UNIQUE CHECK (workspace ~ '^[a-zA-Z0-9_-]{1,80}$'),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The delivery workspace keeps its identity and stays exempt from credit accounting.
-- Effectively unlimited, but chosen to survive a JSON round trip: values above
-- Number.MAX_SAFE_INTEGER lose precision in backup/restore and overflow bigint on the way back.
INSERT INTO tenants(id, name, plan, billing_mode, style_quota, storage_quota_bytes, workspace)
VALUES ('00000000-0000-0000-0000-000000000001', '内部', 'internal', 'exempt',
        2147483647, 1125899906842624, 'main');  -- 1 PiB

ALTER TABLE users ADD COLUMN tenant_id uuid REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE users ADD COLUMN tenant_role text NOT NULL DEFAULT 'owner'
  CHECK (tenant_role IN ('owner', 'member'));
UPDATE users SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
-- The backfill above fires the deferred foreign key, and a table with pending trigger events
-- cannot be altered. Forcing the check now keeps the constraint deferrable for restore
-- ordering while letting this migration proceed on a database that already has rows.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX users_tenant ON users(tenant_id);

-- Verification-code accounts have no password; email stays NOT NULL for existing code paths
-- and carries an undeliverable placeholder for phone signups.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Login credentials move off users.email so phone and social logins do not need a schema change.
CREATE TABLE user_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL CHECK (kind IN ('email', 'phone', 'wechat')),
  identifier text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, identifier)
);
CREATE INDEX user_identities_user ON user_identities(user_id);

-- Existing accounts are trusted internal migrations, not historical email verifications.
INSERT INTO user_identities(id, user_id, kind, identifier, verified_at)
SELECT gen_random_uuid(), id, 'email', email, created_at FROM users;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mockup_app') THEN
    GRANT SELECT ON garment_catalog.tenants TO mockup_app;
    GRANT SELECT, INSERT, UPDATE ON garment_catalog.user_identities TO mockup_app;
  END IF;
END $$;
