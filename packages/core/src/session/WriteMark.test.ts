import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { EventLog } from "./EventLog";
import { WriteMark } from "./WriteMark";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-write-mark-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Header on line 1, so `entryCount` entries leave the head at `entryCount + 1`. */
async function writeSession(entryCount: number): Promise<string> {
  const path = join(tmp, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: "s", version: 8 }),
    ...Array.from({ length: entryCount }, (_, i) =>
      JSON.stringify({ type: "message", id: `e${i}` })
    ),
  ];
  await Bun.write(path, `${lines.join("\n")}\n`);
  return path;
}

function holding(count: number): { getEntries(): readonly unknown[] } {
  return { getEntries: () => Array.from({ length: count }, (_, i) => i) };
}

async function append(path: string, entry: object): Promise<void> {
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

test("counts the file's durable lines against pi's entries in memory", async () => {
  const path = await writeSession(3);

  expect(await WriteMark.of(new EventLog(path), holding(3))).toEqual({
    head: 4,
    entries: 3,
  });
});

test("appends pi made from memory are never foreign", () => {
  const mark = { head: 4, entries: 3 };

  expect(WriteMark.foreignSince(mark, { head: 6, entries: 5 })).toBe(false);
});

test("a line pi did not append is foreign", () => {
  const mark = { head: 4, entries: 3 };

  expect(WriteMark.foreignSince(mark, { head: 5, entries: 3 })).toBe(true);
  expect(WriteMark.foreignSince(mark, { head: 7, entries: 5 })).toBe(true);
});

/** pi names the file before it writes one, so the first write is header plus every buffered entry. */
test("the whole of a file that did not exist at the mark is pi's own", () => {
  expect(
    WriteMark.foreignSince(WriteMark.UNREAD, { head: 5, entries: 4 })
  ).toBe(false);
  expect(
    WriteMark.foreignSince(WriteMark.UNREAD, { head: 6, entries: 4 })
  ).toBe(true);
});

test("a rename somebody else appended is a line nobody has to replay", async () => {
  const path = await writeSession(3);
  const log = new EventLog(path);
  const mark = await WriteMark.of(log, holding(3));
  await append(path, { type: "session_info", id: "n1", name: "renamed" });

  expect(await WriteMark.benignSince(log, mark)).toBe(true);
});

test("a message beside the rename is not benign, and neither is history alone", async () => {
  const path = await writeSession(3);
  const log = new EventLog(path);
  const mark = await WriteMark.of(log, holding(3));
  await append(path, { type: "session_info", id: "n1", name: "renamed" });
  await append(path, { type: "message", id: "x1" });

  expect(await WriteMark.benignSince(log, mark)).toBe(false);
  expect(
    await WriteMark.benignSince(log, await WriteMark.of(log, holding(3)))
  ).toBe(false);
});

test("a whole file that appeared since the mark is never benign", async () => {
  const path = await writeSession(3);

  expect(
    await WriteMark.benignSince(new EventLog(path), WriteMark.UNREAD)
  ).toBe(false);
});
