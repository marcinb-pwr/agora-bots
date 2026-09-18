import {
  parseCanonicalEventV1,
  type CanonicalEventV1,
  type CreateSessionRequest,
  type SessionResource,
} from "@agora-bots/contracts";
import type { Pool, PoolClient } from "pg";

export interface SessionStore {
  cancel(sessionId: string, now: Date): Promise<SessionResource | undefined>;
  create(request: CreateSessionRequest, now: Date): Promise<SessionResource>;
  get(sessionId: string): Promise<SessionResource | undefined>;
  listRunnable(limit: number): Promise<readonly string[]>;
  rebuildTranscript(sessionId: string, now: Date): Promise<void>;
}

export function createSessionStore(
  pool: Pool,
  idForKey: (key: string) => string,
): SessionStore {
  return {
    cancel: (sessionId, now) => cancel(pool, idForKey, sessionId, now),
    create: (request, now) => create(pool, idForKey, request, now),
    get: (sessionId) => get(pool, sessionId),
    listRunnable: async (limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError("limit must be between 1 and 100");
      const result = await pool.query<{ id: string }>(
        "SELECT id FROM sessions WHERE status IN ('queued','running') ORDER BY created_at,id LIMIT $1",
        [limit],
      );
      return result.rows.map(({ id }) => id);
    },
    rebuildTranscript: (sessionId, now) =>
      rebuildTranscript(pool, sessionId, now),
  };
}

