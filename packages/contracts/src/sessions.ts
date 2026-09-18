export interface RunLimitsContract {
  readonly costLimitMicrounits: number;
  readonly currency: string;
  readonly durationLimitMs: number;
  readonly messageLimit: number;
  readonly totalTokenLimit: number;
}

export interface CreateSessionRequest {
  readonly botVersionIds: readonly [string, string];
  readonly idempotencyKey: string;
  readonly limits: RunLimitsContract;
  readonly scenarioVersionId: string;
}

export interface SessionResource {
  readonly createdAt: string;
  readonly id: string;
  readonly limits: RunLimitsContract;
  readonly participantIds: readonly [string, string];
  readonly status:
    | "cancelled"
    | "completed"
    | "created"
    | "failed"
    | "limit_reached"
    | "queued"
    | "running";
  readonly stopReason?: string;
}

export interface ApiError {
  readonly error: {
    readonly code: "conflict" | "invalid_request" | "not_found" | "unavailable";
    readonly message: string;
  };
}

export class SessionContractError extends Error {
  public constructor(readonly issues: readonly string[]) {
    super(`Invalid session request: ${issues.join("; ")}`);
    this.name = "SessionContractError";
  }
}

export function parseCreateSessionRequest(
  value: unknown,
): CreateSessionRequest {
  const issues: string[] = [];
  if (!isRecord(value))
    throw new SessionContractError(["body must be an object"]);
  const allowed = new Set([
    "botVersionIds",
    "idempotencyKey",
    "limits",
    "scenarioVersionId",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) issues.push(`unknown field ${key}`);
  const bots = value.botVersionIds;
  if (
    !Array.isArray(bots) ||
    bots.length !== 2 ||
    bots.some((id) => typeof id !== "string" || id.trim() === "") ||
    bots[0] === bots[1]
  ) {
    issues.push("botVersionIds must contain two distinct non-empty IDs");
  }
  const botVersionIds: readonly [string, string] = [
    String(Array.isArray(bots) ? bots[0] : ""),
    String(Array.isArray(bots) ? bots[1] : ""),
  ];
  const idempotencyKey = stringField(
    value.idempotencyKey,
    "idempotencyKey",
    issues,
  );
  const scenarioVersionId = stringField(
    value.scenarioVersionId,
    "scenarioVersionId",
    issues,
  );
  const limits = parseLimits(value.limits, issues);
  if (
    issues.length > 0 ||
    idempotencyKey === undefined ||
    scenarioVersionId === undefined ||
    limits === undefined
  )
    throw new SessionContractError(issues);
  return {
    botVersionIds,
    idempotencyKey,
    limits,
    scenarioVersionId,
  };
}

export function parseLastEventId(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d+$/.test(value))
    throw new SessionContractError([
      "Last-Event-ID must be a non-negative integer",
    ]);
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence))
    throw new SessionContractError([
      "Last-Event-ID is outside the safe integer range",
    ]);
  return sequence;
}

function parseLimits(
  value: unknown,
  issues: string[],
): RunLimitsContract | undefined {
  if (!isRecord(value)) {
    issues.push("limits must be an object");
    return undefined;
  }
  const names = [
    "costLimitMicrounits",
    "durationLimitMs",
    "messageLimit",
    "totalTokenLimit",
  ] as const;
  const numbers = {
    costLimitMicrounits: 0,
    durationLimitMs: 0,
    messageLimit: 0,
    totalTokenLimit: 0,
  };
  for (const name of names) {
    const number = value[name];
    if (!Number.isSafeInteger(number) || (number as number) <= 0)
      issues.push(`limits.${name} must be a positive safe integer`);
    else numbers[name] = number as number;
  }
  const currency = value.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
    issues.push("limits.currency must be a three-letter uppercase code");
  if (issues.length > 0) return undefined;
  return { ...numbers, currency: currency as string };
}

function stringField(
  value: unknown,
  name: string,
  issues: string[],
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${name} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
