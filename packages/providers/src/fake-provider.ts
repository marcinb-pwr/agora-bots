import type {
  CompletionEvent,
  CompletionRequest,
  ProviderAdapter,
} from "./provider.js";

export interface FakeProviderResponse {
  readonly chunks: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class FakeProvider implements ProviderAdapter {
  public constructor(private readonly response: FakeProviderResponse) {}

  public async *streamCompletion(
    request: CompletionRequest,
  ): AsyncIterable<CompletionEvent> {
    await Promise.resolve(request);

    for (const text of this.response.chunks) {
      yield { type: "text.delta", text };
    }

    yield {
      type: "completion.finished",
      finishReason: "stop",
      usage: {
        inputTokens: this.response.inputTokens,
        outputTokens: this.response.outputTokens,
      },
    };
  }
}
