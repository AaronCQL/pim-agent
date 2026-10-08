import type { UserMessage } from "@earendil-works/pi-ai";
import {
  parseSkillBlock,
  type ParsedSkillBlock,
} from "@earendil-works/pi-coding-agent";

import { Attachments, type PromptAttachment } from "../attachments/Attachments";
import { MessageText } from "./MessageText";

/** A skill pi expanded inline into the prompt. */
export type SkillUse = Pick<ParsedSkillBlock, "name" | "content">;

/** A stored user message as the user typed it, with what pi expanded into it set apart. */
export type UserPrompt = {
  readonly text: string;
  readonly files: readonly PromptAttachment[];
  readonly skill?: SkillUse;
};

function of(content: UserMessage["content"]): UserPrompt {
  const raw = MessageText.textOf(content);
  const block = parseSkillBlock(raw);
  if (block === null) {
    return Attachments.parse(raw);
  }
  const said = Attachments.parse(block.userMessage ?? "");
  return {
    ...said,
    text: [`/skill:${block.name}`, said.text].filter(Boolean).join(" "),
    skill: { name: block.name, content: block.content },
  };
}

export const UserPrompt = { of };
