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
  readonly isPartial: boolean;
};

/** One assistant message of the turn in flight; a turn holds one per step. */
export type LiveMessage = {
  readonly messageId: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  /** Durable copy landed; the shell stays for calls whose results are unwritten. */
  retired: boolean;
};

/** The one subagent this browser is reading: its log so far, and its turn in flight. */
export type SubagentTranscript = {
  readonly callId: string;
  durable: DurableEvent[];
  live: LiveMessage[];
};

/** A message this client has said and the server has not echoed back yet. */
export type PendingMessage = {
  readonly id: string;
  readonly text: string;
  readonly attachments?: readonly AttachmentView[];
  readonly timestamp: number;
  readonly queued?: boolean;
};

export type OptimisticMessage = {
  -readonly [K in keyof PendingMessage]: PendingMessage[K];
};

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

type LiveHolder = { live: LiveMessage[] };

type DurableHolder = LiveHolder & { durable: DurableEvent[] };

type SessionHolder = DurableHolder & { optimistic: OptimisticMessage[] };

/** One event of a turn in flight, folded into the bucket holding it. */
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
      // Keep the shell for its calls: each leaves on the durable result that
      // answers for it.
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

// A new bucket, not an edit in place: an earlier event of the same batch may
// have already replaced the message holding the call.
function settleLiveTool(target: LiveHolder, callId: string): void {
  target.live = target.live
    .map((message) => ({
      ...message,
      tools: message.tools.filter((tool) => tool.callId !== callId),
    }))
    .filter((message) => !message.retired || message.tools.length > 0);
}

/** One event of a child's log, folded into the modal reading it. */
export function applyChild(
  target: SubagentTranscript,
  event: StreamEvent
): void {
  if (!isDurableEvent(event)) {
    applyLive(target, event);
    return;
  }
  // A re-opened watch replays from the child's first entry; its ordinals say
  // what this modal has already painted.
  if (event.seq <= (target.durable.at(-1)?.seq ?? 0)) {
    return;
  }
  applyDurable(target, event);
}

function applyDurable(target: DurableHolder, event: DurableEvent): void {
  target.durable.push(event);
  if (event.type === "tool_result") {
    settleLiveTool(target, event.callId);
  }
}

/** One written line of the session's own log, plus the optimistic row it supersedes. */
export function ingestDurable(
  target: SessionHolder,
  event: DurableEvent
): void {
  applyDurable(target, event);
  if (event.type === "message" && event.role === "user") {
    // Filter, not splice: a store patch can be applied against a later array
    // than the index was read from.
    const at = target.optimistic.findIndex((pending) =>
      event.text.startsWith(pending.text)
    );
    target.optimistic = target.optimistic.filter(
      (_, index) => index !== (at === -1 ? 0 : at)
    );
  }
}

/** The message a session opens with: the first one written, or the first said. */
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

function namesOf(attachments: readonly AttachmentView[] | undefined): string {
  return (attachments ?? []).map((file) => file.name).join(", ");
}

/** A frame's files, as URLs this browser can fetch. */
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

function resolveViewUrls(
  view: ToolView,
  absolute: (url: string) => string
): ToolView {
  const walk = (blocks: readonly ViewBlock[]): readonly ViewBlock[] =>
    blocks.map((block) => {
      switch (block.kind) {
        case "attachment":
          return { ...block, url: absolute(block.url) };
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
