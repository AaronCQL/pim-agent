import { AsyncLocalStorage } from "node:async_hooks";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
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
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { Errors } from "../../shared/Errors";
import { SubagentLogs } from "../../shared/SubagentLogs";
import { Tools } from "../../shared/Tools";
import { MessageText } from "../../session/MessageText";
import { PlainPainter } from "../../view/PlainPainter";
import { CoreExtensions } from "../CoreExtensions";
import { formatTopLine } from "./render";

const PER_TASK_OUTPUT_CAP = 32 * 1024;
const SUBAGENT_TOOL_NAME = "subagent";
const RECENT_TOOLS = 10;
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
  readonly sessionId: string | undefined;
  readonly usage: SubagentUsage;
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
  readonly model: string | undefined;
  readonly contextWindow: number | undefined;
};

/** `returnedOutput` is the capped last message; `fullOutput` is every message. */
export type SubagentDetails = SubagentSnapshot & {
  readonly returnedOutput: string;
  readonly fullOutput: string;
  readonly outputTruncated: boolean;
  readonly omittedBytes: number;
};

export type ToolTrace = {
  readonly title: string;
  readonly state: "running" | "done" | "error";
};

export type SubagentSession = {
  readonly sessionId?: string;
  readonly subscribe: (
    listener: (event: AgentSessionEvent) => void
  ) => () => void;
  readonly prompt: (prompt: string) => Promise<void>;
  readonly steer: (message: string) => Promise<unknown>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
};

/** What a child needs from its parent, read once. */
export type SubagentParent = {
  readonly cwd: string;
  readonly model: Model<Api> | undefined;
  readonly sessionId: string | undefined;
};

export type SubagentSessionSpec = {
  readonly activeToolNames?: readonly string[];
  /** Unset falls back to pi's settings, not the parent's level. */
  readonly thinkingLevel?: ThinkingLevel;
  /** Names the child's log file. */
  readonly callId?: string;
};

export type CreateSubagentSession = (
  parent: SubagentParent,
  spec: SubagentSessionSpec
) => Promise<SubagentSession>;

export type SubagentRun = SubagentSessionSpec & {
  readonly signal?: AbortSignal;
  readonly onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  /** Fires at each boundary that can change usage or the child's log, never per streamed token; builds nothing. */
  readonly onChange?: () => void;
  readonly createSession?: CreateSubagentSession;
};

/** A child started without awaiting it. `result` rejects like `runSubagent`. */
export type SubagentChild = {
  readonly capture: SubagentEventCapture;
  readonly result: Promise<AgentToolResult<SubagentDetails>>;
  readonly steer: (message: string) => Promise<void>;
  /** Aborts the child and resolves once `result` has settled. */
  readonly stop: () => Promise<void>;
};

export function childToolNames(
  activeToolNames: readonly string[]
): readonly string[] {
  return activeToolNames.filter((name) => name !== SUBAGENT_TOOL_NAME);
}

// The child inherits no registrations; without these its `tools` allowlist drops every pim tool.
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

export function subagentParent(ctx: ExtensionContext): SubagentParent {
  return {
    cwd: ctx.cwd,
    model: ctx.model,
    sessionId: ctx.sessionManager.getSessionId(),
  };
}

async function createSdkSubagentSession(
  parent: SubagentParent,
  spec: SubagentSessionSpec = {}
): Promise<SubagentSession> {
  const loader = new DefaultResourceLoader(childLoaderOptions(parent.cwd));
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: parent.cwd,
    agentDir: getAgentDir(),
    model: parent.model,
    thinkingLevel: spec.thinkingLevel,
    sessionManager: await childSessionManager(parent, spec.callId),
    resourceLoader: loader,
    tools: spec.activeToolNames
      ? [...childToolNames(spec.activeToolNames)]
      : undefined,
  });

  return childSession(session);
}

/** Steering goes straight to the child's agent, so a message that looks like a command or template stays text. */
export function childSession(session: AgentSession): SubagentSession {
  return {
    sessionId: session.sessionId,
    subscribe: (listener) => session.subscribe(listener),
    prompt: (prompt) => session.prompt(prompt),
    steer: async (message) => {
      session.agent.steer({
        role: "user",
        content: [{ type: "text", text: message }],
        timestamp: Date.now(),
      });
    },
    abort: () => session.abort(),
    dispose: () => session.dispose(),
  };
}

// `open`, not `create`, so the log path is derived from the parent session id and call id.
async function childSessionManager(
  parent: SubagentParent,
  callId: string | undefined
): Promise<SessionManager> {
  const path =
    callId && parent.sessionId
      ? await SubagentLogs.create(parent.sessionId, callId)
      : null;
  return path === null
    ? SessionManager.inMemory(parent.cwd)
    : SessionManager.open(path, undefined, parent.cwd);
}

export async function runSubagent(
  prompt: string,
  parent: SubagentParent,
  run: SubagentRun = {}
): Promise<AgentToolResult<SubagentDetails>> {
  return await startSubagent(prompt, parent, run).result;
}

