CREATE TABLE session_requests (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) > 0),
  session_id uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL
);

ALTER TABLE messages ADD COLUMN input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0);
ALTER TABLE messages ADD COLUMN output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0);
ALTER TABLE messages ADD COLUMN cost_microunits bigint NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0);
ALTER TABLE messages ADD COLUMN finish_reason text NOT NULL DEFAULT 'unknown';

CREATE TABLE projection_versions (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  projection text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  rebuilt_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, projection)
);
