import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  FileEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

/**
 * One durable line of a pi session file, tagged with its physical append
 * ordinal. The header is line 1, so the first entry is `seq` 2.
 */
export type LoggedEntry = {
  readonly seq: number;
  readonly entry: FileEntry;
};

/**
 * The assistant turn currently being produced. Never durable: pi persists an
 * assistant message once, on completion, so the deltas that built it have no
 * `seq` and cannot be replayed from disk. A reconnecting client receives this
 * as one coalesced block instead of a delta stream.
 */
export type InFlightTurn = {
  readonly startedAt: number;
  readonly text: string;
  readonly thinking: string;
  readonly tools: readonly InFlightToolCall[];
};

export type InFlightToolCall = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: number;
};

type Cursor = {
  readonly offset: number;
  readonly seq: number;
};

const HEADER_PROBE_BYTES = 64 * 1024;

function isHeader(entry: FileEntry): entry is SessionHeader {
  return entry.type === "session";
}

/**
 * A reader over one pi session file, plus the in-memory buffer for the turn
 * that has not been written yet. Deliberately **not** a store: pi's JSONL is
 * already append-only, so `seq` is the physical line ordinal and resuming is
 * `seq > n`. Compaction is an appended entry, never a rewrite, so ordinals
 * assigned to a line never change once that line exists.
 */
export class EventLog {
  public readonly path: string;
  private cursor: Cursor = { offset: 0, seq: 0 };
  private inFlightTurn: InFlightTurn | undefined;

  public constructor(path: string) {
    this.path = path;
  }

  /** Durable entries with `seq > afterSeq`, oldest first. */
  public async read(afterSeq = 0): Promise<readonly LoggedEntry[]> {
    const start =
      this.cursor.seq <= afterSeq ? this.cursor : { offset: 0, seq: 0 };
    const file = Bun.file(this.path);
    if (!(await file.exists())) {
      return [];
    }
    const text = await file.slice(start.offset).text();

    // A trailing fragment is a write in progress: it has no ordinal yet, so
    // stopping short of it is what makes an interrupted read lossless.
    const lastBreak = text.lastIndexOf("\n");
    if (lastBreak === -1) {
      return [];
    }
    const complete = text.slice(0, lastBreak + 1);
    const lines = complete.split("\n");
    lines.pop();

    const entries: LoggedEntry[] = [];
    for (const [index, line] of lines.entries()) {
      const seq = start.seq + index + 1;
      if (seq <= afterSeq) {
        continue;
      }
      const parsed = parseSessionEntries(line)[0];
      if (parsed) {
        entries.push({ seq, entry: parsed });
      }
    }

    this.cursor = {
      offset: start.offset + new TextEncoder().encode(complete).length,
      seq: start.seq + lines.length,
    };
    return entries;
  }

  /** Highest durable `seq`, or 0 when the session has not been flushed yet. */
  public async head(): Promise<number> {
    await this.read(this.cursor.seq);
    return this.cursor.seq;
  }

  /** Line 1 only, so listing many sessions never reads their bodies. */
  public async header(): Promise<SessionHeader | undefined> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) {
      return undefined;
    }
    const head = await file.slice(0, HEADER_PROBE_BYTES).text();
    const end = head.indexOf("\n");
    if (end === -1) {
      return undefined;
    }
    const entry = parseSessionEntries(head.slice(0, end))[0];
    return entry && isHeader(entry) ? entry : undefined;
  }

  public get inFlight(): InFlightTurn | undefined {
    return this.inFlightTurn;
  }

  /**
   * Feed live `AgentSession` events so the in-flight turn stays current. Every
   * event that reaches here is either already durable or about to become so;
   * the buffer exists only to cover the window between the two.
   */
  public observe(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.inFlightTurn = {
          startedAt: Date.now(),
          text: "",
          thinking: "",
          tools: [],
        };
        return;
      case "message_update": {
        if (event.message.role !== "assistant") {
          return;
        }
        const turn = this.ensureTurn();
        this.inFlightTurn = {
          ...turn,
          text: textOf(event.message.content, "text"),
          thinking: textOf(event.message.content, "thinking"),
        };
        return;
      }
      case "tool_execution_start": {
        const turn = this.ensureTurn();
        this.inFlightTurn = {
          ...turn,
          tools: [
            ...turn.tools,
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              startedAt: Date.now(),
            },
          ],
        };
        return;
      }
      case "tool_execution_end": {
        const turn = this.ensureTurn();
        this.inFlightTurn = {
          ...turn,
          tools: turn.tools.filter((t) => t.toolCallId !== event.toolCallId),
        };
        return;
      }
      case "agent_settled":
        this.inFlightTurn = undefined;
        return;
      default:
        return;
    }
  }

  private ensureTurn(): InFlightTurn {
    this.inFlightTurn ??= {
      startedAt: Date.now(),
      text: "",
      thinking: "",
      tools: [],
    };
    return this.inFlightTurn;
  }
}

function textOf(
  content: AssistantMessage["content"],
  kind: "text" | "thinking"
): string {
  let out = "";
  for (const part of content) {
    if (kind === "text" && part.type === "text") {
      out += part.text;
    } else if (kind === "thinking" && part.type === "thinking") {
      out += part.thinking;
    }
  }
  return out;
}
