import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import { PickerService } from "#core/picker/PickerService";
import { MessageText } from "#core/session/MessageText";
import type { SessionHost } from "#core/session/SessionHost";
import { Git, type GitState } from "#core/shared/Git";
import { Tools } from "#core/shared/Tools";
import type { ToolView } from "#core/view/ViewBlock";
import type {
  EphemeralEvent,
  ServerEvent,
  StreamEvent,
} from "#protocol/ServerEvent";
import { SessionProjection } from "./SessionProjection";

export type StreamListener = (event: ServerEvent) => void;

type LiveTool = {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  view: ToolView;
  isError: boolean;
  done: boolean;
};

type LiveMessage = {
  readonly messageId: string;
  text: string;
  thinking: string;
  ended: boolean;
  retired: boolean;
  readonly tools: LiveTool[];
};

const GIT_TTL_MS = 5_000;

/** One session's view of the world, shared by every client attached to it and kept running when none are. */
export class SessionStream {
  public readonly sessionId: string;
  public readonly host: SessionHost;
  public readonly picker: PickerService;
  private readonly projection: SessionProjection;
  private readonly listeners = new Set<StreamListener>();
  private liveTurn: LiveMessage[] = [];
  private unsubscribe: (() => void) | undefined;
  private liveMessageId = 0;
  private turnStartedAt = 0;
  private git: GitState = Git.EMPTY;
  private gitCwd = "";
  private gitReadAt = 0;
  private gitInFlight = false;

  public constructor(
    sessionId: string,
    host: SessionHost,
    sessionPath: string
  ) {
    this.sessionId = sessionId;
    this.host = host;
    this.projection = new SessionProjection(sessionPath, () => host.cwd);
    this.picker = new PickerService({
      cwd: () => host.cwd,
      agentDir: host.agentDir,
      agent: () => host.agentSession,
    });
  }

  public start(agent: AgentSession): void {
    this.unsubscribe ??= agent.subscribe((event) => {
      this.onAgentEvent(event);
    });
  }

  /** Project whatever pi has appended since the last read; returns the head. */
  public async refresh(): Promise<number> {
    await this.projection.drain();
    return this.projection.head;
  }

  public subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Everything a client at `fromSeq` has not seen: the durable tail, the in-flight turn coalesced, then state. */
  public async replay(fromSeq: number): Promise<readonly StreamEvent[]> {
    await this.projection.drain();
    return [...this.projection.since(fromSeq), ...this.inFlight()];
  }

  private inFlight(): readonly StreamEvent[] {
    const events: StreamEvent[] = [];
    for (const message of this.liveTurn) {
      const { messageId } = message;
      events.push({ type: "message_start", role: "assistant", messageId });
      if (message.thinking) {
        events.push({
          type: "thinking_delta",
          messageId,
          delta: message.thinking,
        });
      }
      if (message.text) {
        events.push({ type: "text_delta", messageId, delta: message.text });
      }
      for (const tool of message.tools) {
        events.push({
          type: "tool_call",
          callId: tool.callId,
          name: tool.name,
          messageId,
          view: tool.view,
        });
        if (tool.done) {
          events.push({
            type: "tool_end",
            callId: tool.callId,
            view: tool.view,
            isError: tool.isError,
          });
        }
      }
    }
    events.push(this.sessionState());
    return events;
  }

  /** Broadcast an event the stream did not derive itself, e.g. a state push. */
  public push(event: ServerEvent): void {
    this.emit(event);
  }

  /** Drop the server's picker caches and tell every client to drop theirs. */
  public invalidatePickers(scope: "files" | "commands" | "all"): void {
    this.picker.invalidate();
    this.emit({ type: "picker_invalidate", scope, cwd: this.host.cwd });
  }

