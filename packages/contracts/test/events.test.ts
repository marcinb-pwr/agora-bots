import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  parseCanonicalEventV1,
} from "../src/index.js";

const chunk = {
  eventId: "event-1",
  eventType: "message.chunk.appended",
  occurredAt: "2026-09-09T10:00:00.000Z",
  participantId: "participant-1",
  payload: {
    chunkIndex: 0,
    endOffset: 5,
    messageId: "message-1",
    startOffset: 0,
    text: "hello",
  },
  schemaVersion: 1,
  sequence: 2,
  sessionId: "session-1",
} as const;

describe("parseCanonicalEventV1", () => {
  it("accepts a valid durable chunk envelope", () => {
    expect(parseCanonicalEventV1(chunk)).toEqual(chunk);
  });

  it("rejects unknown fields, invalid sequence/timestamp, and non-JSON payloads", () => {
    expect(() =>
      parseCanonicalEventV1({
        ...chunk,
        extra: "not additive without a schema change",
        occurredAt: "2026-09-09T12:00:00+02:00",
        payload: { value: Number.NaN },
        sequence: 0,
      }),
    ).toThrow(ContractValidationError);
  });

  it("requires message provenance and valid canonical offsets", () => {
    expect(() =>
      parseCanonicalEventV1({
        ...chunk,
        participantId: undefined,
        payload: { ...chunk.payload, endOffset: 2, startOffset: 3 },
      }),
    ).toThrow(/requires participantId/);
  });
});
