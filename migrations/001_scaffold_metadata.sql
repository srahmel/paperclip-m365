CREATE TABLE plugin_m365_8b2a74e8fa.scaffold_metadata (
  schema_version integer PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plugin_m365_8b2a74e8fa.scaffold_metadata (schema_version)
VALUES (1);
