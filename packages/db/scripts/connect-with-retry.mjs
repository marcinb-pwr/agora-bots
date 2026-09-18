import { setTimeout as wait } from "node:timers/promises";

const RETRYABLE_POSTGRES_CODES = new Set(["08001", "08006", "08007", "57P03"]);
const RETRYABLE_SYSTEM_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);

export async function connectWithRetry({
  createClient,
  delay = wait,
  maxAttempts = 30,
  retryDelayMs = 1_000,
  onRetry = () => undefined,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = createClient();
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);

      if (!isRetryableConnectionError(error) || attempt === maxAttempts) {
        throw error;
      }

      onRetry({ attempt, maxAttempts, retryDelayMs });
      await delay(retryDelayMs);
    }
  }

  throw new Error("Database connection retry loop ended unexpectedly");
}

export function isRetryableConnectionError(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (
    RETRYABLE_POSTGRES_CODES.has(error.code) ||
    RETRYABLE_SYSTEM_CODES.has(error.code)
  );
}
