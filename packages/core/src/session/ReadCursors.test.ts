import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { ReadCursors } from "./ReadCursors";

let tmp: string;
let file: string;

/** Long enough ago to be behind any baseline taken during the test. */
const BEFORE = Date.now() - 60_000;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pim-read-cursors-"));
  file = join(tmp, "read.json");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("a first launch reads everything that already exists", async () => {
  const cursors = new ReadCursors(file);

  expect(await cursors.isUnread("old", BEFORE)).toBe(false);
  // Answered after this server first ran, so it is news.
  expect(await cursors.isUnread("fresh", Date.now() + 1)).toBe(true);
});

test("the baseline outlives the process, so an unread session stays unread", async () => {
  const first = new ReadCursors(file);
  await first.isUnread("any", BEFORE);
  const answeredAt = Date.now() + 1;
  expect(await first.isUnread("s1", answeredAt)).toBe(true);

  // A restart takes the baseline off disk rather than from the clock; taking
  // it from the clock would read every session that had gone unread.
  expect(await new ReadCursors(file).isUnread("s1", answeredAt)).toBe(true);
});

test("a session never answered is read, however old the baseline", async () => {
  const cursors = new ReadCursors(file);

  expect(await cursors.isUnread("s1", undefined)).toBe(false);
});

test("marking is forward-only and survives a restart", async () => {
  const cursors = new ReadCursors(file);
  const at = Date.now() + 10_000;
  await cursors.mark("s1", at);
  await cursors.mark("s1", at - 5_000);
  await cursors.flush();

  const restarted = new ReadCursors(file);
  expect(await restarted.isUnread("s1", at)).toBe(false);
  expect(await restarted.isUnread("s1", at + 1)).toBe(true);
});

test("reading a session settles it against a later answer", async () => {
  const cursors = new ReadCursors(file);
  const answeredAt = Date.now() + 1;
  expect(await cursors.isUnread("s1", answeredAt)).toBe(true);

  await cursors.mark("s1", answeredAt + 1);
  expect(await cursors.isUnread("s1", answeredAt)).toBe(false);
});

test("pruning forgets the sessions that are gone and keeps the rest", async () => {
  const cursors = new ReadCursors(file);
  await cursors.mark("kept", Date.now() + 1_000);
  await cursors.mark("deleted", Date.now() + 1_000);
  await cursors.prune(new Set(["kept"]));
  await cursors.flush();

  const restarted = new ReadCursors(file);
  expect(await restarted.isUnread("kept", Date.now())).toBe(false);
  // Back to the baseline, which everything on disk at first launch is behind.
  expect(await restarted.isUnread("deleted", Date.now() + 2_000)).toBe(true);
});

test("a file that will not parse is a file that is not there", async () => {
  await Bun.write(file, "{ not json");

  const cursors = new ReadCursors(file);
  expect(await cursors.isUnread("s1", BEFORE)).toBe(false);
  await cursors.flush();
  expect(JSON.parse(await Bun.file(file).text())).toMatchObject({
    sessions: {},
  });
});
