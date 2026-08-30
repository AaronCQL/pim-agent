import type {
  AgentMessage,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

import { EventLog, type LoggedEntry } from "../../core/src/session/EventLog";
import { Tools } from "../../core/src/shared/Tools";
import type {
  DurableEvent,
  ToolCallView,
} from "../../protocol/src/ServerEvent";

type PendingCall = {
  readonly name: string;
  readonly args: unknown;
};

/**
 * Projects pi's session file into the durable half of the wire protocol: one
 * line in, at most one `DurableEvent` out, tagged with that line's ordinal.
 *
 * Stateful because a tool result carries no arguments — only the assistant
 * message that requested it does — so rendering a result's `ToolView` requires
 * the call recorded earlier in the same file. That is also why a partial
 * replay still reads from ordinal 0 and filters afterwards: the arguments a
 * client needs may live behind its cursor.
 */
export class SessionProjection {
  private readonly log: EventLog;
  private readonly cwd: () => string;
  private readonly events: DurableEvent[] = [];
  private readonly calls = new Map<string, PendingCall>();
  private draining: Promise<void> = Promise.resolve();
  private highest = 0;

  public constructor(path: string, cwd: () => string) {
    this.log = new EventLog(path);
    this.cwd = cwd;
  }

  /** Highest line ordinal projected so far, whether or not it emitted. */
  public get head(): number {
    return this.highest;
  }

  public since(fromSeq: number): readonly DurableEvent[] {
    return this.events.filter((event) => event.seq > fromSeq);
  }

  /**
   * Read whatever pi has appended since the last drain. Serialized against
   * itself: two overlapping reads would double-project the same lines.
   */
  public async drain(): Promise<readonly DurableEvent[]> {
    const before = this.events.length;
    const done = this.draining.then(async () => {
      for (const logged of await this.log.read(this.highest)) {
        this.highest = logged.seq;
        const event = this.project(logged);
        if (event) {
          this.events.push(event);
        }
      }
    });
    this.draining = done.catch(() => {});
    await done;
    return this.events.slice(before);
  }

  private project(logged: LoggedEntry): DurableEvent | undefined {
    const { seq, entry } = logged;
    if (entry.type === "compaction") {
      return {
        seq,
        type: "notice",
        severity: "info",
        text: `Context compacted (${entry.tokensBefore} tokens before).`,
      };
    }
    if (!isMessageEntry(entry)) {
      return undefined;
    }
    const message = entry.message;
    switch (message.role) {
      case "user":
        return {
          seq,
          type: "message",
          messageId: entry.id,
          role: "user",
          text: textOf(message.content),
        };
      case "assistant": {
        const toolCalls: ToolCallView[] = [];
        for (const part of message.content) {
          if (part.type !== "toolCall") {
            continue;
          }
          this.calls.set(part.id, { name: part.name, args: part.arguments });
          toolCalls.push({
            callId: part.id,
            name: part.name,
            view: Tools.viewOf({
              name: part.name,
              args: part.arguments,
              isPartial: true,
              cwd: this.cwd(),
            }),
          });
        }
        const thinking = partsOf(message.content, "thinking");
        return {
          seq,
          type: "message",
          messageId: entry.id,
          role: "assistant",
          text: partsOf(message.content, "text"),
          ...(thinking ? { thinking } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        };
      }
      case "toolResult": {
        const call = this.calls.get(message.toolCallId);
        return {
          seq,
          type: "tool_result",
          callId: message.toolCallId,
          name: message.toolName,
          isError: message.isError,
          view: Tools.viewOf({
            name: message.toolName,
            args: call?.args ?? {},
            result: {
              content: message.content,
              details: message.details,
            } as AgentToolResult<unknown>,
            isPartial: false,
            cwd: this.cwd(),
          }),
        };
      }
      default:
        return undefined;
    }
  }
}

type MessageEntry = { readonly id: string; readonly message: AgentMessage };

function isMessageEntry(entry: FileEntry): entry is FileEntry & MessageEntry {
  return entry.type === "message";
}

function partsOf(
  content: readonly { readonly type: string }[],
  kind: "text" | "thinking"
): string {
  let out = "";
  for (const part of content) {
    if (part.type === kind) {
      out += (part as Record<string, string>)[kind] ?? "";
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return partsOf(content as readonly { readonly type: string }[], "text");
}
