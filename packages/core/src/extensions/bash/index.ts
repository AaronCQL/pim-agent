import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Images } from "../../shared/Images";
import { SpillCache } from "../../shared/SpillCache";
import { Tools } from "../../shared/Tools";
import { detailsOf, formatResult, isErrorResult } from "./format";
import { imageNote } from "./image";
import { bashView } from "./render";
import { killAllActiveBashGroups, runBashCommand } from "./run";
import {
  type BashDetails,
  type BashInput,
  bashSchema,
  DEFAULT_TIMEOUT_MS,
} from "./schema";

let lifecycleHandlersInstalled = false;

function installLifecycleHandlers(): void {
  if (lifecycleHandlersInstalled) {
    return;
  }
  lifecycleHandlersInstalled = true;

  // Sweep escaped bash subtrees, then re-raise so the default handler still runs.
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
  Tools.register<typeof bashSchema, BashDetails>(pi, {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the cwd. " +
      "Returns exit code, signal (if any), and stdout/stderr captured separately. " +
      "Stdout that is a png/jpeg/gif/webp is returned as a picture. " +
      "Prefer commands that emit only what you need; keep output as small as possible.",
    parameters: bashSchema,
    renderShell: "self",
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

      const content: AgentToolResult<BashDetails>["content"] = [
        { type: "text", text },
      ];
      const image = result.stdoutImage;
      if (image !== null) {
        const vision = Images.canSee(ctx.model);
        const note = imageNote(image, vision);
        content.push(
          ...(vision
            ? Images.contentOf(image, note)
            : [{ type: "text" as const, text: note }])
        );
      }

      return {
        content,
        details: detailsOf(result),
      };
    },
    toViewModel: bashView,
  });
}
