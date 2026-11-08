import { expect, test } from "bun:test";

import { DiffLines } from "#core/shared/DiffLines";
import { ChangeMarks } from "./ChangeMarks";

function marks(before: string, after: string) {
  const diff = DiffLines.buildToolDiff(
    "file.ts",
    DiffLines.fromText(before),
    DiffLines.fromText(after),
    3
  );
  const total = DiffLines.fromText(after).lines.length;
  return Object.fromEntries(ChangeMarks.of(diff?.hunks ?? [], total));
}

test("new lines are added, rewritten lines are modified", () => {
  expect(marks("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({
    2: "modified",
    4: "added",
  });
});

test("removed lines mark the line that follows them", () => {
  expect(marks("a\nb\nc\nd\n", "a\nd\n")).toEqual({ 2: "removedAbove" });
  expect(marks("a\nb\nc\n", "c\n")).toEqual({ 1: "removedAbove" });
});

test("lines removed from the end mark the last line", () => {
  expect(marks("a\nb\nc\n", "a\n")).toEqual({ 1: "removedBelow" });
});

test("far-apart edits land on their own lines", () => {
  const before = Array.from({ length: 30 }, (_, at) => `line ${at}`);
  const after = [...before];
  after[2] = "changed";
  after.splice(25, 0, "inserted");
  expect(marks(`${before.join("\n")}\n`, `${after.join("\n")}\n`)).toEqual({
    3: "modified",
    26: "added",
  });
});

test("a whole new file is added throughout", () => {
  expect(Object.fromEntries(ChangeMarks.whole(2))).toEqual({
    1: "added",
    2: "added",
  });
});
