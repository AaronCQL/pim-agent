import { expect, test } from "bun:test";

import { JobLine } from "./JobLine";
import type { JobView } from "./SubagentJobs";

const job: JobView = {
  id: "call-1",
  handle: "j1",
  title: "fix\r\nthe\tbug\x07",
  startedAt: 0,
  turns: 4,
  cost: 0.123,
};

test("parts are the handle, the usage stats and the elapsed time", () => {
  expect(JobLine.parts(job, 125_000)).toEqual({
    handle: "j1",
    stats: [{ text: "4 turns" }, { text: "$0.12" }],
    elapsed: "2m 5s",
  });
});

test("usage adds the context share only when both sides are known", () => {
  const usage = { turns: 1, cost: 0 };
  const texts = (job: Parameters<typeof JobLine.usage>[0]) =>
    JobLine.usage(job).map((span) => span.text);
  expect(
    texts({ ...usage, contextTokens: 50_000, contextWindow: 1_000_000 })
  ).toEqual(["1 turn", "$0.00", "5.0%/1.0M"]);
  expect(texts({ ...usage, contextTokens: 50_000 })).toEqual([
    "1 turn",
    "$0.00",
  ]);
  expect(texts({ ...usage, contextTokens: 50_000, contextWindow: 0 })).toEqual([
    "1 turn",
    "$0.00",
  ]);
});

test("the context share is amber past 40% and red from 70%", () => {
  const tone = (contextTokens: number) =>
    JobLine.usage({ turns: 1, cost: 0, contextTokens, contextWindow: 100 })[2]
      ?.tone;
  expect(tone(40)).toBeUndefined();
  expect(tone(41)).toBe("warning");
  expect(tone(70)).toBe("error");
});

test("the model's line joins handle, elapsed, usage and a one-line title", () => {
  expect(JobLine.text(job, 125_000)).toBe(
    "- j1 · 2m 5s · 4 turns · $0.12 · fix the bug"
  );
  expect(
    JobLine.text({ ...job, contextTokens: 10_000, contextWindow: 200_000 }, 0)
  ).toBe("- j1 · 0s · 4 turns · $0.12 · 5.0%/200K · fix the bug");
});

test("handle numbers read j-handles and nothing else", () => {
  expect(JobLine.handleNumber("j12")).toBe(12);
  expect(JobLine.handleNumber("x")).toBe(0);
});
