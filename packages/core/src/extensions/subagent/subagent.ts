import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentSessionEvent,
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import { formatTopLine } from "./render";

export const PER_TASK_OUTPUT_CAP = 32 * 1024;
export const SUBAGENT_TOOL_NAME = "subagent";

/**
 * How long text may accumulate before the parent is told. Time, not a
 * character count: a short answer that never reaches a byte threshold would
 * otherwise sit invisible until the call settled.
 */
const UPDATE_INTERVAL_MS = 100;

const inSubagent = new AsyncLocalStorage<true>();

export type SubagentUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly turns: number;
  readonly contextTokens: number | undefined;
};

/**
 * One thing the child did, in the order it did it. Tool entries are names
 * only: this list is re-serialised into the parent's log and re-shipped on
 * every partial update, so a child's arguments and output must never ride
 * along.
 */
export type SubagentEntry =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly name: string;
      readonly isError: boolean;
    };

export type SubagentSnapshot = {
  readonly entries: readonly SubagentEntry[];
  readonly usage: SubagentUsage;
  readonly activeToolNames: readonly string[];
  readonly lastToolName: string | undefined;
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
  readonly model: string | undefined;
  readonly contextWindow: number | undefined;
};

/**
 * `returnedOutput` is the child's answer, capped for the parent model;
 * `fullOutput` is every word it wrote, which is what a reader opens the row
 * to see.
 */
export type SubagentDetails = SubagentSnapshot & {
  readonly returnedOutput: string;
  readonly fullOutput: string;
  readonly outputTruncated: boolean;
  readonly omittedBytes: number;
};

export type SubagentSession = {
  readonly subscribe: (
    listener: (event: AgentSessionEvent) => void
  ) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
};

export type CreateSubagentSession = (
  parentCtx: ExtensionContext,
  activeToolNames: readonly string[] | undefined
) => Promise<SubagentSession>;

export function childToolNames(
  activeToolNames: readonly string[]
): readonly string[] {
  return activeToolNames.filter((name) => name !== SUBAGENT_TOOL_NAME);
}

/** Everything the child wrote, one paragraph per assistant message. */
function narrationOf(entries: readonly SubagentEntry[]): string {
  return entries
    .filter((entry) => entry.kind === "text")
    .map((entry) => entry.text)
    .join("\n\n");
}

/** The child's last word, which is the answer the parent model asked for. */
function answerOf(entries: readonly SubagentEntry[]): string {
  return entries.findLast((entry) => entry.kind === "text")?.text ?? "";
}

export async function createSdkSubagentSession(
  parentCtx: ExtensionContext,
  activeToolNames: readonly string[] | undefined
): Promise<SubagentSession> {
  const loader = new DefaultResourceLoader({
    cwd: parentCtx.cwd,
    agentDir: getAgentDir(),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: parentCtx.cwd,
    agentDir: getAgentDir(),
    model: parentCtx.model,
    sessionManager: SessionManager.inMemory(parentCtx.cwd),
    resourceLoader: loader,
    tools: activeToolNames ? [...childToolNames(activeToolNames)] : undefined,
  });

  return session;
}

export async function runSubagent(
  prompt: string,
  parentCtx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
  createSession: CreateSubagentSession = createSdkSubagentSession,
  activeToolNames?: readonly string[]
): Promise<AgentToolResult<SubagentDetails>> {
  if (inSubagent.getStore()) {
    throw new Error("subagents cannot call subagent tool");
  }

  return inSubagent.run(true, async () => {
    const capture = new SubagentEventCapture(onUpdate, {
      contextWindow: parentCtx.model?.contextWindow,
      model: parentCtx.model?.id,
    });
    let session: SubagentSession | undefined;
    let thrown: unknown;
    let abortRequested = false;
    let abortPromise: Promise<void> | undefined;

    const ensureAbort = (): Promise<void> => {
      if (!session) {
        return Promise.resolve();
      }
      abortPromise ??= session.abort().catch(() => {});
      return abortPromise;
    };

    const onAbort = () => {
      abortRequested = true;
      void ensureAbort();
    };

    try {
      session = await createSession(parentCtx, activeToolNames);
      session.subscribe((event) => capture.handle(event));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        abortRequested = true;
        throw new Error("subagent aborted before start");
      }
      await session.prompt(prompt);
      if (abortRequested && capture.snapshot().stopReason !== "aborted") {
        capture.markAborted();
      }
    } catch (err) {
      thrown = err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await ensureAbort();
      session?.dispose();
      capture.dispose();
    }

    const snapshot = capture.snapshot();
    if (thrown !== undefined) {
      throw makeFailureError(
        thrownMessage(thrown),
        undefined,
        narrationOf(snapshot.entries)
      );
    }
    if (snapshot.stopReason === "error" || snapshot.stopReason === "aborted") {
      throw makeFailureError(
        snapshot.stopReason,
        snapshot.errorMessage,
        narrationOf(snapshot.entries)
      );
    }

    const details = capture.details();
    const text =
      details.returnedOutput ||
      "[subagent tool: completed with no text output.]";
    return {
      content: [{ type: "text", text }],
      details,
    };
  });
}

