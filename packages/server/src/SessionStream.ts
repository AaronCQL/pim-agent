import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import type { SessionHost } from "../../core/src/session/SessionHost";
import { Tools } from "../../core/src/shared/Tools";
import type {
  EphemeralEvent,
  ServerEvent,
} from "../../protocol/src/ServerEvent";
import { SessionProjection } from "./SessionProjection";

export type StreamListener = (event: ServerEvent) => void;

type LiveTool = {
  readonly name: string;
  readonly args: unknown;
};

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
  private readonly projection: SessionProjection;
  private readonly listeners = new Set<StreamListener>();
  private readonly liveTools = new Map<string, LiveTool>();
  private unsubscribe: (() => void) | undefined;
  private liveMessageId = 0;
  private streamedText = "";
  private turnStartedAt = 0;

  public constructor(
    sessionId: string,
    host: SessionHost,
    sessionPath: string
  ) {
    this.sessionId = sessionId;
    this.host = host;
    this.projection = new SessionProjection(sessionPath, () => host.cwd);
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
  public async replay(fromSeq: number): Promise<readonly ServerEvent[]> {
    await this.projection.drain();
    return [...this.projection.since(fromSeq), ...this.inFlight()];
  }

  /** The live turn as a self-contained block, safe to send at any moment. */
  private inFlight(): readonly ServerEvent[] {
    const events: ServerEvent[] = [];
    const messageId = this.currentMessageId();
    const text = this.host.eventLog?.inFlight?.text ?? "";
    if (text) {
      events.push(
        { type: "message_start", role: "assistant", messageId },
        { type: "text_delta", messageId, delta: text }
      );
    }
    for (const [callId, tool] of this.liveTools) {
      events.push({
        type: "tool_call",
        callId,
        name: tool.name,
        view: Tools.viewOf({
          name: tool.name,
          args: tool.args,
          isPartial: true,
          cwd: this.host.cwd,
        }),
      });
    }
    events.push(this.sessionState());
    return events;
  }

  /** Broadcast an event the stream did not derive itself, e.g. a state push. */
  public push(event: ServerEvent): void {
    this.emit(event);
  }

  public sessionState(): EphemeralEvent {
    const tps = this.host.tps;
    return {
      type: "session_state",
      cwd: this.host.cwd,
      model: this.host.currentModelId ?? "",
      thinking: this.host.currentThinkingLevel,
      cost: this.host.settings.cumulativeCost ?? 0,
      status: this.host.status,
      ...(tps === undefined ? {} : { tps }),
    };
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
        this.liveMessageId += 1;
        this.streamedText = "";
        this.emit(this.sessionState());
        return;
      case "message_start":
        if (event.message.role === "assistant") {
          this.streamedText = "";
          this.emit({
            type: "message_start",
            role: "assistant",
            messageId: this.currentMessageId(),
          });
        }
        return;
      case "message_update": {
        if (event.message.role !== "assistant") {
          return;
        }
        const full = textOf(event.message.content);
        if (full.startsWith(this.streamedText) && full !== this.streamedText) {
          this.emit({
            type: "text_delta",
            messageId: this.currentMessageId(),
            delta: full.slice(this.streamedText.length),
          });
          this.streamedText = full;
        }
        return;
      }
      case "tool_execution_start":
        this.liveTools.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
        });
        this.emit({
          type: "tool_call",
          callId: event.toolCallId,
          name: event.toolName,
          view: Tools.viewOf({
            name: event.toolName,
            args: event.args,
            isPartial: true,
            cwd: this.host.cwd,
          }),
        });
        this.emit(this.sessionState());
        return;
      case "tool_execution_update":
        this.emit({
          type: "tool_update",
          callId: event.toolCallId,
          view: Tools.viewOf({
            name: event.toolName,
            args: event.args,
            result: event.partialResult,
            isPartial: true,
            cwd: this.host.cwd,
          }),
        });
        return;
      case "tool_execution_end":
        this.liveTools.delete(event.toolCallId);
        return;
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
        this.liveTools.clear();
        this.streamedText = "";
        void this.flushDurable().then(() => {
          this.emit(this.sessionState());
        });
        return;
      default:
        return;
    }
  }

  private async flushDurable(): Promise<void> {
    for (const event of await this.projection.drain()) {
      this.emit(event);
    }
  }

  private currentMessageId(): string {
    return `${this.sessionId}:live:${this.liveMessageId}`;
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  let out = "";
  for (const part of content as readonly Record<string, unknown>[]) {
    if (part.type === "text" && typeof part.text === "string") {
      out += part.text;
    }
  }
  return out;
}
