import {
  parseCanonicalEventV1,
  type CanonicalEventV1,
} from "@agora-bots/contracts";
import type { Pool, PoolClient } from "pg";

export interface AppendEventInput {
  readonly event: Omit<CanonicalEventV1, "sequence">;
  readonly idempotencyKey: string;
  readonly outboxId: string;
  readonly topic: string;
}

export interface Lease {
  readonly expiresAt: string;
  readonly ownerId: string;
  readonly sessionId: string;
}

export interface ClaimedOutboxEvent {
  readonly claimId: string;
  readonly deliveryAttempts: number;
  readonly event: CanonicalEventV1;
  readonly outboxId: string;
  readonly topic: string;
}

export interface EventStore {
  append(input: AppendEventInput): Promise<CanonicalEventV1>;
  acquireLease(input: {
    readonly durationMs: number;
    readonly now: Date;
    readonly ownerId: string;
    readonly sessionId: string;
  }): Promise<Lease | undefined>;
  claimOutbox(input: {
    readonly claimDurationMs: number;
    readonly claimId: string;
    readonly limit: number;
    readonly now: Date;
    readonly ownerId: string;
    readonly topic: string;
  }): Promise<readonly ClaimedOutboxEvent[]>;
  listEventsAfter(input: {
    readonly afterSequence: number;
    readonly limit: number;
    readonly sessionId: string;
  }): Promise<readonly CanonicalEventV1[]>;
  markOutboxPublished(input: {
    readonly claimId: string;
    readonly outboxId: string;
    readonly ownerId: string;
    readonly publishedAt: Date;
  }): Promise<boolean>;
  renewLease(input: {
    readonly durationMs: number;
    readonly now: Date;
    readonly ownerId: string;
    readonly sessionId: string;
  }): Promise<Lease | undefined>;
  releaseOutboxClaim(input: {
    readonly claimId: string;
    readonly outboxId: string;
    readonly ownerId: string;
  }): Promise<boolean>;
  releaseLease(sessionId: string, ownerId: string): Promise<boolean>;
}

export function createEventStore(pool: Pool): EventStore {
  return {
    append: (input) => append(pool, input),
    acquireLease: (input) => acquireLease(pool, input),
    claimOutbox: (input) => claimOutbox(pool, input),
    listEventsAfter: (input) => listEventsAfter(pool, input),
    markOutboxPublished: (input) => markOutboxPublished(pool, input),
    renewLease: (input) => renewLease(pool, input),
    releaseOutboxClaim: async (input) => {
      assertNonEmpty(input.claimId, "claimId");
      assertNonEmpty(input.ownerId, "ownerId");
      const result = await pool.query(
        `UPDATE outbox
         SET claim_id = NULL, claimed_by = NULL, claim_expires_at = NULL
         WHERE id = $1 AND claim_id = $2 AND claimed_by = $3
           AND published_at IS NULL`,
        [input.outboxId, input.claimId, input.ownerId],
      );
      return result.rowCount === 1;
    },
    releaseLease: async (sessionId, ownerId) => {
      const result = await pool.query(
        "DELETE FROM session_leases WHERE session_id = $1 AND owner_id = $2",
        [sessionId, ownerId],
      );
      return result.rowCount === 1;
    },
  };
}

