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
  /** Kept because `tool_execution_end` carries a result but not the call. */
  readonly args: unknown;
  view: ToolView;
  isError: boolean;
  done: boolean;
};

/**
 * One assistant message of the turn in flight. A turn is a list of these
 * because pi calls the model once per step and only appends the entry for a
 * step later — often not until the whole turn settles — so between the two
 * this is the only record that the step's prose, reasoning and calls exist.
 */
type LiveMessage = {
  readonly messageId: string;
  text: string;
  thinking: string;
  readonly tools: LiveTool[];
};

/**
 * How long a branch reading is trusted. Git shells out and `sessionState()`
 * is synchronous and hot — every tool call emits one — so the answer is
 * cached and refreshed behind the caller, who gets the previous reading and a
 * second `session_state` a moment later if it changed.
 */
const GIT_TTL_MS = 5_000;

/**
 * One session's view of the world, shared by every client attached to it and
 * kept running when none are.
 *
 * Durable events come from the projection over pi's JSONL; ephemeral ones are
 * synthesized from the live `AgentSession` subscription. The subscription
 * exists independently of any client precisely because the agent must finish
 * with zero clients attached — the JSONL is what a late client reads, and the
 * in-flight buffer is what it is handed on top.
 */
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

  /**
   * Everything a client at `fromSeq` has not seen: the durable tail, then the
   * in-flight turn coalesced into a single text block, then current state.
   *
   * The coalescing is not an optimisation — individual deltas are never
   * persisted, so there is nothing else to replay them from.
   */
  public async replay(fromSeq: number): Promise<readonly StreamEvent[]> {
    await this.projection.drain();
    return [...this.projection.since(fromSeq), ...this.inFlight()];
  }

  /** The live turn as a self-contained block, safe to send at any moment. */
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

  /**
   * Drop the server's picker caches and tell every client to drop theirs. The
   * results are a function of the filesystem, so anything that moves the cwd
   * or writes into it makes them stale.
   */
  public invalidatePickers(scope: "files" | "commands" | "all"): void {
    this.picker.invalidate();
    this.emit({ type: "picker_invalidate", scope, cwd: this.host.cwd });
  }

  public sessionState(): EphemeralEvent {
    const tps = this.host.tps;
    const usage = this.host.agentSession?.getContextUsage();
    const { branch, dirtyCount, ahead, behind } = this.gitState();
    const modelLabel = this.host.currentModelLabel;
    return {
      type: "session_state",
      cwd: this.host.cwd,
      model: this.host.currentModelId ?? "",
      ...(modelLabel === undefined ? {} : { modelLabel }),
      thinking: this.host.currentThinkingLevel,
      cost: this.host.settings.cumulativeCost ?? 0,
      status: this.host.status,
      ...(tps === undefined ? {} : { tps }),
      ...(usage?.percent === null || usage === undefined
        ? {}
        : {
            contextPercent: usage.percent,
            contextWindow: usage.contextWindow,
          }),
      ...(branch === null ? {} : { branch, dirtyCount, ahead, behind }),
    };
  }

  /**
   * The last reading, and a refresh behind it once that reading is stale.
   * Stale means old *or* about another directory — a `set_cwd` invalidates
   * the branch outright rather than leaving the old repo's name up for a tick.
   */
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
      void Git.fetchStatus(cwd).then((next) => {
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
      });
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
        // Only ever a suffix: pi re-states the whole message on each update,
        // so anything that is not an extension of what was sent is a rewrite
        // the deltas cannot express, and the durable entry settles it.
        if (
          thinking.startsWith(message.thinking) &&
          thinking !== message.thinking
        ) {
          this.emit({
            type: "thinking_delta",
            messageId: message.messageId,
            delta: thinking.slice(message.thinking.length),
          });
          message.thinking = thinking;
        }
        if (text.startsWith(message.text) && text !== message.text) {
          this.emit({
            type: "text_delta",
            messageId: message.messageId,
            delta: text.slice(message.text.length),
          });
          message.text = text;
        }
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
        // The result is durable, but pi may not append it for another step or
        // two; until it does, this is the only settled view of the call there
        // is, and without it the row would spin for the rest of the turn.
        const tool = this.findTool(event.toolCallId);
        const view = Tools.viewOf({
          name: event.toolName,
          args: tool?.args,
          result: event.result,
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
        // The watcher tick, without a watcher: a tool that is not declared
        // read-only may have just changed what the file picker would answer.
        if (Tools.effectOf(event.toolName)?.kind !== "readOnly") {
          this.invalidatePickers("files");
        }
        return;
      }
      case "entry_appended":
        void this.flushDurable();
        return;
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
          // Cleared only once what supersedes it is on the wire: a client that
          // reconnects in between must still be handed the finished turn.
          this.liveTurn = [];
          this.emit(this.sessionState());
        });
        return;
      default:
        return;
    }
  }

  /**
   * The message being streamed. Synthesised when an update or a call arrives
   * before any `message_start` — a step that only calls tools still needs
   * somewhere to hang them, and the client orders the bucket by message.
   */
  private currentMessage(): LiveMessage {
    return this.liveTurn.at(-1) ?? this.startMessage();
  }

  /** Opens the next live message of the turn and announces it. */
  private startMessage(): LiveMessage {
    this.liveMessageId += 1;
    const message: LiveMessage = {
      messageId: `${this.sessionId}:live:${this.liveMessageId}`,
      text: "",
      thinking: "",
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

  /** The live call with this id, wherever in the turn it was made. */
  private findTool(callId: string): LiveTool | undefined {
    for (const message of this.liveTurn) {
      const tool = message.tools.find(
        (candidate) => candidate.callId === callId
      );
      if (tool) {
        return tool;
      }
    }
    return undefined;
  }

  private async flushDurable(): Promise<void> {
    for (const event of await this.projection.drain()) {
      this.emit(event);
    }
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
