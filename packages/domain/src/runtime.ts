export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  generate(): string;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export function createUuidV7Generator(
  clock: Clock,
  random: RandomSource,
): IdGenerator {
  return {
    generate(): string {
      return uuidV7(clock.now(), random.bytes(10));
    },
  };
}

export function uuidV7(timestamp: Date, randomBytes: Uint8Array): string {
  const timestampMs = timestamp.getTime();
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs > 0xffffffffffff
  ) {
    throw new RangeError("UUIDv7 timestamp must be between 1970 and 10889");
  }
  if (randomBytes.length !== 10) {
    throw new RangeError("UUIDv7 requires exactly 10 random bytes");
  }

  const bytes = new Uint8Array(16);
  let remainingTimestamp = timestampMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }

  bytes.set(randomBytes, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hexadecimal = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
}
