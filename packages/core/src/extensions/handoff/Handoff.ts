import type {
  ContextEditEntryDraft,
  CustomMessageEntryDraft,
  ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { Format } from "../../shared/Format";
import type { ToolViewInput } from "../../shared/Tools";
import type { ToolView } from "../../view/ViewBlock";

const TOOL = "handoff";
const REQUEST_TYPE = "handoff";
const NOTE_TYPE = "handoff-note";

const INSTRUCTION = `Your conversation is about to be cleared. A fresh agent takes over with your system prompt, project instructions and tools, and can read the repo and git, but nothing said or done in this conversation reaches it except the note you write now. Call the ${TOOL} tool with that note and do nothing else.

Spend the note on what exists only in this conversation, and point to files instead of restating them. Carry over:
- what the user asked for, and every preference, constraint and correction they gave, in their words where the wording matters;
- the decisions made and why;
- what was ruled out, as the constraint that ruled it out where one exists, otherwise one line per option a fresh agent would likely propose again; not how you got there;
- where the work stands: done, in progress, the next step, and any background jobs still running and what each is for.

Mark what is unverified. Keep it short, but never by dropping something the user told you.`;

const schema = Type.Object({
  note: Type.String({
    minLength: 1,
    description:
      "Everything from this conversation the next agent needs to carry on, in Markdown. It sees none of this conversation but the note.",
  }),
});

type Input = Static<typeof schema>;

export type HandoffDetails = {
  readonly tokensBefore: number;
  readonly tokensAfter: number;
};

function request(focus: string): Omit<CustomMessageEntryDraft, "type"> {
  return {
    customType: REQUEST_TYPE,
    content:
      focus === ""
        ? INSTRUCTION
        : `${INSTRUCTION}\n\nThe user wants the next agent to focus on: ${focus}`,
    display: false,
  };
}

function noteMessage(note: string): CustomMessageEntryDraft {
  return {
    type: "custom_message",
    customType: NOTE_TYPE,
    content: `Your earlier conversation was cleared. This is the handoff note you left yourself. It is a summary: where it disagrees with the files, trust the files.\n\n${note}`,
    display: false,
  };
}

/** Pi refuses an edit of an entry that carries no editable model content, or that is only a draft so far. */
function omissions(
  context: readonly ProjectedSessionEntry[],
  committed: (id: string) => boolean
): readonly ContextEditEntryDraft[] {
  return context.flatMap(({ sourceEntry: entry, messages }) => {
    const editable =
      entry.type === "custom_message" ||
      (entry.type === "message" &&
        ["user", "assistant", "toolResult"].includes(entry.message.role));
    return editable && messages.length > 0 && committed(entry.id)
      ? [{ type: "context_edit", targetId: entry.id, replacement: null }]
      : [];
  });
}

function view({
  args,
  result,
}: ToolViewInput<typeof schema, HandoffDetails>): ToolView {
  const details = result?.details;
  const note = (args as Partial<Input> | undefined)?.note ?? "";
  return {
    label: "Handoff",
    title: [
      {
        kind: "text",
        text:
          details === undefined
            ? "compacting session..."
            : `compacted from ${Format.formatTokens(details.tokensBefore)} tokens to ${Format.formatTokens(details.tokensAfter)} tokens`,
      },
    ],
    body: note === "" ? [] : [{ kind: "markdown", text: note }],
  };
}

export const Handoff = {
  TOOL,
  REQUEST_TYPE,
  schema,
  request,
  noteMessage,
  omissions,
  view,
};
