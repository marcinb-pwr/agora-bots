import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { describe, expect, it } from "vitest";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("database migrations", () => {
  it("apply idempotently and record immutable checksums", async () => {
    const migrationScript = fileURLToPath(
      new URL("../../scripts/migrate.mjs", import.meta.url),
    );
    execFileSync(process.execPath, [migrationScript], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    execFileSync(process.execPath, [migrationScript], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const migrations = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM schema_migrations WHERE name = $1",
        ["0001-enable-required-extensions.sql"],
      );
      const extensions = await client.query<{ installed: boolean }>(
        "SELECT EXISTS (SELECT FROM pg_extension WHERE extname = 'vector') AS installed",
      );
      expect(migrations.rows[0]?.count).toBe("1");
      expect(extensions.rows[0]?.installed).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("enforces version immutability, event ordering, and idempotency", async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
    try {
      await insertCatalogAndSession(client);
      await client.query(
        `INSERT INTO canonical_events
          (id, session_id, sequence, idempotency_key, event_type, schema_version, occurred_at, payload)
         VALUES ($1, $2, 1, 'create-session', 'session.created', 1, now(), '{}')`,
        [ids.event, ids.session],
      );

      await expectConstraintFailure(client, () =>
        client.query(
          `INSERT INTO canonical_events
            (id, session_id, sequence, idempotency_key, event_type, schema_version, occurred_at, payload)
           VALUES ($1, $2, 1, 'different-key', 'session.queued', 1, now(), '{}')`,
          [ids.secondEvent, ids.session],
        ),
      );
      await expectConstraintFailure(client, () =>
        client.query(
          "UPDATE canonical_events SET payload = '{\"changed\":true}' WHERE id = $1",
          [ids.event],
        ),
      );
      await expectConstraintFailure(client, () =>
        client.query(
          "UPDATE bot_versions SET model = 'changed' WHERE id = $1",
          [ids.botVersionA],
        ),
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  it("requires two distinct participants before a session leaves created", async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query("BEGIN");
    try {
      await insertCatalogAndSession(client, false);
      await client.query("SAVEPOINT participant_check");
      await expect(
        client
          .query(
            "UPDATE sessions SET status = 'queued', queued_at = now() WHERE id = $1",
            [ids.session],
          )
          .then(() => client.query("SET CONSTRAINTS ALL IMMEDIATE")),
      ).rejects.toThrow(/exactly two participants/);
      await client.query("ROLLBACK TO SAVEPOINT participant_check");
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});

const ids = {
  botA: "00000000-0000-7000-8000-000000000001",
  botB: "00000000-0000-7000-8000-000000000002",
  botVersionA: "00000000-0000-7000-8000-000000000003",
  botVersionB: "00000000-0000-7000-8000-000000000004",
  event: "00000000-0000-7000-8000-000000000005",
  participantA: "00000000-0000-7000-8000-000000000006",
  participantB: "00000000-0000-7000-8000-000000000007",
  scenario: "00000000-0000-7000-8000-000000000008",
  scenarioVersion: "00000000-0000-7000-8000-000000000009",
  secondEvent: "00000000-0000-7000-8000-000000000010",
  session: "00000000-0000-7000-8000-000000000011",
} as const;

interface QueryClient {
  query(query: string, values?: unknown[]): Promise<unknown>;
}

async function insertCatalogAndSession(
  client: QueryClient,
  includeParticipants = true,
): Promise<void> {
  await client.query(
    "INSERT INTO bots (id, name, created_at) VALUES ($1, 'A', now()), ($2, 'B', now())",
    [ids.botA, ids.botB],
  );
  await client.query(
    `INSERT INTO bot_versions
      (id, bot_id, version, provider, model, system_prompt, created_at)
     VALUES ($1, $2, 1, 'fake', 'fake-a', 'safe fixture', now()),
            ($3, $4, 1, 'fake', 'fake-b', 'safe fixture', now())`,
    [ids.botVersionA, ids.botA, ids.botVersionB, ids.botB],
  );
  await client.query(
    "INSERT INTO scenarios (id, name, created_at) VALUES ($1, 'Fixture', now())",
    [ids.scenario],
  );
  await client.query(
    `INSERT INTO scenario_versions (id, scenario_id, version, opening_message, defaults, created_at)
     VALUES ($1, $2, 1, 'Begin.', '{}', now())`,
    [ids.scenarioVersion, ids.scenario],
  );
  await client.query(
    `INSERT INTO sessions
      (id, scenario_version_id, message_limit, total_token_limit, duration_limit_ms,
       cost_limit_microunits, currency, created_at)
     VALUES ($1, $2, 4, 100, 60000, 1000, 'USD', now())`,
    [ids.session, ids.scenarioVersion],
  );
  if (includeParticipants) {
    await client.query(
      `INSERT INTO session_participants (id, session_id, position, bot_version_id)
       VALUES ($1, $2, 0, $3), ($4, $2, 1, $5)`,
      [
        ids.participantA,
        ids.session,
        ids.botVersionA,
        ids.participantB,
        ids.botVersionB,
      ],
    );
  }
}

async function expectConstraintFailure(
  client: QueryClient,
  action: () => Promise<unknown>,
): Promise<void> {
  await client.query("SAVEPOINT expected_failure");
  await expect(action()).rejects.toThrow();
  await client.query("ROLLBACK TO SAVEPOINT expected_failure");
}
