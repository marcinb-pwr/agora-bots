import { describe, expect, it } from "vitest";

import { FakeProvider, type CompletionRequest } from "../src/index.js";

const request: CompletionRequest = {
  idempotencyKey: "session-1:turn-1:attempt-1",
  maxOutputTokens: 20,
  messages: [{ content: "Begin.", role: "user" }],
  model: "deterministic-fake-v1",
};

describe("FakeProvider", () => {
  it("replays configured chunks and normalized usage deterministically", async () => {
    const provider = new FakeProvider({
      chunks: ["Hello", " world", "."],
      inputTokens: 1,
      outputTokens: 3,
    });

    const first = await collect(provider.streamCompletion(request));
    const second = await collect(provider.streamCompletion(request));

    expect(second).toEqual(first);
    expect(first).toEqual([
      { type: "text.delta", text: "Hello" },
      { type: "text.delta", text: " world" },
      { type: "text.delta", text: "." },
      {
        type: "completion.finished",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 3 },
      },
    ]);
  });
});

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) {
    result.push(item);
  }
  return result;
}
