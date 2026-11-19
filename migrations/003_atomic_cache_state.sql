ALTER TABLE plugin_m365_8b2a74e8fa.connections
  ADD COLUMN cache_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN cache_algorithm text,
  ADD COLUMN cache_key_version text,
  ADD COLUMN cache_iv text,
  ADD COLUMN cache_ciphertext text,
  ADD COLUMN cache_authentication_tag text;

UPDATE plugin_m365_8b2a74e8fa.connections AS connection
SET cache_version = cache.cache_version, cache_algorithm = cache.algorithm,
  cache_key_version = cache.key_version, cache_iv = cache.iv,
  cache_ciphertext = cache.ciphertext, cache_authentication_tag = cache.authentication_tag
FROM plugin_m365_8b2a74e8fa.token_caches AS cache
WHERE connection.company_id = cache.company_id AND connection.id = cache.connection_id
  AND connection.status IN ('pending', 'connected');

UPDATE plugin_m365_8b2a74e8fa.connections
SET status = 'blocked', error_code = 'cache_invalid'
WHERE status = 'connected' AND cache_version = 0;

ALTER TABLE plugin_m365_8b2a74e8fa.connections
  ADD CONSTRAINT connections_cache_shape CHECK (
    (cache_version = 0 AND cache_algorithm IS NULL AND cache_key_version IS NULL
      AND cache_iv IS NULL AND cache_ciphertext IS NULL AND cache_authentication_tag IS NULL)
    OR (cache_version > 0 AND cache_algorithm IS NOT NULL AND cache_algorithm = 'aes-256-gcm'
      AND cache_key_version IS NOT NULL AND cache_iv IS NOT NULL
      AND cache_ciphertext IS NOT NULL AND cache_authentication_tag IS NOT NULL)
  ),
  DROP CONSTRAINT connections_error_code_check,
  ADD CONSTRAINT connections_error_code_check CHECK (error_code IS NULL OR error_code IN (
    'cache_conflict', 'cache_invalid', 'consent_revoked', 'interaction_required',
    'key_unavailable', 'tenant_mismatch', 'provider_unavailable', 'storage_unavailable'
  ));

UPDATE plugin_m365_8b2a74e8fa.token_caches
SET iv = '', ciphertext = '', authentication_tag = '';
