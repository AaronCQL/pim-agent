import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Hashline } from "../../shared/Hashline";
import { buildReadRange, readFile } from "./read";

const tempRoot = (): Promise<string> =>
  mkdtemp(join(tmpdir(), "pim-read-tool-"));

describe("readFile", () => {
  test("emits inclusive hashline ranges", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf8");

    const outcome = await readFile(path, buildReadRange(2, 2, "hashline"));
    expect(outcome.body).toBe(Hashline.formatLine(2, "beta"));
    expect(outcome.totalLines).toBe(3);
    expect(outcome.visibleStart).toBe(2);
    expect(outcome.visibleEnd).toBe(2);
    expect(outcome.truncatedByByteCap).toBe(false);
    expect(outcome.nextStart).toBeUndefined();
  });

  test("does not surface a phantom final line for files ending in a newline", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");

    const outcome = await readFile(
      path,
      buildReadRange(undefined, undefined, "hashline")
    );
    expect(outcome.body).toBe(
      [
        Hashline.formatLine(1, "alpha"),
        Hashline.formatLine(2, "beta"),
        Hashline.formatLine(3, "gamma"),
      ].join("\n")
    );
    expect(outcome.totalLines).toBe(3);
  });

  test("throws on empty files and out-of-range starts", async () => {
    const root = await tempRoot();
    const path = join(root, "empty.txt");
    await writeFile(path, "", "utf8");

    await expect(
      readFile(path, buildReadRange(undefined, undefined, "hashline"))
    ).rejects.toThrow(
      "File is empty. Use edit with prepend or append and omit pos to insert content."
    );

    await expect(
      readFile(path, buildReadRange(2, undefined, "hashline"))
    ).rejects.toThrow(
      "File is empty. Use edit with prepend or append and omit pos to insert content."
    );

    const populated = join(root, "small.txt");
    await writeFile(populated, "alpha\nbeta", "utf8");
    await expect(
      readFile(populated, buildReadRange(99, undefined, "hashline"))
    ).rejects.toThrow(
      "Start 99 is beyond end of file (2 lines total). Use start=1 to read from the beginning, or start=2 to read the last line."
    );
  });

  test("throws the same advisories in plain format", async () => {
    const root = await tempRoot();
    const path = join(root, "empty.txt");
    await writeFile(path, "", "utf8");

    await expect(
      readFile(path, buildReadRange(undefined, undefined, "plain"))
    ).rejects.toThrow("File is empty.");

    const populated = join(root, "small.txt");
    await writeFile(populated, "alpha\nbeta", "utf8");
    await expect(
      readFile(populated, buildReadRange(99, undefined, "plain"))
    ).rejects.toThrow("Start 99 is beyond end of file (2 lines total).");
  });

  test("rejects directories and binary files", async () => {
    const root = await tempRoot();
    const nested = join(root, "nested");
    const binary = join(root, "data.bin");

    await mkdir(nested);
    await Bun.write(binary, new Uint8Array([1, 0, 2]));

    await expect(
      readFile(nested, buildReadRange(undefined, undefined, "hashline"))
    ).rejects.toThrow(`Path is a directory: ${nested}`);

    await expect(
      readFile(binary, buildReadRange(undefined, undefined, "hashline"))
    ).rejects.toThrow("Read only supports UTF-8 text files");
  });

  test("returns missing-file error with remediation hint", async () => {
    const root = await tempRoot();
    const missing = join(root, "nope.txt");

    await expect(
      readFile(missing, buildReadRange(undefined, undefined, "hashline"))
    ).rejects.toThrow(
      `File not found: ${missing}. Use glob to locate the file or verify the path.`
    );
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
        readFile(path, buildReadRange(undefined, undefined, "hashline"))
      ).rejects.toThrow(`Permission denied reading ${path}.`);
    } finally {
      await chmod(path, 0o644);
    }
  });

  test("supports plain output", async () => {
    const root = await tempRoot();
    const path = join(root, "notes.txt");
    await writeFile(path, "alpha\nbeta", "utf8");

    const outcome = await readFile(
      path,
      buildReadRange(undefined, undefined, "plain")
    );
    expect(outcome.body).toBe("alpha\nbeta");
    expect(outcome.truncatedByByteCap).toBe(false);
  });

  test("throws when the first line alone exceeds the byte cap", async () => {
    const root = await tempRoot();
    const path = join(root, "huge.txt");
    const huge = "x".repeat(40 * 1024);
    await writeFile(path, `${huge}\nshort line`, "utf8");

    const promise = readFile(
      path,
      buildReadRange(undefined, undefined, "plain")
    );

    await expect(promise).rejects.toThrow(
      new RegExp(
        `Line 1 is .* exceeds the .* read cap\\. Use bash: sed -n '1p' ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| head -c \\d+, or call read again with start=2 to skip this line\\.`
      )
    );
  });

  test("throws without next-line hint when the only line exceeds the byte cap", async () => {
    const root = await tempRoot();
    const path = join(root, "single.txt");
    await writeFile(path, "x".repeat(40 * 1024), "utf8");

    const promise = readFile(
      path,
      buildReadRange(undefined, undefined, "plain")
    );

    await expect(promise).rejects.toThrow(
      /Use bash: sed -n '1p' .* head -c \d+\.$/
    );
  });

  test("applies a 32 KiB head-only byte cap and reports pagination metadata", async () => {
    const root = await tempRoot();
    const path = join(root, "long.txt");
    const lines = Array.from(
      { length: 80 },
      (_, index) => `${index + 1}: ${"x".repeat(500)}`
    );
    await writeFile(path, lines.join("\n"), "utf8");

    const outcome = await readFile(
      path,
      buildReadRange(undefined, undefined, "hashline")
    );
    expect(Buffer.byteLength(outcome.body, "utf8")).toBeLessThanOrEqual(
      32 * 1024
    );
    expect(outcome.truncatedByByteCap).toBe(true);
    expect(outcome.nextStart).toBeDefined();
    expect(outcome.nextStart).toBe(outcome.visibleEnd + 1);
    expect(outcome.totalLines).toBe(80);
    expect(outcome.body).not.toContain("[Showing lines");
  });
});

describe("buildReadRange", () => {
  test("rejects end before start", () => {
    expect(() => buildReadRange(5, 4, "hashline")).toThrow(
      "Read end line 4 must be >= start line 5."
    );
  });

  test("rejects non-positive integers", () => {
    expect(() => buildReadRange(0, undefined, "hashline")).toThrow(
      "Read start 0 must be a positive integer."
    );
    expect(() => buildReadRange(undefined, -1, "hashline")).toThrow(
      "Read end -1 must be a positive integer."
    );
  });

  test("defaults start to 1 and format to hashline", () => {
    expect(buildReadRange(undefined, undefined, undefined)).toEqual({
      start: 1,
      format: "hashline",
    });
  });
});
