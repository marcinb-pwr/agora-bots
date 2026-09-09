import { describe, expect, it } from "vitest";

import { ConfigurationError, parseRuntimeConfig } from "../src/index.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://app:local-only@127.0.0.1:5432/agora_bots",
  LOG_LEVEL: "info",
  NODE_ENV: "test",
  REDIS_URL: "redis://127.0.0.1:6379",
} as const;

describe("parseRuntimeConfig", () => {
  it("returns a typed configuration when every required setting is valid", () => {
    expect(parseRuntimeConfig(validEnvironment)).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      environment: "test",
      logLevel: "info",
      redisUrl: validEnvironment.REDIS_URL,
    });
  });

  it("reports all invalid fields without exposing their values", () => {
    const invalid = {
      DATABASE_URL: "contains-a-password-but-is-not-a-url",
      LOG_LEVEL: "verbose",
      NODE_ENV: undefined,
      REDIS_URL: "https://redis.invalid",
    };

    expect(() => parseRuntimeConfig(invalid)).toThrow(ConfigurationError);
    try {
      parseRuntimeConfig(invalid);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain("contains-a-password");
      expect((error as ConfigurationError).issues).toHaveLength(4);
    }
  });
});
