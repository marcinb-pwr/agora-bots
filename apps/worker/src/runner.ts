import type { CanonicalEventV1 } from "@agora-bots/contracts";
import {
  commitTurn,
  createSession,
  failSession,
  prepareNextTurn,
  queueSession,
  startSession,
  type Session,
  type SessionStopReason,
} from "@agora-bots/domain";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderMessage,
} from "@agora-bots/providers";

interface LeaseStore {
  acquireLease(input: {
    durationMs: number;
    now: Date;
    ownerId: string;
    sessionId: string;
  }): Promise<object | undefined>;
  renewLease(input: {
    durationMs: number;
    now: Date;
    ownerId: string;
    sessionId: string;
  }): Promise<object | undefined>;
  releaseLease(sessionId: string, ownerId: string): Promise<boolean>;
}

interface Journal {
  append(input: {
    event: Omit<CanonicalEventV1, "sequence">;
    idempotencyKey: string;
    outboxId: string;
    topic: string;
  }): Promise<CanonicalEventV1>;
  listEventsAfter(input: {
    afterSequence: number;
    limit: number;
    sessionId: string;
  }): Promise<readonly CanonicalEventV1[]>;
}

export interface RunnerDependencies {
  readonly clock: { now(): Date };
  readonly ids: { forKey(key: string): string };
  readonly journal: Journal;
  readonly leaseStore: LeaseStore;
  readonly leaseDurationMs: number;
  readonly maxRetryAttempts: number;
  readonly ownerId: string;
  readonly providerFor: (provider: string) => ProviderAdapter;
}

export type RunnerResult = "busy" | "recovered_partial" | "terminal";

interface CreationPayload {
  readonly botVersions: readonly [
    { model: string; provider: string; systemPrompt: string },
    { model: string; provider: string; systemPrompt: string },
  ];
  readonly limits: {
    costLimitMicrounits: number;
    currency: string;
    durationLimitMs: number;
    messageLimit: number;
    totalTokenLimit: number;
  };
  readonly openingMessage: string;
  readonly participantIds: readonly [string, string];
}

export class DurableSessionRunner {
  public constructor(private readonly dependencies: RunnerDependencies) {}

  public async run(sessionId: string): Promise<RunnerResult> {
    const { clock, leaseDurationMs, leaseStore, ownerId } = this.dependencies;
    const lease = await leaseStore.acquireLease({
      durationMs: leaseDurationMs,
      now: clock.now(),
      ownerId,
      sessionId,
    });
    if (lease === undefined) return "busy";
    try {
      let events = await this.readAll(sessionId);
      const dangling = findDanglingMessage(events);
      if (dangling !== undefined) {
        await this.finishPartial(sessionId, dangling);
        return "recovered_partial";
      }
      let session = restoreSession(events);
      if (session.status === "queued") {
        await this.append(sessionId, "session.started", "start", {});
        events = await this.readAll(sessionId);
        session = restoreSession(events);
      }
      while (session.status === "running") {
        if (events.some((event) => event.eventType === "session.cancelled"))
          return "terminal";
        const renewed = await leaseStore.renewLease({
          durationMs: leaseDurationMs,
          now: clock.now(),
          ownerId,
          sessionId,
        });
        if (renewed === undefined) return "busy";
        const preparation = prepareNextTurn(session, clock.now());
        if (preparation.type === "stopped") {
          await this.appendTerminal(preparation.session);
          return "terminal";
        }
        await this.executeTurn(preparation.session, events);
        events = await this.readAll(sessionId);
        session = restoreSession(events);
      }
      return "terminal";
    } finally {
      await leaseStore.releaseLease(sessionId, ownerId);
    }
  }