export class SubagentEventCapture {
  private readonly entries: SubagentEntry[] = [];
  private pendingText = "";
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly usage: MutableUsage = emptyUsage();
  private readonly activeToolsById = new Map<string, string>();
  private lastToolName: string | undefined;
  private stopReason: string | undefined;
  private errorMessage: string | undefined;
  private model: string | undefined;

  public constructor(
    private readonly onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
    private readonly options: {
      readonly contextWindow?: number;
      readonly model?: string;
    } = {}
  ) {
    this.model = options.model;
  }

  public handle(event: AgentSessionEvent): void {
    if (event.type === "message_update" && isAssistantMessage(event.message)) {
      this.pendingText = collectText(event.message);
      this.scheduleUpdate();
      return;
    }

    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      this.commitText(collectText(event.message));
      addUsage(this.usage, event.message.usage);
      this.usage.turns += 1;
      this.stopReason = event.message.stopReason;
      this.errorMessage = event.message.errorMessage;
      this.model = event.message.model;
      this.emitUpdate();
      return;
    }

    if (event.type === "tool_execution_start") {
      this.activeToolsById.set(event.toolCallId, event.toolName);
      this.lastToolName = event.toolName;
      this.emitUpdate();
      return;
    }

    if (event.type === "tool_execution_end") {
      this.activeToolsById.delete(event.toolCallId);
      this.entries.push({
        kind: "tool",
        callId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
      });
      this.lastToolName = event.toolName;
      this.emitUpdate();
    }
  }

  public markAborted(): void {
    this.stopReason = "aborted";
    this.emitUpdate();
  }

  /** Drops a throttled update still in flight once the run is over. */
  public dispose(): void {
    this.cancelPending();
  }

  /** A message still streaming reads as the entry it is about to become. */
  public snapshot(): SubagentSnapshot {
    return {
      entries:
        this.pendingText === ""
          ? [...this.entries]
          : [...this.entries, { kind: "text", text: this.pendingText }],
      usage: freezeUsage(this.usage),
      activeToolNames: Array.from(new Set(this.activeToolsById.values())),
      lastToolName: this.lastToolName,
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      model: this.model,
      contextWindow: this.options.contextWindow,
    };
  }

  public details(): SubagentDetails {
    const snapshot = this.snapshot();
    const cap = applyOutputCap(answerOf(snapshot.entries));
    return {
      ...snapshot,
      returnedOutput: cap.text,
      fullOutput: narrationOf(snapshot.entries),
      outputTruncated: cap.truncated,
      omittedBytes: cap.omittedBytes,
    };
  }

  private commitText(text: string): void {
    this.pendingText = "";
    if (text !== "") {
      this.entries.push({ kind: "text", text });
    }
  }

  private scheduleUpdate(): void {
    if (this.onUpdate === undefined || this.updateTimer !== undefined) {
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.emitUpdate();
    }, UPDATE_INTERVAL_MS);
  }

  private cancelPending(): void {
    if (this.updateTimer !== undefined) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
  }

  private emitUpdate(): void {
    this.cancelPending();
    if (!this.onUpdate) {
      return;
    }
    const details = this.details();
    this.onUpdate({
      content: [{ type: "text", text: formatTopLine(details) }],
      details,
    });
  }
}

type MutableUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  contextTokens: number | undefined;
};

export type OutputCapResult = {
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
};

export function applyOutputCap(
  text: string,
  capBytes = PER_TASK_OUTPUT_CAP
): OutputCapResult {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(text).byteLength;
  if (totalBytes <= capBytes) {
    return { text, truncated: false, omittedBytes: 0 };
  }

  const buffer = new Uint8Array(capBytes);
  const { read, written } = encoder.encodeInto(text, buffer);
  const out = text.slice(0, read);
  const omittedBytes = totalBytes - written;
  return {
    text: `${out}\n[subagent: output truncated, ${omittedBytes} bytes omitted; full output preserved in tool details.]`,
    truncated: true,
    omittedBytes,
  };
}

function makeFailureError(
  reason: string,
  errorMessage: string | undefined,
  partialOutput: string
): Error {
  const capped = applyOutputCap(partialOutput);
  return new Error(
    `Subagent failed: ${reason}. Error: ${errorMessage ?? "none"}.\n` +
      `Partial output before failure:\n${capped.text}`
  );
}

function collectText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant" &&
    "content" in message &&
    Array.isArray(message.content)
  );
}

function emptyUsage(): MutableUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    contextTokens: undefined,
  };
}

function freezeUsage(usage: MutableUsage): SubagentUsage {
  return { ...usage };
}

function addUsage(target: MutableUsage, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost.total;
  target.contextTokens = usage.totalTokens || target.contextTokens;
}

function thrownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
