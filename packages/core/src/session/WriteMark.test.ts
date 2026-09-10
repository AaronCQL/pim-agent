import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
