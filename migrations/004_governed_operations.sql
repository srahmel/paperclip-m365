ALTER TABLE plugin_m365_8b2a74e8fa.connections
  ADD COLUMN policy_revision bigint NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  ADD COLUMN policy_bindings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(policy_bindings) = 'array' AND jsonb_array_length(policy_bindings) <= 100),
  ADD COLUMN policy_approver_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(policy_approver_user_ids) = 'array' AND jsonb_array_length(policy_approver_user_ids) <= 100),
  ADD COLUMN policy_changed_by text,
  ADD COLUMN policy_changed_at timestamptz;

CREATE TABLE plugin_m365_8b2a74e8fa.operations (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  home_account_id text NOT NULL CHECK (char_length(home_account_id) BETWEEN 1 AND 1024),
  agent_id uuid NOT NULL,
  run_id uuid NOT NULL,
  project_id uuid NOT NULL,
  operation_type text NOT NULL,
  resource text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
  policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  snapshot_envelope jsonb CHECK (snapshot_envelope IS NULL OR jsonb_typeof(snapshot_envelope) = 'object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('pending','approved','rejected','expired','invalidated','executing','succeeded','failed','unknown')),
  decision_user_id text,
  decided_at timestamptz,
  executor_nonce uuid,
  reserved_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  audit jsonb NOT NULL CHECK (jsonb_typeof(audit) = 'array' AND jsonb_array_length(audit) BETWEEN 1 AND 8),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, connection_id) REFERENCES plugin_m365_8b2a74e8fa.connections(company_id, id),
  CHECK (expires_at > created_at),
  CHECK ((decision_user_id IS NULL) = (decided_at IS NULL)),
  CHECK (state NOT IN ('approved','rejected','executing','succeeded','failed','unknown') OR decision_user_id IS NOT NULL),
  CHECK (state NOT IN ('executing','succeeded','failed','unknown') OR (executor_nonce IS NOT NULL AND reserved_at IS NOT NULL))
);

CREATE INDEX operations_company_state_expiry ON plugin_m365_8b2a74e8fa.operations(company_id, state, expires_at);