async function create(
  pool: Pool,
  idForKey: (key: string) => string,
  request: CreateSessionRequest,
  now: Date,
): Promise<SessionResource> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = await client.query<{ session_id: string }>(
      "SELECT session_id FROM session_requests WHERE idempotency_key = $1",
      [request.idempotencyKey],
    );
    if (replay.rows[0] !== undefined) {
      await client.query("COMMIT");
      const session = await get(pool, replay.rows[0].session_id);
      if (session === undefined)
        throw new Error("idempotent session disappeared");
      return session;
    }
    const versions = await client.query<{
      id: string;
      model: string;
      provider: string;
      system_prompt: string;
    }>(
      "SELECT id, model, provider, system_prompt FROM bot_versions WHERE id = ANY($1::uuid[])",
      [request.botVersionIds],
    );
    const byId = new Map(versions.rows.map((row) => [row.id, row]));
    const firstBot = byId.get(request.botVersionIds[0]);
    const secondBot = byId.get(request.botVersionIds[1]);
    if (firstBot === undefined || secondBot === undefined)
      throw new SessionStoreError(
        "not_found",
        "A selected bot version does not exist",
      );
    const scenario = await client.query<{ opening_message: string }>(
      "SELECT opening_message FROM scenario_versions WHERE id = $1",
      [request.scenarioVersionId],
    );
    if (scenario.rows[0] === undefined)
      throw new SessionStoreError(
        "not_found",
        "The selected scenario version does not exist",
      );
    const sessionId = idForKey(`request:${request.idempotencyKey}:session`);
    const participantIds = [
      idForKey(`${sessionId}:participant:0`),
      idForKey(`${sessionId}:participant:1`),
    ] as const;
    await client.query(
      `INSERT INTO sessions (id, scenario_version_id, status, message_limit, total_token_limit, duration_limit_ms, cost_limit_microunits, currency, created_at, queued_at) VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $8)`,
      [
        sessionId,
        request.scenarioVersionId,
        request.limits.messageLimit,
        request.limits.totalTokenLimit,
        request.limits.durationLimitMs,
        request.limits.costLimitMicrounits,
        request.limits.currency,
        now.toISOString(),
      ],
    );
    await client.query(
      "INSERT INTO session_participants (id, session_id, position, bot_version_id) VALUES ($1, $2, 0, $3), ($4, $2, 1, $5)",
      [
        participantIds[0],
        sessionId,
        request.botVersionIds[0],
        participantIds[1],
        request.botVersionIds[1],
      ],
    );
    await client.query(
      "INSERT INTO session_requests (idempotency_key, session_id, created_at) VALUES ($1, $2, $3)",
      [request.idempotencyKey, sessionId, now.toISOString()],
    );
    const payload = {
      botVersions: [firstBot, secondBot].map((bot) => ({
        model: bot.model,
        provider: bot.provider,
        systemPrompt: bot.system_prompt,
      })),
      limits: request.limits,
      openingMessage: scenario.rows[0].opening_message,
      participantIds,
    };
    await insertEvent(
      client,
      idForKey,
      sessionId,
      1,
      "session.created",
      now,
      payload as unknown as CanonicalEventV1["payload"],
      "create",
    );
    await insertEvent(
      client,
      idForKey,
      sessionId,
      2,
      "session.queued",
      now,
      {},
      "queue",
    );
    await client.query("COMMIT");
    return {
      createdAt: now.toISOString(),
      id: sessionId,
      limits: request.limits,
      participantIds,
      status: "queued",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cancel(
  pool: Pool,
  idForKey: (key: string) => string,
  sessionId: string,
  now: Date,
): Promise<SessionResource | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: string }>(
      "SELECT status FROM sessions WHERE id = $1 FOR UPDATE",
      [sessionId],
    );
    const status = locked.rows[0]?.status;
    if (status === undefined) {
      await client.query("ROLLBACK");
      return undefined;
    }
    if (status === "queued" || status === "running") {
      await client.query(
        "UPDATE sessions SET status = 'cancelled', stop_reason = 'cancelled_by_user', ended_at = $2 WHERE id = $1",
        [sessionId, now.toISOString()],
      );
      const sequence = await nextSequence(client, sessionId);
      await insertEvent(
        client,
        idForKey,
        sessionId,
        sequence,
        "session.cancelled",
        now,
        { stopReason: "cancelled_by_user" },
        "cancel",
      );
    }
    await client.query("COMMIT");
    return await get(pool, sessionId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function get(
  pool: Pool,
  sessionId: string,
): Promise<SessionResource | undefined> {
  const result = await pool.query<{
    cost_limit_microunits: string;
    created_at: string;
    currency: string;
    duration_limit_ms: string;
    id: string;
    message_limit: number;
    participant_ids: string[];
    status: SessionResource["status"];
    stop_reason: string | null;
    total_token_limit: string;
  }>(
    `SELECT s.id, s.status, s.stop_reason, s.created_at::text, s.message_limit, s.total_token_limit::text, s.duration_limit_ms::text, s.cost_limit_microunits::text, s.currency, array_agg(p.id ORDER BY p.position) AS participant_ids FROM sessions s JOIN session_participants p ON p.session_id = s.id WHERE s.id = $1 GROUP BY s.id`,
    [sessionId],
  );
  const row = result.rows[0];
  if (row?.participant_ids.length !== 2) return undefined;
  return {
    createdAt: new Date(row.created_at).toISOString(),
    id: row.id,
    limits: {
      costLimitMicrounits: Number(row.cost_limit_microunits),
      currency: row.currency,
      durationLimitMs: Number(row.duration_limit_ms),
      messageLimit: row.message_limit,
      totalTokenLimit: Number(row.total_token_limit),
    },
    participantIds: row.participant_ids as unknown as readonly [string, string],
    status: row.status,
    ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
  };
}

async function rebuildTranscript(
  pool: Pool,
  sessionId: string,
  now: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
      sessionId,
    ]);
    await client.query(
      "DELETE FROM message_chunks WHERE message_id IN (SELECT id FROM messages WHERE session_id = $1)",
      [sessionId],
    );
    await client.query("DELETE FROM messages WHERE session_id = $1", [
      sessionId,
    ]);
    await client.query(
      `INSERT INTO messages (id, session_id, participant_id, ordinal, content, partial, source_event_id, input_tokens, output_tokens, cost_microunits, finish_reason) SELECT (payload->>'messageId')::uuid, session_id, participant_id, (payload->>'turn')::integer, payload->>'content', (payload->>'partial')::boolean, id, (payload->>'inputTokens')::bigint, (payload->>'outputTokens')::bigint, (payload->>'costMicrounits')::bigint, payload->>'finishReason' FROM canonical_events WHERE session_id = $1 AND event_type = 'message.completed' ORDER BY sequence`,
      [sessionId],
    );
    await client.query(
      `INSERT INTO message_chunks (id, message_id, chunk_index, text, start_offset, end_offset, source_event_id) SELECT id, (payload->>'messageId')::uuid, (payload->>'chunkIndex')::integer, payload->>'text', (payload->>'startOffset')::integer, (payload->>'endOffset')::integer, id FROM canonical_events WHERE session_id = $1 AND event_type = 'message.chunk.appended' ORDER BY sequence`,
      [sessionId],
    );
    await client.query(
      "INSERT INTO projection_versions (session_id, projection, version, rebuilt_at) VALUES ($1, 'transcript', 1, $2) ON CONFLICT (session_id, projection) DO UPDATE SET version = EXCLUDED.version, rebuilt_at = EXCLUDED.rebuilt_at",
      [sessionId, now.toISOString()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertEvent(
  client: PoolClient,
  idForKey: (key: string) => string,
  sessionId: string,
  sequence: number,
  eventType: CanonicalEventV1["eventType"],
  now: Date,
  payload: CanonicalEventV1["payload"],
  key: string,
): Promise<void> {
  const event = parseCanonicalEventV1({
    eventId: idForKey(`${sessionId}:event:${key}`),
    eventType,
    occurredAt: now.toISOString(),
    payload,
    schemaVersion: 1,
    sequence,
    sessionId,
  });
  const outboxId = idForKey(`${sessionId}:outbox:${key}`);
  await client.query(
    "INSERT INTO canonical_events (id, session_id, sequence, idempotency_key, event_type, schema_version, occurred_at, payload) VALUES ($1,$2,$3,$4,$5,1,$6,$7::jsonb)",
    [
      event.eventId,
      sessionId,
      sequence,
      key,
      eventType,
      event.occurredAt,
      JSON.stringify(payload),
    ],
  );
  await client.query(
    "INSERT INTO outbox (id, event_id, topic, created_at) VALUES ($1,$2,$3,$4)",
    [outboxId, event.eventId, `session.events.${sessionId}`, event.occurredAt],
  );
}
async function nextSequence(
  client: PoolClient,
  sessionId: string,
): Promise<number> {
  const result = await client.query<{ sequence: string }>(
    "SELECT (COALESCE(max(sequence), 0) + 1)::text AS sequence FROM canonical_events WHERE session_id = $1",
    [sessionId],
  );
  return Number(result.rows[0]?.sequence);
}

export class SessionStoreError extends Error {
  public constructor(
    readonly code: "conflict" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}
