import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Renderer } from "../../shared/Renderer";
import { detailsOf, formatResult, isErrorResult } from "./format";
import { runBashCommand } from "./run";
import {
  type BashInput,
  bashSchema,
  DEFAULT_TIMEOUT_MS,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

const PREVIEW_LINES = 5;

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
      const cmd =
        typeof args?.command === "string" && args.command
          ? args.command
          : "...";
      return Renderer.renderToolCallTitle({
        label: "Bash",
        title: cmd,
        theme,
        context,
      });
    },
    renderResult(result, options, theme, context) {
      return Renderer.renderBorderedResult({
        result,
        options,
        theme,
        context,
        previewLines: PREVIEW_LINES,
      });
    },
  });
}
