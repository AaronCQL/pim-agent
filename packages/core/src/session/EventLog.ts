import type { BunFile } from "bun";

import type { FileEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

import { SessionDigest, type Durable } from "./SessionDigest";

export type { SessionDigest } from "./SessionDigest";

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

const PROBE_LIMIT = 16 * 1024 * 1024;

const PROBE_CHUNK = 8 * 1024;
const PROBE_CHUNK_MAX = 256 * 1024;

const EMPTY = new Uint8Array();

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
   * reason `SessionDigest` takes a whole file rather than a bounded head and tail.
   */
  public async name(): Promise<string | undefined> {
    const body = await durableBytes(Bun.file(this.path));
    return body === undefined ? undefined : SessionDigest.nameOf(body);
  }

  /** Title and settle time for the catalogue, without opening a session. */
  public async digest(): Promise<SessionDigest> {
    const body = await durableBytes(Bun.file(this.path));
    return body === undefined
      ? {}
      : SessionDigest.of(SessionDigest.partsOf(body));
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

async function durableBytes(file: BunFile): Promise<Durable | undefined> {
  const read = await ifPresent(() => file.bytes(), EMPTY);
  return SessionDigest.durable(read);
}
