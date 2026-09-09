export type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CanonicalEventV1 {
  readonly eventId: string;
  readonly eventType:
    | "message.chunk.appended"
    | "message.completed"
    | "provider.attempt.failed"
    | "session.cancelled"
    | "session.completed"
    | "session.created"
    | "session.failed"
    | "session.limit_reached"
    | "session.queued"
    | "session.started";
  readonly occurredAt: string;
  readonly participantId?: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly sessionId: string;
}

export class ContractValidationError extends Error {
  public constructor(readonly issues: readonly string[]) {
    super(`Invalid canonical event: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
  }
}

export const canonicalEventV1Schema = {
  $id: "https://agora-bots.local/schemas/canonical-event-v1.json",
  additionalProperties: false,
  properties: {
    eventId: { minLength: 1, type: "string" },
    eventType: {
      enum: [
        "message.chunk.appended",
        "message.completed",
        "provider.attempt.failed",
        "session.cancelled",
        "session.completed",
        "session.created",
        "session.failed",
        "session.limit_reached",
        "session.queued",
        "session.started",
      ],
      type: "string",
    },
    occurredAt: { format: "date-time", type: "string" },
    participantId: { minLength: 1, type: "string" },
    payload: { type: "object" },
    schemaVersion: { const: 1 },
    sequence: { minimum: 1, type: "integer" },
    sessionId: { minLength: 1, type: "string" },
  },
  required: [
    "eventId",
    "eventType",
    "occurredAt",
    "payload",
    "schemaVersion",
    "sequence",
    "sessionId",
  ],
  type: "object",
} as const;

const eventTypes = new Set<CanonicalEventV1["eventType"]>(
  canonicalEventV1Schema.properties.eventType.enum,
);
const allowedKeys = new Set([
  "eventId",
  "eventType",
  "occurredAt",
  "participantId",
  "payload",
  "schemaVersion",
  "sequence",
  "sessionId",
]);

export function parseCanonicalEventV1(value: unknown): CanonicalEventV1 {
  const issues: string[] = [];
  if (!isRecord(value))
    throw new ContractValidationError(["event must be an object"]);

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(`unknown field ${key}`);
  }
  const eventId = requiredString(value.eventId, "eventId", issues);
  const sessionId = requiredString(value.sessionId, "sessionId", issues);
  const participantId = optionalString(
    value.participantId,
    "participantId",
    issues,
  );
  const eventType = value.eventType;
  if (
    typeof eventType !== "string" ||
    !eventTypes.has(eventType as CanonicalEventV1["eventType"])
  ) {
    issues.push("eventType is unsupported");
  }
  if (value.schemaVersion !== 1) issues.push("schemaVersion must equal 1");
  const sequence = value.sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1)
    issues.push("sequence must be a positive safe integer");
  const occurredAt = value.occurredAt;
  if (
    typeof occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(occurredAt) ||
    Number.isNaN(Date.parse(occurredAt))
  ) {
    issues.push("occurredAt must be a UTC ISO 8601 timestamp");
  }
  if (!isJsonObject(value.payload))
    issues.push("payload must be a JSON object");
  validatePayload(eventType, value.payload, participantId, issues);

  if (issues.length > 0 || eventId === undefined || sessionId === undefined)
    throw new ContractValidationError(issues);
  return {
    eventId,
    eventType: eventType as CanonicalEventV1["eventType"],
    occurredAt: occurredAt as string,
    ...(participantId === undefined ? {} : { participantId }),
    payload: value.payload as CanonicalEventV1["payload"],
    schemaVersion: 1,
    sequence: sequence as number,
    sessionId,
  };
}

function validatePayload(
  eventType: unknown,
  payload: unknown,
  participantId: string | undefined,
  issues: string[],
): void {
  if (!isRecord(payload) || typeof eventType !== "string") return;
  if (eventType.startsWith("message.") && participantId === undefined)
    issues.push(`${eventType} requires participantId`);
  if (eventType === "message.chunk.appended") {
    requiredString(payload.messageId, "payload.messageId", issues);
    requiredStringAllowEmpty(payload.text, "payload.text", issues);
    positiveInteger(payload.chunkIndex, "payload.chunkIndex", issues, true);
    positiveInteger(payload.startOffset, "payload.startOffset", issues, true);
    positiveInteger(payload.endOffset, "payload.endOffset", issues, true);
    if (
      Number.isSafeInteger(payload.startOffset) &&
      Number.isSafeInteger(payload.endOffset) &&
      (payload.endOffset as number) < (payload.startOffset as number)
    )
      issues.push("payload.endOffset must not precede startOffset");
  }
  if (eventType === "message.completed") {
    requiredString(payload.messageId, "payload.messageId", issues);
    for (const key of ["inputTokens", "outputTokens", "costMicrounits"])
      positiveInteger(payload[key], `payload.${key}`, issues, true);
    requiredString(payload.finishReason, "payload.finishReason", issues);
    if (typeof payload.partial !== "boolean")
      issues.push("payload.partial must be boolean");
  }
  if (eventType === "session.limit_reached")
    requiredString(payload.stopReason, "payload.stopReason", issues);
}

function requiredString(
  value: unknown,
  name: string,
  issues: string[],
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${name} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requiredStringAllowEmpty(
  value: unknown,
  name: string,
  issues: string[],
): string | undefined {
  if (typeof value !== "string") {
    issues.push(`${name} must be a string`);
    return undefined;
  }
  return value;
}

function positiveInteger(
  value: unknown,
  name: string,
  issues: string[],
  allowZero: boolean,
): void {
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? (value as number) < 0 : (value as number) <= 0)
  )
    issues.push(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`,
    );
}

function optionalString(
  value: unknown,
  name: string,
  issues: string[],
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, issues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
