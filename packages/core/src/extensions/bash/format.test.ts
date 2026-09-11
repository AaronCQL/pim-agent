import { describe, expect, test } from "bun:test";
import { normalised } from "../../shared/fixtures/images";
import {
  detailsOf,
  formatResult,
  formatTruncationAffordance,
  isErrorResult,
  stripTrailingNewline,
} from "./format";
import {
  type BashCommandResult,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

const picture = normalised({
  mimeType: "image/png",
  width: 40,
  height: 30,
  bytes: 2560,
  originalWidth: 40,
  originalHeight: 30,
  originalMimeType: "image/png",
  sha256: "abc123",
});

function makeResult(
  overrides: Partial<BashCommandResult> = {}
): BashCommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: {
      text: "",
      totalBytes: 0,
      truncated: false,
      path: null,
      nextStart: null,
    },
    stderr: {
      text: "",
      totalBytes: 0,
      truncated: false,
      path: null,
      nextStart: null,
    },
    stdoutSniffed: null,
    stdoutImage: null,
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

describe("formatTruncationAffordance", () => {
  test("emits bracketed affordance with byte counts and next-step", () => {
    const out = formatTruncationAffordance("stderr", {
      text: "x",
      totalBytes: 12345,
      truncated: true,
      path: null,
      nextStart: 1,
    });
    expect(out.startsWith("[bash tool:")).toBe(true);
    expect(out.endsWith("]")).toBe(true);
    expect(out).toContain("stderr showing first");
    expect(out).toContain(`first ${STREAM_HEAD_BYTES} bytes`);
    expect(out).toContain(`last ${STREAM_TAIL_BYTES} bytes`);
    expect(out).toContain("of 12345");
    expect(out).toContain("redirect to a file");
    expect(out).toContain("read");
  });

  test("points to spill path with a resume line when one is provided", () => {
    const out = formatTruncationAffordance("stdout", {
      text: "x",
      totalBytes: 99999,
      truncated: true,
      path: "/tmp/pim-bash-abc.out",
      nextStart: 42,
    });
    expect(out).toContain(
      "use read with path=/tmp/pim-bash-abc.out and start=42 for the rest."
    );
    expect(out).not.toContain("redirect to a file");
  });
});

describe("formatResult", () => {
  test("happy path with stdout only", () => {
    const out = formatResult(
      makeResult({
        stdout: {
          text: "hello\n",
          totalBytes: 6,
          truncated: false,
          path: null,
          nextStart: null,
        },
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
        stdout: {
          text: "out",
          totalBytes: 3,
          truncated: false,
          path: null,
          nextStart: null,
        },
        stderr: {
          text: "err",
          totalBytes: 3,
          truncated: false,
          path: null,
          nextStart: null,
        },
      }),
      30_000
    );
    expect(out).toBe("Exit code: 1\nstdout:\nout\nstderr:\nerr");
  });

  test("appends bracket affordance after a truncated stream body", () => {
    const out = formatResult(
      makeResult({
        stdout: {
          text: "head…tail",
          totalBytes: 99999,
          truncated: true,
          path: null,
          nextStart: 1,
        },
      }),
      30_000
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Exit code: 0");
    expect(lines[1]).toBe("stdout:");
    expect(lines[2]).toBe("head…tail");
    expect(lines[3]?.startsWith("[bash tool: stdout showing first")).toBe(true);
    expect(lines[3]?.endsWith("]")).toBe(true);
  });

  test("does not append affordance when stream is not truncated", () => {
    const out = formatResult(
      makeResult({
        stdout: {
          text: "ok",
          totalBytes: 2,
          truncated: false,
          path: null,
          nextStart: null,
        },
      }),
      30_000
    );
    expect(out).not.toContain("[bash tool:");
  });

  test("says nothing about stdout when the picture rides the content array", () => {
    const out = formatResult(
      makeResult({
        stdout: {
          text: "",
          totalBytes: 4096,
          truncated: false,
          path: null,
          nextStart: null,
        },
        stdoutSniffed: "image/png",
        stdoutImage: picture,
      }),
      30_000
    );
    expect(out).toBe("Exit code: 0");
  });

  test("names the bytes when a failing command means the picture is not shown", () => {
    const out = formatResult(
      makeResult({
        exitCode: 1,
        stdout: {
          text: "",
          totalBytes: 4096,
          truncated: false,
          path: null,
          nextStart: null,
        },
        stdoutSniffed: "image/png",
      }),
      30_000
    );
    expect(out).toBe(
      "Exit code: 1\n[bash tool: stdout is 4 KB of png data, not shown because the command failed.]"
    );
  });

  test("names bytes that sniffed as a picture but decoded as nothing", () => {
    const out = formatResult(
      makeResult({
        stdout: {
          text: "",
          totalBytes: 12,
          truncated: false,
          path: null,
          nextStart: null,
        },
        stdoutSniffed: "image/webp",
      }),
      30_000
    );
    expect(out).toBe(
      "Exit code: 0\n[bash tool: stdout is 12 bytes of webp data that could not be decoded as an image.]"
    );
  });
});

describe("detailsOf", () => {
  test("mirrors per-stream truncation and byte counts", () => {
    const details = detailsOf(
      makeResult({
        exitCode: 1,
        durationMs: 42,
        stdout: {
          text: "x",
          totalBytes: 99999,
          truncated: true,
          path: null,
          nextStart: 1,
        },
        stderr: {
          text: "y",
          totalBytes: 5,
          truncated: false,
          path: null,
          nextStart: null,
        },
      })
    );
    expect(details).toEqual({
      exitCode: 1,
      signal: null,
      durationMs: 42,
      timedOut: false,
      aborted: false,
      stdout: { totalBytes: 99999, truncated: true, path: null },
      stderr: { totalBytes: 5, truncated: false, path: null },
    });
  });

  test("carries the picture's address, never its bytes", () => {
    const details = detailsOf(makeResult({ stdoutImage: picture }));
    expect(details.image).toEqual({
      sha256: "abc123",
      mimeType: "image/png",
      width: 40,
      height: 30,
      bytes: 2560,
      resized: false,
      frames: 1,
    });
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
