import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SendFile } from "./SendFile";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pim-sendfile-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test("resolves a relative path against the cwd and reports its size", async () => {
  await Bun.write(join(cwd, "notes.txt"), "hello");

  expect(await SendFile.validate("notes.txt", cwd)).toEqual({
    path: join(cwd, "notes.txt"),
    size: 5,
  });
});

test("refuses a missing path and a directory", async () => {
  expect(SendFile.validate("nope.png", cwd)).rejects.toThrow(/Path not found/);
  expect(SendFile.validate(".", cwd)).rejects.toThrow(
    ". is not a regular file."
  );
});

test("any size passes unless the caller sets a cap", async () => {
  const huge = join(cwd, "huge.bin");
  await Bun.write(huge, "");
  await truncate(huge, 60 * 1024 * 1024);

  expect((await SendFile.validate("huge.bin", cwd)).size).toBe(
    60 * 1024 * 1024
  );
  expect(SendFile.validate("huge.bin", cwd, 50 * 1024 * 1024)).rejects.toThrow(
    "huge.bin is 60 MB; max allowed is 50 MB."
  );
});
