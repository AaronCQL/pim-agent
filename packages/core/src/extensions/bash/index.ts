import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SpillCache } from "../../shared/SpillCache";
import { Tools } from "../../shared/Tools";
import { detailsOf, formatResult, isErrorResult } from "./format";
import { bashView } from "./render";
import { killAllActiveBashGroups, runBashCommand } from "./run";
import { type BashInput, bashSchema, DEFAULT_TIMEOUT_MS } from "./schema";

const ERROR_PREVIEW_LINES = 5;

let lifecycleHandlersInstalled = false;

function installLifecycleHandlers(): void {
  if (lifecycleHandlersInstalled) {
    return;
  }
  lifecycleHandlersInstalled = true;

  // Sweep bash subtrees that escaped our process group (double-forked
  // daemons via their own setsid) or that the parent harness is about to
  // strand by signalling us. Re-raise the signal so the default handler
  // still runs.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(sig, () => {
      try {
        killAllActiveBashGroups(sig);
      } catch {}
      process.kill(process.pid, sig);
    });
  }
}

export default function (pi: ExtensionAPI): void {
  SpillCache.installSweeper();
  installLifecycleHandlers();
  Tools.register(pi, {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the cwd. " +
      "Returns exit code, signal (if any), and stdout/stderr captured separately. " +
      "Prefer commands that emit only what you need; keep output as small as possible.",
    parameters: bashSchema,
    renderShell: "self",
    // A command line has no target path to contain: `>`, `git push` and `curl`
    // all live in the same string. Statically deciding what a shell will touch
    // is the halting problem with extra steps, so bash always asks.
    effect: { kind: "unbounded" },
    executionMode: "sequential",
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
    toViewModel: bashView,
    previewLines: ERROR_PREVIEW_LINES,
  });
}
