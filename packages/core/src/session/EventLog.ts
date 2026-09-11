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

const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 10;

const TITLE_LIMIT = 120;

/** What the session catalogue shows for one file without opening a session. */
export type SessionDigest = {
  /** The first user message, trimmed; absent when the session has none yet. */
  readonly title?: string;
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

  /** Title and settle time for the catalogue, read from the two ends of the file. */
  public async digest(): Promise<SessionDigest> {
    const file = Bun.file(this.path);
    const [title, settledAt] = await Promise.all([
      firstUserMessage(file),
      settleTime(file),
    ]);
    return {
      ...(title === undefined ? {} : { title }),
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

async function settleTime(file: BunFile): Promise<number | undefined> {
  const near = Math.max(0, file.size - TAIL_BYTES);
  const lines = await tailLines(file, near);
  const found = lastAgentTime(lines);
  if (found !== undefined || near === 0 || lines.length >= TAIL_LINES) {
    return found;
  }
  return lastAgentTime(await tailLines(file, 0));
}

async function tailLines(file: BunFile, from: number): Promise<string[]> {
  const text = await ifPresent(() => file.slice(from).text(), "");
  const lines = text.split("\n");
  lines.pop();
  if (from > 0) {
    lines.shift();
  }
  return lines.slice(-TAIL_LINES).reverse();
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

async function firstUserMessage(file: BunFile): Promise<string | undefined> {
  for await (const line of headLines(file, PROBE_LINES)) {
    const entry = parseSessionEntries(line)[0];
    if (entry?.type !== "message" || entry.message.role !== "user") {
      continue;
    }
    const said = Attachments.parse(MessageText.textOf(entry.message.content));
    const text =
      said.text.trim() ||
      said.files.map((file) => Attachments.nameOf(file.path)).join(", ");
    if (text !== "") {
      return text.length > TITLE_LIMIT
        ? `${text.slice(0, TITLE_LIMIT).trimEnd()}…`
        : text;
    }
  }
  return undefined;
}
