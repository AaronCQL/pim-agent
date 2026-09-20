import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

import type { Surface } from "../../shared/Surface";
import { buildSystemPrompt, formatDatetime } from "./prompt";

const DATETIME_MESSAGE_TYPE = "pim-datetime";

export default function (surface?: Surface): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
    // On submit rather than in `before_agent_start`, which can only append
    // behind the user's message.
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
      const {
        cwd,
        contextFiles,
        skills,
        promptGuidelines,
        appendSystemPrompt,
        customPrompt,
      } = event.systemPromptOptions;
      return {
        systemPrompt: buildSystemPrompt({
          model: ctx.model,
          cwd,
          contextFiles: contextFiles ?? [],
          skillsBlock:
            skills && skills.length > 0 ? formatSkillsForPrompt(skills) : "",
          toolGuidelines: promptGuidelines ?? [],
          appendSystemPrompt,
          customPrompt,
          ...(surface === undefined ? {} : { surface }),
        }),
      };
    });
  };
}
