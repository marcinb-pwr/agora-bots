import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEventStore, createSessionStore } from "../../src/index.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "session commands and projections",
  () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const sessions = createSessionStore(pool, stableId);
    const events = createEventStore(pool);
    const ids = {
      botA: randomUUID(),
      botB: randomUUID(),
      botVersionA: randomUUID(),
      botVersionB: randomUUID(),
      scenario: randomUUID(),
      scenarioVersion: randomUUID(),
    };

    beforeAll(async () => {
      await pool.query(
        "INSERT INTO bots (id,name,created_at) VALUES ($1,'Command A',now()),($2,'Command B',now())",
        [ids.botA, ids.botB],
      );
      await pool.query(
        "INSERT INTO bot_versions (id,bot_id,version,provider,model,system_prompt,created_at) VALUES ($1,$2,1,'fake','a','A',now()),($3,$4,1,'fake','b','B',now())",
        [ids.botVersionA, ids.botA, ids.botVersionB, ids.botB],
      );
      await pool.query(
        "INSERT INTO scenarios (id,name,created_at) VALUES ($1,'Command scenario',now())",
        [ids.scenario],
      );
      await pool.query(
        "INSERT INTO scenario_versions (id,scenario_id,version,opening_message,defaults,created_at) VALUES ($1,$2,1,'Begin.','{}',now())",
        [ids.scenarioVersion, ids.scenario],
      );
    });
    afterAll(async () => pool.end());

    it("creates idempotently, advances state with events, and rebuilds exact projections", async () => {
      const now = new Date();
      const request = {
        botVersionIds: [ids.botVersionA, ids.botVersionB] as const,
        idempotencyKey: randomUUID(),
        limits: {
          costLimitMicrounits: 100,
          currency: "USD",
          durationLimitMs: 60_000,
          messageLimit: 1,
          totalTokenLimit: 100,
        },
        scenarioVersionId: ids.scenarioVersion,
      };
      const created = await sessions.create(request, now);
      expect(await sessions.create(request, now)).toEqual(created);
      const append = (
        type:
          | "message.chunk.appended"
          | "message.completed"
          | "session.limit_reached"
          | "session.started",
        key: string,
        payload: Record<string, boolean | number | string>,
        participantId?: string,
      ) =>
        events.append({
          event: {
            eventId: stableId(`${created.id}:event:${key}`),
            eventType: type,
            occurredAt: now.toISOString(),
            ...(participantId === undefined ? {} : { participantId }),
            payload,
            schemaVersion: 1,
            sessionId: created.id,
          },
          idempotencyKey: key,
          outboxId: stableId(`${created.id}:outbox:${key}`),
          topic: `session.events.${created.id}`,
        });
      await append("session.started", "start", {});
      const messageId = stableId(`${created.id}:message`);
      await append(
        "message.chunk.appended",
        "chunk",
        {
          chunkIndex: 0,
          endOffset: 5,
          messageId,
          startOffset: 0,
          text: "Hello",
        },
        created.participantIds[0],
      );
      await append(
        "message.completed",
        "complete",
        {
          content: "Hello",
          costMicrounits: 5,
          finishReason: "stop",
          inputTokens: 2,
          messageId,
          outputTokens: 1,
          partial: false,
          turn: 1,
        },
        created.participantIds[0],
      );
      await append("session.limit_reached", "terminal", {
        stopReason: "message_limit",
      });
      await sessions.rebuildTranscript(created.id, now);
      await sessions.rebuildTranscript(created.id, now);
      await expect(sessions.get(created.id)).resolves.toMatchObject({
        status: "limit_reached",
        stopReason: "message_limit",
      });
      const projection = await pool.query(
        "SELECT m.content, c.text FROM messages m JOIN message_chunks c ON c.message_id=m.id WHERE m.session_id=$1",
        [created.id],
      );
      expect(projection.rows).toEqual([{ content: "Hello", text: "Hello" }]);
    });
  },
);

function stableId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
