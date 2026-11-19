CREATE TABLE plugin_m365_8b2a74e8fa.telemetry_companies (
  company_id uuid PRIMARY KEY,
  inventory jsonb,
  rule_revision bigint NOT NULL DEFAULT 0,
  rule_states jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rule_states)='array' AND jsonb_array_length(rule_states)<=1024),
  incidents jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(incidents)='array' AND jsonb_array_length(incidents)<=256)
);

CREATE TABLE plugin_m365_8b2a74e8fa.telemetry_buckets (
  company_id uuid NOT NULL,
  minute timestamptz NOT NULL,
  metric text NOT NULL,
  labels_key text NOT NULL CHECK (char_length(labels_key)=64),
  labels jsonb NOT NULL CHECK (jsonb_typeof(labels)='object'),
  sample_count double precision NOT NULL CHECK (sample_count>=0),
  sample_sum double precision NOT NULL CHECK (sample_sum>=0),
  sample_max double precision NOT NULL CHECK (sample_max>=0),
  h0 double precision NOT NULL CHECK (h0>=0),
  h1 double precision NOT NULL CHECK (h1>=h0),
  h2 double precision NOT NULL CHECK (h2>=h1),
  h3 double precision NOT NULL CHECK (h3>=h2 AND h3<=sample_count),
  PRIMARY KEY(company_id,minute,metric,labels_key)
);

CREATE TABLE plugin_m365_8b2a74e8fa.telemetry_days (
  company_id uuid NOT NULL,
  day date NOT NULL,
  operations bigint NOT NULL CHECK (operations>=0),
  audit_events bigint NOT NULL CHECK (audit_events>=0),
  PRIMARY KEY(company_id,day)
);
