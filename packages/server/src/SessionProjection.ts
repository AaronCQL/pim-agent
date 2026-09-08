import type {
  AgentMessage,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { FileEntry } from "@earendil-works/pi-coding-agent";

import { Attachments } from "#core/attachments/Attachments";
import { EventLog, type LoggedEntry } from "#core/session/EventLog";
import { MessageText } from "#core/session/MessageText";
import { Tools } from "#core/shared/Tools";
import type {
  AttachmentView,
  DurableEvent,
  ToolCallView,
} from "#protocol/ServerEvent";
import { attachmentUrl } from "./AttachmentEndpoint";

type PendingCall = {
  readonly name: string;
  readonly args: unknown;
};

/** Projects pi's session file into durable events: one line in, at most one `DurableEvent` out, tagged with that line's ordinal. */
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

  /** Highest line ordinal projected, whether or not it emitted. */
  public get head(): number {
    return this.highest;
  }

  public since(fromSeq: number): readonly DurableEvent[] {
    let low = 0;
    let high = this.events.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.events[mid]!.seq > fromSeq) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return this.events.slice(low);
  }

  /** Read whatever pi has appended since the last drain; serialized, as overlapping reads double-project lines. */
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
    const timestamp = Date.parse(entry.timestamp);
    switch (message.role) {
      case "user": {
        const said = Attachments.parse(MessageText.textOf(message.content));
        const attachments: readonly AttachmentView[] = said.files.map(
          (file) => ({
            name: Attachments.nameOf(file.path),
            url: attachmentUrl(file.path),
            isImage: file.isImage,
          })
        );
        return {
          seq,
          type: "message",
          messageId: entry.id,
          role: "user",
          text: said.text,
          timestamp,
          ...(attachments.length === 0 ? {} : { attachments }),
        };
      }
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
        const thinking = MessageText.textOf(message.content, "thinking");
        const error =
          message.stopReason === "error"
            ? (message.errorMessage ?? "The model call failed.")
            : undefined;
        return {
          seq,
          type: "message",
          messageId: entry.id,
          role: "assistant",
          text: MessageText.textOf(message.content),
          timestamp,
          ...(thinking ? { thinking } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(error === undefined ? {} : { error }),
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
            isError: message.isError,
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

type MessageEntry = {
  readonly id: string;
  readonly timestamp: string;
  readonly message: AgentMessage;
};

function isMessageEntry(entry: FileEntry): entry is FileEntry & MessageEntry {
  return entry.type === "message";
}
