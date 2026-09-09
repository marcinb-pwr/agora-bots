import { describe, expect, it } from "vitest";

import {
  createUuidV7Generator,
  uuidV7,
  type Clock,
  type RandomSource,
} from "../src/index.js";

describe("uuidV7", () => {
  it("encodes the injected timestamp and RFC version and variant bits", () => {
    const timestamp = new Date("2024-01-02T03:04:05.678Z");
    const id = uuidV7(
      timestamp,
      Uint8Array.from([
        0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde,
      ]),
    );

    expect(id).toBe("018cc820-db2e-7bcd-af12-3456789abcde");
    expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(
      timestamp.getTime(),
    );
  });

  it("rejects invalid timestamps and random input", () => {
    expect(() => uuidV7(new Date(Number.NaN), new Uint8Array(10))).toThrow(
      "UUIDv7 timestamp",
    );
    expect(() => uuidV7(new Date(0), new Uint8Array(9))).toThrow(
      "exactly 10 random bytes",
    );
  });
});

describe("createUuidV7Generator", () => {
  it("uses injected clock and randomness without hidden nondeterminism", () => {
    const clock: Clock = { now: () => new Date("2024-01-02T03:04:05.678Z") };
    const random: RandomSource = { bytes: (length) => new Uint8Array(length) };
    const generator = createUuidV7Generator(clock, random);

    expect(generator.generate()).toBe("018cc820-db2e-7000-8000-000000000000");
    expect(generator.generate()).toBe("018cc820-db2e-7000-8000-000000000000");
  });
});
