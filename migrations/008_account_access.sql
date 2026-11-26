-- Preserve the approved account envelope independently of individual agent grants.
-- This migration grants nobody additional access and never creates wildcard rules.
ALTER TABLE plugin_m365_8b2a74e8fa.connections
  ADD COLUMN account_access_rules jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(account_access_rules) = 'array');

UPDATE plugin_m365_8b2a74e8fa.connections AS connection
SET account_access_rules = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('operationType', grouped.operation_type, 'resources', grouped.resources) ORDER BY grouped.operation_type)
  FROM (
    SELECT rule->>'operationType' AS operation_type, jsonb_agg(DISTINCT resource) AS resources
    FROM jsonb_array_elements(connection.policy_bindings) AS binding,
      jsonb_array_elements(binding->'rules') AS rule,
      jsonb_array_elements(rule->'resources') AS resource
    GROUP BY rule->>'operationType'
  ) AS grouped
), '[]'::jsonb);

-- Persist the account-switch rejection introduced by reconnect identity pinning.
ALTER TABLE plugin_m365_8b2a74e8fa.connections
  DROP CONSTRAINT connections_error_code_check,
  ADD CONSTRAINT connections_error_code_check CHECK (error_code IS NULL OR error_code IN (
    'cache_conflict', 'cache_invalid', 'consent_revoked', 'interaction_required',
    'key_unavailable', 'tenant_mismatch', 'account_mismatch', 'provider_unavailable', 'storage_unavailable'
  ));
