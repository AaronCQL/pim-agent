import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "./prompt";

export default function (pi: ExtensionAPI): void {
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
      }),
    };
  });
}
