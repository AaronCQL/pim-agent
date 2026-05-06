import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Container,
  Text,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { detailsOf, formatResult, isErrorResult } from "./format";
import { buildPreviewLines, markerColorFor, PREVIEW_LINES } from "./render";
import { runBashCommand } from "./run";
import {
  type BashInput,
  bashSchema,
  DEFAULT_TIMEOUT_MS,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      `Execute a bash command (\`bash -lc <command>\`) in the project working directory.\n` +
      `Returns exit code, signal (if any), and stdout/stderr captured separately.\n` +
      `Default timeout: ${DEFAULT_TIMEOUT_MS} ms (override with "timeoutMs").\n` +
      `Each stream is capped at ${STREAM_HEAD_BYTES} bytes head + ${STREAM_TAIL_BYTES} bytes tail; the middle is truncated.`,
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    parameters: bashSchema,
    renderShell: "self",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { command, timeoutMs: requestedTimeoutMs } = params as BashInput;
      const timeoutMs = requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS;

      if (signal?.aborted) {
        throw new Error("Command aborted before execution.");
      }

      const result = await runBashCommand(command, timeoutMs, signal, ctx.cwd);
      const text = formatResult(result, timeoutMs);
      if (isErrorResult(result)) {
        throw new Error(text);
      }
      return {
        content: [{ type: "text", text }],
        details: detailsOf(result),
      };
    },
    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const cmd =
        typeof args?.command === "string" && args.command
          ? args.command
          : "...";
      const markerColor = markerColorFor(
        Boolean(context.isPartial),
        Boolean(context.isError)
      );
      text.setText(
        theme.fg(markerColor, " ▪") +
          " " +
          theme.fg("toolTitle", theme.bold("Bash") + ": " + cmd)
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      const container =
        (context.lastComponent as Container | undefined) ?? new Container();
      container.clear();

      if (options.isPartial) {
        return container;
      }
      if (!context.isError && !options.expanded) {
        return container;
      }

      const first = result.content?.[0];
      const body = first && "text" in first ? (first.text ?? "") : "";
      if (!body) {
        return container;
      }

      const PREFIX = " │ ";
      const PREFIX_WIDTH = 3;
      const colorPrefix = () => theme.fg("toolOutput", PREFIX);
      const colorLine = (line: string) => theme.fg("toolOutput", line);

      const borderedBlock = (text: string): Component => ({
        render(width: number): string[] {
          const inner = Math.max(1, width - PREFIX_WIDTH);
          const out: string[] = [];
          for (const logical of text.split("\n")) {
            const wrapped = wrapTextWithAnsi(logical, inner);
            for (const w of wrapped) {
              out.push(colorPrefix() + colorLine(w));
            }
          }
          return out;
        },
        invalidate() {},
      });

      if (options.expanded) {
        container.addChild(borderedBlock(body));
      } else {
        const { preview, overflow } = buildPreviewLines(body, PREVIEW_LINES);
        if (preview) {
          container.addChild(borderedBlock(preview));
        }
        if (overflow > 0) {
          container.addChild(borderedBlock(`… ${overflow} more lines`));
        }
      }

      container.invalidate();
      return container;
    },
  });
}