async function claimOutbox(
  pool: Pool,
  input: {
    readonly claimDurationMs: number;
    readonly claimId: string;
    readonly limit: number;
    readonly now: Date;
    readonly ownerId: string;
    readonly topic: string;
  },
): Promise<readonly ClaimedOutboxEvent[]> {
  assertNonEmpty(input.claimId, "claimId");
  assertNonEmpty(input.ownerId, "ownerId");
  assertNonEmpty(input.topic, "topic");
  assertBoundedLimit(input.limit);
  const claimExpiresAt = addDuration(input.now, input.claimDurationMs);
  const result = await pool.query<OutboxEventRow>(
    `WITH candidates AS (
       SELECT id
       FROM outbox
       WHERE published_at IS NULL AND topic = $6
         AND (claim_id IS NULL OR claim_expires_at <= $1)
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     ), claimed AS (
       UPDATE outbox AS o
       SET claim_id = $3, claimed_by = $4, claim_expires_at = $5,
           delivery_attempts = delivery_attempts + 1
       FROM candidates
       WHERE o.id = candidates.id
       RETURNING o.id, o.event_id, o.topic, o.delivery_attempts, o.created_at
     )
     SELECT claimed.id AS outbox_id, claimed.topic, claimed.delivery_attempts,
            e.id, e.session_id, e.sequence::text, e.event_type, e.schema_version,
            e.participant_id, e.occurred_at::text, e.payload
     FROM claimed
     JOIN canonical_events AS e ON e.id = claimed.event_id
     ORDER BY claimed.created_at ASC, claimed.id ASC`,
    [
      input.now.toISOString(),
      input.limit,
      input.claimId,
      input.ownerId,
      claimExpiresAt.toISOString(),
      input.topic,
    ],
  );
  return result.rows.map((row) => ({
    claimId: input.claimId,
    deliveryAttempts: row.delivery_attempts,
    event: eventFromRow(row),
    outboxId: row.outbox_id,
    topic: row.topic,
  }));
}

async function markOutboxPublished(
  pool: Pool,
  input: {
    readonly claimId: string;
    readonly outboxId: string;
    readonly ownerId: string;
    readonly publishedAt: Date;
  },
): Promise<boolean> {
  assertNonEmpty(input.claimId, "claimId");
  assertNonEmpty(input.ownerId, "ownerId");
  assertValidDate(input.publishedAt, "publishedAt");
  const result = await pool.query(
    `UPDATE outbox
     SET published_at = $4, claim_id = NULL, claimed_by = NULL,
         claim_expires_at = NULL
     WHERE id = $1 AND claim_id = $2 AND claimed_by = $3
       AND published_at IS NULL`,
    [
      input.outboxId,
      input.claimId,
      input.ownerId,
      input.publishedAt.toISOString(),
    ],
  );
  return result.rowCount === 1;
}

