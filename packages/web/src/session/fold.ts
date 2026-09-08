import type { ToolView, ViewBlock } from "#core/view/ViewBlock";
import type {
  AttachmentView,
  DurableEvent,
  EphemeralEvent,
  ServerEvent,
  StreamEvent,
} from "#protocol/ServerEvent";
import { isDurableEvent } from "#protocol/ServerEvent";

export type LiveTool = {
  readonly callId: string;
  readonly name: string;
  readonly view: ToolView;
  readonly isError: boolean;
  /** The call is on the wire but nothing has settled its result yet. */
  readonly isPartial: boolean;
};

/**
 * One assistant message of the turn in flight. There is a list of them, not
 * one: a turn is a model call per step, and pi appends the entry for a step
 * long after it streamed — usually only when the whole turn settles — so a
 * bucket that held a single message would drop the prose of every step but
 * the last on the floor.
 */
export type LiveMessage = {
  readonly messageId: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  /**
   * The durable copy of this message has landed, so its prose is gone from
   * here and what is left is a shell holding the calls it made. Those outlive
   * it: pi writes a step down before it writes the results of the calls that
   * step asked for, and the durable message restates each call without one,
   * so until the results are written this is the only settled view of them
   * there is — and the only place an update to one still running can land.
   */
  retired: boolean;
};

/**
 * The one subagent this browser is reading: the child's own log as far as it
 * has been sent, and its turn in flight. The same two halves the session has,
 * because a child's transcript is a transcript — and separate from them,
 * because nothing a child said belongs in the conversation that spawned it.
 */
export type SubagentTranscript = {
  readonly callId: string;
  durable: DurableEvent[];
  live: LiveMessage[];
};

/**
 * A message this client has said and the server has not echoed back yet. Not
 * a `DurableEvent` pretending to be one: it has no ordinal, its stamp is a
 * guess, and — unlike anything the log can hold — it may still be sitting in
 * pi's queue rather than in the conversation, which is what `queued` names.
 */
export type PendingMessage = {
  readonly id: string;
  readonly text: string;
  /** The files sent with it, so the row is not a caption with nothing above it. */
  readonly attachments?: readonly AttachmentView[];
  /**
   * When it was said, which is the closest thing to a stamp there is until
   * the durable event that supersedes it arrives with pi's own.
   */
  readonly timestamp: number;
  /** Said into a running turn, so pi holds it; absent when it began one. */
  readonly queued?: boolean;
};

/** The same message, as the store holds it: grown in place by a second send. */
export type OptimisticMessage = {
  -readonly [K in keyof PendingMessage]: PendingMessage[K];
};

/**
 * The live message with this id, appended if this is the first sight of it.
 * Any of the turn's events may be the first to name a message — a replay
 * arrives mid-turn, and a step that only calls a tool never streams a word.
 */
function liveMessage(live: LiveMessage[], messageId: string): LiveMessage {
  const existing = live.find((message) => message.messageId === messageId);
  if (existing) {
    return existing;
  }
  const message: LiveMessage = {
    messageId,
    text: "",
    thinking: "",
    tools: [],
    retired: false,
  };
  live.push(message);
  return message;
}

/**
 * The bucket a turn in flight is held in — the session's, or a watched
 * subagent's. Taken as a whole rather than as its array because dropping a
 * message from one is a write to the field: a store draft is patched, and a
 * splice through the patch is not the same edit as the array it replaces.
 */
type LiveHolder = { live: LiveMessage[] };

type DurableHolder = LiveHolder & { durable: DurableEvent[] };

type SessionHolder = DurableHolder & { optimistic: OptimisticMessage[] };

/**
 * One event of a turn in flight, folded into the bucket holding it. Shared by
 * the session and by a watched subagent, because a child's turn is a turn:
 * what differs between them is which bucket it lands in, and nothing else.
 */
export function applyLive(target: LiveHolder, event: EphemeralEvent): void {
  switch (event.type) {
    case "message_start":
      liveMessage(target.live, event.messageId);
      return;
    case "text_delta":
      liveMessage(target.live, event.messageId).text += event.delta;
      return;
    case "thinking_delta":
      liveMessage(target.live, event.messageId).thinking += event.delta;
      return;
    case "tool_call": {
      // Onto the message being streamed: pi calls tools from the step it just
      // wrote, and that is the order the transcript draws them in.
      const message = liveMessage(target.live, event.messageId);
      if (message.tools.every((tool) => tool.callId !== event.callId)) {
        message.tools.push({
          callId: event.callId,
          name: event.name,
          view: event.view,
          isError: false,
          isPartial: true,
        });
      }
      return;
    }
    case "tool_update":
      patchLiveTool(target.live, event.callId, { view: event.view });
      return;
    case "tool_end":
      patchLiveTool(target.live, event.callId, {
        view: event.view,
        isError: event.isError,
        isPartial: false,
      });
      return;
    case "message_retire":
      // The durable copy of this message arrived in the same frame, so
      // dropping its prose here is a swap, not a gap. Its calls are not
      // superseded with it — each of them leaves separately, on the durable
      // result that answers for it.
      target.live = target.live.flatMap((message) => {
        if (message.messageId !== event.messageId) {
          return [message];
        }
        return message.tools.length === 0
          ? []
          : [{ ...message, text: "", thinking: "", retired: true }];
      });
      return;
    default:
      return;
  }
}

/** Rewrites one live call wherever in the turn it was made. */
function patchLiveTool(
  live: LiveMessage[],
  callId: string,
  patch: Partial<Omit<LiveTool, "callId" | "name">>
): void {
  for (const message of live) {
    const at = message.tools.findIndex((tool) => tool.callId === callId);
    const existing = message.tools[at];
    if (existing) {
      message.tools[at] = { ...existing, ...patch };
      return;
    }
  }
}

