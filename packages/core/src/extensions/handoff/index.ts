import {
  estimateTokens,
  type ExtensionAPI,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { Tools } from "../../shared/Tools";
import { Handoff, type HandoffDetails } from "./Handoff";

function handedOff(event: TurnEndEvent): string | undefined {
  const result = event.toolResults.find(
    (message) => message.toolName === Handoff.TOOL && !message.isError
  );
  const call =
    event.message.role === "assistant"
      ? event.message.content.find(
          (part) => part.type === "toolCall" && part.id === result?.toolCallId
        )
      : undefined;
  return call?.type === "toolCall" && typeof call.arguments["note"] === "string"
    ? call.arguments["note"]
    : undefined;
}

export default function (pi: ExtensionAPI): void {
  let asked = false;
  let settle: (() => void) | undefined;

  Tools.register(pi, {
    name: Handoff.TOOL,
    label: "Handoff",
    description:
      "Clear your context, carrying over only the note you pass. Only call this when a handoff instruction asks you to.",
    parameters: Handoff.schema,
    renderShell: "self",
    effect: { kind: "readOnly" },
    executionMode: "sequential",
    async execute(_toolCallId, { note }, _signal, _onUpdate, ctx) {
      if (!asked) {
        throw new Error(
          "handoff runs only when the user asks for one with /handoff; carry on with the task instead."
        );
      }
      const details: HandoffDetails = {
        tokensBefore: ctx.getContextUsage()?.tokens ?? 0,
        tokensAfter: estimateTokens({
          role: "user",
          content: Handoff.noteMessage(note).content,
          timestamp: Date.now(),
        }),
      };
      return {
        content: [
          { type: "text", text: "Handed off; your context is cleared." },
        ],
        details,
        terminate: true,
      };
    },
    toViewModel: Handoff.view,
  });

  pi.on("turn_end", (event, ctx) => {
    if (!asked) {
      return undefined;
    }
    const note = handedOff(event);
    const final =
      note !== undefined ||
      event.outcome !== "completed" ||
      event.toolResults.length === 0;
    if (!final) {
      return undefined;
    }
    asked = false;
    const branch = ctx.sessionManager.getBranch();
    const ids = new Set(branch.map((entry) => entry.id));
    const committed = (id: string): boolean => ids.has(id);
    if (note !== undefined) {
      return {
        entries: [
          ...event.entries,
          ...Handoff.omissions(event.context.contextEntries, committed),
          Handoff.noteMessage(note),
        ],
      };
    }
    const requestEntry = branch.findLast(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === Handoff.REQUEST_TYPE
    );
    return requestEntry === undefined
      ? undefined
      : {
          entries: [
            ...event.entries,
            {
              type: "context_edit",
              targetId: requestEntry.id,
              replacement: null,
            },
          ],
        };
  });

  pi.on("agent_settled", () => {
    asked = false;
    settle?.();
    settle = undefined;
  });

  pi.registerCommand("handoff", {
    description:
      "Have the agent write a handoff note, then continue from only that note",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for the turn to finish before handing off.",
          "warning"
        );
        return;
      }
      asked = true;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      pi.sendMessage(Handoff.request(args.trim()), { triggerTurn: true });
      if (ctx.isIdle()) {
        asked = false;
        settle = undefined;
        return;
      }
      await settled;
    },
  });
}
