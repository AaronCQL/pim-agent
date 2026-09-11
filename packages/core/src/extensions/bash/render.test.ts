import { describe, expect, test } from "bun:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ImageDetails } from "../../shared/Images";
import type { ToolViewInput } from "../../shared/Tools";
import { AnsiPainter } from "../../view/AnsiPainter";
import type { ToolView } from "../../view/ViewBlock";
import { bashView } from "./render";
import type { BashDetails, bashSchema } from "./schema";

type Input = ToolViewInput<typeof bashSchema, BashDetails>;

function tracingTheme(): {
  readonly theme: Theme;
  readonly calls: { readonly color: ThemeColor; readonly text: string }[];
} {
  const calls: { color: ThemeColor; text: string }[] = [];
  return {
    calls,
    theme: {
      fg: (color: ThemeColor, text: string) => {
        calls.push({ color, text });
        return `<${color}>${text}</${color}>`;
      },
    } as unknown as Theme,
  };
}

const cwd = "/work/repo";

function input(args: unknown, text?: string): Input {
  return {
    args: args as Input["args"],
    result:
      text === undefined
        ? undefined
        : ({
            content: [{ type: "text", text }],
            details: {
              exitCode: 0,
              signal: null,
              durationMs: 3,
              timedOut: false,
              aborted: false,
              stdout: { totalBytes: 0, truncated: false, path: null },
              stderr: { totalBytes: 0, truncated: false, path: null },
            },
          } as Input["result"]),
    cwd,
    isPartial: false,
  };
}

function paintTitle(args: unknown, themed = tracingTheme()): string {
  return AnsiPainter.paint(bashView(input(args)).title, themed.theme).join(" ");
}

function paintBody(args: unknown, text?: string): string {
  return AnsiPainter.paint(
    bashView(input(args, text)).body ?? [],
    tracingTheme().theme
  ).join("\n");
}

describe("bashView", () => {
  test("supplies the title-cased display label", () => {
    expect(bashView(input({ command: "ls" })).label).toBe("Bash");
  });
});

describe("bashView title", () => {
  test("renders the command verbatim and unstyled", () => {
    const themed = tracingTheme();
    expect(paintTitle({ command: "bun run check" }, themed)).toBe(
      "bun run check"
    );
    expect(themed.calls).toEqual([]);
  });

  test("keeps a multi-line command on separate lines", () => {
    expect(paintTitle({ command: "for f in a b; do\n  echo $f\ndone" })).toBe(
      "for f in a b; do\n  echo $f\ndone"
    );
  });

  test("placeholder while the command is still streaming", () => {
    expect(paintTitle({})).toBe("...");
    expect(paintTitle(undefined)).toBe("...");
    expect(paintTitle({ command: "" })).toBe("...");
  });

  test("ignores a non-string command from a malformed partial", () => {
    expect(paintTitle({ command: 42 })).toBe("...");
  });

  test("renders from args alone, without a result", () => {
    expect(paintTitle({ command: "ls", timeoutMs: 5000 })).toBe("ls");
  });
});

describe("bashView body", () => {
  test("paints the formatted result verbatim and unstyled", () => {
    expect(paintBody({ command: "echo hi" }, "Exit code: 0\nstdout:\nhi")).toBe(
      "Exit code: 0\nstdout:\nhi"
    );
  });

  test("keeps the truncation affordance the tool wrote for the model", () => {
    const text =
      "Exit code: 0\nstdout:\nhead…tail\n[bash tool: stdout showing first 8192 bytes + last 8192 bytes of 99999; use read with path=/tmp/x.out and start=42 for the rest.]";
    expect(paintBody({ command: "cat big" }, text)).toBe(text);
  });

  test("is empty while the call is in flight", () => {
    expect(paintBody({ command: "sleep 1" })).toBe("");
  });

  test("is empty when the result carries no text content", () => {
    expect(
      AnsiPainter.paint(
        bashView({
          args: { command: "true" } as Input["args"],
          result: { content: [] } as unknown as Input["result"],
          cwd,
          isPartial: false,
        }).body ?? [],
        tracingTheme().theme
      ).join("\n")
    ).toBe("");
  });
});

describe("bashView on stdout that is a picture", () => {
  const details = {
    exitCode: 0,
    signal: null,
    durationMs: 3,
    timedOut: false,
    aborted: false,
    stdout: { totalBytes: 2560, truncated: false, path: null },
    stderr: { totalBytes: 0, truncated: false, path: null },
    image: {
      sha256: "a".repeat(64),
      mimeType: "image/png",
      width: 40,
      height: 30,
      bytes: 2560,
      resized: false,
      frames: 1,
    },
  } satisfies BashDetails;

  function view(overrides: Partial<ImageDetails> = {}): ToolView {
    return bashView({
      args: { command: "grim -" } as Input["args"],
      result: {
        content: [{ type: "text", text: "Exit code: 0" }],
        details: { ...details, image: { ...details.image, ...overrides } },
      } as Input["result"],
      cwd,
      isPartial: false,
    });
  }

  test("draws the picture above the command's own output", () => {
    expect(view().body).toEqual([
      {
        kind: "image",
        sha256: "a".repeat(64),
        mimeType: "image/png",
        width: 40,
        height: 30,
        bytes: 2560,
        alt: "grim -",
      },
      {
        kind: "kv",
        pairs: [
          ["dimensions", "40x30"],
          ["size", "2.5 KB"],
        ],
      },
      { kind: "text", text: "Exit code: 0" },
    ]);
  });

  test("says how many frames the still left behind", () => {
    expect(view({ frames: 12 }).body?.[1]).toEqual({
      kind: "kv",
      pairs: [
        ["dimensions", "40x30"],
        ["frames", "12 (frame 1 shown)"],
        ["size", "2.5 KB"],
      ],
    });
  });

  test("a result without the field is text alone", () => {
    expect(paintBody({ command: "echo hi" }, "Exit code: 0")).toBe(
      "Exit code: 0"
    );
  });
});