/**
 * The call has been written down, so the live view of it is superseded.
 *
 * A new bucket rather than an edit inside the one that is there: this runs
 * off a durable event, so the `message_retire` that superseded the message
 * holding the call can be an earlier event of the same batch — and a write
 * through a message that batch has already replaced is a patch on the path
 * it sat at, applied after the assignment that drops it. The message comes
 * back as a shell with nothing in it.
 */
function settleLiveTool(target: LiveHolder, callId: string): void {
  target.live = target.live
    .map((message) => ({
      ...message,
      tools: message.tools.filter((tool) => tool.callId !== callId),
    }))
    // A retired message is kept for its calls alone, so the last result to be
    // written is what takes the shell with it.
    .filter((message) => !message.retired || message.tools.length > 0);
}

/**
 * One event of a child's log, folded into the modal reading it. Applied here
 * rather than through `ingest` for the reason the envelope exists at all: a
 * child's messages carry ordinals of their own, and taken for the session's
 * they would land in the conversation.
 */
export function applyChild(
  target: SubagentTranscript,
  event: StreamEvent
): void {
  if (!isDurableEvent(event)) {
    applyLive(target, event);
    return;
  }
  // A watch cannot be resumed across a reconnect, so a re-opened one starts
  // at the child's first entry; the child's own ordinals say which of those
  // this modal has already painted.
  if (event.seq <= (target.durable.at(-1)?.seq ?? 0)) {
    return;
  }
  applyDurable(target, event);
}

/**
 * One written line, folded into the transcript holding it: the session's or a
 * watched child's. The call it answers for, if it answers for one, is no
 * longer in flight.
 */
function applyDurable(target: DurableHolder, event: DurableEvent): void {
  target.durable.push(event);
  if (event.type === "tool_result") {
    settleLiveTool(target, event.callId);
  }
}

/**
 * One written line of the session's own log: the fold above, plus the
 * optimistic row it supersedes.
 */
export function ingestDurable(
  target: SessionHolder,
  event: DurableEvent
): void {
  applyDurable(target, event);
  if (event.type === "message" && event.role === "user") {
    // Splicing a store draft in place is not safe across a batch of
    // events — the write is a patch, and it can be applied against a
    // later array than the one the index was read from.
    const at = target.optimistic.findIndex((pending) =>
      event.text.startsWith(pending.text)
    );
    target.optimistic = target.optimistic.filter(
      (_, index) => index !== (at === -1 ? 0 : at)
    );
  }
}

/**
 * The message a session opens with: the first one written, and before it is
 * written the first one said. One rule, because a name that changed when the
 * echo landed would be two.
 */
export function openingMessage(
  durable: readonly DurableEvent[],
  optimistic: readonly OptimisticMessage[]
): string | undefined {
  for (const event of durable) {
    if (event.type === "message" && event.role === "user") {
      return event.text || namesOf(event.attachments);
    }
  }
  const first = optimistic[0];
  return first && (first.text || namesOf(first.attachments));
}

/**
 * What to call a message that is only files, which is how the server names
 * one too: a row reading "Untitled" says less than the photo it stands for.
 */
function namesOf(attachments: readonly AttachmentView[] | undefined): string {
  return (attachments ?? []).map((file) => file.name).join(", ");
}

/**
 * A frame's files, where this browser can fetch them: what a message
 * carried, and what a tool sent back — a `send_file` view holds the same
 * kind of URL, and a durable message holds the views of the calls it made.
 * Server frames carry server-relative paths, and a child's events are
 * served by the same gateway the session's are.
 */
export function resolveUrls<TEvent extends ServerEvent>(
  event: TEvent,
  absolute: (url: string) => string
): TEvent {
  switch (event.type) {
    case "message":
      if (event.attachments === undefined && event.toolCalls === undefined) {
        return event;
      }
      return {
        ...event,
        ...(event.attachments === undefined
          ? {}
          : {
              attachments: event.attachments.map((file) => ({
                ...file,
                url: absolute(file.url),
              })),
            }),
        ...(event.toolCalls === undefined
          ? {}
          : {
              toolCalls: event.toolCalls.map((call) => ({
                ...call,
                view: resolveViewUrls(call.view, absolute),
              })),
            }),
      };
    case "tool_call":
    case "tool_update":
    case "tool_end":
    case "tool_result":
      return { ...event, view: resolveViewUrls(event.view, absolute) };
    default:
      return event;
  }
}

/**
 * A tool view with every `attachment` block's URL made absolute.
 *
 * Rebuilt rather than patched, and with no attempt to hand back the same
 * arrays when nothing changed: the view was parsed out of a JSON frame
 * moments ago and is already nobody's reference, so preserving identity
 * would save a handful of pointer copies and buy no reconciliation.
 */
function resolveViewUrls(
  view: ToolView,
  absolute: (url: string) => string
): ToolView {
  const walk = (blocks: readonly ViewBlock[]): readonly ViewBlock[] =>
    blocks.map((block) => {
      switch (block.kind) {
        case "attachment":
          return { ...block, url: absolute(block.url) };
        // The containers, so a block nested in one is not quietly skipped.
        case "section":
          return { ...block, content: walk(block.content) };
        case "list":
          return { ...block, items: walk(block.items) };
        default:
          return block;
      }
    });

  return {
    ...view,
    title: walk(view.title),
    ...(view.summary === undefined ? {} : { summary: walk(view.summary) }),
    ...(view.body === undefined ? {} : { body: walk(view.body) }),
  };
}