  public sessionState(): EphemeralEvent {
    const tps = this.host.tps;
    const usage = this.host.usage();
    const { branch, dirtyCount, ahead, behind } = this.gitState();
    const modelLabel = this.host.currentModelLabel;
    const turnElapsedMs =
      this.host.status === "idle" || this.turnStartedAt === 0
        ? undefined
        : Date.now() - this.turnStartedAt;
    return {
      type: "session_state",
      cwd: this.host.cwd,
      model: this.host.currentModelId ?? "",
      ...(modelLabel === undefined ? {} : { modelLabel }),
      thinking: this.host.currentThinkingLevel,
      cost: this.host.settings.cumulativeCost ?? 0,
      status: this.host.status,
      ...(tps === undefined ? {} : { tps }),
      ...(turnElapsedMs === undefined ? {} : { turnElapsedMs }),
      ...(usage?.percent === null || usage === undefined
        ? {}
        : {
            contextPercent: usage.percent,
            contextWindow: usage.contextWindow,
          }),
      ...(branch === null ? {} : { branch, dirtyCount, ahead, behind }),
    };
  }

  private gitState(): GitState {
    const cwd = this.host.cwd;
    const moved = cwd !== this.gitCwd;
    if (moved) {
      this.gitCwd = cwd;
      this.git = Git.EMPTY;
    }
    if (
      (moved || Date.now() - this.gitReadAt > GIT_TTL_MS) &&
      !this.gitInFlight
    ) {
      this.gitInFlight = true;
      void Git.fetchStatus(cwd)
        .then((next) => {
          this.gitInFlight = false;
          this.gitReadAt = Date.now();
          const changed =
            next.branch !== this.git.branch ||
            next.dirtyCount !== this.git.dirtyCount ||
            next.ahead !== this.git.ahead ||
            next.behind !== this.git.behind;
          this.git = next;
          if (changed) {
            this.emit(this.sessionState());
          }
        })
        .catch(() => {});
    }
    return this.git;
  }

