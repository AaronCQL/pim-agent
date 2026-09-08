import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentSessionEvent,
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  InlineExtension,
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
import { SubagentLogs } from "../../shared/SubagentLogs";
import { CoreExtensions } from "../CoreExtensions";
import { formatTopLine } from "./render";

export const PER_TASK_OUTPUT_CAP = 32 * 1024;
export const SUBAGENT_TOOL_NAME = "subagent";

/**
 * How long text may accumulate before the parent is told. Time, not a
 * character count: a short answer that never reaches a byte threshold would
 * otherwise sit invisible until the call settled.
 */
export const UPDATE_INTERVAL_MS = 100;

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

export type SubagentSnapshot = {
  /**
   * The child's own session id, for a human reading a log. Nothing may resolve
   * the child's transcript through it: a failed run persists no details at
   * all, so its log is found by deriving the path from the call id instead.
   */
  readonly sessionId: string | undefined;
  readonly usage: SubagentUsage;
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
  readonly sessionId?: string;
  readonly subscribe: (
    listener: (event: AgentSessionEvent) => void
  ) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
};

export type SubagentSessionSpec = {
  readonly activeToolNames?: readonly string[];
  /** The parent's tool call id, which names the child's log on disk. */
  readonly callId?: string;
};

export type CreateSubagentSession = (
  parentCtx: ExtensionContext,
  spec: SubagentSessionSpec
) => Promise<SubagentSession>;

export type SubagentRun = SubagentSessionSpec & {
  readonly signal?: AbortSignal;
  readonly onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  readonly createSession?: CreateSubagentSession;
};

export function childToolNames(
  activeToolNames: readonly string[]
): readonly string[] {
  return activeToolNames.filter((name) => name !== SUBAGENT_TOOL_NAME);
}

/**
 * The child builds its own session, so it inherits none of the parent's
 * registrations: without the roster it would see pi's built-in tools alone
 * and silently lose every pim tool the `tools` allowlist goes on to name.
 */
export function childLoaderOptions(cwd: string): {
  readonly cwd: string;
  readonly agentDir: string;
  readonly extensionFactories: InlineExtension[];
} {
  return {
    cwd,
    agentDir: getAgentDir(),
    extensionFactories: CoreExtensions.gated(),
  };
}

export async function createSdkSubagentSession(
  parentCtx: ExtensionContext,
  spec: SubagentSessionSpec = {}
): Promise<SubagentSession> {
  const loader = new DefaultResourceLoader(childLoaderOptions(parentCtx.cwd));
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: parentCtx.cwd,
    agentDir: getAgentDir(),
    model: parentCtx.model,
    sessionManager: await childSessionManager(parentCtx, spec.callId),
    resourceLoader: loader,
    tools: spec.activeToolNames
      ? [...childToolNames(spec.activeToolNames)]
      : undefined,
  });

  return session;
}

/**
 * The child writes to a path a reader can derive from the parent session id
 * and the call id alone, which is why the file is opened rather than created:
 * `SessionManager.create` names the file itself, while `open` on a path that
 * does not exist yet is how pi is told one. Losing the log costs the run
 * nothing — the child then works in memory, as it always did.
 */
async function childSessionManager(
  parentCtx: ExtensionContext,
  callId: string | undefined
): Promise<SessionManager> {
  const path = callId
    ? await SubagentLogs.create(parentCtx.sessionManager.getSessionId(), callId)
    : null;
  return path === null
    ? SessionManager.inMemory(parentCtx.cwd)
    : SessionManager.open(path, undefined, parentCtx.cwd);
}

export async function runSubagent(
  prompt: string,
  parentCtx: ExtensionContext,
  run: SubagentRun = {}
): Promise<AgentToolResult<SubagentDetails>> {
  const {
    signal,
    onUpdate,
    createSession = createSdkSubagentSession,
    activeToolNames,
    callId,
  } = run;

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
      session = await createSession(parentCtx, { activeToolNames, callId });
      capture.noteSessionId(session.sessionId);
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
        capture.narration()
      );
    }
    if (snapshot.stopReason === "error" || snapshot.stopReason === "aborted") {
      throw makeFailureError(
        snapshot.stopReason,
        snapshot.errorMessage,
        capture.narration()
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
  /**
   * What the child said, one entry per assistant message, in order — and only
   * what it said, never the tools it reached for.
   *
   * Private, and it stays private: `details` is re-serialised into the
   * parent's log and re-shipped on every partial update, `fullOutput` already
   * carries every word of this, and nothing may ride along that no one reads.
   * A roster of the child's tool calls would be a transcript with the
   * substance taken out; the child's own log has every call in full, and that
   * is what its row opens.
   */
  private readonly entries: string[] = [];
  private pendingText = "";
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly usage: MutableUsage = emptyUsage();
  private stopReason: string | undefined;
  private errorMessage: string | undefined;
  private model: string | undefined;
  private sessionId: string | undefined;

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
    }
  }

  public noteSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  public markAborted(): void {
    this.stopReason = "aborted";
    this.emitUpdate();
  }

  /** Drops a throttled update still in flight once the run is over. */
  public dispose(): void {
    this.cancelPending();
  }

  public snapshot(): SubagentSnapshot {
    return {
      sessionId: this.sessionId,
      usage: freezeUsage(this.usage),
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      model: this.model,
      contextWindow: this.options.contextWindow,
    };
  }

  /**
   * Everything the child wrote, one paragraph per assistant message. A
   * message still streaming reads as the entry it is about to become.
   */
  public narration(): string {
    const said =
      this.pendingText === ""
        ? this.entries
        : [...this.entries, this.pendingText];
    return said.join("\n\n");
  }

  public details(): SubagentDetails {
    const cap = applyOutputCap(this.answer());
    return {
      ...this.snapshot(),
      returnedOutput: cap.text,
      fullOutput: this.narration(),
      outputTruncated: cap.truncated,
      omittedBytes: cap.omittedBytes,
    };
  }

  /** The child's last word, which is the answer the parent model asked for. */
  private answer(): string {
    return this.pendingText === ""
      ? (this.entries.at(-1) ?? "")
      : this.pendingText;
  }

  private commitText(text: string): void {
    this.pendingText = "";
    if (text !== "") {
      this.entries.push(text);
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
