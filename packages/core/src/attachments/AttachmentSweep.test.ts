import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachmentSweep, type StoredEntry } from "./AttachmentSweep";

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function entry(
  scope: string,
  name: string,
  size: number,
  ageDays: number
): StoredEntry {
  return {
    scope,
    path: `${scope}/${name}`,
    size,
    modifiedAt: NOW - ageDays * DAY,
  };
}

function doomedNames(
  entries: readonly StoredEntry[],
  overrides: { alive?: string[]; archived?: string[] } = {}
): readonly string[] {
  return AttachmentSweep.doomed(entries, {
    alive: new Set(overrides.alive ?? ["a", "b"]),
    archived: new Set(overrides.archived ?? []),
    now: NOW,
  }).map((doomed) => doomed.path);
}

test("under the budget, files of live sessions stay", () => {
  expect(
    doomedNames([entry("a", "x", GB, 30), entry("b", "y", GB, 60)])
  ).toEqual([]);
});

test("a session whose file is gone loses its attachments once past the grace", () => {
  expect(
    doomedNames([entry("gone", "old", 5, 2), entry("gone", "fresh", 5, 0.5)])
  ).toEqual(["gone/old"]);
});

test("an empty listing is not taken as every session being gone", () => {
  expect(doomedNames([entry("a", "x", 5, 30)], { alive: [] })).toEqual([]);
});

test("over the budget, the oldest go first until the rest fits", () => {
  expect(
    doomedNames([
      entry("a", "newest", 2 * GB, 2),
      entry("a", "oldest", 2 * GB, 9),
      entry("b", "middle", 2 * GB, 5),
    ])
  ).toEqual(["a/oldest"]);
});

test("archived sessions are evicted before older files of active ones", () => {
  expect(
    doomedNames(
      [
        entry("a", "ancient", 2 * GB, 90),
        entry("b", "archived", 2 * GB, 3),
        entry("a", "recent", 2 * GB, 2),
      ],
      { archived: ["b"] }
    )
  ).toEqual(["b/archived"]);
});

test("a file bigger than the whole budget lives out its grace, then goes alone", () => {
  const history = [
    entry("a", "notes", 100, 40),
    entry("b", "chart", 1 * GB, 20),
  ];
  const huge = (ageDays: number) => entry("a", "video", 10 * GB, ageDays);

  expect(doomedNames([...history, huge(0.5)])).toEqual([]);
  expect(doomedNames([...history, huge(2)])).toEqual(["a/video"]);
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pim-attachment-sweep-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function place(scope: string, name: string, ageDays: number) {
  await mkdir(join(root, scope), { recursive: true });
  const path = join(root, scope, name);
  await Bun.write(path, "hello");
  const at = new Date(Date.now() - ageDays * DAY);
  await utimes(path, at, at);
}

test("a sweep deletes the doomed files and the folders they leave empty", async () => {
  await place("live", "kept.txt", 30);
  await place("gone", "old.txt", 30);
  await place("gone", "fresh.txt", 0);
  await place("orphan", "old.txt", 30);

  const result = await AttachmentSweep.sweep(root, {
    alive: new Set(["live"]),
    archived: new Set(),
    now: Date.now(),
  });

  expect(result).toEqual({ removed: 2, freedBytes: 10 });
  expect((await readdir(root)).sort()).toEqual(["gone", "live"]);
  expect(await readdir(join(root, "gone"))).toEqual(["fresh.txt"]);
});

test("a missing root sweeps nothing", async () => {
  expect(
    await AttachmentSweep.sweep(join(root, "absent"), {
      alive: new Set(),
      archived: new Set(),
      now: Date.now(),
    })
  ).toEqual({ removed: 0, freedBytes: 0 });
});
