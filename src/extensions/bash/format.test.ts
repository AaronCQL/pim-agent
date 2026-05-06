import { describe, expect, test } from "bun:test";
import {
  formatResult,
  formatStreamHeader,
  isErrorResult,
  stripTrailingNewline,
} from "./format";
import type { BashCommandResult } from "./schema";

function makeResult(
  overrides: Partial<BashCommandResult> = {}
): BashCommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: { text: "", totalBytes: 0, truncated: false },
    stderr: { text: "", totalBytes: 0, truncated: false },
    timedOut: false,
    aborted: false,
    durationMs: 1,
    ...overrides,
  };
}

describe("stripTrailingNewline", () => {
  test("removes one trailing newline", () => {
    expect(stripTrailingNewline("foo\n")).toBe("foo");
  });
  test("leaves no-newline strings alone", () => {
    expect(stripTrailingNewline("foo")).toBe("foo");
  });
  test("only strips one", () => {
    expect(stripTrailingNewline("foo\n\n")).toBe("foo\n");
  });
});

describe("formatStreamHeader", () => {
  test("plain label when not truncated", () => {
    expect(
      formatStreamHeader("stdout", {
        text: "x",
        totalBytes: 1,
        truncated: false,
      })
    ).toBe("stdout:");
  });
  test("includes byte count when truncated", () => {
    expect(
      formatStreamHeader("stderr", {
        text: "x",
        totalBytes: 12345,
        truncated: true,
      })
    ).toBe("stderr (12345 bytes):");
  });
});

describe("formatResult", () => {
  test("happy path with stdout only", () => {
    const out = formatResult(
      makeResult({
        stdout: { text: "hello\n", totalBytes: 6, truncated: false },
      }),
      30_000
    );
    expect(out).toBe("Exit code: 0\nstdout:\nhello");
  });

  test("includes signal line when signal present", () => {
    const out = formatResult(
      makeResult({ exitCode: null, signal: "SIGTERM" }),
      30_000
    );
    expect(out).toContain("Exit code: none");
    expect(out).toContain("Signal: SIGTERM");
  });

  test("aborted overrides timed out message", () => {
    const out = formatResult(
      makeResult({ aborted: true, timedOut: true }),
      30_000
    );
    expect(out).toContain("Aborted.");
    expect(out).not.toContain("Timed out");
  });

  test("timed out adds duration message", () => {
    const out = formatResult(makeResult({ timedOut: true }), 5000);
    expect(out).toContain("Timed out after 5000 ms.");
  });

  test("includes both stdout and stderr when both have bytes", () => {
    const out = formatResult(
      makeResult({
        exitCode: 1,
        stdout: { text: "out", totalBytes: 3, truncated: false },
        stderr: { text: "err", totalBytes: 3, truncated: false },
      }),
      30_000
    );
    expect(out).toBe("Exit code: 1\nstdout:\nout\nstderr:\nerr");
  });
});

describe("isErrorResult", () => {
  test("zero exit code is not an error", () => {
    expect(isErrorResult(makeResult({ exitCode: 0 }))).toBe(false);
  });
  test("non-zero exit code is an error", () => {
    expect(isErrorResult(makeResult({ exitCode: 1 }))).toBe(true);
  });
  test("null exit code is an error", () => {
    expect(isErrorResult(makeResult({ exitCode: null }))).toBe(true);
  });
  test("aborted is an error", () => {
    expect(isErrorResult(makeResult({ aborted: true }))).toBe(true);
  });
  test("timed out is an error", () => {
    expect(isErrorResult(makeResult({ timedOut: true }))).toBe(true);
  });
});
