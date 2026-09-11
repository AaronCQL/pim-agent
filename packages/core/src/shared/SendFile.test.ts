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

test("refuses a missing path, a directory and an oversize file", async () => {
  expect(SendFile.validate("nope.png", cwd)).rejects.toThrow(/Path not found/);
  expect(SendFile.validate(".", cwd)).rejects.toThrow(
    ". is not a regular file."
  );

  const huge = join(cwd, "huge.bin");
  await Bun.write(huge, "");
  await truncate(huge, SendFile.MAX_BYTES + 1);
  expect(SendFile.validate("huge.bin", cwd)).rejects.toThrow(
    `huge.bin is ${SendFile.MAX_BYTES + 1} bytes; max allowed is ${SendFile.MAX_BYTES}.`
  );
});
