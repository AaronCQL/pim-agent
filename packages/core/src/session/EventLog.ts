import type { BunFile } from "bun";

import type {
  AgentSessionEvent,
  FileEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

import { MessageText } from "./MessageText";

/**
 * Reads a session file, answering `absent` when there is no file to read.
 *
 * Testing `exists()` first cannot do this: a session discarded, rotated or
 * cleaned up under a reader lands in the window between that stat and the
 * read, and the read then throws where the stat had just promised it would
 * not. Catching the miss is the only version without the window — and it
 * costs one syscall less on the path that listing every session runs over
 * every byte of.
 */
async function ifPresent<T>(read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return absent;
    }
    throw err;
  }
}

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

/**
 * How much of a session file is worth parsing to describe it: the header is
 * line 1, and the first user message — the session's name — is in the first
 * entries or it is not worth finding.
 */
const PROBE_BYTES = 64 * 1024;

/**
 * How much of the end is read to find where the agent last stopped, and how
 * far back through it that search may look: enough to clear the queued
 * messages and setting changes that can trail the agent's last word, and no
 * more. The window is a guess and the line count is the rule — a session
 * ending in a message larger than the window is re-read whole rather than
 * answered for out of a fragment.
 */
const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 10;

/** Long enough to tell two sessions apart, short enough for a sidebar row. */
const TITLE_LIMIT = 120;

/** What the session catalogue shows for one file without opening a session. */
export type SessionDigest = {
  /** The first user message, trimmed; absent when the session has none yet. */
  readonly title?: string;
  /**
   * When the agent last stopped writing: the timestamp of the file's last
   * assistant or tool-result entry. Absent until one exists.
   *
   * Read as "the end of the last completed turn", which is what it is for
   * every session nothing is currently running — and only for those. Turn
   * boundaries are events in pi's loop, never entries in its file: a turn
   * runs on past an assistant message with no tool calls when a steering
   * message is queued behind it, and stops on one *with* tool calls when a
   * tool terminates it. So there is no line here that means "the turn ended"
   * — but when nobody is writing, the last thing the agent wrote is by
   * definition where it last stopped, whether it finished, failed, or was
   * interrupted. A caller that knows a turn is in flight must hold the value
   * it read before that turn started; this one moves with the turn.
   *
   * User entries are skipped rather than dated, which is the whole point: a
   * message typed into an idle session says nothing about when the agent
   * last answered.
   */
  readonly settledAt?: number;
};

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
    const text = await ifPresent(() => file.slice(start.offset).text(), "");

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
      offset: start.offset + Buffer.byteLength(complete, "utf8"),
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
    const head = await ifPresent(() => file.slice(0, PROBE_BYTES).text(), "");
    const end = head.indexOf("\n");
    if (end === -1) {
      return undefined;
    }
    const entry = parseSessionEntries(head.slice(0, end))[0];
    return entry && isHeader(entry) ? entry : undefined;
  }

  /**
   * Title and settle time for the catalogue, from the two ends of the file
   * and without reading between them: the name is in the first entries and
   * the settle time is in the last, so a listing reads two bounded windows
   * per session rather than the whole of each. Deliberately not `read()` —
   * a listing must not pay to project a conversation it is only naming, and
   * the session being listed is usually the largest file in the directory.
   */
  public async digest(): Promise<SessionDigest> {
    const file = Bun.file(this.path);
    const [probe, settledAt] = await Promise.all([
      ifPresent(() => file.slice(0, PROBE_BYTES).text(), ""),
      settleTime(file),
    ]);
    const title = firstUserMessage(probe);
    return {
      ...(title === undefined ? {} : { title }),
      ...(settledAt === undefined ? {} : { settledAt }),
    };
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
          text: MessageText.textOf(event.message.content),
          thinking: MessageText.textOf(event.message.content, "thinking"),
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

/**
 * When the agent last wrote, read backwards from the end of the file — which
 * is where the answer always is, and usually on the very last line, since a
 * session usually ends in the agent's reply.
 *
 * The tail window holds those lines for every session that does not end in a
 * huge message. One that does is re-read whole, which is rare enough to pay
 * for when it happens rather than to scan every file to be ready for.
 */
async function settleTime(file: BunFile): Promise<number | undefined> {
  const near = Math.max(0, file.size - TAIL_BYTES);
  const lines = await tailLines(file, near);
  const found = lastAgentTime(lines);
  if (found !== undefined || near === 0 || lines.length >= TAIL_LINES) {
    return found;
  }
  // The window ran out of lines before it ran out of allowance, so it did not
  // hold the whole tail: this session ends in a message bigger than it.
  return lastAgentTime(await tailLines(file, 0));
}

/**
 * The last `TAIL_LINES` complete lines from `from` on, newest first. The
 * final line is the file's end or a write in progress, and the first of a
 * window that does not begin at the file's is the tail of a line that
 * started outside it; neither is a line, so both are dropped.
 */
async function tailLines(file: BunFile, from: number): Promise<string[]> {
  const text = await ifPresent(() => file.slice(from).text(), "");
  const lines = text.split("\n");
  lines.pop();
  if (from > 0) {
    lines.shift();
  }
  return lines.slice(-TAIL_LINES).reverse();
}

/** The timestamp of the newest of these lines the agent wrote, if any is. */
function lastAgentTime(lines: readonly string[]): number | undefined {
  for (const line of lines) {
    const entry = parseSessionEntries(line)[0];
    if (entry?.type !== "message") {
      continue;
    }
    const role = entry.message.role;
    if (role === "assistant" || role === "toolResult") {
      const at = Date.parse(entry.timestamp);
      return Number.isNaN(at) ? undefined : at;
    }
  }
  return undefined;
}

function firstUserMessage(probe: string): string | undefined {
  // The last line of a probe is a fragment as often as not, so it is dropped
  // rather than fed to the parser.
  const lines = probe.split("\n").slice(0, -1);
  for (const line of lines) {
    const entry = parseSessionEntries(line)[0];
    if (entry?.type !== "message" || entry.message.role !== "user") {
      continue;
    }
    const text = MessageText.textOf(entry.message.content).trim();
    if (text !== "") {
      return text.length > TITLE_LIMIT
        ? `${text.slice(0, TITLE_LIMIT).trimEnd()}…`
        : text;
    }
  }
  return undefined;
}
