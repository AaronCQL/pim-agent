import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { PickerService } from "#core/picker/PickerService";
import { MessageText } from "#core/session/MessageText";
import type { LeaseState, SessionHost } from "#core/session/SessionHost";
import { SessionLease, type LeaseRecord } from "#core/session/SessionLease";
import type { SessionUi, UiAsk } from "#core/session/SessionUi";
import { FileWatch } from "#core/shared/FileWatch";
import { GitMonitor } from "#core/shared/GitMonitor";
import { Tools } from "#core/shared/Tools";
import type { NoticeSeverity, ToolView } from "#core/view/ViewBlock";
import type { Command } from "#protocol/Command";
import type {
  EphemeralEvent,
  ServerEvent,
  StreamEvent,
} from "#protocol/ServerEvent";
import { SessionProjection } from "./SessionProjection";

export type StreamListener = (event: ServerEvent) => void;

export type UiAnswer = Omit<
  Extract<Command, { readonly type: "ui_response" }>,
  "id" | "type" | "sessionId" | "requestId"
>;

type PendingRequest = {
  /** Re-sent to clients that attach while it is pending. */
  readonly asked: Extract<EphemeralEvent, { readonly type: "ui_request" }>;
  /** Only the first call has any effect. */
  readonly settle: (answer: UiAnswer | undefined, because?: string) => void;
  readonly expiry: ReturnType<typeof setTimeout>;
  grace: ReturnType<typeof setTimeout> | undefined;
};

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
  /** File watch poll interval. Defaults to 1s. */
  readonly pollMs?: number;
  /** Shared across sessions in the same directory. */
  readonly git?: GitMonitor;
  /** Whether any session in this cwd is mid-turn, this one included. */
  readonly repoBusy?: () => boolean;
  readonly requestCeilingMs?: number;
  readonly detachGraceMs?: number;
};

/** Max wait for a dialog answer; a shorter `opts.timeout` wins. */
const REQUEST_CEILING_MS = 180_000;

/** How long a pending dialog survives its last client detaching (reloads, reconnects). */
const DETACH_GRACE_MS = 15_000;

function sameLease(a: LeaseState, b: LeaseState): boolean {
  return (
    a.writable === b.writable &&
    a.heldBy?.pid === b.heldBy?.pid &&
    a.heldBy?.frontend === b.heldBy?.frontend
  );
}

