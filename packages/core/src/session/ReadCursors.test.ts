import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { ReadCursors } from "./ReadCursors";

let tmp: string;
let file: string;
let opened: ReadCursors[] = [];

/** Tracked so teardown can flush pending writes. */
function open(): ReadCursors {
  const cursors = new ReadCursors(file);
  opened.push(cursors);
  return cursors;
}

const BEFORE = Date.now() - 60_000;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-read-cursors-"));
  file = join(tmp, "read.json");
});

afterEach(async () => {
  await Promise.all(opened.map((cursors) => cursors.flush()));
  opened = [];
  await rm(tmp, { recursive: true, force: true });
});

test("a first launch reads everything that already exists", async () => {
  const cursors = open();

  expect(await cursors.isUnread("old", BEFORE)).toBe(false);
  expect(await cursors.isUnread("fresh", Date.now() + 1)).toBe(true);
});

test("the baseline outlives the process, so an unread session stays unread", async () => {
  const first = open();
  await first.isUnread("any", BEFORE);
  const answeredAt = Date.now() + 1;
  expect(await first.isUnread("s1", answeredAt)).toBe(true);

  await first.flush();
  expect(await open().isUnread("s1", answeredAt)).toBe(true);
});

test("a session never answered is read, however old the baseline", async () => {
  const cursors = open();

  expect(await cursors.isUnread("s1", undefined)).toBe(false);
});

test("marking is forward-only and survives a restart", async () => {
  const cursors = open();
  const at = Date.now() + 10_000;
  await cursors.mark("s1", at);
  await cursors.mark("s1", at - 5_000);
  await cursors.flush();

  const restarted = open();
  expect(await restarted.isUnread("s1", at)).toBe(false);
  expect(await restarted.isUnread("s1", at + 1)).toBe(true);
});

test("reading a session settles it against a later answer", async () => {
  const cursors = open();
  // Let the load take its baseline before reading the clock.
  await cursors.isUnread("any", BEFORE);
  const answeredAt = Date.now() + 1;
  expect(await cursors.isUnread("s1", answeredAt)).toBe(true);

  await cursors.mark("s1", answeredAt + 1);
  expect(await cursors.isUnread("s1", answeredAt)).toBe(false);
});

test("pruning forgets the sessions that are gone and keeps the rest", async () => {
  const cursors = open();
  await cursors.mark("kept", Date.now() + 1_000);
  await cursors.mark("deleted", Date.now() + 1_000);
  await cursors.prune(new Set(["kept"]));
  await cursors.flush();

  const restarted = open();
  expect(await restarted.isUnread("kept", Date.now())).toBe(false);
  expect(await restarted.isUnread("deleted", Date.now() + 2_000)).toBe(true);
});

test("a file that will not parse is a file that is not there", async () => {
  await Bun.write(file, "{ not json");

  const cursors = open();
  expect(await cursors.isUnread("s1", BEFORE)).toBe(false);
  await cursors.flush();
  expect(JSON.parse(await Bun.file(file).text())).toMatchObject({
    sessions: {},
  });
});
