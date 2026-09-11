import { expect, test } from "bun:test";
import { FuzzyMatcher, type FuzzyCandidate } from "./FuzzyMatcher";

type Command = {
  readonly name: string;
  readonly description: string;
};

const commandCandidates = (
  commands: readonly Command[]
): readonly FuzzyCandidate<Command>[] =>
  commands.map((command) => ({
    item: command,
    haystacks: [command.name, command.description],
  }));

test("empty query returns candidates sorted alphabetically by first haystack", () => {
  const candidates = commandCandidates([
    { name: "rename", description: "rename" },
    { name: "clear", description: "clear" },
    { name: "help", description: "help" },
  ]);

  const hits = FuzzyMatcher.rank("", candidates);

  expect(hits.map((hit) => hit.item.name)).toEqual(["clear", "help", "rename"]);
  expect(hits[0]?.score).toBe(0);
  expect(hits[0]?.positions.size).toBe(0);
});

test("whitespace-only query is treated as empty", () => {
  const candidates = commandCandidates([
    { name: "b", description: "b" },
    { name: "a", description: "a" },
  ]);

  const hits = FuzzyMatcher.rank("   ", candidates);

  expect(hits.map((hit) => hit.item.name)).toEqual(["a", "b"]);
});

test("non-empty query orders results by fzf score", () => {
  const candidates = commandCandidates([
    { name: "clear", description: "Clear the session." },
    { name: "rename", description: "Rename the session." },
    { name: "resume", description: "Resume a session." },
    { name: "help", description: "Show help." },
  ]);

  const hits = FuzzyMatcher.rank("cl", candidates);

  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.item.name).toBe("clear");
});

test("limit truncates ranked results", () => {
  const candidates = commandCandidates([
    { name: "alpha", description: "" },
    { name: "alphabet", description: "" },
    { name: "alphanumeric", description: "" },
  ]);

  const hits = FuzzyMatcher.rank("a", candidates, { limit: 2 });

  expect(hits.length).toBe(2);
});

test("limit also applies to the empty-query alphabetical case", () => {
  const candidates = commandCandidates([
    { name: "c", description: "" },
    { name: "a", description: "" },
    { name: "b", description: "" },
  ]);

  const hits = FuzzyMatcher.rank("", candidates, { limit: 2 });

  expect(hits.map((hit) => hit.item.name)).toEqual(["a", "b"]);
});

test("ties on score break toward the earlier match start", () => {
  const candidates = commandCandidates([
    { name: "new", description: "Start a new session." },
    { name: "status", description: "Show the current session status." },
  ]);

  const hits = FuzzyMatcher.rank("sta", candidates);

  expect(hits[0]?.item.name).toBe("status");
});

test("ties on score and start break toward the shorter haystack", () => {
  const candidates: readonly FuzzyCandidate<string>[] = [
    {
      item: "src/shared/DiffLines.test.ts",
      haystacks: ["src/shared/DiffLines.test.ts"],
    },
    { item: "src/shared/DiffLines.ts", haystacks: ["src/shared/DiffLines.ts"] },
  ];

  const hits = FuzzyMatcher.rank("difflines", candidates);

  expect(hits[0]?.item).toBe("src/shared/DiffLines.ts");
});

test("matches against the second haystack when the first does not contain the query", () => {
  const candidates = commandCandidates([
    { name: "noop", description: "fully unrelated" },
    { name: "x", description: "rename the session" },
  ]);

  const hits = FuzzyMatcher.rank("rename", candidates);

  expect(hits[0]?.item.name).toBe("x");
});
