import { describe, expect, it } from "vitest";
import { parseCreateSessionRequest, parseLastEventId } from "../src/index.js";

const valid = {
  botVersionIds: ["bot-a-v1", "bot-b-v1"],
  idempotencyKey: "request-1",
  limits: {
    costLimitMicrounits: 1_000,
    currency: "USD",
    durationLimitMs: 60_000,
    messageLimit: 4,
    totalTokenLimit: 100,
  },
  scenarioVersionId: "scenario-v1",
};

describe("session contracts", () => {
  it("parses a bounded two-bot request", () => {
    expect(parseCreateSessionRequest(valid)).toEqual(valid);
  });
  it("rejects duplicates, unbounded limits, and unknown fields", () => {
    expect(() =>
      parseCreateSessionRequest({
        ...valid,
        botVersionIds: ["same", "same"],
        limits: { ...valid.limits, messageLimit: 0 },
        prompt: "no",
      }),
    ).toThrow(/unknown field.*two distinct.*messageLimit/s);
  });
  it("accepts only durable SSE sequences", () => {
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId("42")).toBe(42);
    expect(() => parseLastEventId("-1")).toThrow(/Last-Event-ID/);
  });
});
