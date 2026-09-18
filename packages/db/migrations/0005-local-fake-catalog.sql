-- Synthetic local-only catalog entries used by the runnable fake-provider slice.
INSERT INTO bots (id, name, created_at) VALUES
  ('11111111-1111-7111-8111-111111111110', 'Local Atlas', now()),
  ('11111111-1111-7111-8111-111111111111', 'Local Beacon', now());

INSERT INTO bot_versions (id, bot_id, version, provider, model, system_prompt, parameters, created_at) VALUES
  ('11111111-1111-7111-8111-111111111102', '11111111-1111-7111-8111-111111111110', 1, 'fake', 'deterministic-fake-v1', 'Respond concisely as Atlas. This is public synthetic provenance.', '{}', now()),
  ('11111111-1111-7111-8111-111111111103', '11111111-1111-7111-8111-111111111111', 1, 'fake', 'deterministic-fake-v1', 'Respond concisely as Beacon. This is public synthetic provenance.', '{}', now());

INSERT INTO scenarios (id, name, created_at) VALUES
  ('11111111-1111-7111-8111-111111111112', 'Local opening', now());

INSERT INTO scenario_versions (id, scenario_id, version, opening_message, defaults, created_at) VALUES
  ('11111111-1111-7111-8111-111111111101', '11111111-1111-7111-8111-111111111112', 1, 'What makes a claim reproducible?', '{}', now());
