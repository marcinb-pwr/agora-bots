import { describe, expect, it, vi } from "vitest";
import { createApi, encodeSseEvent } from "../src/index.js";

const session = {
  createdAt: "2026-09-18T00:00:00.000Z",
  id: "session-1",
  limits: {
    costLimitMicrounits: 100,
    currency: "USD",
    durationLimitMs: 1_000,
    messageLimit: 2,
    totalTokenLimit: 20,
  },
  participantIds: ["a", "b"] as const,
  status: "queued" as const,
};

describe("session API", () => {
  it("validates, creates, and enqueues a bounded session", async () => {
    const create = vi.fn().mockResolvedValue(session);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const app = createApi({
      clock: { now: () => new Date(session.createdAt) },
      enqueue,
      events: { listEventsAfter: vi.fn().mockResolvedValue([]) },
      sessions: { cancel: vi.fn(), create, get: vi.fn() },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        botVersionIds: ["bot-a", "bot-b"],
        idempotencyKey: "request-1",
        limits: session.limits,
        scenarioVersionId: "scenario",
      },
    });
    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith("session-1");
    expect(response.headers.location).toBe("/v1/sessions/session-1");
    await app.close();
  });
  it("returns a sanitized validation error", async () => {
    const app = createApi({
      clock: { now: () => new Date() },
      enqueue: vi.fn(),
      events: { listEventsAfter: vi.fn() },
      sessions: { cancel: vi.fn(), create: vi.fn(), get: vi.fn() },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { prompt: "unbounded" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    await app.close();
  });
  it("encodes durable sequence IDs without rendering HTML", () => {
    const output = encodeSseEvent({
      eventId: "event",
      eventType: "session.started",
      occurredAt: session.createdAt,
      payload: { text: "<script>" },
      schemaVersion: 1,
      sequence: 7,
      sessionId: session.id,
    });
    expect(output).toContain("id: 7\n");
    expect(output).toContain('"text":"<script>"');
  });
});
