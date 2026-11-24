-- A live operation may belong to a company task without an assigned project.
-- Purged records are still distinguished by metadata_purged_at and tombstones.
ALTER TABLE plugin_m365_8b2a74e8fa.operations
  DROP CONSTRAINT operation_live_identity,
  ADD CONSTRAINT operation_live_identity CHECK (metadata_purged_at IS NOT NULL OR
    (connection_id IS NOT NULL AND agent_id IS NOT NULL AND run_id IS NOT NULL
      AND tenant_id IS NOT NULL AND home_account_id IS NOT NULL AND resource IS NOT NULL
      AND policy_revision IS NOT NULL AND connection_generation IS NOT NULL));