  private async executeTurn(
    session: Extract<Session, { status: "running" }>,
    events: readonly CanonicalEventV1[],
  ): Promise<void> {
    const creation = creationPayload(events);
    const turn = session.usage.messageCount + 1;
    const participantIndex = session.nextParticipantIndex;
    const bot = creation.botVersions[participantIndex];
    const messageId = this.dependencies.ids.forKey(
      `${session.id}:turn:${String(turn)}:message`,
    );
    const messages = providerMessages(creation, events, participantIndex);
    let attempt = 1;
    while (attempt <= this.dependencies.maxRetryAttempts) {
      const attemptKey = `${session.id}:turn:${String(turn)}:attempt:${String(attempt)}`;
      let text = "";
      let chunkIndex = 0;
      try {
        const provider = this.dependencies.providerFor(bot.provider);
        for await (const event of provider.streamCompletion({
          idempotencyKey: attemptKey,
          maxOutputTokens: remainingTokens(session),
          messages,
          model: bot.model,
        })) {
          if (event.type === "text.delta") {
            const startOffset = text.length;
            text += event.text;
            await this.append(
              session.id,
              "message.chunk.appended",
              `${attemptKey}:chunk:${String(chunkIndex)}`,
              {
                chunkIndex,
                endOffset: text.length,
                messageId,
                startOffset,
                text: event.text,
              },
              session.participantIds[participantIndex],
            );
            chunkIndex += 1;
          } else {
            await this.append(
              session.id,
              "message.completed",
              `${attemptKey}:completed`,
              {
                content: text,
                costMicrounits: event.usage.costMicrounits,
                finishReason: event.finishReason,
                inputTokens: event.usage.inputTokens,
                messageId,
                outputTokens: event.usage.outputTokens,
                partial: false,
                turn,
              },
              session.participantIds[participantIndex],
            );
            const advanced = commitTurn(session, {
              finishedAt: this.dependencies.clock.now(),
              participantId: session.participantIds[participantIndex],
              usage: event.usage,
            });
            if (isTerminalSession(advanced))
              await this.appendTerminal(advanced);
            return;
          }
        }
        throw new ProviderError(
          "ambiguous",
          "provider stream ended without usage",
        );
      } catch (error: unknown) {
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError("ambiguous", "provider request failed");
        await this.append(
          session.id,
          "provider.attempt.failed",
          `${attemptKey}:failed`,
          {
            attempt,
            errorClass: providerError.kind,
            partialOutput: text.length > 0,
            retryable: providerError.kind === "retryable",
            turn,
          },
        );
        if (
          text.length > 0 ||
          providerError.kind !== "retryable" ||
          attempt === this.dependencies.maxRetryAttempts
        ) {
          if (text.length > 0)
            await this.append(
              session.id,
              "message.completed",
              `${attemptKey}:partial`,
              {
                content: text,
                costMicrounits: 0,
                finishReason: "provider_error",
                inputTokens: 0,
                messageId,
                outputTokens: 0,
                partial: true,
                turn,
              },
              session.participantIds[participantIndex],
            );
          await this.appendTerminal(
            failSession(session, this.dependencies.clock.now()),
          );
          return;
        }
        attempt += 1;
      }
    }
  }

  private async finishPartial(
    sessionId: string,
    dangling: {
      messageId: string;
      participantId: string;
      text: string;
      turn: number;
    },
  ): Promise<void> {
    const session = restoreSession(await this.readAll(sessionId));
    if (session.status !== "running") return;
    await this.append(
      sessionId,
      "message.completed",
      `${sessionId}:turn:${String(dangling.turn)}:recovered-partial`,
      {
        content: dangling.text,
        costMicrounits: 0,
        finishReason: "worker_recovery",
        inputTokens: 0,
        messageId: dangling.messageId,
        outputTokens: 0,
        partial: true,
        turn: dangling.turn,
      },
      dangling.participantId,
    );
    await this.appendTerminal(
      failSession(session, this.dependencies.clock.now()),
    );
  }

  private async appendTerminal(
    session: Extract<
      Session,
      { status: "cancelled" | "completed" | "failed" | "limit_reached" }
    >,
  ): Promise<void> {
    const eventType =
      session.status === "limit_reached"
        ? "session.limit_reached"
        : session.status === "failed"
          ? "session.failed"
          : session.status === "cancelled"
            ? "session.cancelled"
            : "session.completed";
    await this.append(session.id, eventType, `terminal:${session.stopReason}`, {
      stopReason: session.stopReason,
    });
  }

  private async append(
    sessionId: string,
    eventType: CanonicalEventV1["eventType"],
    key: string,
    payload: CanonicalEventV1["payload"],
    participantId?: string,
  ): Promise<CanonicalEventV1> {
    return this.dependencies.journal.append({
      event: {
        eventId: this.dependencies.ids.forKey(`${sessionId}:event:${key}`),
        eventType,
        occurredAt: this.dependencies.clock.now().toISOString(),
        ...(participantId === undefined ? {} : { participantId }),
        payload,
        schemaVersion: 1,
        sessionId,
      },
      idempotencyKey: key,
      outboxId: this.dependencies.ids.forKey(`${sessionId}:outbox:${key}`),
      topic: `session.events.${sessionId}`,
    });
  }

  private async readAll(
    sessionId: string,
  ): Promise<readonly CanonicalEventV1[]> {
    const events: CanonicalEventV1[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = await this.dependencies.journal.listEventsAfter({
        afterSequence,
        limit: 100,
        sessionId,
      });
      events.push(...page);
      if (page.length < 100) return events;
      afterSequence = page.at(-1)?.sequence ?? afterSequence;
    }
  }
}

