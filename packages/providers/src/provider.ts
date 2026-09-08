export interface CompletionRequest {
  readonly idempotencyKey: string;
  readonly messages: readonly ProviderMessage[];
  readonly model: string;
  readonly maxOutputTokens: number;
}

export interface ProviderMessage {
  readonly content: string;
  readonly role: "assistant" | "system" | "user";
}

export type CompletionEvent =
  | { readonly type: "text.delta"; readonly text: string }
  | {
      readonly type: "completion.finished";
      readonly finishReason: "stop";
      readonly usage: ProviderUsage;
    };

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ProviderAdapter {
  streamCompletion(request: CompletionRequest): AsyncIterable<CompletionEvent>;
}
