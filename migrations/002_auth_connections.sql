CREATE TABLE plugin_m365_8b2a74e8fa.connections (
  company_id uuid NOT NULL,
  id uuid NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  shareable boolean NOT NULL DEFAULT false,
  expected_tenant_id uuid NOT NULL,
  tenant_id uuid,
  home_account_id text,
  account_username text,
  status text NOT NULL CHECK (status IN (
    'pending', 'connected', 'interaction_required', 'consent_revoked', 'blocked', 'disconnected'
  )),
  error_code text CHECK (error_code IS NULL OR error_code IN (
    'cache_conflict', 'cache_invalid', 'consent_revoked', 'interaction_required',
    'key_unavailable', 'tenant_mismatch'
  )),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (company_id, id)
);

CREATE TABLE plugin_m365_8b2a74e8fa.token_caches (
  company_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  cache_version bigint NOT NULL CHECK (cache_version > 0),
  algorithm text NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  key_version text NOT NULL,
  iv text NOT NULL,
  ciphertext text NOT NULL,
  authentication_tag text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, connection_id),
  FOREIGN KEY (company_id, connection_id)
    REFERENCES plugin_m365_8b2a74e8fa.connections (company_id, id)
    ON DELETE CASCADE
);
