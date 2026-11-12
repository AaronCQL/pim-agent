import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { FileChunks } from "./FileChunks";

afterEach(() => {
  mock.restore();
});

test("chunks are built only as requested and retained across pages", () => {
  const lines = Array.from({ length: 3001 }, (_, index) => `row ${index + 1}`);
  const slice = spyOn(lines, "slice");
  const chunks = new FileChunks(lines);
  expect(slice).not.toHaveBeenCalled();

  const first = chunks.take(3);
  expect(slice).toHaveBeenCalledTimes(3);
  expect(first).toHaveLength(3);
  expect(first[2]?.lines.at(-1)).toEqual({
    kind: "context",
    oldLine: 3000,
    newLine: 3000,
    text: "row 3000",
  });

  const more = chunks.take(6);
  expect(slice).toHaveBeenCalledTimes(4);
  expect(more).toHaveLength(4);
  for (const [index, hunk] of first.entries()) {
    expect(more[index]).toBe(hunk);
  }
  expect(more[3]?.lines).toEqual([
    { kind: "context", oldLine: 3001, newLine: 3001, text: "row 3001" },
  ]);
  expect(chunks.take(3)).toEqual(first);
  expect(slice).toHaveBeenCalledTimes(4);
});

test("an empty file has no chunks", () => {
  expect(new FileChunks([]).take(3)).toEqual([]);
});
