import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

import type { SubagentParent, SubagentSession } from "../subagent";

type UsageOverrides = Omit<Partial<Usage>, "cost"> & {
  readonly cost?: Partial<Usage["cost"]>;
};

export const parent: SubagentParent = {
  cwd: "/work",
  model: undefined,
  sessionId: undefined,
};

export function usage(overrides: UsageOverrides = {}): Usage {
  const { cost, ...rest } = overrides;
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      ...cost,
    },
    ...rest,
  };
}

export function assistant(
  textParts: readonly string[],
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  return {
    role: "assistant",
    content: textParts.map((text) => ({ type: "text", text })),
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

export class FakeSession implements SubagentSession {
  public promptCalls = 0;
  public abortCalls = 0;
  public disposeCalls = 0;
  public readonly steered: string[] = [];
  private listener: ((event: never) => void) | undefined;

  public constructor(
    private readonly onPrompt: (
      session: FakeSession,
      prompt: string
    ) => Promise<void>
  ) {}

  public subscribe(listener: (event: never) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public emit(event: unknown): void {
    this.listener?.(event as never);
  }

  public async prompt(prompt: string): Promise<void> {
    this.promptCalls += 1;
    await this.onPrompt(this, prompt);
  }

  public async steer(message: string): Promise<void> {
    this.steered.push(message);
  }

  public async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

/** A child that runs until told how to end: `finish` answers, `fail` errors, and an abort ends it as aborted. */
export class HeldSession extends FakeSession {
  private readonly ended = Promise.withResolvers<void>();
  private over = false;

  public constructor() {
    super(async () => {
      await this.ended.promise;
    });
  }

  public finish(text: string, cost = 0): void {
    this.over = true;
    this.emit({
      type: "message_end",
      message: assistant([text], { usage: usage({ cost: { total: cost } }) }),
    });
    this.ended.resolve();
  }

  public fail(errorMessage: string): void {
    this.over = true;
    this.emit({
      type: "message_end",
      message: assistant([], { stopReason: "error", errorMessage }),
    });
    this.ended.resolve();
  }

  public override async abort(): Promise<void> {
    await super.abort();
    if (this.over) {
      return;
    }
    this.over = true;
    this.emit({
      type: "message_end",
      message: assistant([], { stopReason: "aborted" }),
    });
    this.ended.resolve();
  }
}
