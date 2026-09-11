import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { PickerService } from "#core/picker/PickerService";
import { MessageText } from "#core/session/MessageText";
import type { LeaseState, SessionHost } from "#core/session/SessionHost";
import { SessionLease, type LeaseRecord } from "#core/session/SessionLease";
import { FileWatch } from "#core/shared/FileWatch";
import { GitMonitor } from "#core/shared/GitMonitor";
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

export type SessionStreamDeps = {
  /** How often the file watch falls back to a poll; the default is a second. */
  readonly pollMs?: number;
  /** Shared with every other session in the same directory; one is made here when none is given. */
  readonly git?: GitMonitor;
  /**
   * Whether a session in this stream's directory is mid-turn, this one
   * included. Only the gateway can see the others, so a stream standing alone
   * reports nothing rather than guessing from itself.
   */
  readonly repoBusy?: () => boolean;
};

function sameLease(a: LeaseState, b: LeaseState): boolean {
  return (
    a.writable === b.writable &&
    a.heldBy?.pid === b.heldBy?.pid &&
    a.heldBy?.frontend === b.heldBy?.frontend
  );
}

/** One session's view of the world, shared by every client attached to it and kept running when none are. */
export class SessionStream {
  public readonly sessionId: string;
  public readonly host: SessionHost;
  public readonly picker: PickerService;
  private readonly sessionPath: string;
  private readonly projection: SessionProjection;
  private readonly listeners = new Set<StreamListener>();
  private readonly pollMs: number | undefined;
  private readonly git: GitMonitor;
  private readonly repoBusy: (() => boolean) | undefined;
  private liveTurn: LiveMessage[] = [];
  private unsubscribe: (() => void) | undefined;
  private unsubscribeLease: (() => void) | undefined;
  private unsubscribeForeign: (() => void) | undefined;
  private unwatch: (() => void) | undefined;
  private holder: LeaseRecord | undefined;
  private lease: LeaseState = { writable: true };
  private draining: Promise<void> = Promise.resolve();
  private drainQueued = false;
  private sentSeq = 0;
  private liveMessageId = 0;
  private turnStartedAt = 0;
  private gitCwd: string | undefined;
  private gitStop: (() => void) | undefined;
  private gitBranch: string | null = null;

  public constructor(
    sessionId: string,
    host: SessionHost,
    sessionPath: string,
    deps: SessionStreamDeps = {}
  ) {
    this.sessionId = sessionId;
    this.host = host;
    this.sessionPath = sessionPath;
    this.pollMs = deps.pollMs;
    this.git = deps.git ?? new GitMonitor();
    this.repoBusy = deps.repoBusy;
    this.projection = new SessionProjection(sessionPath, () => host.cwd);
    this.picker = new PickerService({
      cwd: () => host.cwd,
      agentDir: host.agentDir,
      agent: () => host.agentSession,
    });
  }

  /** Follow the host, not one agent: a rehydrated session is a new `AgentSession`. */
  public start(): void {
    this.unsubscribe ??= this.host.subscribe((event) => {
      this.onAgentEvent(event);
    });
    this.unsubscribeLease ??= this.host.onLeaseChange(() => {
      void this.pushLease();
    });
    this.unsubscribeForeign ??= this.host.onForeignWrite(() => {
      this.push({
        type: "error",
        message:
          "Another process is writing this session; its history may be inconsistent.",
      });
    });
  }

  /**
   * Watch the lease and the session file while a client is reading: un-greying
   * has to feel instant, and a turn another process runs reaches the browser
   * only through the file, which emits no agent event here. Idle sessions pay
   * nothing.
   */
  public watchFiles(active: boolean): void {
    if (active === (this.unwatch !== undefined)) {
      return;
    }
    if (!active) {
      this.unwatch?.();
      this.unwatch = undefined;
      this.syncGit();
      return;
    }
    const stops = [
      SessionLease.watch(this.sessionPath, () => {
        void this.pushLease();
      }),
      FileWatch.file(
        this.sessionPath,
        () => {
          this.scheduleDrain();
        },
        this.pollMs
      ),
    ];
    this.unwatch = (): void => {
      for (const stop of stops) {
        stop();
      }
    };
    this.syncGit();
  }