async function append(
  pool: Pool,
  input: AppendEventInput,
): Promise<CanonicalEventV1> {
  assertNonEmpty(input.idempotencyKey, "idempotencyKey");
  assertNonEmpty(input.topic, "topic");
  const validatedEvent = parseCanonicalEventV1({ ...input.event, sequence: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, validatedEvent.sessionId);
    const replay = await findByIdempotencyKey(
      client,
      validatedEvent.sessionId,
      input.idempotencyKey,
    );
    if (replay !== undefined) {
      await client.query("COMMIT");
      return replay;
    }

    const sequenceResult = await client.query<{ sequence: string }>(
      `SELECT (COALESCE(max(sequence), 0) + 1)::text AS sequence
       FROM canonical_events WHERE session_id = $1`,
      [validatedEvent.sessionId],
    );
    const sequence = Number(sequenceResult.rows[0]?.sequence);
    const event = { ...validatedEvent, sequence };
    await client.query(
      `INSERT INTO canonical_events
        (id, session_id, sequence, idempotency_key, event_type, schema_version,
         participant_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        event.eventId,
        event.sessionId,
        event.sequence,
        input.idempotencyKey,
        event.eventType,
        event.schemaVersion,
        event.participantId ?? null,
        event.occurredAt,
        JSON.stringify(event.payload),
      ],
    );
    await applyEvent(client, event);
    await client.query(
      `INSERT INTO outbox (id, event_id, topic, created_at)
       VALUES ($1, $2, $3, $4)`,
      [input.outboxId, event.eventId, input.topic, event.occurredAt],
    );
    await client.query("COMMIT");
    return event;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyEvent(
  client: PoolClient,
  event: CanonicalEventV1,
): Promise<void> {
  if (event.eventType === "session.started") {
    const result = await client.query(
      `UPDATE sessions SET status = 'running', started_at = $2
       WHERE id = $1 AND status = 'queued'`,
      [event.sessionId, event.occurredAt],
    );
    if (result.rowCount !== 1) throw new Error("Session cannot be started");
    return;
  }
  if (event.eventType === "message.completed") {
    const messageId = payloadString(event, "messageId");
    const turn = payloadInteger(event, "turn");
    const partial = event.payload.partial === true;
    if (event.participantId === undefined)
      throw new Error("Completed message requires a participant");
    await client.query(
      `INSERT INTO messages
         (id, session_id, participant_id, ordinal, content, partial, source_event_id,
          input_tokens, output_tokens, cost_microunits, finish_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        messageId,
        event.sessionId,
        event.participantId,
        turn,
        payloadString(event, "content"),
        partial,
        event.eventId,
        payloadInteger(event, "inputTokens"),
        payloadInteger(event, "outputTokens"),
        payloadInteger(event, "costMicrounits"),
        payloadString(event, "finishReason"),
      ],
    );
    await client.query(
      `INSERT INTO message_chunks
         (id, message_id, chunk_index, text, start_offset, end_offset, source_event_id)
       SELECT id, $1, (payload->>'chunkIndex')::integer, payload->>'text',
              (payload->>'startOffset')::integer, (payload->>'endOffset')::integer, id
       FROM canonical_events
       WHERE session_id = $2 AND event_type = 'message.chunk.appended'
         AND payload->>'messageId' = $1
       ORDER BY sequence`,
      [messageId, event.sessionId],
    );
    if (!partial) {
      const result = await client.query(
        `UPDATE sessions
         SET message_count = message_count + 1,
             input_tokens = input_tokens + $2,
             output_tokens = output_tokens + $3,
             cost_microunits = cost_microunits + $4,
             next_participant_index = CASE next_participant_index WHEN 0 THEN 1 ELSE 0 END
         WHERE id = $1 AND status = 'running'`,
        [
          event.sessionId,
          payloadInteger(event, "inputTokens"),
          payloadInteger(event, "outputTokens"),
          payloadInteger(event, "costMicrounits"),
        ],
      );
      if (result.rowCount !== 1)
        throw new Error("Turn cannot be committed to a non-running session");
    }
    return;
  }
  const terminal = terminalState(event);
  if (terminal !== undefined) {
    const result = await client.query(
      `UPDATE sessions SET status = $2, stop_reason = $3, ended_at = $4
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [event.sessionId, terminal.status, terminal.reason, event.occurredAt],
    );
    if (result.rowCount !== 1) throw new Error("Session is already terminal");
  }
}

function terminalState(
  event: CanonicalEventV1,
): { readonly reason: string; readonly status: string } | undefined {
  if (event.eventType === "session.limit_reached")
    return {
      reason: payloadString(event, "stopReason"),
      status: "limit_reached",
    };
  if (event.eventType === "session.failed")
    return { reason: "provider_error", status: "failed" };
  if (event.eventType === "session.completed")
    return { reason: "conversation_completed", status: "completed" };
  if (event.eventType === "session.cancelled")
    return { reason: "cancelled_by_user", status: "cancelled" };
  return undefined;
}

function payloadString(event: CanonicalEventV1, key: string): string {
  const value = event.payload[key];
  if (typeof value !== "string")
    throw new Error(`Event payload ${key} is invalid`);
  return value;
}

function payloadInteger(event: CanonicalEventV1, key: string): number {
  const value = event.payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Event payload ${key} is invalid`);
  return value as number;
}

async function listEventsAfter(
  pool: Pool,
  input: {
    readonly afterSequence: number;
    readonly limit: number;
    readonly sessionId: string;
  },
): Promise<readonly CanonicalEventV1[]> {
  assertNonEmpty(input.sessionId, "sessionId");
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0)
    throw new TypeError("afterSequence must be a non-negative safe integer");
  assertBoundedLimit(input.limit);
  const result = await pool.query<EventRow>(
    `SELECT id, session_id, sequence::text, event_type, schema_version,
            participant_id, occurred_at::text, payload
     FROM canonical_events
     WHERE session_id = $1 AND sequence > $2
     ORDER BY sequence ASC
     LIMIT $3`,
    [input.sessionId, input.afterSequence, input.limit],
  );
  return result.rows.map(eventFromRow);
}

