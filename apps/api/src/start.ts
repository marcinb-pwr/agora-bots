import { createHash } from "node:crypto";
import { createEventStore, createSessionStore } from "@agora-bots/db";
import pg from "pg";
import { createApi } from "./server.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
const app = createApi({
  clock: { now: () => new Date() },
  enqueue: async () => Promise.resolve(),
  events: createEventStore(pool),
  sessions: createSessionStore(pool, stableId),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => pool.end());
  });
await app.listen({ host: "127.0.0.1", port: 3001 });

function stableId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
