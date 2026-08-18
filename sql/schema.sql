CREATE TABLE IF NOT EXISTS mm_system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ingest_revision bigint NOT NULL DEFAULT 0 CHECK (ingest_revision >= 0),
  updated_at timestamptz NOT NULL
);

INSERT INTO mm_system_state (singleton, ingest_revision, updated_at)
VALUES (true, 0, clock_timestamp())
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS mm_sources (
  source_id text PRIMARY KEY,
  source_epoch bigint NOT NULL DEFAULT 0 CHECK (source_epoch >= 0),
  next_batch_sequence bigint NOT NULL DEFAULT 0 CHECK (next_batch_sequence >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mm_series (
  series_digest char(64) PRIMARY KEY,
  tenant text NOT NULL CHECK (tenant = 'synthetic-lab'),
  metric_name text NOT NULL,
  labels_json jsonb NOT NULL CHECK (jsonb_typeof(labels_json) = 'object'),
  created_revision bigint NOT NULL CHECK (created_revision > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (tenant, metric_name, labels_json)
);

CREATE TABLE IF NOT EXISTS mm_samples (
  series_digest char(64) NOT NULL REFERENCES mm_series(series_digest),
  observed_at timestamptz NOT NULL,
  value double precision NOT NULL CHECK (
    value <> 'NaN'::double precision
    AND value <> 'Infinity'::double precision
    AND value <> '-Infinity'::double precision
  ),
  ingest_revision bigint NOT NULL CHECK (ingest_revision > 0),
  received_at timestamptz NOT NULL,
  PRIMARY KEY (series_digest, observed_at)
);

CREATE INDEX IF NOT EXISTS mm_samples_snapshot_query
ON mm_samples (series_digest, observed_at, ingest_revision);

CREATE TABLE IF NOT EXISTS mm_ingest_receipts (
  source_id text NOT NULL REFERENCES mm_sources(source_id),
  source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
  batch_sequence bigint NOT NULL CHECK (batch_sequence >= 0),
  intent_digest char(64) NOT NULL,
  ingest_revision bigint NOT NULL CHECK (ingest_revision > 0),
  submitted_count integer NOT NULL CHECK (submitted_count > 0),
  unique_count integer NOT NULL CHECK (unique_count > 0 AND unique_count <= submitted_count),
  inserted_count integer NOT NULL CHECK (inserted_count >= 0 AND inserted_count <= unique_count),
  duplicate_count integer NOT NULL CHECK (duplicate_count >= 0 AND duplicate_count <= unique_count),
  new_series_count integer NOT NULL CHECK (new_series_count >= 0),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (source_id, source_epoch, batch_sequence),
  UNIQUE (ingest_revision),
  CHECK (inserted_count + duplicate_count = unique_count)
);

CREATE TABLE IF NOT EXISTS mm_mutation_receipts (
  principal text NOT NULL,
  request_key text NOT NULL,
  intent_digest char(64) NOT NULL,
  operation text NOT NULL CHECK (operation IN (
    'rotate_source_epoch',
    'create_rule',
    'create_rule_generation',
    'rotate_evaluator_authority',
    'create_silence',
    'rotate_notification_authority'
  )),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (principal, request_key)
);

CREATE TABLE IF NOT EXISTS mm_query_receipts (
  principal text NOT NULL,
  request_key text NOT NULL,
  intent_digest char(64) NOT NULL,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision >= 0),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (principal, request_key)
);

CREATE TABLE IF NOT EXISTS mm_rule_heads (
  rule_id text PRIMARY KEY,
  current_generation bigint NOT NULL CHECK (current_generation > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mm_rule_generations (
  rule_id text NOT NULL REFERENCES mm_rule_heads(rule_id),
  generation bigint NOT NULL CHECK (generation > 0),
  series_digest char(64) NOT NULL,
  metric_name text NOT NULL,
  labels_json jsonb NOT NULL CHECK (jsonb_typeof(labels_json) = 'object'),
  threshold double precision NOT NULL CHECK (
    threshold <> 'NaN'::double precision
    AND threshold <> 'Infinity'::double precision
    AND threshold <> '-Infinity'::double precision
  ),
  lookback_seconds integer NOT NULL CHECK (lookback_seconds BETWEEN 1 AND 3600),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 10 AND 300),
  consecutive_true_slots integer NOT NULL CHECK (consecutive_true_slots BETWEEN 1 AND 12),
  missing_policy text NOT NULL CHECK (missing_policy = 'reset_pending_keep_firing'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (rule_id, generation)
);

CREATE TABLE IF NOT EXISTS mm_rule_states (
  rule_id text NOT NULL,
  generation bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('inactive', 'pending', 'firing')),
  consecutive_true integer NOT NULL CHECK (consecutive_true >= 0),
  last_slot timestamptz,
  episode bigint NOT NULL DEFAULT 0 CHECK (episode >= 0),
  active_incident_id char(64),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (rule_id, generation),
  FOREIGN KEY (rule_id, generation) REFERENCES mm_rule_generations(rule_id, generation)
);

CREATE TABLE IF NOT EXISTS mm_evaluator_authority (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  worker_id text,
  worker_epoch bigint NOT NULL DEFAULT 0 CHECK (worker_epoch >= 0),
  updated_at timestamptz NOT NULL
);

INSERT INTO mm_evaluator_authority (singleton, worker_id, worker_epoch, updated_at)
VALUES (true, NULL, 0, clock_timestamp())
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS mm_incidents (
  incident_id char(64) PRIMARY KEY,
  rule_id text NOT NULL,
  generation bigint NOT NULL,
  episode bigint NOT NULL CHECK (episode > 0),
  status text NOT NULL CHECK (status IN ('firing', 'resolved')),
  opened_slot timestamptz NOT NULL,
  resolved_slot timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (rule_id, generation) REFERENCES mm_rule_generations(rule_id, generation),
  UNIQUE (rule_id, generation, episode),
  CHECK ((status = 'firing' AND resolved_slot IS NULL) OR (status = 'resolved' AND resolved_slot IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS mm_transitions (
  transition_id char(64) PRIMARY KEY,
  incident_id char(64) NOT NULL REFERENCES mm_incidents(incident_id),
  kind text NOT NULL CHECK (kind IN ('firing', 'resolved')),
  slot timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (incident_id, kind, slot)
);

CREATE TABLE IF NOT EXISTS mm_silences (
  silence_id char(64) PRIMARY KEY,
  rule_id text NOT NULL REFERENCES mm_rule_heads(rule_id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (starts_at < ends_at),
  CHECK (ends_at - starts_at <= interval '24 hours')
);

CREATE INDEX IF NOT EXISTS mm_silences_active
ON mm_silences (rule_id, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS mm_routing_receipts (
  transition_id char(64) PRIMARY KEY REFERENCES mm_transitions(transition_id),
  status text NOT NULL CHECK (status IN ('routable', 'suppressed')),
  silence_id char(64) REFERENCES mm_silences(silence_id),
  notification_id char(64) UNIQUE,
  created_at timestamptz NOT NULL,
  CHECK (
    (status = 'routable' AND silence_id IS NULL AND notification_id IS NOT NULL)
    OR (status = 'suppressed' AND silence_id IS NOT NULL AND notification_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS mm_notification_outbox (
  notification_id char(64) PRIMARY KEY,
  transition_id char(64) NOT NULL UNIQUE REFERENCES mm_transitions(transition_id),
  transition_kind text NOT NULL CHECK (transition_kind IN ('firing', 'resolved')),
  destination text NOT NULL CHECK (destination = 'local-synthetic-provider'),
  status text NOT NULL CHECK (status IN ('pending', 'leased', 'provider_accepted')),
  worker_id text,
  worker_epoch bigint,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_until timestamptz,
  provider_result_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (
    (status = 'pending' AND worker_id IS NULL AND worker_epoch IS NULL AND lease_until IS NULL)
    OR (status = 'leased' AND worker_id IS NOT NULL AND worker_epoch IS NOT NULL AND lease_until IS NOT NULL)
    OR (status = 'provider_accepted' AND provider_result_json IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS mm_outbox_claimable
ON mm_notification_outbox (status, lease_until, created_at);

CREATE TABLE IF NOT EXISTS mm_notification_authority (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  worker_id text,
  worker_epoch bigint NOT NULL DEFAULT 0 CHECK (worker_epoch >= 0),
  updated_at timestamptz NOT NULL
);

INSERT INTO mm_notification_authority (singleton, worker_id, worker_epoch, updated_at)
VALUES (true, NULL, 0, clock_timestamp())
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS mm_provider_attempts (
  provider_attempt_id bigserial PRIMARY KEY,
  notification_id char(64) NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  request_digest char(64) NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE (notification_id, attempt)
);

CREATE TABLE IF NOT EXISTS mm_provider_acceptances (
  notification_id char(64) PRIMARY KEY,
  transition_kind text NOT NULL CHECK (transition_kind IN ('firing', 'resolved')),
  first_provider_attempt_id bigint NOT NULL REFERENCES mm_provider_attempts(provider_attempt_id),
  accepted_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mm_evaluations (
  evaluation_id char(64) PRIMARY KEY,
  rule_id text NOT NULL,
  generation bigint NOT NULL,
  slot timestamptz NOT NULL,
  evaluator_id text NOT NULL,
  evaluator_epoch bigint NOT NULL CHECK (evaluator_epoch > 0),
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision >= 0),
  outcome text NOT NULL CHECK (outcome IN ('true', 'false', 'unknown')),
  sample_observed_at timestamptz,
  sample_value double precision,
  state_before text NOT NULL CHECK (state_before IN ('inactive', 'pending', 'firing')),
  state_after text NOT NULL CHECK (state_after IN ('inactive', 'pending', 'firing')),
  transition_id char(64) REFERENCES mm_transitions(transition_id),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (rule_id, generation) REFERENCES mm_rule_generations(rule_id, generation),
  UNIQUE (rule_id, generation, slot),
  CHECK ((outcome = 'unknown' AND sample_observed_at IS NULL AND sample_value IS NULL) OR outcome <> 'unknown')
);
