import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

import { Attachments } from "../attachments/Attachments";
import { MessageText } from "./MessageText";

/** Catalogue summary of a session file. */
export type SessionDigest = {
  /** The session name, else the first user message. */
  readonly title?: string;
  /** Set when `title` is a session name. */
  readonly named?: true;
  /** When the agent last wrote. Moves during a turn, so read it before starting one. */
  readonly settledAt?: number;
};

/** The unclamped digest, so a tail read can be merged into an earlier one. */
export type DigestParts = {
  readonly name?: string;
  readonly opening?: string;
  readonly settledAt?: number;
};

/** A session file's bytes, kept undecoded so only the lines used become strings. */
export type Durable = {
  readonly bytes: Buffer;
  /** Just past the last newline; a trailing partial line is excluded. */
  readonly end: number;
};

const PROBE_LINES = 16;

const TAIL_LINES = 10;

const TITLE_LIMIT = 120;

/** Searched in raw bytes before decoding a line. */
const NAMED = Buffer.from('"session_info"');

export const NEWLINE = 0x0a;

function durable(read: Uint8Array): Durable | undefined {
  const bytes = Buffer.from(read.buffer, read.byteOffset, read.byteLength);
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  return end === 0 ? undefined : { bytes, end };
}

function partsOf(body: Durable): DigestParts {
  return {
    name: nameOf(body),
    opening: firstUserMessage(headLinesOf(body, PROBE_LINES)),
    settledAt: lastAgentTime(tailLinesOf(body, TAIL_LINES).reverse()),
  };
}

/** Keeps the earlier opening; a later name or settle time wins. */
function merge(before: DigestParts, appended: DigestParts): DigestParts {
  return {
    name: appended.name ?? before.name,
    opening: before.opening ?? appended.opening,
    settledAt: appended.settledAt ?? before.settledAt,
  };
}

function of({ name, opening, settledAt }: DigestParts): SessionDigest {
  const title = name ?? opening;
  return {
    ...(title === undefined ? {} : { title: clamp(title) }),
    ...(name === undefined ? {} : { named: true as const }),
    ...(settledAt === undefined ? {} : { settledAt }),
  };
}

/** The last `session_info` entry's name. Skips lines that merely quote the marker. */
function nameOf({ bytes, end }: Durable): string | undefined {
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

function clamp(text: string): string {
  return text.length > TITLE_LIMIT
    ? `${text.slice(0, TITLE_LIMIT).trimEnd()}…`
    : text;
}

function firstUserMessage(lines: readonly string[]): string | undefined {
  for (const line of lines) {
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

export const SessionDigest = { durable, partsOf, merge, of, nameOf };
