import { afterEach, expect, test } from "bun:test";

import {
  startParent,
  type Parent,
  type Reply,
} from "../subagent/fixtures/parent";
import { SubagentJobs } from "../subagent/SubagentJobs";
import { usePimHome } from "../../shared/fixtures/home";
import handoff from "./index";

usePimHome("pim-handoff-");

let parents: Parent[] = [];

afterEach(async () => {
  await Promise.all(parents.map((parent) => parent.dispose()));
  parents = [];
});

const INSTRUCTION = "Your conversation is about to be cleared";

const NOTE = "Fix the flaky test in `a.test.ts`; the retry idea is a dead end.";

const handOff: Reply = {
  call: { id: "call-1", name: "handoff", arguments: { note: NOTE } },
};

async function start(replies: readonly Reply[]): Promise<Parent> {
  const parent = await startParent({
    jobs: new SubagentJobs(),
    script: (_request, index) => replies[index] ?? { text: "ok" },
    extensions: [handoff],
  });
  parents.push(parent);
  return parent;
}

function sent(parent: Parent, index: number): string {
  return JSON.stringify(parent.requests[index]?.messages);
}

test("/handoff carries on from only the note, keeping the whole transcript", async () => {
  const parent = await start([{ text: "hello there" }, handOff]);
  const { session } = parent;
  await session.prompt("say hello");
  await session.prompt("/handoff the tests");
  expect(parent.requests).toHaveLength(2);
  expect(sent(parent, 1)).toContain("focus on: the tests");
  expect(sent(parent, 1)).toContain(INSTRUCTION);

  await session.prompt("carry on");

  const resumed = sent(parent, 2);
  expect(resumed).toContain("the retry idea is a dead end");
  expect(resumed).toContain("carry on");
  expect(resumed).not.toContain("say hello");
  expect(resumed).not.toContain("hello there");
  expect(resumed).not.toContain(INSTRUCTION);
  const shown = JSON.stringify(session.sessionManager.getBranch());
  expect(shown).toContain("say hello");
  expect(shown).toContain('"tokensAfter"');
  expect(parent.errors).toEqual([]);
});

test("a handoff the model declines leaves the context as it was, without the instruction", async () => {
  const parent = await start([{ text: "hello there" }, { text: "no" }]);
  const { session } = parent;
  await session.prompt("say hello");
  await session.prompt("/handoff");
  await session.prompt("carry on");

  const resumed = sent(parent, 2);
  expect(resumed).toContain("say hello");
  expect(resumed).not.toContain(INSTRUCTION);
  expect(parent.errors).toEqual([]);
});

test("the tool refuses a handoff nobody asked for", async () => {
  const parent = await start([handOff]);
  await parent.session.prompt("say hello");

  expect(sent(parent, 1)).toContain("only when the user asks");
  expect(sent(parent, 1)).toContain("say hello");
});
