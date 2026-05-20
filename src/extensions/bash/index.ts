import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Renderer } from "../../shared/Renderer";
import { Tools } from "../../shared/Tools";
import { detailsOf, formatResult, isErrorResult } from "./format";
import { killAllActiveBashGroups, runBashCommand } from "./run";
import {
  type BashInput,
  bashSchema,
  DEFAULT_TIMEOUT_MS,
  STREAM_HEAD_BYTES,
  STREAM_TAIL_BYTES,
} from "./schema";

const PREVIEW_LINES = 5;

let signalHandlersInstalled = false;

function installShutdownHandlers(): void {
  if (signalHandlersInstalled) {
    return;
  }
  signalHandlersInstalled = true;
  // Sweep bash subtrees that escaped our process group (double-forked
  // daemons via their own setsid) or that the parent harness is about to
  // strand by signalling us. Re-raise the signal so the default handler
  // still runs.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(sig, () => {
      killAllActiveBashGroups(sig);
      process.kill(process.pid, sig);
    });
  }
}

export default function (pi: ExtensionAPI): void {
  installShutdownHandlers();
  Tools.register(pi, {
    name: "bash",
    label: "bash",
    description:
      `Execute a bash command in the cwd. ` +
      `Returns exit code, signal (if any), and stdout/stderr captured separately. ` +
      `Each stream is capped at ${STREAM_HEAD_BYTES} bytes head + ${STREAM_TAIL_BYTES} bytes tail; the middle is truncated. ` +
      `Use bash with trimming args or pipe to head/tail/cut to keep output small.`,
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
