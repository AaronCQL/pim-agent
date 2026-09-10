import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SubagentLogs } from "./SubagentLogs";

const HASHED = /^[0-9a-f]{64}\.jsonl$/;

let previousPimHomeDir: string | undefined;
let testPimHomeDir: string | undefined;

beforeAll(async () => {
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  testPimHomeDir = await mkdtemp(join(tmpdir(), "pim-subagents-home-"));
  process.env.PIM_HOME_DIR = testPimHomeDir;
});

afterAll(async () => {
  if (previousPimHomeDir === undefined) {
    delete process.env.PIM_HOME_DIR;
  } else {
    process.env.PIM_HOME_DIR = previousPimHomeDir;
  }
  if (testPimHomeDir) {
    await rm(testPimHomeDir, { recursive: true, force: true });
  }
});

describe("SubagentLogs.pathFor", () => {
  test("keys a child log by its parent session and a hash of its call id", () => {
    const path = SubagentLogs.pathFor("parent-1", "call_1");
    expect(dirname(path!)).toBe(join(SubagentLogs.dir(), "parent-1"));
    expect(basename(path!)).toMatch(HASHED);
    expect(path).not.toBe(SubagentLogs.pathFor("parent-1", "call_2"));
  });

  test("hashes call ids instead of treating them as path segments", () => {
    const path = SubagentLogs.pathFor("parent", "../../../etc/passwd|fc_123");
    expect(dirname(path!)).toBe(join(SubagentLogs.dir(), "parent"));
    expect(basename(path!)).toMatch(HASHED);
  });

  test("refuses invalid parent and empty call ids", () => {
    expect(SubagentLogs.pathFor("..", "call")).toBeNull();
    expect(SubagentLogs.pathFor("parent", "")).toBeNull();
    expect(SubagentLogs.pathFor("parent", "a".repeat(4097))).toBeNull();
  });

  test("stays outside the directory the session catalogue globs", () => {
    expect(SubagentLogs.dir().startsWith(join(getAgentDir(), "sessions"))).toBe(
      false
    );
  });
});

describe("SubagentLogs.create", () => {
  test("opens an empty log with locked-down modes", async () => {
    const path = await SubagentLogs.create("parent-2", "call-2");
    expect(path).toBe(SubagentLogs.pathFor("parent-2", "call-2"));

    const dirMode = (await stat(join(SubagentLogs.dir(), "parent-2"))).mode;
    expect(dirMode & 0o777).toBe(0o700);
    expect((await stat(path!)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(path!).text()).toBe("");
  });

  test("never reopens a log that already exists", async () => {
    await SubagentLogs.create("parent-3", "call-3");
    expect(await SubagentLogs.create("parent-3", "call-3")).toBeNull();
  });

  test("creates a log for a provider id with path punctuation", async () => {
    const callId = "call_4|fc_123";
    const path = await SubagentLogs.create("parent-4", callId);
    expect(path).toBe(SubagentLogs.pathFor("parent-4", callId));
    expect(path).not.toContain(callId);
  });
});

describe("SubagentLogs.cleanup", () => {
  test("expires a parent's children together, by the newest of them", async () => {
    const root = await mkdtemp(join(tmpdir(), "pim-subagents-sweep-"));
    const now = Date.now();
    const stale = new Date(now - SubagentLogs.TTL_MS - 1000);
    const cold = join(root, "cold-parent");
    const warm = join(root, "warm-parent");
    const loose = join(root, "loose.jsonl");
    try {
      await mkdir(cold);
      await mkdir(warm);
      // A truncated log is the crash case: it must sweep like any other.
      await writeFile(join(cold, "a.jsonl"), '{"type":"session"');
      await writeFile(join(warm, "old.jsonl"), "{}\n");
      await writeFile(join(warm, "new.jsonl"), "{}\n");
      await writeFile(loose, "{}\n");
      for (const path of [
        join(cold, "a.jsonl"),
        cold,
        join(warm, "old.jsonl"),
        warm,
        loose,
      ]) {
        await utimes(path, stale, stale);
      }

      SubagentLogs.cleanup(root, now);

      expect(await Bun.file(join(cold, "a.jsonl")).exists()).toBe(false);
      expect(await Bun.file(join(warm, "old.jsonl")).exists()).toBe(true);
      expect(await Bun.file(loose).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is a no-op when the subagent dir is absent", () => {
    expect(() =>
      SubagentLogs.cleanup(join(tmpdir(), "pim-subagents-missing"), Date.now())
    ).not.toThrow();
  });
});
