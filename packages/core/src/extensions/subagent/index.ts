import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Tools } from "../../shared/Tools";
import { subagentView } from "./render";
import { subagentSchema, type SubagentInput } from "./schema";
import { runSubagent, type SubagentDetails } from "./subagent";

export default function (pi: ExtensionAPI): void {
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
    // The subagent builds its own AgentSession, so its tool calls never reach
    // the parent's approval hook. Approving the subagent approves everything
    // it goes on to do.
    effect: { kind: "unbounded" },
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
    toViewModel: subagentView,
  });
}
