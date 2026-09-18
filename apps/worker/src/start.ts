import { createHash } from "node:crypto";
import { createEventStore, createSessionStore } from "@agora-bots/db";
import { FakeProvider } from "@agora-bots/providers";
import pg from "pg";
import { DurableSessionRunner } from "./runner.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
const eventStore = createEventStore(pool);
const sessions = createSessionStore(pool, stableId);
const provider = new FakeProvider({
  chunks: ["This is a deterministic local response."],
  costMicrounits: 0,
  inputTokens: 8,
  outputTokens: 7,
});
const runner = new DurableSessionRunner({
  clock: { now: () => new Date() },
  ids: { forKey: stableId },
  journal: eventStore,
  leaseDurationMs: 30_000,
  leaseStore: eventStore,
  maxRetryAttempts: 3,
  ownerId: `worker-${String(process.pid)}`,
  providerFor: (name) => {
    if (name !== "fake") throw new Error("Unsupported provider");
    return provider;
  },
});

const stopped = new Promise<"stop">((resolve) => {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      resolve("stop");
    });
});
for (;;) {
  const runnable = await sessions.listRunnable(10);
  for (const sessionId of runnable) await runner.run(sessionId);
  const next = await Promise.race([
    stopped,
    new Promise<"poll">((resolve) =>
      setTimeout(
        () => {
          resolve("poll");
        },
        runnable.length === 0 ? 500 : 10,
      ),
    ),
  ]);
  if (next === "stop") break;
}
await pool.end();

function stableId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
