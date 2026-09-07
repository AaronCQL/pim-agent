import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentLogs } from "../../shared/SubagentLogs";
import { Tools } from "../../shared/Tools";
import { subagentView } from "./render";
import { subagentSchema, type SubagentInput } from "./schema";
import { runSubagent, type SubagentDetails } from "./subagent";

export default function (pi: ExtensionAPI): void {
  SubagentLogs.installSweeper();
  Tools.register<typeof subagentSchema, SubagentDetails>(pi, {
    name: "subagent",
    label: "subagent",
    description:
      "Run a task in an isolated subagent with a fresh context. " +
      "The subagent inherits the currently active tools, except subagent itself. " +
      "Multiple subagent calls in one turn run in parallel. " +
      "Subagent output returned to the main agent is capped at 32KB.",
    parameters: subagentSchema,
    renderShell: "self",
    // The subagent builds its own AgentSession and runs whatever tools it
    // likes inside it, so nothing about this call's arguments bounds what it
    // touches.
    effect: { kind: "unbounded" },
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as SubagentInput;
      return runSubagent(input.prompt, ctx, {
        callId: toolCallId,
        signal,
        onUpdate,
        activeToolNames: pi.getActiveTools(),
      });
    },
    toViewModel: subagentView,
  });
}
