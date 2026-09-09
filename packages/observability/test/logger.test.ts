import { describe, expect, it } from "vitest";

import { createJsonLogger } from "../src/index.js";

describe("createJsonLogger", () => {
  it("writes stable JSON with correlation fields and recursively redacts secrets", () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      clock: { now: () => new Date("2026-01-02T03:04:05.000Z") },
      context: { correlationId: "correlation-1", sessionId: "session-1" },
      minimumLevel: "info",
      sink: { write: (line) => lines.push(line) },
    });

    logger.info("session.started", {
      attempt: 1,
      provider: {
        api_key: "private key",
        authorization: "Bearer private",
        name: "fake",
      },
      prompt: "private transcript text",
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines.join(""))).toEqual({
      correlationId: "correlation-1",
      event: "session.started",
      fields: {
        attempt: 1,
        prompt: "[REDACTED]",
        provider: {
          api_key: "[REDACTED]",
          authorization: "[REDACTED]",
          name: "fake",
        },
      },
      level: "info",
      sessionId: "session-1",
      timestamp: "2026-01-02T03:04:05.000Z",
    });
  });

  it("filters records below the configured level", () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      clock: { now: () => new Date(0) },
      context: { correlationId: "correlation-1" },
      minimumLevel: "warn",
      sink: { write: (line) => lines.push(line) },
    });

    logger.info("filtered");
    logger.warn("retained");
    expect(lines).toHaveLength(1);
  });
});
