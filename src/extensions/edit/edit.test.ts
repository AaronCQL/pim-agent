import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { editFile, formatEditSummary } from "./edit";
import type { RawEdit } from "./schema";

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-edit-tool-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("editFile", () => {
  test("applies exact single edit", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    const outcome = await editFile(path, [
      { oldString: "beta", newString: "delta" },
    ]);

    expect(await readFile(path, "utf8")).toBe("alpha\ndelta\ngamma");
    expect(outcome.editCount).toBe(1);
    expect(outcome.noops).toEqual([]);
    expect(outcome.resolvedEdits[0]?.strategy).toBe("simple");
    expect(formatEditSummary(path, outcome)).toBe(
      `1 edit made to ${path}: lines 2.`
    );
  });

  test("applies multi-edit batch against pre-batch content", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma\ndelta", "utf8");

    await editFile(path, [
      { oldString: "beta", newString: "BETA" },
      { oldString: "delta", newString: "DELTA" },
    ]);

    expect(await readFile(path, "utf8")).toBe("alpha\nBETA\ngamma\nDELTA");
  });

  test("rejects sequential transformations in one batch", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta", "utf8");

    await expect(
      editFile(path, [
        { oldString: "beta", newString: "delta" },
        { oldString: "delta", newString: "omega" },
      ])
    ).rejects.toThrow(/oldString was not found/);
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta");
  });

  test("rejects overlapping resolved ranges", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    await expect(
      editFile(path, [
        { oldString: "beta\ngamma", newString: "merged" },
        { oldString: "gamma", newString: "changed" },
      ])
    ).rejects.toThrow(/target overlapping byte ranges/);
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta\ngamma");
  });

  test("replaceAll replaces all occurrences and lists every range", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "foo\nbar\nfoo", "utf8");

    const outcome = await editFile(path, [
      { oldString: "foo", newString: "baz", replaceAll: true },
    ]);

    expect(await readFile(path, "utf8")).toBe("baz\nbar\nbaz");
    expect(outcome.ranges).toEqual(["1", "3"]);
    expect(formatEditSummary(path, outcome)).toBe(
      `1 edit made to ${path}: lines 1 and 3.`
    );
  });

  test("replaceAll overlap with another edit is rejected", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "foo\nbar\nfoo", "utf8");

    await expect(
      editFile(path, [
        { oldString: "foo", newString: "baz", replaceAll: true },
        { oldString: "foo\nbar", newString: "merged" },
      ])
    ).rejects.toThrow(/target overlapping byte ranges/);
  });

  test("rejects duplicate edits", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta", "utf8");

    const edit: RawEdit = { oldString: "beta", newString: "delta" };

    await expect(editFile(path, [edit, edit])).rejects.toThrow(
      /Edits 0 and 1 are identical/
    );
  });

  test("rejects all-noop fuzzy batches and tracks partial noops", async () => {
    const root = await tempRoot();
    const noopPath = join(root, "noop.txt");
    const partialPath = join(root, "partial.txt");
    await writeFile(noopPath, "  beta", "utf8");
    await writeFile(partialPath, "alpha\n  beta", "utf8");

    await expect(
      editFile(noopPath, [{ oldString: "beta ", newString: "  beta" }])
    ).rejects.toThrow(/All edits were no-ops/);

    const outcome = await editFile(partialPath, [
      { oldString: "alpha", newString: "ALPHA" },
      { oldString: "beta ", newString: "  beta" },
    ]);

    expect(await readFile(partialPath, "utf8")).toBe("ALPHA\n  beta");
    expect(outcome.noops).toEqual([{ index: 1, range: "2" }]);
  });

  test("reports closest regions when oldString is not found", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    await expect(
      editFile(path, [{ oldString: "betx", newString: "delta" }])
    ).rejects.toThrow(/oldString was not found[\s\S]*lines 2/);
  });

  test("reports bare not found when nothing is close", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "aaaa\nbbbb", "utf8");

    await expect(
      editFile(path, [{ oldString: "zzzz", newString: "delta" }])
    ).rejects.toThrow("oldString was not found in the file.");
  });

  test("rejects multiple matches without replaceAll", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "foo\nbar\nfoo", "utf8");

    await expect(
      editFile(path, [{ oldString: "foo", newString: "baz" }])
    ).rejects.toThrow(/matched multiple regions/);
  });

  test("rejects escape drift after fuzzy match", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "  beta", "utf8");

    await expect(
      editFile(path, [{ oldString: "beta ", newString: "new\\nvalue" }])
    ).rejects.toThrow(/newString contains literal escape text/);
  });

  test("preserves UTF-8 BOM when editing", async () => {
    const root = await tempRoot();
    const path = join(root, "bom.txt");
    await writeFile(path, "\uFEFFalpha\nbeta", "utf8");

    await editFile(path, [{ oldString: "beta", newString: "delta" }]);

    const bytes = await Bun.file(path).bytes();
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(await readFile(path, "utf8")).toBe("\uFEFFalpha\ndelta");
  });

  test("preserves CRLF line endings when editing", async () => {
    const root = await tempRoot();
    const path = join(root, "crlf.txt");
    await writeFile(path, "alpha\r\nbeta\r\n", "utf8");

    await editFile(path, [{ oldString: "beta", newString: "delta" }]);

    expect(await readFile(path, "utf8")).toBe("alpha\r\ndelta\r\n");
  });

  test("updates symlink targets and preserves hard-link inodes plus mode", async () => {
    const root = await tempRoot();
    const target = join(root, "target.txt");
    const linked = join(root, "linked.txt");
    const alias = join(root, "alias.txt");

    await writeFile(target, "alpha\nbeta", "utf8");
    await chmod(target, 0o640);
    await link(target, linked);
    await symlink(target, alias);

    const before = await stat(target);

    await editFile(alias, [{ oldString: "beta", newString: "delta" }]);

    const after = await stat(target);
    expect(await readFile(target, "utf8")).toBe("alpha\ndelta");
    expect(await readFile(linked, "utf8")).toBe("alpha\ndelta");
    expect(after.ino).toBe(before.ino);
    expect(Number(after.mode) & 0o777).toBe(0o640);
  });

  test("serializes concurrent edits on the same path", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "0\n", "utf8");

    const concurrent = await Promise.all([
      editFile(path, [{ oldString: "0", newString: "0\n1" }]),
      editFile(path, [{ oldString: "0", newString: "0\n2" }]),
      editFile(path, [{ oldString: "0", newString: "0\n3" }]),
    ]);

    const final = await readFile(path, "utf8");
    expect(final).toContain("0");
    expect(concurrent).toHaveLength(3);
  });

  test("buildDiff splits distant edits into separate hunks", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    const lines = Array.from(
      { length: 200 },
      (_, index) => `line ${index + 1}`
    );
    await writeFile(path, lines.join("\n"), "utf8");

    const outcome = await editFile(path, [
      { oldString: "line 1\nline 2", newString: "changed 1\nline 2" },
      { oldString: "line 199\nline 200", newString: "line 199\nchanged 200" },
    ]);

    expect(outcome.diff?.hunks).toHaveLength(2);
    expect(formatEditSummary(path, outcome)).toBe(
      `2 edits made to ${path}: lines 1-2 and 199-200.`
    );
  });

  test("rejects directories and binary files", async () => {
    const root = await tempRoot();
    const binary = join(root, "bin.dat");
    await Bun.write(binary, new Uint8Array([0, 1, 2, 0, 4]));

    await expect(
      editFile(root, [{ oldString: "x", newString: "y" }])
    ).rejects.toThrow(/Path is a directory/);

    await expect(
      editFile(binary, [{ oldString: "x", newString: "y" }])
    ).rejects.toThrow(/binary file/);
  });
});
