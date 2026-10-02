import { expect, test } from "bun:test";
import { rankCommands } from "./commandRanker";

test("matches against description when label doesn't contain query", () => {
  const items = rankCommands("rename", [
    { value: "noop", label: "noop", description: "fully unrelated" },
    { value: "x", label: "x", description: "rename the session" },
  ]);

  expect(items[0]?.value).toBe("x");
});
