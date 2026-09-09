export type SessionStatus =
  | "cancelled"
  | "completed"
  | "created"
  | "failed"
  | "limit_reached"
  | "queued"
  | "running";

export type LimitStopReason =
  | "cost_limit"
  | "duration_limit"
  | "message_limit"
  | "token_limit";

export type SessionStopReason =
  | LimitStopReason
  | "cancelled_by_user"
  | "conversation_completed"
  | "provider_error";

export interface RunLimits {
  readonly costLimitMicrounits: number;
  readonly currency: string;
  readonly durationLimitMs: number;
  readonly messageLimit: number;
  readonly totalTokenLimit: number;
}

export interface SessionUsage {
  readonly costMicrounits: number;
  readonly inputTokens: number;
  readonly messageCount: number;
  readonly outputTokens: number;
}

interface SessionBase {
  readonly createdAt: string;
  readonly id: string;
  readonly limits: RunLimits;
  readonly nextParticipantIndex: 0 | 1;
  readonly participantIds: readonly [string, string];
  readonly usage: SessionUsage;
}

export type Session =
  | (SessionBase & { readonly status: "created" })
  | (SessionBase & { readonly queuedAt: string; readonly status: "queued" })
  | (SessionBase & {
      readonly queuedAt: string;
      readonly startedAt: string;
      readonly status: "running";
    })
  | (SessionBase & {
      readonly endedAt: string;
      readonly queuedAt?: string;
      readonly startedAt?: string;
      readonly status: "cancelled" | "completed" | "failed" | "limit_reached";
      readonly stopReason: SessionStopReason;
    });

export interface TurnUsage {
  readonly costMicrounits: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type TurnPreparation =
  | {
      readonly participantId: string;
      readonly session: RunningSession;
      readonly type: "ready";
    }
  | { readonly session: TerminalSession; readonly type: "stopped" };

type RunningSession = Extract<Session, { readonly status: "running" }>;
type TerminalSession = Extract<
  Session,
  { readonly status: "cancelled" | "completed" | "failed" | "limit_reached" }
>;

export type SessionErrorCode =
  | "invalid_limits"
  | "invalid_participants"
  | "invalid_transition"
  | "invalid_turn_usage"
  | "out_of_turn";

export class SessionDomainError extends Error {
  public constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionDomainError";
  }
}

const emptyUsage: SessionUsage = {
  costMicrounits: 0,
  inputTokens: 0,
  messageCount: 0,
  outputTokens: 0,
};

export function createSession(input: {
  readonly createdAt: Date;
  readonly id: string;
  readonly limits: RunLimits;
  readonly participantIds: readonly [string, string];
}): Extract<Session, { readonly status: "created" }> {
  validateParticipants(input.participantIds);
  validateLimits(input.limits);
  return {
    createdAt: toIsoTimestamp(input.createdAt),
    id: input.id,
    limits: { ...input.limits },
    nextParticipantIndex: 0,
    participantIds: [...input.participantIds],
    status: "created",
    usage: emptyUsage,
  };
}

export function queueSession(
  session: Session,
  queuedAt: Date,
): Extract<Session, { readonly status: "queued" }> {
  assertStatus(session, "created", "queue");
  assertAtOrAfter(queuedAt, session.createdAt);
  return { ...session, queuedAt: toIsoTimestamp(queuedAt), status: "queued" };
}

export function startSession(
  session: Session,
  startedAt: Date,
): RunningSession {
  assertStatus(session, "queued", "start");
  assertAtOrAfter(startedAt, session.queuedAt);
  return {
    ...session,
    startedAt: toIsoTimestamp(startedAt),
    status: "running",
  };
}

export function prepareNextTurn(session: Session, now: Date): TurnPreparation {
  assertStatus(session, "running", "prepare a turn");
  assertAtOrAfter(now, session.startedAt);
  const stopReason = reachedLimit(session, now);
  if (stopReason !== undefined) {
    return { session: stopAtLimit(session, stopReason, now), type: "stopped" };
  }
  return {
    participantId: session.participantIds[session.nextParticipantIndex],
    session,
    type: "ready",
  };
}

export function commitTurn(
  session: Session,
  input: {
    readonly finishedAt: Date;
    readonly participantId: string;
    readonly usage: TurnUsage;
  },
): Session {
  assertStatus(session, "running", "commit a turn");
  assertAtOrAfter(input.finishedAt, session.startedAt);
  const expectedParticipant =
    session.participantIds[session.nextParticipantIndex];
  if (input.participantId !== expectedParticipant) {
    throw new SessionDomainError(
      "out_of_turn",
      `Expected participant at index ${String(session.nextParticipantIndex)}`,
    );
  }
  validateTurnUsage(input.usage);
  const usage: SessionUsage = {
    costMicrounits: session.usage.costMicrounits + input.usage.costMicrounits,
    inputTokens: session.usage.inputTokens + input.usage.inputTokens,
    messageCount: session.usage.messageCount + 1,
    outputTokens: session.usage.outputTokens + input.usage.outputTokens,
  };
  validateSafeUsage(usage);
  const advanced: RunningSession = {
    ...session,
    nextParticipantIndex: session.nextParticipantIndex === 0 ? 1 : 0,
    usage,
  };
  const stopReason = reachedLimit(advanced, input.finishedAt);
  return stopReason === undefined
    ? advanced
    : stopAtLimit(advanced, stopReason, input.finishedAt);
}

