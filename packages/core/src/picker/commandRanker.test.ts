import { expect, test } from "bun:test";
import type { PickerItem } from "./PickerItem";
import { rankCommands } from "./commandRanker";

const item = (name: string, description?: string): PickerItem => ({
  value: name,
  label: name,
  ...(description !== undefined && { description }),
});

test("empty query returns items alphabetically by label", () => {
  const items = rankCommands("", [
    item("rename", "Rename the session."),
    item("clear", "Clear the session."),
    item("help", "Show help."),
  ]);

  expect(items.map((i) => i.value)).toEqual(["clear", "help", "rename"]);
});

test("query ranks fuzzy matches by score", () => {
  const items = rankCommands("cl", [
    item("rename", "Rename the session."),
    item("clear", "Clear the session."),
    item("help", "Show help."),
  ]);

  expect(items[0]?.value).toBe("clear");
});

test("matches against description when label doesn't contain query", () => {
  const items = rankCommands("rename", [
    item("noop", "fully unrelated"),
    item("x", "rename the session"),
  ]);

  expect(items[0]?.value).toBe("x");
});

test("limit caps the returned items", () => {
  const items = rankCommands("", [item("c"), item("a"), item("b"), item("d")], {
    limit: 2,
  });

  expect(items.map((i) => i.value)).toEqual(["a", "b"]);
});
