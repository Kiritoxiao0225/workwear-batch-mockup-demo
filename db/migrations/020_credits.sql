SET LOCAL search_path TO garment_catalog, public;
-- Credits. Amounts are integer cents; prices carry a finer unit so an action costing less
-- than one cent can still be expressed. No floating point anywhere.

CREATE TABLE credit_accounts (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  held_cents bigint NOT NULL DEFAULT 0 CHECK (held_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO credit_accounts(tenant_id) SELECT id FROM tenants;

-- Prices are versioned: settlement reads the snapshot taken when the work was reserved, so
-- changing a price never rewrites history.
CREATE TABLE price_list (
  action text NOT NULL CHECK (action IN ('analyze', 'generate', 'enhance', 'cutout', 'recognize')),
  cost_micro_cents bigint NOT NULL CHECK (cost_micro_cents >= 0),
  multiplier_milli integer NOT NULL DEFAULT 2000 CHECK (multiplier_milli > 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, effective_from)
);
-- Starting points, maintained by the operator; these are estimates, not supplier invoices.
INSERT INTO price_list(action, cost_micro_cents) VALUES
  ('analyze', 7500), ('generate', 20000), ('enhance', 10000), ('cutout', 5000), ('recognize', 4000);

CREATE TABLE credit_holds (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL CHECK (kind IN ('analysis', 'production', 'recognize')),
  job_ref text NOT NULL,
  -- Fixed when the work is reserved: changing a tenant's plan later must not rewrite old accounting.
  billing_mode text NOT NULL CHECK (billing_mode IN ('charge', 'exempt')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  confirmed_cents bigint CHECK (confirmed_cents >= 0),
  unknown_cents bigint CHECK (unknown_cents >= 0),
  settled_cents bigint CHECK (settled_cents >= 0),
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'settled', 'released', 'disputed')),
  price_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disputed_at timestamptz,
  resolved_at timestamptz,
  CHECK (state <> 'held' OR (resolved_at IS NULL AND disputed_at IS NULL)),
  -- A dispute is entered but not yet decided, so it carries a start time and no resolution.
  CHECK (state <> 'disputed' OR (resolved_at IS NULL AND disputed_at IS NOT NULL
                                 AND confirmed_cents IS NOT NULL AND unknown_cents IS NOT NULL)),
  CHECK (state NOT IN ('settled', 'released') OR
         (resolved_at IS NOT NULL AND settled_cents IS NOT NULL
          AND confirmed_cents IS NOT NULL AND unknown_cents IS NOT NULL
          -- Reserved at the worst case, so settlement never needs to charge more.
          AND settled_cents <= amount_cents
          -- Calls with a receipt are always charged; only the uncertain part is a judgement call.
          AND settled_cents >= confirmed_cents
          AND settled_cents <= confirmed_cents + unknown_cents)),
  CHECK (state <> 'released' OR settled_cents = 0)
);
CREATE INDEX credit_holds_open ON credit_holds(state, created_at) WHERE state IN ('held', 'disputed');
CREATE INDEX credit_holds_tenant ON credit_holds(tenant_id, created_at DESC);

-- Read-only history. Idempotency lives in credit_holds' state machine, not here.
CREATE TABLE credit_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL CHECK (kind IN ('grant', 'hold', 'settle', 'release', 'adjust')),
  amount_cents bigint NOT NULL,
  balance_after bigint NOT NULL,
  held_after bigint NOT NULL,
  hold_id text REFERENCES credit_holds(id) DEFERRABLE INITIALLY DEFERRED,
  reason text NOT NULL,
  operator_id uuid REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED,
  cost_estimate_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_tenant_time ON credit_ledger(tenant_id, created_at DESC);
CREATE INDEX credit_ledger_hold ON credit_ledger(hold_id) WHERE hold_id IS NOT NULL;

-- Usage events, shaped for a future metering provider. Written in the settlement transaction,
-- which also makes them the reconciliation source today.
CREATE TABLE usage_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) DEFERRABLE INITIALLY DEFERRED,
  idempotency_key text NOT NULL UNIQUE,
  metric_code text NOT NULL CHECK (metric_code IN ('analyze', 'generate', 'enhance', 'cutout', 'recognize')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  forwarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_pending ON usage_events(occurred_at) WHERE forwarded_at IS NULL;
CREATE INDEX usage_events_tenant ON usage_events(tenant_id, occurred_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mockup_app') THEN
    GRANT SELECT, INSERT, UPDATE ON garment_catalog.credit_accounts, garment_catalog.credit_holds TO mockup_app;
    GRANT SELECT, INSERT ON garment_catalog.credit_ledger, garment_catalog.usage_events TO mockup_app;
    GRANT SELECT ON garment_catalog.price_list TO mockup_app;
  END IF;
END $$;