/** Throws at once when called from inside a subagent. */
export function startSubagent(
  prompt: string,
  parent: SubagentParent,
  run: SubagentRun = {}
): SubagentChild {
  if (inSubagent.getStore()) {
    throw new Error("subagents cannot call subagent tool");
  }

  const capture = new SubagentEventCapture(run.onUpdate, {
    ...(run.onChange === undefined ? {} : { onChange: run.onChange }),
    contextWindow: parent.model?.contextWindow,
    model: parent.model?.id,
    cwd: parent.cwd,
  });
  const stopper = new AbortController();
  const signal =
    run.signal === undefined
      ? stopper.signal
      : AbortSignal.any([run.signal, stopper.signal]);
  const started = Promise.withResolvers<SubagentSession | undefined>();
  const result = inSubagent.run(true, () =>
    drive(prompt, parent, run, { capture, signal, started })
  );
  const settled = result.then(
    () => undefined,
    () => undefined
  );

  return {
    capture,
    result,
    steer: async (message) => {
      const session = await started.promise;
      if (session === undefined) {
        throw new Error("the subagent never started, so it cannot be steered");
      }
      await session.steer(message);
    },
    stop: async () => {
      stopper.abort();
      await settled;
    },
  };
}

async function drive(
  prompt: string,
  parent: SubagentParent,
  run: SubagentRun,
  live: {
    readonly capture: SubagentEventCapture;
    readonly signal: AbortSignal;
    readonly started: PromiseWithResolvers<SubagentSession | undefined>;
  }
): Promise<AgentToolResult<SubagentDetails>> {
  const { capture, signal, started } = live;
  const createSession = run.createSession ?? createSdkSubagentSession;
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
    session = await createSession(parent, {
      activeToolNames: run.activeToolNames,
      thinkingLevel: run.thinkingLevel,
      callId: run.callId,
    });
    started.resolve(session);
    capture.noteSessionId(session.sessionId);
    session.subscribe((event) => capture.handle(event));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
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
    started.resolve(undefined);
    signal.removeEventListener("abort", onAbort);
    await ensureAbort();
    session?.dispose();
    capture.dispose();
  }

  const snapshot = capture.snapshot();
  if (thrown !== undefined) {
    throw makeFailureError(
      Errors.describe(thrown),
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
    details.returnedOutput || "[subagent tool: completed with no text output.]";
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export class SubagentEventCapture {
  private readonly entries: string[] = [];
  private pendingText = "";
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly usage: MutableUsage = emptyUsage();
  private stopReason: string | undefined;
  private errorMessage: string | undefined;
  private model: string | undefined;
  private sessionId: string | undefined;
  private readonly traces: {
    readonly id: string;
    readonly title: string;
    state: ToolTrace["state"];
  }[] = [];

  public constructor(
    private readonly onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
    private readonly options: {
      readonly onChange?: () => void;
      readonly contextWindow?: number;
      readonly model?: string;
      readonly cwd?: string;
    } = {}
  ) {
    this.model = options.model;
  }

  public handle(event: AgentSessionEvent): void {
    if (event.type === "message_update" && event.message.role === "assistant") {
      this.pendingText = MessageText.textOf(event.message.content);
      this.scheduleUpdate();
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        this.commitText(MessageText.textOf(event.message.content));
        addUsage(this.usage, event.message.usage);
        this.usage.turns += 1;
        this.stopReason = event.message.stopReason;
        this.errorMessage = event.message.errorMessage;
        this.model = event.message.model;
        this.emitUpdate();
      }
      this.options.onChange?.();
      return;
    }

    if (event.type === "tool_execution_start") {
      const title = toolTitle(event.toolName, event.args, this.options.cwd);
      this.traces.push({ id: event.toolCallId, title, state: "running" });
      this.traces.splice(0, Math.max(0, this.traces.length - RECENT_TOOLS));
      this.changed();
      return;
    }

    if (event.type === "tool_execution_end") {
      const trace = this.traces.find((t) => t.id === event.toolCallId);
      if (trace !== undefined) {
        trace.state = event.isError ? "error" : "done";
      }
      this.changed();
    }
  }

  public noteSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  public markAborted(): void {
    this.stopReason = "aborted";
    this.changed();
  }

  public dispose(): void {
    this.cancelPending();
  }

  public snapshot(): SubagentSnapshot {
    return {
      sessionId: this.sessionId,
      usage: { ...this.usage },
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      model: this.model,
      contextWindow: this.options.contextWindow,
    };
  }

  /** Oldest first, at most the last ten. */
  public recentTools(): readonly ToolTrace[] {
    return this.traces.map(({ title, state }) => ({ title, state }));
  }

  /** Each assistant message so far, oldest first, including one still streaming. */
  public messages(): readonly string[] {
    return this.pendingText === ""
      ? [...this.entries]
      : [...this.entries, this.pendingText];
  }

  /** All assistant messages so far, including one still streaming. */
  public narration(): string {
    return this.messages().join("\n\n");
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

  private changed(): void {
    this.emitUpdate();
    this.options.onChange?.();
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

function toolTitle(
  name: string,
  args: unknown,
  cwd: string | undefined
): string {
  return PlainPainter.toolTitle(
    Tools.viewOf({ name, args, isPartial: true, cwd: cwd ?? "" })
  );
}

type MutableUsage = { -readonly [K in keyof SubagentUsage]: SubagentUsage[K] };

export type OutputCapResult = {
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
};

export function applyOutputCap(
  text: string,
  capBytes = PER_TASK_OUTPUT_CAP
): OutputCapResult {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= capBytes) {
    return { text, truncated: false, omittedBytes: 0 };
  }

  const buffer = new Uint8Array(capBytes);
  const { read, written } = new TextEncoder().encodeInto(text, buffer);
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

function addUsage(target: MutableUsage, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost.total;
  target.contextTokens = usage.totalTokens || target.contextTokens;
}
