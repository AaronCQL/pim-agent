import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { Json } from "../../shared/Json";
import { ModelId } from "../../shared/ModelId";

const CUSTOM_TYPE = "pim-subagent-choice";

/** What a session's subagents run on; an absent field follows the main agent. */
export type SubagentChoice = {
  /** `provider/id`. */
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
};

/** `null` goes back to following the main agent; an absent field is left alone. */
export type SubagentChoicePatch = {
  readonly model?: string | null;
  readonly thinking?: ThinkingLevel | null;
};

type Entries = readonly {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}[];

type Running = {
  readonly model: Model<Api> | undefined;
  readonly thinkingLevel: ThinkingLevel;
};

function of(
  model: string | undefined,
  thinking: ThinkingLevel | undefined
): SubagentChoice {
  return {
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
  };
}

/** The last choice written anywhere in the file. */
function read(entries: Entries): SubagentChoice {
  const entry = entries.findLast(
    (candidate) =>
      candidate.type === "custom" && candidate.customType === CUSTOM_TYPE
  );
  const data = Json.asRecord(entry?.data);
  const model = data?.["model"];
  const thinking = data?.["thinking"];
  return of(
    typeof model === "string" ? model : undefined,
    typeof thinking === "string" ? (thinking as ThinkingLevel) : undefined
  );
}

function append(
  session: { appendCustomEntry(customType: string, data?: unknown): string },
  choice: SubagentChoice
): void {
  session.appendCustomEntry(CUSTOM_TYPE, choice);
}

function patched(
  choice: SubagentChoice,
  patch: SubagentChoicePatch
): SubagentChoice {
  const model = patch.model === undefined ? choice.model : patch.model;
  const thinking =
    patch.thinking === undefined ? choice.thinking : patch.thinking;
  return of(model ?? undefined, thinking ?? undefined);
}

/** A chosen model that is no longer available falls back to the main agent's. */
function resolve(
  choice: SubagentChoice,
  main: Running,
  available: () => readonly Model<Api>[]
): Running {
  const chosen =
    choice.model === undefined
      ? undefined
      : available().find((model) => ModelId.of(model) === choice.model);
  return {
    model: chosen ?? main.model,
    thinkingLevel: choice.thinking ?? main.thinkingLevel,
  };
}

export const SubagentChoice = { read, append, patched, resolve };
