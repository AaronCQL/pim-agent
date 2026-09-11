import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { OutputBudget } from "../../shared/OutputBudget";
import { buildReadRange, readFile } from "./read";

const MAX_LINE_LENGTH = OutputBudget.maxLineLength;

const tempRoots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pim-read-tool-"));
  tempRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("readFile", () => {
  test("emits inclusive LINE:CONTENT ranges", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    const outcome = await readFile(path, buildReadRange(2, 2));
    expect(outcome.body).toBe("2:beta");
    expect(outcome.totalLines).toBe(3);
    expect(outcome.visibleStart).toBe(2);
    expect(outcome.visibleEnd).toBe(2);
    expect(outcome.truncatedByByteCap).toBe(false);
    expect(outcome.truncatedByEnd).toBe(true);
    expect(outcome.nextStart).toBe(3);
  });

  test("does not surface a phantom final line for files ending in a newline", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const outcome = await readFile(path, buildReadRange(undefined, undefined));
    expect(outcome.body).toBe(["1:alpha", "2:beta", "3:gamma"].join("\n"));
    expect(outcome.totalLines).toBe(3);
    expect(outcome.truncatedByEnd).toBe(false);
  });

  test("reports the actual final line when end is beyond EOF", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    const outcome = await readFile(path, buildReadRange(undefined, 999));
    expect(outcome.body).toBe(["1:alpha", "2:beta", "3:gamma"].join("\n"));
    expect(outcome.totalLines).toBe(3);
    expect(outcome.visibleEnd).toBe(3);
    expect(outcome.truncatedByEnd).toBe(false);
  });

  test("strips UTF-8 BOM from output and reports it in details", async () => {
    const root = await tempRoot();
    const path = join(root, "bom.txt");
    await writeFile(path, "\uFEFFalpha\nbeta", "utf8");

    const outcome = await readFile(path, buildReadRange(undefined, undefined));
    expect(outcome.body).toBe("1:alpha\n2:beta");
    expect(outcome.hadBom).toBe(true);
  });

  test("truncates very long individual lines", async () => {
    const root = await tempRoot();
    const path = join(root, "long-line.txt");
    await writeFile(path, `${"x".repeat(MAX_LINE_LENGTH + 10)}\nshort`, "utf8");

    const outcome = await readFile(path, buildReadRange(1, 1));
    expect(outcome.body).toBe(
      `1:${"x".repeat(MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`
    );
  });

  test("throws on empty files and out-of-range starts", async () => {
    const root = await tempRoot();
    const path = join(root, "empty.txt");
    await writeFile(path, "", "utf8");

    await expect(
      readFile(path, buildReadRange(undefined, undefined))
    ).rejects.toThrow("File is empty. Use the write tool to create content.");

    const populated = join(root, "small.txt");
    await writeFile(populated, "alpha\nbeta", "utf8");
    await expect(
      readFile(populated, buildReadRange(99, undefined))
    ).rejects.toThrow(
      "Start 99 is beyond end of file (2 lines total). Use start=1 to read from the beginning, or start=2 to read the last line."
    );
  });

  test("rejects directories and binary files", async () => {
    const root = await tempRoot();
    const nested = join(root, "nested");
    const binary = join(root, "data.bin");

    await mkdir(nested);
    await Bun.write(binary, new Uint8Array([1, 0, 2]));

    await expect(
      readFile(nested, buildReadRange(undefined, undefined))
    ).rejects.toThrow(`Path is a directory: ${nested}`);

    await expect(
      readFile(binary, buildReadRange(undefined, undefined))
    ).rejects.toThrow("Read only supports UTF-8 text files");
  });

  test("returns missing-file error with sibling suggestions", async () => {
    const root = await tempRoot();
    const missing = join(root, "note.txt");
    await writeFile(join(root, "notes.txt"), "alpha", "utf8");

    await expect(
      readFile(missing, buildReadRange(undefined, undefined))
    ).rejects.toThrow(/Did you mean one of these\?[\s\S]*notes\.txt/);
  });

  test("surfaces permission-denied as a structured error", async () => {
    if (process.getuid?.() === 0) {
      return;
    }

    const root = await tempRoot();
    const path = join(root, "locked.txt");
    await writeFile(path, "secret", "utf8");
    await chmod(path, 0o000);

    try {
      await expect(
        readFile(path, buildReadRange(undefined, undefined))
      ).rejects.toThrow(`Permission denied reading ${path}.`);
    } finally {
      await chmod(path, 0o644);
    }
  });

  test("applies a 32 KiB head-only byte cap and reports pagination metadata", async () => {
    const root = await tempRoot();
    const path = join(root, "long.txt");
    const lines = Array.from(
      { length: 80 },
      (_, index) => `${index + 1}: ${"x".repeat(500)}`
    );
    await writeFile(path, lines.join("\n"), "utf8");

    const outcome = await readFile(path, buildReadRange(undefined, undefined));
    expect(Buffer.byteLength(outcome.body, "utf8")).toBeLessThanOrEqual(
      32 * 1024
    );
    expect(outcome.truncatedByByteCap).toBe(true);
    expect(outcome.truncatedByEnd).toBe(true);
    expect(outcome.nextStart).toBe(outcome.visibleEnd + 1);
    expect(outcome.totalLines).toBe(80);
  });
});

describe("buildReadRange", () => {
  test("rejects end before start", () => {
    expect(() => buildReadRange(5, 4)).toThrow(
      "Read end line 4 must be >= start line 5."
    );
  });

  test("rejects non-positive integers", () => {
    expect(() => buildReadRange(0, undefined)).toThrow(
      "Read start 0 must be a positive integer."
    );
    expect(() => buildReadRange(undefined, -1)).toThrow(
      "Read end -1 must be a positive integer."
    );
  });

  test("defaults start to 1", () => {
    expect(buildReadRange(undefined, undefined)).toEqual({
      start: 1,
    });
  });
});
