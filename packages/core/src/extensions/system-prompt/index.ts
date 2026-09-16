import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

import type { Surface } from "../../shared/Surface";
import { buildSystemPrompt } from "./prompt";

export default function (surface?: Surface): ExtensionFactory {
  return (pi: ExtensionAPI): void => {
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