/** One session's live state, shared by every attached client; keeps running with none. */
export class SessionStream implements SessionUi {
  public readonly sessionId: string;
  public readonly host: SessionHost;
  public readonly picker: PickerService;
  private readonly sessionPath: string;
  private readonly projection: SessionProjection;
  private readonly listeners = new Set<StreamListener>();
  private readonly observers = new Set<StreamListener>();
  private readonly pollMs: number | undefined;
  private readonly git: GitMonitor;
  private readonly repoBusy: (() => boolean) | undefined;
  private readonly requestCeilingMs: number;
  private readonly detachGraceMs: number;
  private readonly pending = new Map<string, PendingRequest>();
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
  private uiSeq = 0;
  private readonly dispatching: string[] = [];
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
    this.requestCeilingMs = deps.requestCeilingMs ?? REQUEST_CEILING_MS;
    this.detachGraceMs = deps.detachGraceMs ?? DETACH_GRACE_MS;
    this.projection = new SessionProjection(sessionPath, () => host.cwd);
    this.picker = new PickerService({
      cwd: () => host.cwd,
      agentDir: host.agentDir,
      agent: () => host.agentSession,
    });
  }

  /** Subscribes to the host, not the agent, which is replaced on rehydrate. */
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

  /** Watches the lease and session file while a client is reading, to pick up other processes' turns. */
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

  /** Re-points the git watch after the cwd changes. */
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
      // A branch switch stales file pickers; the first reading is not a switch.
      const moved = this.gitBranch !== null && state.branch !== this.gitBranch;
      this.gitBranch = state.branch;
      if (moved) {
        this.invalidatePickers("files");
      }
      this.emit(this.sessionState());
    });
  }

  public async refreshGit(fetch: boolean): Promise<void> {
    await this.git.refresh(this.host.cwd, { fetch });
  }

  /** Projects and broadcasts new entries; returns the head. */
  public async refresh(): Promise<number> {
    await this.flushDurable();
    return this.projection.head;
  }

  public subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    this.holdRequests();
    return () => {
      this.listeners.delete(listener);
      this.holdRequests();
    };
  }

  /** Like `subscribe`, but does not count as an attached client. */
  public observe(listener: StreamListener): () => void {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  /** Tags notices and requests raised during `run` with `command`. Nests; the innermost wins. */
  public async dispatch<T>(command: string, run: () => Promise<T>): Promise<T> {
    this.dispatching.push(command);
    try {
      return await run();
    } finally {
      this.dispatching.pop();
    }
  }

  /** Dropped when nobody is attached. */
  public notify(text: string, severity: NoticeSeverity): void {
    this.emit({
      type: "ui_notice",
      id: this.nextUiId("notice"),
      severity,
      text,
      ...this.asked(),
    });
  }

  private asked(): { readonly command?: string } {
    const command = this.dispatching.at(-1);
    return command === undefined ? {} : { command };
  }

  public async select(
    title: string,
    options: readonly string[],
    opts?: UiAsk
  ): Promise<string | undefined> {
    return (
      await this.ask({ method: "select", title, options: [...options] }, opts)
    )?.value;
  }

  public async confirm(
    title: string,
    message: string,
    opts?: UiAsk
  ): Promise<boolean> {
    return (
      (await this.ask({ method: "confirm", title, message }, opts))
        ?.confirmed === true
    );
  }

  public async input(
    title: string,
    placeholder?: string,
    opts?: UiAsk
  ): Promise<string | undefined> {
    return (
      await this.ask(
        {
          method: "input",
          title,
          ...(placeholder === undefined ? {} : { placeholder }),
        },
        opts
      )
    )?.value;
  }

  /** False when the request is unknown or already settled. */
  public answer(requestId: string, answer: UiAnswer): boolean {
    const request = this.pending.get(requestId);
    if (request === undefined) {
      return false;
    }
    request.settle(answer);
    return true;
  }

  /** Undefined when cancelled, timed out, or nobody is attached. */
  private ask(
    request: Omit<
      Extract<ServerEvent, { readonly type: "ui_request" }>,
      "type" | "requestId" | "command"
    >,
    opts: UiAsk | undefined
  ): Promise<UiAnswer | undefined> {
    if (this.listeners.size === 0) {
      this.answered(request.title, "nobody was attached");
      return Promise.resolve(undefined);
    }
    const requestId = this.nextUiId("request");
    const waitMs = Math.min(this.requestCeilingMs, opts?.timeout ?? Infinity);
    const asked = {
      ...request,
      ...this.asked(),
      type: "ui_request",
      requestId,
    } as const;
    return new Promise<UiAnswer | undefined>((resolve) => {
      const settle = (answer: UiAnswer | undefined, because?: string): void => {
        const entry = this.pending.get(requestId);
        if (entry === undefined) {
          return;
        }
        this.pending.delete(requestId);
        clearTimeout(entry.expiry);
        clearTimeout(entry.grace);
        opts?.signal?.removeEventListener("abort", abort);
        this.emit({ type: "ui_request_done", requestId });
        if (because !== undefined) {
          this.answered(asked.title, because);
        }
        resolve(answer?.cancelled === true ? undefined : answer);
      };
      const abort = (): void => {
        settle(undefined, "the extension withdrew it");
      };
      this.pending.set(requestId, {
        asked,
        settle,
        expiry: setTimeout(() => {
          settle(undefined, "it timed out");
        }, waitMs),
        grace: undefined,
      });
      opts?.signal?.addEventListener("abort", abort, { once: true });
      this.emit(asked);
      // `abort` listeners don't fire for an already-aborted signal.
      if (opts?.signal?.aborted === true) {
        abort();
      }
    });
  }

  private answered(title: string, why: string): void {
    this.notify(`Answered “${title}” for you: ${why}.`, "warn");
  }

  /** Starts the detach grace when the last client leaves; cancels it when one returns. */
  private holdRequests(): void {
    const detached = this.listeners.size === 0;
    for (const [requestId, request] of this.pending) {
      if (!detached) {
        clearTimeout(request.grace);
        request.grace = undefined;
        continue;
      }
      request.grace ??= setTimeout(() => {
        this.pending.get(requestId)?.settle(undefined, "everyone had left");
      }, this.detachGraceMs);
    }
  }

  private nextUiId(kind: "notice" | "request"): string {
    this.uiSeq += 1;
    return `${this.sessionId}:${kind}:${this.uiSeq}`;
  }

  public isRunning(callId: string): boolean {
    return this.findTool(callId)?.done === false;
  }

  /** The durable tail after `fromSeq`, then the in-flight turn coalesced, then state. */
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
    for (const request of this.pending.values()) {
      events.push(request.asked);
    }
    events.push(this.sessionState());
    return events;
  }

  public push(event: ServerEvent): void {
    this.emit(event);
  }

  public invalidatePickers(scope: "files" | "commands" | "all"): void {
    this.picker.invalidate();
    this.emit({ type: "picker_invalidate", scope, cwd: this.host.cwd });
  }

  public sessionState(): EphemeralEvent {
    const tps = this.host.tps;
    const usage = this.host.usage();
    const cwd = this.host.cwd;
    const { branch, dirtyCount, ahead, behind, revision } =
      this.git.stateOf(cwd);
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
      ...(branch === null
        ? {}
        : { branch, dirtyCount, ahead, behind, repoRevision: revision }),
    };
  }

  /** The host only knows about its own blocked writes; the lease record covers an idle session under a foreign lease. */
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

  /** Re-reads the holder; true when the visible lease state changed. */
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
    // Safe: Map iteration tolerates deleting the current entry.
    for (const request of this.pending.values()) {
      request.settle(undefined, "the session stopped");
    }
    this.listeners.clear();
    this.observers.clear();
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
          // Worktree writes don't touch `.git`, so the watch won't see them.
          void this.git.refresh(this.host.cwd);
        }
        return;
      }
      case "entry_appended":
        void this.flushDurable();
        return;
      // Don't await: pi appends the entry only after this listener returns.
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
          // Clear only after the superseding durable events are sent.
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

  // Pi re-sends the whole message each update; only an appended suffix becomes a delta.
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

  /** Serialized: concurrent reads would race on `sentSeq` and duplicate or reorder lines. */
  private flushDurable(): Promise<void> {
    const done = this.draining.then(() => this.drainDurable());
    this.draining = done.catch(() => {});
    return done;
  }

  // Coalesces a burst of file changes into one drain queued behind the current one.
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

  // One frame, so a retire never arrives apart from the durable message replacing it.
  private async drainDurable(): Promise<void> {
    await this.projection.drain();
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

  // The oldest *ended* message; a retired one with tools stays until they settle.
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
    // Observers first, so their broadcasts precede this event on every socket.
    for (const observer of this.observers) {
      observer(event);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