function restoreSession(events: readonly CanonicalEventV1[]): Session {
  const creation = creationPayload(events);
  const createdEvent = events.find(
    (event) => event.eventType === "session.created",
  );
  if (createdEvent === undefined) throw new Error("session.created is missing");
  let session: Session = createSession({
    createdAt: new Date(createdEvent.occurredAt),
    id: createdEvent.sessionId,
    limits: creation.limits,
    participantIds: creation.participantIds,
  });
  for (const event of events) {
    if (event.eventType === "session.queued" && session.status === "created")
      session = queueSession(session, new Date(event.occurredAt));
    else if (
      event.eventType === "session.started" &&
      session.status === "queued"
    )
      session = startSession(session, new Date(event.occurredAt));
    else if (
      event.eventType === "message.completed" &&
      session.status === "running" &&
      event.payload.partial === false &&
      event.participantId !== undefined
    )
      session = commitTurn(session, {
        finishedAt: new Date(event.occurredAt),
        participantId: event.participantId,
        usage: {
          costMicrounits: numberPayload(event, "costMicrounits"),
          inputTokens: numberPayload(event, "inputTokens"),
          outputTokens: numberPayload(event, "outputTokens"),
        },
      });
    else if (isTerminal(event.eventType) && session.status === "running")
      return {
        ...session,
        endedAt: event.occurredAt,
        status: terminalStatus(event.eventType),
        stopReason: stringPayload(event, "stopReason") as SessionStopReason,
      };
  }
  return session;
}

function creationPayload(events: readonly CanonicalEventV1[]): CreationPayload {
  const payload = events.find(
    (event) => event.eventType === "session.created",
  )?.payload;
  if (payload === undefined) throw new Error("session.created is missing");
  return payload as unknown as CreationPayload;
}

function providerMessages(
  creation: CreationPayload,
  events: readonly CanonicalEventV1[],
  participantIndex: 0 | 1,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [
    {
      content: creation.botVersions[participantIndex].systemPrompt,
      role: "system",
    },
    { content: creation.openingMessage, role: "user" },
  ];
  for (const event of events)
    if (
      event.eventType === "message.completed" &&
      event.payload.partial === false &&
      typeof event.payload.content === "string"
    )
      messages.push({
        content: event.payload.content,
        role:
          event.participantId === creation.participantIds[participantIndex]
            ? "assistant"
            : "user",
      });
  return messages;
}

function findDanglingMessage(
  events: readonly CanonicalEventV1[],
):
  | { messageId: string; participantId: string; text: string; turn: number }
  | undefined {
  const completed = new Set(
    events
      .filter((event) => event.eventType === "message.completed")
      .map((event) => event.payload.messageId),
  );
  const chunks = events.filter(
    (event) =>
      event.eventType === "message.chunk.appended" &&
      !completed.has(event.payload.messageId),
  );
  const first = chunks[0];
  if (
    first?.participantId === undefined ||
    typeof first.payload.messageId !== "string"
  )
    return undefined;
  return {
    messageId: first.payload.messageId,
    participantId: first.participantId,
    text: chunks.map((event) => stringPayload(event, "text")).join(""),
    turn:
      events.filter(
        (event) =>
          event.eventType === "message.completed" &&
          event.payload.partial === false,
      ).length + 1,
  };
}

function remainingTokens(
  session: Extract<Session, { status: "running" }>,
): number {
  return Math.max(
    1,
    session.limits.totalTokenLimit -
      session.usage.inputTokens -
      session.usage.outputTokens,
  );
}
function numberPayload(event: CanonicalEventV1, key: string): number {
  const value = event.payload[key];
  if (typeof value !== "number") throw new Error(`invalid ${key}`);
  return value;
}

function stringPayload(event: CanonicalEventV1, key: string): string {
  const value = event.payload[key];
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
}
function isTerminal(type: CanonicalEventV1["eventType"]): boolean {
  return (
    type === "session.cancelled" ||
    type === "session.completed" ||
    type === "session.failed" ||
    type === "session.limit_reached"
  );
}
function terminalStatus(
  type: CanonicalEventV1["eventType"],
): "cancelled" | "completed" | "failed" | "limit_reached" {
  if (type === "session.cancelled") return "cancelled";
  if (type === "session.completed") return "completed";
  if (type === "session.limit_reached") return "limit_reached";
  return "failed";
}

function isTerminalSession(
  session: Session,
): session is Extract<
  Session,
  { status: "cancelled" | "completed" | "failed" | "limit_reached" }
> {
  return (
    session.status === "cancelled" ||
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "limit_reached"
  );
}
