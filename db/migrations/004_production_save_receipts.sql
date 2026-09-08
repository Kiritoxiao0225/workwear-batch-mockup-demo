SET LOCAL search_path TO garment_catalog, public;
CREATE TABLE production_save_receipts (
  operation_id uuid PRIMARY KEY,
  state_key text NOT NULL REFERENCES production_states(state_key),
  request_hash text NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
