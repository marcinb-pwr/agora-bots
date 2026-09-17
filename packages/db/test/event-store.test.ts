import { describe, expect, it } from "vitest";

import { createEventStore } from "../src/index.js";

describe("event store input boundaries", () => {
  it("rejects an invalid event before opening a transaction", async () => {
    let connected = false;
    const store = createEventStore({
      connect: () => {
        connected = true;
        return Promise.reject(new Error("unexpected connection"));
      },
    } as unknown as Parameters<typeof createEventStore>[0]);

    await expect(
      store.append({
        event: {
          eventId: "event-id",
          eventType: "message.completed",
          occurredAt: "not-a-timestamp",
          payload: {},
          schemaVersion: 1,
          sessionId: "session-id",
        },
        idempotencyKey: "complete-turn",
        outboxId: "outbox-id",
        topic: "session.events",
      }),
    ).rejects.toThrow(/Invalid canonical event/);
    expect(connected).toBe(false);
  });

  it("rejects unbounded event reads before querying", async () => {
    let queried = false;
    const store = createEventStore({
      query: () => {
        queried = true;
        return Promise.reject(new Error("unexpected query"));
      },
    } as unknown as Parameters<typeof createEventStore>[0]);

    await expect(
      store.listEventsAfter({
        afterSequence: 0,
        limit: 1_001,
        sessionId: "session-id",
      }),
    ).rejects.toThrow(/limit/);
    expect(queried).toBe(false);
  });

  it("rejects invalid outbox claim bounds before querying", async () => {
    let queried = false;
    const store = createEventStore({
      query: () => {
        queried = true;
        return Promise.reject(new Error("unexpected query"));
      },
    } as unknown as Parameters<typeof createEventStore>[0]);

    await expect(
      store.claimOutbox({
        claimDurationMs: 0,
        claimId: "claim-id",
        limit: 10,
        now: new Date("2026-01-01T00:00:00.000Z"),
        ownerId: "worker-a",
        topic: "session.events",
      }),
    ).rejects.toThrow(/claimDurationMs/);
    expect(queried).toBe(false);
  });

  it("rejects invalid lease renewal input before querying", async () => {
    let queried = false;
    const store = createEventStore({
      query: () => {
        queried = true;
        return Promise.reject(new Error("unexpected query"));
      },
    } as unknown as Parameters<typeof createEventStore>[0]);

    await expect(
      store.renewLease({
        durationMs: 0,
        now: new Date("2026-01-01T00:00:00.000Z"),
        ownerId: "worker-a",
        sessionId: "session-id",
      }),
    ).rejects.toThrow(/leaseDurationMs/);
    expect(queried).toBe(false);
  });
});
