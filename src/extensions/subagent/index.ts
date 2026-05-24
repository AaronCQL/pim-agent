import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Tools } from "../../shared/Tools";
import { renderCall, renderResult } from "./render";
import { subagentSchema, type SubagentInput } from "./schema";
import { runSubagent, type SubagentDetails } from "./subagent";

export default function (pi: ExtensionAPI): void {
  Tools.register<typeof subagentSchema, SubagentDetails>(pi, {
    name: "subagent",
    label: "subagent",
    description:
      "Delegate a task to an isolated subagent to keep your main context clean. The subagent inherits your currently active tools (except subagent itself) and runs in a fresh in-memory session. Multiple subagent calls in one turn run in parallel. Subagent responses are capped at 32KB; the full output is preserved in tool details.",
    parameters: subagentSchema,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as SubagentInput;
      return runSubagent(
        input.prompt,
        ctx,
        signal,
        onUpdate,
        undefined,
        pi.getActiveTools()
      );
    },
    renderCall,
    renderResult,
  });
}
