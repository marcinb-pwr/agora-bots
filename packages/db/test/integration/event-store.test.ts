import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEventStore } from "../../src/index.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("event store", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = createEventStore(pool);
  const id = {
    botA: randomUUID(),
    botB: randomUUID(),
    botVersionA: randomUUID(),
    botVersionB: randomUUID(),
    event: randomUUID(),
    outbox: randomUUID(),
    participantA: randomUUID(),
    participantB: randomUUID(),
    scenario: randomUUID(),
    scenarioVersion: randomUUID(),
    session: randomUUID(),
  };
  const topic = `session.events.${id.session}`;

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO bots (id, name, created_at) VALUES ($1, 'Store A', now()), ($2, 'Store B', now())",
      [id.botA, id.botB],
    );
    await pool.query(
      `INSERT INTO bot_versions (id, bot_id, version, provider, model, system_prompt, created_at)
       VALUES ($1, $2, 1, 'fake', 'a', 'fixture', now()), ($3, $4, 1, 'fake', 'b', 'fixture', now())`,
      [id.botVersionA, id.botA, id.botVersionB, id.botB],
    );
    await pool.query(
      "INSERT INTO scenarios (id, name, created_at) VALUES ($1, 'Store fixture', now())",
      [id.scenario],
    );
    await pool.query(
      "INSERT INTO scenario_versions (id, scenario_id, version, opening_message, defaults, created_at) VALUES ($1, $2, 1, 'Begin.', '{}', now())",
      [id.scenarioVersion, id.scenario],
    );
    await pool.query(
      `INSERT INTO sessions (id, scenario_version_id, message_limit, total_token_limit, duration_limit_ms, cost_limit_microunits, currency, created_at)
       VALUES ($1, $2, 4, 100, 60000, 1000, 'USD', now())`,
      [id.session, id.scenarioVersion],
    );
    await pool.query(
      "INSERT INTO session_participants (id, session_id, position, bot_version_id) VALUES ($1, $2, 0, $3), ($4, $2, 1, $5)",
      [
        id.participantA,
        id.session,
        id.botVersionA,
        id.participantB,
        id.botVersionB,
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("atomically appends and deduplicates event delivery", async () => {
    const first = await store.append({
      event: {
        eventId: id.event,
        eventType: "session.created",
        occurredAt: new Date().toISOString(),
        payload: {},
        schemaVersion: 1,
        sessionId: id.session,
      },
      idempotencyKey: "create",
      outboxId: id.outbox,
      topic,
    });
    const replay = await store.append({
      event: { ...first, eventId: randomUUID() },
      idempotencyKey: "create",
      outboxId: randomUUID(),
      topic,
    });
    expect(first.sequence).toBe(1);
    expect(replay).toEqual(first);
    const counts = await pool.query<{ events: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM canonical_events WHERE session_id = $1)::text AS events,
              (SELECT count(*) FROM outbox WHERE event_id = $2)::text AS outbox`,
      [id.session, id.event],
    );
    expect(counts.rows[0]).toEqual({ events: "1", outbox: "1" });
  });

  it("assigns concurrent appends unique sequences and reads bounded resume pages", async () => {
    const append = (eventId: string, outboxId: string, key: string) =>
      store.append({
        event: {
          eventId,
          eventType: "session.queued",
          occurredAt: new Date().toISOString(),
          payload: {},
          schemaVersion: 1,
          sessionId: id.session,
        },
        idempotencyKey: key,
        outboxId,
        topic,
      });
    const appended = await Promise.all([
      append(randomUUID(), randomUUID(), "queue-a"),
      append(randomUUID(), randomUUID(), "queue-b"),
    ]);

    expect(appended.map(({ sequence }) => sequence).sort()).toEqual([2, 3]);
    const firstPage = await store.listEventsAfter({
      afterSequence: 1,
      limit: 1,
      sessionId: id.session,
    });
    const resumeSequence = firstPage[0]?.sequence;
    if (resumeSequence === undefined)
      throw new Error("expected a resume event");
    const secondPage = await store.listEventsAfter({
      afterSequence: resumeSequence,
      limit: 1,
      sessionId: id.session,
    });
    expect(firstPage.map(({ sequence }) => sequence)).toEqual([2]);
    expect(secondPage.map(({ sequence }) => sequence)).toEqual([3]);
  });

  it("rejects invalid resume bounds before querying", async () => {
    await expect(
      store.listEventsAfter({
        afterSequence: -1,
        limit: 100,
        sessionId: id.session,
      }),
    ).rejects.toThrow(/afterSequence/);
    await expect(
      store.listEventsAfter({
        afterSequence: 0,
        limit: 1_001,
        sessionId: id.session,
      }),
    ).rejects.toThrow(/limit/);
  });

  it("claims outbox work exclusively and acknowledges only the current claim", async () => {
    const now = new Date();
    const firstClaimId = randomUUID();
    const first = await store.claimOutbox({
      claimDurationMs: 1_000,
      claimId: firstClaimId,
      limit: 2,
      now,
      ownerId: "publisher-a",
      topic,
    });
    const second = await store.claimOutbox({
      claimDurationMs: 1_000,
      claimId: randomUUID(),
      limit: 2,
      now,
      ownerId: "publisher-b",
      topic,
    });

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(
      new Set([...first, ...second].map(({ outboxId }) => outboxId)).size,
    ).toBe(3);
    const claimed = first[0];
    if (claimed === undefined) throw new Error("expected claimed outbox work");
    await expect(
      store.markOutboxPublished({
        claimId: randomUUID(),
        outboxId: claimed.outboxId,
        ownerId: "publisher-a",
        publishedAt: now,
      }),
    ).resolves.toBe(false);
    await expect(
      store.markOutboxPublished({
        claimId: firstClaimId,
        outboxId: claimed.outboxId,
        ownerId: "publisher-a",
        publishedAt: now,
      }),
    ).resolves.toBe(true);
    await expect(
      store.markOutboxPublished({
        claimId: firstClaimId,
        outboxId: claimed.outboxId,
        ownerId: "publisher-a",
        publishedAt: now,
      }),
    ).resolves.toBe(false);
  });

  it("allows lease takeover only after expiry", async () => {
    const now = new Date();
    await expect(
      store.acquireLease({
        durationMs: 1_000,
        now,
        ownerId: "worker-a",
        sessionId: id.session,
      }),
    ).resolves.toMatchObject({ ownerId: "worker-a" });
    await expect(
      store.acquireLease({
        durationMs: 1_000,
        now,
        ownerId: "worker-b",
        sessionId: id.session,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.acquireLease({
        durationMs: 1_000,
        now: new Date(now.getTime() + 1_001),
        ownerId: "worker-b",
        sessionId: id.session,
      }),
    ).resolves.toMatchObject({ ownerId: "worker-b" });
    await expect(store.releaseLease(id.session, "worker-a")).resolves.toBe(
      false,
    );
    await expect(store.releaseLease(id.session, "worker-b")).resolves.toBe(
      true,
    );
  });
});
