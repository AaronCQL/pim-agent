import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpillCache } from "./SpillCache";

let previousPimHomeDir: string | undefined;
let testPimHomeDir: string | undefined;

beforeAll(async () => {
  previousPimHomeDir = process.env.PIM_HOME_DIR;
  testPimHomeDir = await mkdtemp(join(tmpdir(), "pim-spill-home-"));
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

describe("SpillCache.write", () => {
  test("writes a prefixed UUIDv7 file with locked-down modes", async () => {
    const path = await SpillCache.write("fetch", "md", "# hello\nworld");
    expect(path).toBeTruthy();
    expect(path!.startsWith(join(SpillCache.dir(), "fetch-"))).toBe(true);
    expect(path!.endsWith(".md")).toBe(true);

    const dirMode = (await stat(SpillCache.dir())).mode & 0o777;
    const fileMode = (await stat(path!)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    expect(await Bun.file(path!).text()).toBe("# hello\nworld");
  });

  test("accepts binary payloads", async () => {
    const path = await SpillCache.write(
      "bash",
      "out",
      new Uint8Array([65, 66])
    );
    expect(path).toBeTruthy();
    expect(await Bun.file(path!).text()).toBe("AB");
  });
});

describe("SpillCache.cleanup", () => {
  test("deletes only expired spill files across prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pim-spill-cleanup-"));
    const now = Date.now();
    const oldBash = join(root, "bash-0192ce11-26d5-7dc3-9305-1426de888c5a.out");
    const oldFetch = join(
      root,
      "fetch-0192ce11-26d5-7dc3-9305-1426de888c5b.md"
    );
    const recent = join(root, "bash-0192ce11-26d5-7dc4-8894-bc88d506d6ee.err");
    const invalidName = join(root, "bash-not-a-uuid.out");
    const unrelated = join(root, "other-old.out");
    try {
      await writeFile(oldBash, "old");
      await writeFile(oldFetch, "old");
      await writeFile(recent, "recent");
      await writeFile(invalidName, "invalid");
      await writeFile(unrelated, "unrelated");
      const oldDate = new Date(now - SpillCache.TTL_MS - 1000);
      await utimes(oldBash, oldDate, oldDate);
      await utimes(oldFetch, oldDate, oldDate);
      await utimes(invalidName, oldDate, oldDate);
      await utimes(unrelated, oldDate, oldDate);

      SpillCache.cleanup(root, now);

      expect(await Bun.file(oldBash).exists()).toBe(false);
      expect(await Bun.file(oldFetch).exists()).toBe(false);
      expect(await Bun.file(recent).exists()).toBe(true);
      expect(await Bun.file(invalidName).exists()).toBe(true);
      expect(await Bun.file(unrelated).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is a no-op when the cache dir is absent", () => {
    expect(() =>
      SpillCache.cleanup(join(tmpdir(), "pim-spill-missing-dir"), Date.now())
    ).not.toThrow();
  });
});
