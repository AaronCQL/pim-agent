import type { BunFile } from "bun";

import type { FileEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

import { Attachments } from "../attachments/Attachments";
import { MessageText } from "./MessageText";

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

/** One durable line of a session file; the header is line 1, so entries start at `seq` 2. */
export type LoggedEntry = {
  readonly seq: number;
  readonly entry: FileEntry;
};

type Cursor = {
  readonly offset: number;
  readonly seq: number;
};

const PROBE_LINES = 16;

const PROBE_LIMIT = 16 * 1024 * 1024;

const PROBE_CHUNK = 8 * 1024;
const PROBE_CHUNK_MAX = 256 * 1024;

const EMPTY = new Uint8Array();

const TAIL_LINES = 10;

const TITLE_LIMIT = 120;

/** Cheap reject before decoding a line: pi writes the discriminant verbatim. */
const NAMED = Buffer.from('"session_info"');

const NEWLINE = 0x0a;

/** What the session catalogue shows for one file without opening a session. */
export type SessionDigest = {
  /** The session's name if it has one, else its first user message; absent when it has neither. */
  readonly title?: string;
  /** True when `title` is a name somebody wrote rather than the opening message. */
  readonly named?: true;
  /** When the agent last wrote; it moves with an in-flight turn, so read it before starting one. */
  readonly settledAt?: number;
};

function isHeader(entry: FileEntry): entry is SessionHeader {
  return entry.type === "session";
}

/** A reader over one pi session file: append-only JSONL, so a line's `seq` never changes. */
export class EventLog {
  public readonly path: string;
  private cursor: Cursor = { offset: 0, seq: 0 };

  public constructor(path: string) {
    this.path = path;
  }

  /** Durable entries with `seq > afterSeq`, oldest first. */
  public async read(afterSeq = 0): Promise<readonly LoggedEntry[]> {
    const start =
      this.cursor.seq <= afterSeq ? this.cursor : { offset: 0, seq: 0 };
    const file = Bun.file(this.path);
    const text = await ifPresent(() => file.slice(start.offset).text(), "");

    // A trailing fragment is a write in progress: stop short of it or reads lose entries.
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

  public async header(): Promise<SessionHeader | undefined> {
    for await (const line of headLines(Bun.file(this.path), 1)) {
      const entry = parseSessionEntries(line)[0];
      return entry && isHeader(entry) ? entry : undefined;
    }
    return undefined;
  }

  /** The `seq` of the last complete line, without parsing any of them. */
  public async head(): Promise<number> {
    await this.read(Number.MAX_SAFE_INTEGER);
    return this.cursor.seq;
  }

  /**
   * The name pi's own `/name` writes: the last `session_info` entry wins, and an
   * empty one clears it. Appended rather than replaced, so it is found by reading
   * the whole file — the one unbounded read the catalogue makes, and the only
   * reason the bytes below are not a bounded head and tail.
   */
  public async name(): Promise<string | undefined> {
    const body = await durableBytes(Bun.file(this.path));
    return body === undefined ? undefined : lastName(body);
  }

  /** Title and settle time for the catalogue, without opening a session. */
  public async digest(): Promise<SessionDigest> {
    const body = await durableBytes(Bun.file(this.path));
    if (body === undefined) {
      return {};
    }
    const name = lastName(body);
    const title = name ?? firstUserMessage(headLinesOf(body, PROBE_LINES));
    const settledAt = settleTime(body);
    return {
      ...(title === undefined ? {} : { title: clamp(title) }),
      ...(name === undefined ? {} : { named: true as const }),
      ...(settledAt === undefined ? {} : { settledAt }),
    };
  }
}

async function* headLines(
  file: BunFile,
  count: number
): AsyncGenerator<string> {
  // Decode with `stream: true`: a chunk boundary can split a character.
  const decoder = new TextDecoder();
  let pending = "";
  let yielded = 0;
  let offset = 0;
  let ask = PROBE_CHUNK;
  while (offset < PROBE_LIMIT) {
    const chunk = await ifPresent(
      () => file.slice(offset, offset + ask).bytes(),
      EMPTY
    );
    if (chunk.length === 0) {
      return;
    }
    offset += chunk.length;
    ask = Math.min(ask * 2, PROBE_CHUNK_MAX);
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      yield line;
      if (++yielded >= count) {
        return;
      }
    }
  }
}

/**
 * The file's durable bytes, undecoded: a whole session is megabytes of tool
 * output and the digest wants a handful of lines of it, so the search for the
 * name runs over the bytes and only the lines it keeps become strings.
 */
type Durable = {
  readonly bytes: Buffer;
  /** Past the last newline; a trailing fragment is a write in progress and is not a line. */
  readonly end: number;
};

async function durableBytes(file: BunFile): Promise<Durable | undefined> {
  const read = await ifPresent(() => file.bytes(), EMPTY);
  const bytes = Buffer.from(read.buffer, read.byteOffset, read.byteLength);
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  return end === 0 ? undefined : { bytes, end };
}

function headLinesOf({ bytes, end }: Durable, count: number): string[] {
  let at = 0;
  for (let taken = 0; taken < count && at < end; taken++) {
    at = bytes.indexOf(NEWLINE, at) + 1;
  }
  return split(bytes.toString("utf8", 0, at));
}

function tailLinesOf({ bytes, end }: Durable, count: number): string[] {
  let at = end - 1;
  for (let taken = 0; taken < count && at > 0; taken++) {
    at = bytes.lastIndexOf(NEWLINE, at - 1);
  }
  return split(bytes.toString("utf8", at + 1, end));
}

function split(text: string): string[] {
  const lines = text.split("\n");
  lines.pop();
  return lines;
}

function settleTime(body: Durable): number | undefined {
  return lastAgentTime(tailLinesOf(body, TAIL_LINES).reverse());
}

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

/** The last `session_info` line, found by walking the marker's occurrences backwards; a line that merely quotes the marker parses as something else, and the walk carries on past it. */
function lastName({ bytes, end }: Durable): string | undefined {
  let at = end - 1;
  while (at >= 0) {
    const found = bytes.lastIndexOf(NAMED, at);
    if (found === -1) {
      return undefined;
    }
    const from = bytes.lastIndexOf(NEWLINE, found) + 1;
    const to = bytes.indexOf(NEWLINE, found);
    const entry = parseSessionEntries(bytes.toString("utf8", from, to))[0];
    if (entry?.type === "session_info") {
      return entry.name?.trim() || undefined;
    }
    at = from - 1;
  }
  return undefined;
}

function clamp(text: string): string {
  return text.length > TITLE_LIMIT
    ? `${text.slice(0, TITLE_LIMIT).trimEnd()}…`
    : text;
}

function firstUserMessage(lines: readonly string[]): string | undefined {
  for (const line of lines.slice(0, PROBE_LINES)) {
    const entry = parseSessionEntries(line)[0];
    if (entry?.type !== "message" || entry.message.role !== "user") {
      continue;
    }
    const said = Attachments.parse(MessageText.textOf(entry.message.content));
    const text =
      said.text.trim() ||
      said.files.map((file) => Attachments.nameOf(file.path)).join(", ");
    if (text !== "") {
      return text;
    }
  }
  return undefined;
}
