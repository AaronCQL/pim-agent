import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Surface } from "../../shared/Surface";
import {
  buildEnvironment,
  buildFormatting,
  buildInstructions,
  formatDatetime,
  leadWithSystemPrompt,
} from "./prompt";

const DATETIME_MESSAGE_TYPE = "pim-datetime";

export default function (surface?: Surface): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    // `before_agent_start` could only append after the user's message.
    pi.on("input", () => {
      pi.sendMessage(
        {
          customType: DATETIME_MESSAGE_TYPE,
          content: `<datetime>${formatDatetime(new Date())}</datetime>`,
          display: false,
        },
        { triggerTurn: false }
      );
      return { action: "continue" };
    });
    pi.on("before_agent_start", (event, ctx) => {
      const options = event.systemPromptOptions;
      if (!options.customPrompt?.trim()) {
        options.customPrompt = buildInstructions(options);
      }
      options.sections.environment = buildEnvironment({
        model: ctx.model,
        surface,
      });
      options.sections.formatting = buildFormatting(surface);
    });
    pi.on("context_with_system", (event) => {
      const messages = leadWithSystemPrompt(event.messages);
      return messages ? { messages } : undefined;
    });
  };
}
