import { createHash } from "node:crypto";
import type { CanonicalEventV1 } from "@agora-bots/contracts";
import {
  FakeProvider,
  ProviderError,
  type CompletionEvent,
  type ProviderAdapter,
} from "@agora-bots/providers";
import { describe, expect, it } from "vitest";
import { DurableSessionRunner } from "../src/index.js";

class MemoryStore {
  public events: CanonicalEventV1[];
  private owner: string | undefined;
  public constructor(events: CanonicalEventV1[]) {
    this.events = events;
  }
  public append(input: {
    event: Omit<CanonicalEventV1, "sequence">;
    idempotencyKey: string;
  }): Promise<CanonicalEventV1> {
    const replay = this.events.find(
      (event) => event.payload.idempotencyKey === input.idempotencyKey,
    );
    if (replay !== undefined) return Promise.resolve(replay);
    const event = {
      ...input.event,
      payload: { ...input.event.payload, idempotencyKey: input.idempotencyKey },
      sequence: this.events.length + 1,
    };
    this.events.push(event);
    return Promise.resolve(event);
  }
  public listEventsAfter(input: {
    afterSequence: number;
  }): Promise<readonly CanonicalEventV1[]> {
    return Promise.resolve(
      this.events.filter((event) => event.sequence > input.afterSequence),
    );
  }
  public acquireLease(input: { ownerId: string }): Promise<object | undefined> {
    if (this.owner !== undefined) return Promise.resolve(undefined);
    this.owner = input.ownerId;
    return Promise.resolve({});
  }
  public renewLease(input: { ownerId: string }): Promise<object | undefined> {
    return Promise.resolve(this.owner === input.ownerId ? {} : undefined);
  }
  public releaseLease(_sessionId: string, ownerId: string): Promise<boolean> {
    if (this.owner !== ownerId) return Promise.resolve(false);
    this.owner = undefined;
    return Promise.resolve(true);
  }
}

const at = "2026-09-18T00:00:00.000Z";
const sessionId = stableId("session");
const participants = [
  stableId("participant-a"),
  stableId("participant-b"),
] as const;
const creationPayload = {
  botVersions: [
    { model: "fake-a", provider: "fake", systemPrompt: "A" },
    { model: "fake-b", provider: "fake", systemPrompt: "B" },
  ],
  limits: {
    costLimitMicrounits: 100,
    currency: "USD",
    durationLimitMs: 60_000,
    messageLimit: 2,
    totalTokenLimit: 100,
  },
  openingMessage: "Begin.",
  participantIds: participants,
};

describe("durable session runner", () => {
  it("alternates two turns, stops at the limit, and makes redelivery a no-op", async () => {
    const store = new MemoryStore([
      initial("session.created", 1, creationPayload),
      initial("session.queued", 2, {}),
    ]);
    let calls = 0;
    const fake = new FakeProvider({
      chunks: ["Hello", " world"],
      costMicrounits: 5,
      inputTokens: 2,
      outputTokens: 2,
    });
    const provider: ProviderAdapter = {
      streamCompletion(request) {
        calls += 1;
        return fake.streamCompletion(request);
      },
    };
    const runner = makeRunner(store, provider);
    await expect(runner.run(sessionId)).resolves.toBe("terminal");
    expect(
      store.events
        .filter((event) => event.eventType === "message.completed")
        .map((event) => event.participantId),
    ).toEqual(participants);
    expect(store.events.at(-1)).toMatchObject({
      eventType: "session.limit_reached",
      payload: { stopReason: "message_limit" },
    });
    await expect(runner.run(sessionId)).resolves.toBe("terminal");
    expect(calls).toBe(2);
  });

  it("retries a safe failure before any output", async () => {
    let calls = 0;
    const provider: ProviderAdapter = {
      streamCompletion(): AsyncIterable<CompletionEvent> {
        calls += 1;
        if (calls === 1) throw new ProviderError("retryable", "busy");
        return successfulEvents();
      },
    };
    const limits = { ...creationPayload.limits, messageLimit: 1 };
    const store = new MemoryStore([
      initial("session.created", 1, { ...creationPayload, limits }),
      initial("session.queued", 2, {}),
    ]);
    await makeRunner(store, provider).run(sessionId);
    expect(calls).toBe(2);
    expect(
      store.events.some(
        (event) =>
          event.eventType === "provider.attempt.failed" &&
          event.payload.retryable === true,
      ),
    ).toBe(true);
  });

  it("marks committed orphan chunks partial instead of repeating an ambiguous call", async () => {
    const store = new MemoryStore([
      initial("session.created", 1, creationPayload),
      initial("session.queued", 2, {}),
      initial("session.started", 3, {}),
      {
        ...initial("message.chunk.appended", 4, {
          chunkIndex: 0,
          endOffset: 4,
          messageId: stableId("message"),
          startOffset: 0,
          text: "half",
        }),
        participantId: participants[0],
      },
    ]);
    const runner = makeRunner(store, {
      streamCompletion(): AsyncIterable<CompletionEvent> {
        throw new Error("must not be called");
      },
    });
    await expect(runner.run(sessionId)).resolves.toBe("recovered_partial");
    expect(
      store.events.some(
        (event) =>
          event.eventType === "message.completed" &&
          event.payload.partial === true &&
          event.payload.content === "half",
      ),
    ).toBe(true);
    expect(store.events.at(-1)).toMatchObject({ eventType: "session.failed" });
  });
});

function makeRunner(
  store: MemoryStore,
  provider: ProviderAdapter,
): DurableSessionRunner {
  return new DurableSessionRunner({
    clock: { now: () => new Date(at) },
    ids: { forKey: stableId },
    journal: store,
    leaseDurationMs: 30_000,
    leaseStore: store,
    maxRetryAttempts: 2,
    ownerId: "worker-a",
    providerFor: () => provider,
  });
}

async function* successfulEvents(): AsyncIterable<CompletionEvent> {
  await Promise.resolve();
  yield { type: "text.delta", text: "ok" };
  yield {
    type: "completion.finished",
    finishReason: "stop",
    usage: { costMicrounits: 1, inputTokens: 1, outputTokens: 1 },
  };
}
function initial(
  eventType: CanonicalEventV1["eventType"],
  sequence: number,
  payload: CanonicalEventV1["payload"],
): CanonicalEventV1 {
  return {
    eventId: stableId(`event-${String(sequence)}`),
    eventType,
    occurredAt: at,
    payload,
    schemaVersion: 1,
    sequence,
    sessionId,
  };
}
function stableId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