async function lockSession(
  client: PoolClient,
  sessionId: string,
): Promise<void> {
  const result = await client.query(
    "SELECT id FROM sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  if (result.rowCount !== 1) throw new Error("Session does not exist");
}

async function findByIdempotencyKey(
  client: PoolClient,
  sessionId: string,
  idempotencyKey: string,
): Promise<CanonicalEventV1 | undefined> {
  const result = await client.query<EventRow>(
    `SELECT id, session_id, sequence::text, event_type, schema_version,
            participant_id, occurred_at::text, payload
     FROM canonical_events
     WHERE session_id = $1 AND idempotency_key = $2`,
    [sessionId, idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : eventFromRow(row);
}

async function acquireLease(
  pool: Pool,
  input: {
    readonly durationMs: number;
    readonly now: Date;
    readonly ownerId: string;
    readonly sessionId: string;
  },
): Promise<Lease | undefined> {
  assertNonEmpty(input.ownerId, "ownerId");
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0)
    throw new TypeError("durationMs must be a positive safe integer");
  if (!Number.isFinite(input.now.getTime()))
    throw new TypeError("now must be valid");
  const expiresAt = new Date(input.now.getTime() + input.durationMs);
  if (!Number.isFinite(expiresAt.getTime()))
    throw new TypeError("lease expiry must be valid");
  const result = await pool.query<{
    expires_at: string;
    owner_id: string;
    session_id: string;
  }>(
    `INSERT INTO session_leases (session_id, owner_id, expires_at, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at
       WHERE session_leases.owner_id = EXCLUDED.owner_id
          OR session_leases.expires_at <= EXCLUDED.updated_at
     RETURNING session_id, owner_id, expires_at::text`,
    [
      input.sessionId,
      input.ownerId,
      expiresAt.toISOString(),
      input.now.toISOString(),
    ],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        expiresAt: new Date(row.expires_at).toISOString(),
        ownerId: row.owner_id,
        sessionId: row.session_id,
      };
}

async function renewLease(
  pool: Pool,
  input: {
    readonly durationMs: number;
    readonly now: Date;
    readonly ownerId: string;
    readonly sessionId: string;
  },
): Promise<Lease | undefined> {
  assertNonEmpty(input.ownerId, "ownerId");
  assertNonEmpty(input.sessionId, "sessionId");
  const expiresAt = addDuration(input.now, input.durationMs, "leaseDurationMs");
  const result = await pool.query<{
    expires_at: string;
    owner_id: string;
    session_id: string;
  }>(
    `UPDATE session_leases
     SET expires_at = $4, updated_at = $3
     WHERE session_id = $1 AND owner_id = $2 AND expires_at > $3
     RETURNING session_id, owner_id, expires_at::text`,
    [
      input.sessionId,
      input.ownerId,
      input.now.toISOString(),
      expiresAt.toISOString(),
    ],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        expiresAt: new Date(row.expires_at).toISOString(),
        ownerId: row.owner_id,
        sessionId: row.session_id,
      };
}

interface EventRow {
  readonly event_type: string;
  readonly id: string;
  readonly occurred_at: string;
  readonly participant_id: string | null;
  readonly payload: unknown;
  readonly schema_version: number;
  readonly sequence: string;
  readonly session_id: string;
}

interface OutboxEventRow extends EventRow {
  readonly delivery_attempts: number;
  readonly outbox_id: string;
  readonly topic: string;
}

function eventFromRow(row: EventRow): CanonicalEventV1 {
  return parseCanonicalEventV1({
    eventId: row.id,
    eventType: row.event_type,
    occurredAt: new Date(row.occurred_at).toISOString(),
    ...(row.participant_id === null
      ? {}
      : { participantId: row.participant_id }),
    payload: row.payload,
    schemaVersion: row.schema_version,
    sequence: Number(row.sequence),
    sessionId: row.session_id,
  });
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
}

function assertBoundedLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw new TypeError("limit must be a safe integer between 1 and 1000");
}

function assertValidDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime()))
    throw new TypeError(`${name} must be valid`);
}

function addDuration(
  now: Date,
  durationMs: number,
  durationName = "claimDurationMs",
): Date {
  assertValidDate(now, "now");
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
    throw new TypeError(`${durationName} must be a positive safe integer`);
  const result = new Date(now.getTime() + durationMs);
  assertValidDate(result, "claim expiry");
  return result;
}
