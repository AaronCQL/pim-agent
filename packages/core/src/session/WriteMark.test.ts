import { appendFileSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
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

function holding(...ids: string[]): { getEntry(id: string): unknown } {
  return { getEntry: (id) => (ids.includes(id) ? { id } : undefined) };
}

const PI_WROTE = holding("e0", "e1", "e2");

async function append(path: string, entry: object): Promise<void> {
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

test("a mark sits on the file's last durable line", async () => {
  const path = await writeSession(3);

  expect(await WriteMark.at(new EventLog(path))).toEqual({ head: 4 });
});

test("lines pi holds in memory are never foreign, and move the mark past them", async () => {
  const path = await writeSession(3);
  const log = new EventLog(path);

  expect(await WriteMark.scan(log, { head: 2 }, PI_WROTE)).toEqual({
    next: { head: 4 },
    foreign: false,
    renamed: false,
  });
});

test("lines pi appends while a scan reads are pi's on the next scan", async () => {
  const path = await writeSession(3);
  const log = new EventLog(path);
  const ids = ["e0", "e1", "e2"];
  const racing = {
    getEntry(id: string): unknown {
      if (ids.length === 3) {
        for (const late of ["r0", "r1"]) {
          ids.push(late);
          appendFileSync(
            path,
            `${JSON.stringify({ type: "message", id: late })}\n`
          );
        }
      }
      return ids.includes(id) ? { id } : undefined;
    },
  };

  const first = await WriteMark.scan(log, { head: 2 }, racing);

  expect(first).toEqual({
    next: { head: 4 },
    foreign: false,
    renamed: false,
  });
  expect(await WriteMark.scan(log, first.next, racing)).toEqual({
    next: { head: 6 },
    foreign: false,
    renamed: false,
  });
});

test("a line pi does not hold is foreign", async () => {
  const path = await writeSession(3);
  const log = new EventLog(path);
  const mark = await WriteMark.at(log);
  await append(path, { type: "message", id: "x1" });

  expect(await WriteMark.scan(log, mark, PI_WROTE)).toEqual({
    next: { head: 5 },
    foreign: true,
    renamed: false,
  });
});

test("the whole of a file that did not exist at the mark is pi's own", async () => {
  const path = await writeSession(3);
  const log = new EventLog(path);

  expect(await WriteMark.scan(log, WriteMark.UNREAD, PI_WROTE)).toMatchObject({
    foreign: false,
    renamed: false,
  });
  expect(
    await WriteMark.scan(log, WriteMark.UNREAD, holding("e0", "e1"))
  ).toMatchObject({ foreign: true });
});

test("a rename somebody else appended is a line nobody has to replay, but is reported", async () => {
  const path = await writeSession(3);
  const log = new EventLog(path);
  const mark = await WriteMark.at(log);
  await append(path, { type: "session_info", id: "n1", name: "renamed" });

  expect(await WriteMark.scan(log, mark, PI_WROTE)).toEqual({
    next: { head: 5 },
    foreign: false,
    renamed: true,
  });
  expect(
    await WriteMark.scan(log, mark, holding("e0", "e1", "e2", "n1"))
  ).toMatchObject({ renamed: false });
});

test("a message beside the rename is foreign", async () => {
  const path = await writeSession(3);
  const log = new EventLog(path);
  const mark = await WriteMark.at(log);
  await append(path, { type: "session_info", id: "n1", name: "renamed" });
  await append(path, { type: "message", id: "x1" });

  expect(await WriteMark.scan(log, mark, PI_WROTE)).toMatchObject({
    foreign: true,
  });
});
