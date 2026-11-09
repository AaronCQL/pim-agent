import type {
  MessageRenderer,
  MessageRenderOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { subagentNoticeView } from "#core/extensions/subagent/render";
import { SubagentNotice } from "#core/extensions/subagent/SubagentNotice";
import { SubagentResultRenderer } from "./SubagentResultRenderer";

type Message = Parameters<MessageRenderer>[0];

/** A `subagent_notice` message, as a subagent row. */
function render(
  message: Message,
  options: MessageRenderOptions,
  theme: Theme
): Component | undefined {
  const details = SubagentNotice.detailsOf(message);
  return details === undefined
    ? undefined
    : SubagentResultRenderer.paint(
        subagentNoticeView(details),
        false,
        options,
        theme
      );
}

export const SubagentNoticeRenderer = { render };
