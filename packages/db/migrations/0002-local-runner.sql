CREATE TYPE session_status AS ENUM (
  'created', 'queued', 'running', 'completed', 'limit_reached', 'cancelled', 'failed'
);

CREATE TABLE bots (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE bot_versions (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(id),
  version integer NOT NULL CHECK (version > 0),
  provider text NOT NULL,
  model text NOT NULL,
  system_prompt text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (bot_id, version)
);

CREATE TABLE scenarios (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE scenario_versions (
  id uuid PRIMARY KEY,
  scenario_id uuid NOT NULL REFERENCES scenarios(id),
  version integer NOT NULL CHECK (version > 0),
  opening_message text NOT NULL,
  defaults jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (scenario_id, version)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  scenario_version_id uuid NOT NULL REFERENCES scenario_versions(id),
  status session_status NOT NULL DEFAULT 'created',
  next_participant_index smallint NOT NULL DEFAULT 0 CHECK (next_participant_index IN (0, 1)),
  message_limit integer NOT NULL CHECK (message_limit > 0),
  total_token_limit bigint NOT NULL CHECK (total_token_limit > 0),
  duration_limit_ms bigint NOT NULL CHECK (duration_limit_ms > 0),
  cost_limit_microunits bigint NOT NULL CHECK (cost_limit_microunits > 0),
  currency character(3) NOT NULL CHECK (currency = upper(currency)),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_microunits bigint NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),
  stop_reason text,
  created_at timestamptz NOT NULL,
  queued_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  CHECK ((status IN ('completed', 'limit_reached', 'cancelled', 'failed')) = (stop_reason IS NOT NULL)),
  CHECK ((status IN ('completed', 'limit_reached', 'cancelled', 'failed')) = (ended_at IS NOT NULL)),
  CHECK (status = 'created' OR queued_at IS NOT NULL),
  CHECK (status NOT IN ('running', 'completed', 'limit_reached', 'failed') OR started_at IS NOT NULL),
  CHECK (
    (status = 'completed' AND stop_reason = 'conversation_completed') OR
    (status = 'limit_reached' AND stop_reason IN ('message_limit', 'token_limit', 'duration_limit', 'cost_limit')) OR
    (status = 'cancelled' AND stop_reason = 'cancelled_by_user') OR
    (status = 'failed' AND stop_reason = 'provider_error') OR
    status IN ('created', 'queued', 'running')
  )
);

CREATE TABLE session_participants (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position IN (0, 1)),
  bot_version_id uuid NOT NULL REFERENCES bot_versions(id),
  UNIQUE (session_id, position),
  UNIQUE (session_id, bot_version_id),
  UNIQUE (session_id, id)
);

CREATE TABLE canonical_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) > 0),
  event_type text NOT NULL CHECK (length(event_type) > 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  participant_id uuid,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, idempotency_key),
  FOREIGN KEY (session_id, participant_id) REFERENCES session_participants(session_id, id)
);
CREATE INDEX canonical_events_resume_idx ON canonical_events (session_id, sequence);

CREATE TABLE provider_attempts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  turn_number integer NOT NULL CHECK (turn_number > 0),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  idempotency_key text NOT NULL UNIQUE,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'ambiguous')),
  retryable boolean,
  partial_output boolean NOT NULL DEFAULT false,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cost_microunits bigint CHECK (cost_microunits >= 0),
  finish_reason text,
  error_class text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (session_id, turn_number, attempt_number)
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES canonical_events(id) ON DELETE RESTRICT,
  topic text NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0)
);
CREATE INDEX outbox_pending_idx ON outbox (created_at, id) WHERE published_at IS NULL;

CREATE TABLE session_leases (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX session_leases_expiry_idx ON session_leases (expires_at);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  content text NOT NULL,
  partial boolean NOT NULL,
  source_event_id uuid NOT NULL UNIQUE REFERENCES canonical_events(id) ON DELETE RESTRICT,
  UNIQUE (session_id, ordinal),
  FOREIGN KEY (session_id, participant_id) REFERENCES session_participants(session_id, id)
);

CREATE TABLE message_chunks (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  text text NOT NULL,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset >= start_offset),
  source_event_id uuid NOT NULL UNIQUE REFERENCES canonical_events(id) ON DELETE RESTRICT,
  UNIQUE (message_id, chunk_index)
);

CREATE FUNCTION reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER bot_versions_immutable BEFORE UPDATE OR DELETE ON bot_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER scenario_versions_immutable BEFORE UPDATE OR DELETE ON scenario_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER canonical_events_immutable BEFORE UPDATE OR DELETE ON canonical_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE FUNCTION require_two_participants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_session uuid;
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    target_session := COALESCE(NEW.id, OLD.id);
  ELSE
    target_session := COALESCE(NEW.session_id, OLD.session_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = target_session AND s.status <> 'created'
      AND (SELECT count(*) FROM session_participants p WHERE p.session_id = s.id) <> 2
  ) THEN
    RAISE EXCEPTION 'non-created session requires exactly two participants'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sessions_require_two_participants
  AFTER INSERT OR UPDATE ON sessions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_two_participants();
CREATE CONSTRAINT TRIGGER participants_require_two_participants
  AFTER INSERT OR UPDATE OR DELETE ON session_participants DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_two_participants();