export function completeSession(
  session: Session,
  endedAt: Date,
): TerminalSession {
  assertStatus(session, "running", "complete");
  assertAtOrAfter(endedAt, session.startedAt);
  return terminal(session, "completed", "conversation_completed", endedAt);
}

export function failSession(session: Session, endedAt: Date): TerminalSession {
  assertStatus(session, "running", "fail");
  assertAtOrAfter(endedAt, session.startedAt);
  return terminal(session, "failed", "provider_error", endedAt);
}

export function cancelSession(
  session: Session,
  endedAt: Date,
): TerminalSession {
  if (session.status === "cancelled") return session;
  if (session.status !== "queued" && session.status !== "running") {
    throw invalidTransition(session.status, "cancel");
  }
  assertAtOrAfter(
    endedAt,
    session.status === "running" ? session.startedAt : session.queuedAt,
  );
  return terminal(session, "cancelled", "cancelled_by_user", endedAt);
}

function reachedLimit(
  session: RunningSession,
  now: Date,
): LimitStopReason | undefined {
  if (session.usage.messageCount >= session.limits.messageLimit)
    return "message_limit";
  if (
    session.usage.inputTokens + session.usage.outputTokens >=
    session.limits.totalTokenLimit
  )
    return "token_limit";
  if (session.usage.costMicrounits >= session.limits.costLimitMicrounits)
    return "cost_limit";
  if (
    now.getTime() - Date.parse(session.startedAt) >=
    session.limits.durationLimitMs
  )
    return "duration_limit";
  return undefined;
}

function stopAtLimit(
  session: RunningSession,
  reason: LimitStopReason,
  endedAt: Date,
): TerminalSession {
  return terminal(session, "limit_reached", reason, endedAt);
}

function terminal(
  session: Session,
  status: TerminalSession["status"],
  stopReason: SessionStopReason,
  endedAt: Date,
): TerminalSession {
  return {
    ...session,
    endedAt: toIsoTimestamp(endedAt),
    status,
    stopReason,
  } as TerminalSession;
}

function assertStatus<Status extends SessionStatus>(
  session: Session,
  expected: Status,
  action: string,
): asserts session is Extract<Session, { readonly status: Status }> {
  if (session.status !== expected)
    throw invalidTransition(session.status, action);
}

function invalidTransition(
  status: SessionStatus,
  action: string,
): SessionDomainError {
  return new SessionDomainError(
    "invalid_transition",
    `Cannot ${action} a session in status ${status}`,
  );
}

function validateParticipants(participantIds: readonly [string, string]): void {
  if (
    participantIds[0].trim() === "" ||
    participantIds[1].trim() === "" ||
    participantIds[0] === participantIds[1]
  ) {
    throw new SessionDomainError(
      "invalid_participants",
      "A session requires exactly two distinct participant IDs",
    );
  }
}

function validateLimits(limits: RunLimits): void {
  const values = [
    limits.costLimitMicrounits,
    limits.durationLimitMs,
    limits.messageLimit,
    limits.totalTokenLimit,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !/^[A-Z]{3}$/.test(limits.currency)
  ) {
    throw new SessionDomainError(
      "invalid_limits",
      "Limits must be positive safe integers and currency must be an ISO-style code",
    );
  }
}

function validateTurnUsage(usage: TurnUsage): void {
  if (
    [usage.costMicrounits, usage.inputTokens, usage.outputTokens].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    throw new SessionDomainError(
      "invalid_turn_usage",
      "Turn usage must contain non-negative safe integers",
    );
  }
}

function validateSafeUsage(usage: SessionUsage): void {
  if (
    !Number.isSafeInteger(usage.costMicrounits) ||
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.messageCount) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
  ) {
    throw new SessionDomainError(
      "invalid_turn_usage",
      "Session usage overflowed",
    );
  }
}

function toIsoTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new SessionDomainError(
      "invalid_transition",
      "Timestamp must be valid",
    );
  }
  return value.toISOString();
}

function assertAtOrAfter(value: Date, earliest: string): void {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < Date.parse(earliest)) {
    throw new SessionDomainError(
      "invalid_transition",
      "Transition timestamp cannot precede committed session state",
    );
  }
}