  public dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
  }

  private onAgentEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.turnStartedAt = Date.now();
        this.liveTurn = [];
        this.emit(this.sessionState());
        return;
      case "message_start":
        if (event.message.role === "assistant") {
          this.startMessage();
          this.emit(this.sessionState());
        }
        return;
      case "message_update": {
        if (event.message.role !== "assistant") {
          return;
        }
        const message = this.currentMessage();
        const text = MessageText.textOf(event.message.content);
        const thinking = MessageText.textOf(event.message.content, "thinking");
        this.emitDelta(message, "thinking", thinking);
        this.emitDelta(message, "text", text);
        return;
      }
      case "tool_execution_start": {
        const view = Tools.viewOf({
          name: event.toolName,
          args: event.args,
          isPartial: true,
          cwd: this.host.cwd,
        });
        const message = this.currentMessage();
        message.tools.push({
          callId: event.toolCallId,
          name: event.toolName,
          args: event.args,
          view,
          isError: false,
          done: false,
        });
        this.emit({
          type: "tool_call",
          callId: event.toolCallId,
          name: event.toolName,
          messageId: message.messageId,
          view,
        });
        this.emit(this.sessionState());
        return;
      }
      case "tool_execution_update": {
        const view = Tools.viewOf({
          name: event.toolName,
          args: event.args,
          result: event.partialResult,
          isPartial: true,
          cwd: this.host.cwd,
        });
        const tool = this.findTool(event.toolCallId);
        if (tool) {
          tool.view = view;
        }
        this.emit({ type: "tool_update", callId: event.toolCallId, view });
        return;
      }
      case "tool_execution_end": {
        const tool = this.findTool(event.toolCallId);
        const view = Tools.viewOf({
          name: event.toolName,
          args: tool?.args,
          result: event.result,
          isError: event.isError,
          isPartial: false,
          cwd: this.host.cwd,
        });
        if (tool) {
          tool.view = view;
          tool.isError = event.isError;
          tool.done = true;
        }
        this.emit({
          type: "tool_end",
          callId: event.toolCallId,
          view,
          isError: event.isError,
        });
        if (Tools.effectOf(event.toolName)?.kind !== "readOnly") {
          this.invalidatePickers("files");
        }
        return;
      }
      case "entry_appended":
        void this.flushDurable();
        return;
      // Never await the flush: pi appends the entry only after this listener returns.
      case "message_end": {
        if (event.message.role === "assistant") {
          const open = this.liveTurn.at(-1);
          if (open) {
            open.ended = true;
          }
        }
        void this.flushDurable();
        return;
      }
      case "turn_end": {
        const usage =
          event.message.role === "assistant" ? event.message.usage : undefined;
        this.emit({
          type: "turn_end",
          stats: {
            inputTokens: usage?.input ?? 0,
            outputTokens: usage?.output ?? 0,
            costUsd: usage?.cost.total ?? 0,
            durationMs: Date.now() - this.turnStartedAt,
          },
        });
        return;
      }
      case "agent_settled":
        void this.flushDurable().then(() => {
          // Clear only once the durable events superseding it are on the wire.
          this.liveTurn = [];
          this.emit(this.sessionState());
        });
        return;
      default:
        return;
    }
  }

  private currentMessage(): LiveMessage {
    return this.liveTurn.at(-1) ?? this.startMessage();
  }

  private startMessage(): LiveMessage {
    this.liveMessageId += 1;
    const message: LiveMessage = {
      messageId: `${this.sessionId}:live:${this.liveMessageId}`,
      text: "",
      thinking: "",
      ended: false,
      retired: false,
      tools: [],
    };
    this.liveTurn.push(message);
    this.emit({
      type: "message_start",
      role: "assistant",
      messageId: message.messageId,
    });
    return message;
  }

  // Pi re-states the whole message on each update; only a suffix is expressible as a delta.
  private emitDelta(
    message: LiveMessage,
    channel: "text" | "thinking",
    next: string
  ): void {
    const sent = message[channel];
    if (!next.startsWith(sent) || next === sent) {
      return;
    }
    this.emit({
      type: channel === "text" ? "text_delta" : "thinking_delta",
      messageId: message.messageId,
      delta: next.slice(sent.length),
    });
    message[channel] = next;
  }

  private locate(
    callId: string
  ): { readonly message: LiveMessage; readonly at: number } | undefined {
    for (const message of this.liveTurn) {
      const at = message.tools.findIndex((tool) => tool.callId === callId);
      if (at !== -1) {
        return { message, at };
      }
    }
    return undefined;
  }

  private findTool(callId: string): LiveTool | undefined {
    const found = this.locate(callId);
    return found === undefined ? undefined : found.message.tools[found.at];
  }

  // One frame: a retire split from the durable message that caused it paints the step twice.
  private async flushDurable(): Promise<void> {
    const batch: StreamEvent[] = [];
    for (const event of await this.projection.drain()) {
      batch.push(event);
      if (event.type === "message" && event.role === "assistant") {
        const retired = this.retireLive();
        if (retired) {
          batch.push(retired);
        }
      }
      if (event.type === "tool_result") {
        this.settleLive(event.callId);
      }
    }
    if (batch.length > 0) {
      this.emit({ type: "replay", events: batch });
    }
  }

  // Retire the oldest *finished* message, never the oldest: a retired shell may still be collecting calls.
  private retireLive(): EphemeralEvent | undefined {
    const retired = this.liveTurn.find(
      (message) => message.ended && !message.retired
    );
    if (!retired) {
      return undefined;
    }
    retired.text = "";
    retired.thinking = "";
    retired.retired = true;
    if (retired.tools.length === 0) {
      this.liveTurn = this.liveTurn.filter((message) => message !== retired);
    }
    return { type: "message_retire", messageId: retired.messageId };
  }

  private settleLive(callId: string): void {
    const found = this.locate(callId);
    if (found === undefined) {
      return;
    }
    const { message } = found;
    message.tools.splice(found.at, 1);
    if (message.retired && message.tools.length === 0) {
      this.liveTurn = this.liveTurn.filter((held) => held !== message);
    }
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