  /** Re-points the git watch after the session moves; the monitor is shared, so a repeat is free. */
  public syncGit(): void {
    const wanted = this.unwatch === undefined ? undefined : this.host.cwd;
    if (wanted === this.gitCwd) {
      return;
    }
    this.gitStop?.();
    this.gitStop = undefined;
    this.gitCwd = wanted;
    if (wanted === undefined) {
      return;
    }
    this.gitStop = this.git.watch(wanted, (state) => {
      // Whoever moved it — this client, the terminal, another window — every
      // path the pickers hold is from the branch that just left. The first
      // reading is a discovery rather than a move, and drops nothing.
      const moved = this.gitBranch !== null && state.branch !== this.gitBranch;
      this.gitBranch = state.branch;
      if (moved) {
        this.invalidatePickers("files");
      }
      this.emit(this.sessionState());
    });
  }

  /** Reads the repository again for a client that has reason to think its picture is old. */
  public async refreshGit(fetch: boolean): Promise<void> {
    await this.git.refresh(this.host.cwd, { fetch });
  }

  /** Project whatever pi has appended since the last read, telling every client; returns the head. */
  public async refresh(): Promise<number> {
    await this.flushDurable();
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
    await Promise.all([this.flushDurable(), this.readLease()]);
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
    const cwd = this.host.cwd;
    const { branch, dirtyCount, ahead, behind } = this.git.stateOf(cwd);
    const modelLabel = this.host.currentModelLabel;
    const turnElapsedMs =
      this.host.status === "idle" || this.turnStartedAt === 0
        ? undefined
        : Date.now() - this.turnStartedAt;
    return {
      type: "session_state",
      cwd,
      model: this.host.currentModelId ?? "",
      ...(modelLabel === undefined ? {} : { modelLabel }),
      thinking: this.host.currentThinkingLevel,
      cost: this.host.settings.cumulativeCost ?? 0,
      status: this.host.status,
      ...this.leaseState(),
      ...(this.repoBusy?.() === true ? { repoBusy: true } : {}),
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

  /**
   * Two sources, and both are needed: the host knows only about a mutation of
   * its own parked behind someone else, and reads writable for a session
   * merely sitting idle under a foreign lease — which the cached record covers.
   */
  private leaseState(): LeaseState {
    const own = this.host.leaseState;
    if (!own.writable) {
      return own;
    }
    const holder = this.holder;
    // Our own turn: the lease exists because this process took it.
    if (
      holder === undefined ||
      (holder.pid === process.pid && holder.frontend === "daemon")
    ) {
      return { writable: true };
    }
    return {
      writable: false,
      heldBy: { frontend: holder.frontend, pid: holder.pid },
    };
  }

  /**
   * Re-reads the holder; true when what a client would render changed. Our own
   * lease comes and goes on every turn we take and says nothing, so only a
   * holder that is not us ever moves this.
   */
  private async readLease(): Promise<boolean> {
    this.holder = await SessionLease.read(this.sessionPath);
    const next = this.leaseState();
    if (sameLease(this.lease, next)) {
      return false;
    }
    this.lease = next;
    return true;
  }

  private async pushLease(): Promise<void> {
    if (await this.readLease()) {
      this.emit(this.sessionState());
    }
  }

  public dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeLease?.();
    this.unsubscribeLease = undefined;
    this.unsubscribeForeign?.();
    this.unsubscribeForeign = undefined;
    this.watchFiles(false);
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

  /**
   * Serialised: two reads in flight would race on `sentSeq` and hand a client
   * the same lines twice, or out of order. The agent-event path and the file
   * watch both come through here, so they can only ever queue behind one
   * another.
   */
  private flushDurable(): Promise<void> {
    const done = this.draining.then(() => this.drainDurable());
    this.draining = done.catch(() => {});
    return done;
  }

  // A burst of appends is one drain: a trigger waits for the read already running, and one arriving after that starts gets its own.
  private scheduleDrain(): void {
    if (this.drainQueued) {
      return;
    }
    this.drainQueued = true;
    void this.draining
      .then(() => {
        this.drainQueued = false;
        return this.flushDurable();
      })
      .catch(() => {});
  }

  // One frame: a retire split from the durable message that caused it paints the step twice.
  private async drainDurable(): Promise<void> {
    await this.projection.drain();
    // The watermark is what every listener has been offered, so one client's read cannot swallow another's tail.
    const fresh = this.projection.since(this.sentSeq);
    this.sentSeq = this.projection.head;
    const batch: StreamEvent[] = [];
    for (const event of fresh) {
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
