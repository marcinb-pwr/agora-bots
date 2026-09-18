import { describe, expect, it, vi } from "vitest";

import {
  connectWithRetry,
  isRetryableConnectionError,
} from "../scripts/connect-with-retry.mjs";

describe("migration database connection", () => {
  it("uses a fresh client after PostgreSQL reports that it is starting", async () => {
    const startupError = Object.assign(
      new Error("database system is starting up"),
      {
        code: "57P03",
      },
    );
    const firstClient = {
      connect: vi.fn().mockRejectedValue(startupError),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const readyClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const createClient = vi
      .fn()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(readyClient);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      connectWithRetry({ createClient, delay, retryDelayMs: 25 }),
    ).resolves.toBe(readyClient);
    expect(firstClient.end).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(25);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("does not retry authentication or migration errors", async () => {
    const authenticationError = Object.assign(new Error("password failed"), {
      code: "28P01",
    });
    const client = {
      connect: vi.fn().mockRejectedValue(authenticationError),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      connectWithRetry({ createClient: () => client, delay }),
    ).rejects.toBe(authenticationError);
    expect(delay).not.toHaveBeenCalled();
  });

  it("stops retrying after the configured attempt limit", async () => {
    const connectionError = Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    });
    const createClient = vi.fn(() => ({
      connect: vi.fn().mockRejectedValue(connectionError),
      end: vi.fn().mockResolvedValue(undefined),
    }));
    const delay = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await expect(
      connectWithRetry({ createClient, delay, maxAttempts: 3, onRetry }),
    ).rejects.toBe(connectionError);
    expect(createClient).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("recognizes startup and network connection failures only", () => {
    expect(isRetryableConnectionError({ code: "57P03" })).toBe(true);
    expect(isRetryableConnectionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isRetryableConnectionError({ code: "28P01" })).toBe(false);
    expect(isRetryableConnectionError(new Error("unknown"))).toBe(false);
  });
});
