import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileWatch } from "./FileWatch";
import { until } from "./fixtures/wait";

/** Long enough that anything seen in a test came from `fs.watch`. */
const NO_POLL_MS = 60_000;

let root: string;
let stops: (() => void)[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pim-filewatch-"));
});

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops = [];
  await rm(root, { recursive: true, force: true });
});

function watchFile(path: string, pollMs: number): () => number {
  let fired = 0;
  stops.push(
    FileWatch.file(
      path,
      () => {
        fired += 1;
      },
      pollMs
    )
  );
  return () => fired;
}

test("a file that does not exist yet is still watched", async () => {
  const path = join(root, "late.jsonl");
  const fired = watchFile(path, NO_POLL_MS);

  await Bun.write(path, "one\n");

  await until(() => fired() > 0, "the file appearing");
});

test("a burst of writes ends with the last of them seen", async () => {
  const path = join(root, "session.jsonl");
  await Bun.write(path, "one\n");
  let seen = "";
  stops.push(
    FileWatch.file(
      path,
      () => {
        seen = readFileSync(path, "utf8");
      },
      NO_POLL_MS
    )
  );

  await Bun.write(path, "one\ntwo\n");
  await Bun.write(path, "one\ntwo\nthree\n");

  await until(() => seen.includes("three"), "the coalesced write");
});

test("a change with nothing behind it fires once, not on every look", async () => {
  const path = join(root, "quiet.jsonl");
  await Bun.write(path, "one\n");
  let fired = 0;
  let looks = 0;
  stops.push(
    FileWatch.file(
      path,
      () => {
        fired += 1;
      },
      NO_POLL_MS,
      () => {
        looks += 1;
      }
    )
  );

  await Bun.write(path, "one\ntwo\n");
  await until(() => fired > 0, "the write");
  const settled = fired;
  const seen = looks;
  await until(() => looks > seen, "a look after the write");

  expect(fired).toBe(settled);
});

test("a directory that cannot be watched yet is answered by the poll", async () => {
  const path = join(root, "later", "session.jsonl");
  const fired = watchFile(path, 10);

  await Bun.write(path, "one\n");

  await until(() => fired() > 0, "the poll to find the file");
});

test("a directory watch fires for an entry coming and going", async () => {
  let fired = 0;
  stops.push(
    FileWatch.directory(
      root,
      () => {
        fired += 1;
      },
      NO_POLL_MS
    )
  );

  await Bun.write(join(root, "a.jsonl"), "one\n");
  await until(() => fired > 0, "the entry appearing");

  const before = fired;
  await rm(join(root, "a.jsonl"));
  await until(() => fired > before, "the entry going away");
});

test("subdirectories lists only the directories inside", async () => {
  await Bun.write(join(root, "loose.jsonl"), "one\n");
  await Bun.write(join(root, "nested", "session.jsonl"), "one\n");

  expect(FileWatch.subdirectories(root)).toEqual([join(root, "nested")]);
  expect(FileWatch.subdirectories(join(root, "missing"))).toEqual([]);
});
