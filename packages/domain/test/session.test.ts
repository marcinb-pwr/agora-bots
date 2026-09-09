import { describe, expect, it } from "vitest";

import {
  cancelSession,
  commitTurn,
  completeSession,
  createSession,
  failSession,
  prepareNextTurn,
  queueSession,
  SessionDomainError,
  startSession,
  type RunLimits,
  type Session,
} from "../src/index.js";

const limits: RunLimits = {
  costLimitMicrounits: 1_000,
  currency: "USD",
  durationLimitMs: 60_000,
  messageLimit: 4,
  totalTokenLimit: 100,
};
const at = (milliseconds: number): Date =>
  new Date(Date.parse("2026-01-01T00:00:00.000Z") + milliseconds);

describe("session lifecycle", () => {
  it("moves through explicit states and alternates exactly two participants", () => {
    let session = runningSession();

    const first = prepareNextTurn(session, at(2));
    expect(first.type).toBe("ready");
    if (first.type !== "ready") throw new Error("Expected a ready turn");
    expect(first.participantId).toBe("bot-a-version-1");

    session = commitTurn(session, {
      finishedAt: at(3),
      participantId: first.participantId,
      usage: { costMicrounits: 100, inputTokens: 4, outputTokens: 6 },
    });
    expect(session.status).toBe("running");
    expect(session.usage).toEqual({
      costMicrounits: 100,
      inputTokens: 4,
      messageCount: 1,
      outputTokens: 6,
    });

    const second = prepareNextTurn(session, at(4));
    expect(second.type === "ready" && second.participantId).toBe(
      "bot-b-version-1",
    );
  });

  it("rejects out-of-turn, repeated, and timestamp-regressing transitions", () => {
    const created = newSession();
    expectError(() => startSession(created, at(1)), "invalid_transition");
    expectError(() => queueSession(created, at(-1)), "invalid_transition");

    const running = runningSession();
    expectError(
      () =>
        commitTurn(running, {
          finishedAt: at(3),
          participantId: "bot-b-version-1",
          usage: { costMicrounits: 0, inputTokens: 0, outputTokens: 0 },
        }),
      "out_of_turn",
    );
    expectError(
      () => commitTurn(running, turn("bot-a-version-1", at(0))),
      "invalid_transition",
    );
  });

  it("makes cancellation cooperative and idempotent", () => {
    const cancelled = cancelSession(runningSession(), at(3));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.stopReason).toBe("cancelled_by_user");
    expect(cancelSession(cancelled, at(4))).toBe(cancelled);
    expectError(() => completeSession(cancelled, at(5)), "invalid_transition");
  });

  it("records explicit completion and provider failure reasons", () => {
    expect(completeSession(runningSession(), at(3))).toMatchObject({
      status: "completed",
      stopReason: "conversation_completed",
    });
    expect(failSession(runningSession(), at(3))).toMatchObject({
      status: "failed",
      stopReason: "provider_error",
    });
  });
});

describe("run limits", () => {
  it.each([
    ["message_limit", { messageLimit: 1 }, turn("bot-a-version-1", at(3))],
    ["token_limit", { totalTokenLimit: 10 }, turn("bot-a-version-1", at(3))],
    [
      "cost_limit",
      { costLimitMicrounits: 100 },
      turn("bot-a-version-1", at(3)),
    ],
    ["duration_limit", { durationLimitMs: 2 }, turn("bot-a-version-1", at(4))],
  ] as const)(
    "enforces %s after a provider call",
    (reason, override, usage) => {
      const stopped = commitTurn(runningSession(override), usage);
      expect(stopped).toMatchObject({
        status: "limit_reached",
        stopReason: reason,
      });
    },
  );

  it("checks limits before making another provider call", () => {
    const first = commitTurn(
      runningSession({ messageLimit: 1 }),
      turn("bot-a-version-1", at(3)),
    );
    expect(first.status).toBe("limit_reached");

    const duration = prepareNextTurn(
      runningSession({ durationLimitMs: 2 }),
      at(3),
    );
    expect(duration.type).toBe("stopped");
    if (duration.type !== "stopped") throw new Error("Expected a stopped run");
    expect(duration.session.stopReason).toBe("duration_limit");
  });

  it("rejects invalid limits, participants, and usage", () => {
    expectError(() => newSession({ totalTokenLimit: 0 }), "invalid_limits");
    expectError(
      () =>
        createSession({
          createdAt: at(0),
          id: "session-1",
          limits,
          participantIds: ["same", "same"],
        }),
      "invalid_participants",
    );
    expectError(
      () =>
        commitTurn(runningSession(), {
          ...turn("bot-a-version-1", at(3)),
          usage: { costMicrounits: -1, inputTokens: 1, outputTokens: 1 },
        }),
      "invalid_turn_usage",
    );
    expectError(
      () =>
        commitTurn(runningSession(), {
          ...turn("bot-a-version-1", at(3)),
          usage: {
            costMicrounits: 0,
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 1,
          },
        }),
      "invalid_turn_usage",
    );
  });
});

function newSession(overrides: Partial<RunLimits> = {}): Session {
  return createSession({
    createdAt: at(0),
    id: "session-1",
    limits: { ...limits, ...overrides },
    participantIds: ["bot-a-version-1", "bot-b-version-1"],
  });
}

function runningSession(
  overrides: Partial<RunLimits> = {},
): Extract<Session, { readonly status: "running" }> {
  return startSession(queueSession(newSession(overrides), at(1)), at(2));
}

function turn(participantId: string, finishedAt: Date) {
  return {
    finishedAt,
    participantId,
    usage: { costMicrounits: 100, inputTokens: 4, outputTokens: 6 },
  } as const;
}

function expectError(
  action: () => unknown,
  code: SessionDomainError["code"],
): void {
  try {
    action();
    throw new Error("Expected SessionDomainError");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionDomainError);
    expect((error as SessionDomainError).code).toBe(code);
  }
}
