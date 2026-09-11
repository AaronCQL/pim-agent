import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { writeContent } from "./write";

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-write-tool-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("writeContent", () => {
  test("creates a new file and reports an all-added diff", async () => {
    const root = await tempRoot();
    const path = join(root, "fresh.ts");

    const outcome = await writeContent(path, "alpha\nbeta\n");

    expect(outcome.created).toBe(true);
    expect(outcome.bytesWritten).toBe(11);
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta\n");
    expect(outcome.diff).toBeDefined();
    const lines = outcome.diff?.hunks[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(["added", "added"]);
    expect(lines.map((line) => line.text)).toEqual(["alpha", "beta"]);
  });

  test("creates parent directories when missing", async () => {
    const root = await tempRoot();
    const path = join(root, "deep", "nest", "file.txt");

    const outcome = await writeContent(path, "hello");

    expect(outcome.created).toBe(true);
    expect(await readFile(path, "utf8")).toBe("hello");
  });

  test("emits no diff when content is unchanged", async () => {
    const root = await tempRoot();
    const path = join(root, "same.txt");
    await writeFile(path, "alpha\nbeta\n", "utf8");

    const outcome = await writeContent(path, "alpha\nbeta\n");

    expect(outcome.created).toBe(false);
    expect(outcome.diff).toBeUndefined();
  });

  test("reports a trailing-newline removal even when content matches and produces no diff hunks", async () => {
    const root = await tempRoot();
    const path = join(root, "eof.txt");
    await writeFile(path, "alpha\n", "utf8");

    const outcome = await writeContent(path, "alpha");

    expect(outcome.created).toBe(false);
    expect(outcome.diff).toBeUndefined();
    expect(outcome.trailingNewlineChange).toBe("removed");
  });

  test("reports a trailing-newline addition", async () => {
    const root = await tempRoot();
    const path = join(root, "eof2.txt");
    await writeFile(path, "alpha", "utf8");

    const outcome = await writeContent(path, "alpha\n");

    expect(outcome.created).toBe(false);
    expect(outcome.trailingNewlineChange).toBe("added");
  });

  test("does not report trailing-newline change for newly created files", async () => {
    const root = await tempRoot();
    const path = join(root, "fresh.txt");

    const outcome = await writeContent(path, "alpha");

    expect(outcome.created).toBe(true);
    expect(outcome.trailingNewlineChange).toBeUndefined();
  });

  test("emits a diff capturing modified lines", async () => {
    const root = await tempRoot();
    const path = join(root, "edit.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const outcome = await writeContent(path, "alpha\nBETA\ngamma\n");

    expect(outcome.created).toBe(false);
    const lines = outcome.diff?.hunks[0]?.lines ?? [];
    const kinds = lines.map((line) => line.kind);
    expect(kinds).toContain("removed");
    expect(kinds).toContain("added");
    const removed = lines.find((line) => line.kind === "removed");
    const added = lines.find((line) => line.kind === "added");
    expect(removed?.text).toBe("beta");
    expect(added?.text).toBe("BETA");
  });
});
