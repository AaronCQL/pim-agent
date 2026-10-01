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

/** One assistant message of the in-flight turn. */
export type LiveMessage = {
  readonly messageId: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  /** The durable copy landed; kept only while its tool calls lack results. */
  retired: boolean;
};

export type SubagentTranscript = {
  readonly callId: string;
  durable: DurableEvent[];
  live: LiveMessage[];
};

/** A sent message not yet echoed back by the server. */
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
      // Keep messages with tools until their results arrive.
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

// Rebuilt rather than edited in place: an earlier event in the batch may have replaced the message.
function settleLiveTool(target: LiveHolder, callId: string): void {
  target.live = target.live
    .map((message) => ({
      ...message,
      tools: message.tools.filter((tool) => tool.callId !== callId),
    }))
    .filter((message) => !message.retired || message.tools.length > 0);
}

export function applyChild(
  target: SubagentTranscript,
  event: StreamEvent
): void {
  if (!isDurableEvent(event)) {
    applyLive(target, event);
    return;
  }
  // A re-opened watch replays from the start; skip what we already have.
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

/** Also drops the optimistic row a user message supersedes. */
export function ingestDurable(
  target: SessionHolder,
  event: DurableEvent
): void {
  applyDurable(target, event);
  if (event.type === "message" && event.role === "user") {
    // The server may prepend taken-back queued text. A message matching no row came from another
    // surface, or was expanded from a template; the latter is cleared once the turn goes idle.
    const at = target.optimistic.findIndex(
      (pending) =>
        event.text.startsWith(pending.text) ||
        event.text.includes(`\n\n${pending.text}`)
    );
    if (at !== -1) {
      // Filter, not splice: a store patch may apply to a newer array.
      target.optimistic = target.optimistic.filter((_, index) => index !== at);
    }
  }
}

/** The first durable user message, else the first optimistic one. */
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
