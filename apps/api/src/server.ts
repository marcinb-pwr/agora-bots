import {
  parseCreateSessionRequest,
  parseLastEventId,
  SessionContractError,
  type CanonicalEventV1,
  type CreateSessionRequest,
  type SessionResource,
} from "@agora-bots/contracts";
import Fastify, { type FastifyInstance } from "fastify";

export interface ApiDependencies {
  readonly clock: { now(): Date };
  readonly enqueue: (sessionId: string) => Promise<void>;
  readonly events: {
    listEventsAfter(input: {
      afterSequence: number;
      limit: number;
      sessionId: string;
    }): Promise<readonly CanonicalEventV1[]>;
  };
  readonly sessions: {
    cancel(sessionId: string, now: Date): Promise<SessionResource | undefined>;
    create(request: CreateSessionRequest, now: Date): Promise<SessionResource>;
    get(sessionId: string): Promise<SessionResource | undefined>;
  };
  readonly stream?: {
    heartbeatMs?: number;
    maxDurationMs?: number;
    pollMs?: number;
  };
}

export function createApi(dependencies: ApiDependencies): FastifyInstance {
  const app = Fastify({
    bodyLimit: 32_768,
    logger: false,
    requestTimeout: 30_000,
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    void reply.header("access-control-allow-origin", "http://127.0.0.1:3000");
    void reply.header(
      "access-control-allow-headers",
      "content-type,last-event-id",
    );
    void reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  app.options("/*", async (_request, reply) => reply.status(204).send());
  app.setErrorHandler((error, _request, reply) => {
    const invalid = error instanceof SessionContractError;
    void reply.status(invalid ? 400 : 503).send({
      error: {
        code: invalid ? "invalid_request" : "unavailable",
        message: invalid ? error.message : "The request could not be completed",
      },
    });
  });
  app.post("/v1/sessions", async (request, reply) => {
    const input = parseCreateSessionRequest(request.body);
    const session = await dependencies.sessions.create(
      input,
      dependencies.clock.now(),
    );
    await dependencies.enqueue(session.id);
    return reply
      .status(202)
      .header("location", `/v1/sessions/${session.id}`)
      .send(session);
  });
  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    async (request, reply) => {
      const session = await dependencies.sessions.get(request.params.sessionId);
      return session === undefined
        ? reply.status(404).send(notFound())
        : reply.send(session);
    },
  );
  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/cancel",
    async (request, reply) => {
      const session = await dependencies.sessions.cancel(
        request.params.sessionId,
        dependencies.clock.now(),
      );
      return session === undefined
        ? reply.status(404).send(notFound())
        : reply.send(session);
    },
  );
  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/events",
    async (request, reply) => {
      const session = await dependencies.sessions.get(request.params.sessionId);
      if (session === undefined) return reply.status(404).send(notFound());
      const after = parseLastEventId(
        singleHeader(request.headers["last-event-id"]),
      );
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        "access-control-allow-origin": "http://127.0.0.1:3000",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      });
      let cursor = after;
      let lastWrite = Date.now();
      const started = Date.now();
      const heartbeatMs = dependencies.stream?.heartbeatMs ?? 15_000;
      const maxDurationMs = dependencies.stream?.maxDurationMs ?? 300_000;
      const pollMs = dependencies.stream?.pollMs ?? 250;
      while (!response.destroyed && Date.now() - started < maxDurationMs) {
        const events = await dependencies.events.listEventsAfter({
          afterSequence: cursor,
          limit: 100,
          sessionId: session.id,
        });
        for (const event of events) {
          response.write(encodeSseEvent(event));
          cursor = event.sequence;
          lastWrite = Date.now();
        }
        if (Date.now() - lastWrite >= heartbeatMs) {
          response.write(": heartbeat\n\n");
          lastWrite = Date.now();
        }
        const current = await dependencies.sessions.get(session.id);
        if (
          events.length === 0 &&
          current !== undefined &&
          isTerminal(current.status)
        )
          break;
        await delay(pollMs);
      }
      response.end();
    },
  );
  return app;
}

export function encodeSseEvent(event: CanonicalEventV1): string {
  return `id: ${String(event.sequence)}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}
function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function notFound(): { error: { code: "not_found"; message: string } } {
  return { error: { code: "not_found", message: "Session not found" } };
}
function isTerminal(status: SessionResource["status"]): boolean {
  return (
    status === "cancelled" ||
    status === "completed" ||
    status === "failed" ||
    status === "limit_reached"
  );
}
async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
