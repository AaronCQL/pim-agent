import { describe, expect, test } from "bun:test";

import { JobMessage } from "./JobMessage";
import { SubagentNotice } from "./SubagentNotice";
import type { SubagentResultMessage } from "./SubagentResult";

const notice = SubagentNotice.of(
  {
    jobId: "call-1",
    handle: "j1",
    contextTokens: 402_000,
    contextWindow: 1_000_000,
    turns: 69,
    cost: 9.8,
    elapsedMs: 30 * 60_000,
  },
  []
);

const result = {
  customType: "subagent_result",
  content: "[subagent job j1 done]",
  display: true,
  details: { jobId: "call-1", handle: "j1", state: "done" },
} as unknown as SubagentResultMessage;

const spawn = {
  type: "message",
  message: { role: "toolResult", toolCallId: "call-1" },
};

function session(
  branch: readonly unknown[],
  elsewhere: readonly unknown[] = []
) {
  return {
    getBranch: () => branch as never,
    getEntries: () => [...elsewhere, ...branch] as never,
  };
}

function entry(message: object) {
  return { type: "custom_message", ...message };
}

describe("JobMessage.placement", () => {
  test("a notice is due until it, or its job's result, is on the branch", () => {
    expect(JobMessage.placement(session([spawn]), notice)).toBe("due");
    expect(JobMessage.placement(session([spawn, entry(notice)]), notice)).toBe(
      "landed"
    );
    expect(JobMessage.placement(session([spawn, entry(result)]), notice)).toBe(
      "landed"
    );
  });

  test("a notice on the branch never stands in for the job's result", () => {
    expect(JobMessage.placement(session([spawn, entry(notice)]), result)).toBe(
      "due"
    );
  });

  test("a notice whose spawn is on another branch waits there", () => {
    expect(JobMessage.placement(session([], [spawn]), notice)).toBe(
      "elsewhere"
    );
  });
});

describe("JobMessage.key", () => {
  test("tells a job's notice from its result, and ignores other messages", () => {
    expect(JobMessage.key(notice)).toBe("subagent_notice:call-1");
    expect(JobMessage.key(result)).toBe("subagent_result:call-1");
    expect(JobMessage.key({ customType: "other", details: {} })).toBe(
      undefined
    );
  });
});

describe("SubagentNotice", () => {
  test("its one line names the job and its share, then its usage", () => {
    expect(SubagentNotice.line(notice.details)).toBe(
      "⚠ j1 at 40% context · 69 turns · $9.80 · 30m 0s"
    );
  });

  test("rejects details missing any field its line reads", () => {
    expect(SubagentNotice.detailsOf(notice)).toEqual(notice.details);
    for (const [field, value] of [
      ["handle", undefined],
      ["turns", undefined],
      ["cost", "9.8"],
      ["elapsedMs", Number.NaN],
      ["contextTokens", undefined],
      ["contextWindow", 0],
    ] as const) {
      expect(
        SubagentNotice.detailsOf({
          ...notice,
          details: { ...notice.details, [field]: value },
        })
      ).toBeUndefined();
    }
  });
});
