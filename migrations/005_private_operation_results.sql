ALTER TABLE plugin_m365_8b2a74e8fa.operations
  ADD COLUMN private_result_envelope jsonb,
  ADD COLUMN private_result_expires_at timestamptz,
  ADD COLUMN metadata_purge_after timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  ADD COLUMN metadata_purged_at timestamptz,
  ALTER COLUMN connection_id DROP NOT NULL,
  ALTER COLUMN agent_id DROP NOT NULL,
  ALTER COLUMN run_id DROP NOT NULL,
  ALTER COLUMN project_id DROP NOT NULL,
  ALTER COLUMN tenant_id DROP NOT NULL,
  ALTER COLUMN home_account_id DROP NOT NULL,
  ALTER COLUMN resource DROP NOT NULL,
  ALTER COLUMN policy_revision DROP NOT NULL,
  ALTER COLUMN connection_generation DROP NOT NULL,
  DROP CONSTRAINT operations_audit_check,
  DROP CONSTRAINT operations_check1,
  DROP CONSTRAINT operations_check2,
  DROP CONSTRAINT operations_check3;

UPDATE plugin_m365_8b2a74e8fa.operations SET result=NULL;

ALTER TABLE plugin_m365_8b2a74e8fa.operations
  ADD CONSTRAINT operation_public_result_shape CHECK (result IS NULL OR result='null'::jsonb OR
    (jsonb_typeof(result)='object' AND result ?& ARRAY['schemaVersion','code','resourceKind','errorCode']
      AND result-ARRAY['schemaVersion','code','resourceKind','errorCode']='{}'::jsonb
      AND result->'schemaVersion'='1'::jsonb
      AND result->>'code' IN ('completed','created','updated','deleted','accepted','failed','unknown')
      AND result->>'resourceKind' IN ('mail','calendar','drive','none')
      AND (result->'errorCode'='null'::jsonb OR result->>'errorCode' IN ('permission_denied','not_found','conflict','rate_limited','provider_unavailable','validation_failed','unknown')))),
  ADD CONSTRAINT operation_private_result_shape CHECK (
    (private_result_envelope IS NULL AND private_result_expires_at IS NULL)
    OR (private_result_envelope IS NOT NULL AND jsonb_typeof(private_result_envelope)='object' AND private_result_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT operation_audit_shape CHECK (jsonb_typeof(audit)='array' AND
    ((metadata_purged_at IS NULL AND jsonb_array_length(audit) BETWEEN 1 AND 8)
      OR (metadata_purged_at IS NOT NULL AND jsonb_array_length(audit)=0))),
  ADD CONSTRAINT operation_live_identity CHECK (metadata_purged_at IS NOT NULL OR
    (connection_id IS NOT NULL AND agent_id IS NOT NULL AND run_id IS NOT NULL AND project_id IS NOT NULL
      AND tenant_id IS NOT NULL AND home_account_id IS NOT NULL AND resource IS NOT NULL
      AND policy_revision IS NOT NULL AND connection_generation IS NOT NULL)),
  ADD CONSTRAINT operation_live_decision CHECK (metadata_purged_at IS NOT NULL OR
    ((decision_user_id IS NULL)=(decided_at IS NULL) AND
      (state NOT IN ('approved','rejected','executing','succeeded','failed','unknown') OR decision_user_id IS NOT NULL))),
  ADD CONSTRAINT operation_execution_receipt CHECK (state NOT IN ('executing','succeeded','failed','unknown') OR (executor_nonce IS NOT NULL AND reserved_at IS NOT NULL)),
  ADD CONSTRAINT operation_tombstone CHECK (metadata_purged_at IS NULL OR
    (state<>'executing' AND snapshot_envelope IS NULL AND private_result_envelope IS NULL AND result IS NULL
      AND decision_user_id IS NULL AND connection_id IS NULL AND agent_id IS NULL AND run_id IS NULL AND project_id IS NULL
      AND tenant_id IS NULL AND home_account_id IS NULL AND resource IS NULL AND policy_revision IS NULL AND connection_generation IS NULL));
